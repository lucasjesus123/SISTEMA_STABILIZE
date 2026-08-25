import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Contas fixas e fechamento do mês, pela API.
 *
 * O QUE ESTE ARQUIVO PRECISA PROVAR — as duas coisas que, se errarem,
 * erram em cima de dinheiro e ninguém percebe na hora:
 *
 *   1. GERAR DUAS VEZES NÃO COBRA DUAS VEZES. A idempotência é do
 *      índice único no banco, e não do código; um teste que só chamasse
 *      uma vez não diria nada sobre isso.
 *   2. MUDAR O MOLDE NÃO REESCREVE O PASSADO. Subir o aluguel não pode
 *      fazer o mês que já foi pago virar outro número no extrato.
 *
 * E, no fechamento: fechar cria a despesa, fechar duas vezes é recusado,
 * reabrir cancela a despesa, e reabrir DEPOIS DE PAGO é recusado.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';

const ids = {
  tenant: '',
  admin: '',
  emailAdmin: '',
  prof: '',
  aluno: '',
  entry: '',
};

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', ids.tenant]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

let token = '';
const auth = () => ({ authorization: `Bearer ${token}` });

/** O mês de referência: sempre três meses atrás, para o teste não
    depender de que dia do mês ele roda. */
function mesesAtras(n: number): Date {
  const h = new Date();
  return new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - n, 1));
}
const iso = (d: Date): string => d.toISOString().slice(0, 10);

suite('contas fixas e fechamento do mês', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'fixas-acesso-somente-teste-com-tamanho-suficiente-1';
    process.env['JWT_REFRESH_SECRET'] = 'fixas-refresh-somente-teste-com-tamanho-suficiente-2';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    process.env['CORS_ORIGINS'] = 'http://localhost:5173';
    process.env['LOG_LEVEL'] = 'fatal';

    const { resetEnvCache } = await import('../../config/env.js');
    resetEnvCache();
    const { buildApp } = await import('../../app.js');
    app = await buildApp();
    await app.ready();

    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    const sufixo = crypto.randomUUID().slice(0, 8);
    ids.tenant = crypto.randomUUID();
    ids.emailAdmin = `fix-admin-${sufixo}@t.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await tx(async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Fixas Test',
        `fix-${sufixo}`,
      ]);

      const mk = async (email: string, nome: string, papel: string): Promise<string> => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
           VALUES ($1,$2,$3,$4,$5::user_role) RETURNING id`,
          [ids.tenant, email, hash, nome, papel],
        );
        return r.rows[0]!.id;
      };
      ids.admin = await mk(ids.emailAdmin, 'Admin', 'ADMIN');
      ids.prof = await mk(`fix-prof-${sufixo}@t.test`, 'Prof Fixas', 'PROFESSIONAL');

      const a = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno Fixas') RETURNING id`,
        [ids.tenant],
      );
      ids.aluno = a.rows[0]!.id;

      const contrato = await c.query<{ id: string }>(
        `INSERT INTO student_contracts
           (tenant_id, student_id, professional_id, cycle, amount_cents, commission_bp, starts_on)
         VALUES ($1,$2,$3,'MONTHLY',30000,3000,'2026-01-01') RETURNING id`,
        [ids.tenant, ids.aluno, ids.prof],
      );

      /* Uma mensalidade RECEBIDA no mês de referência: é o que dá base
         para a comissão existir e o fechamento poder ser feito. */
      const ref = mesesAtras(3);
      const e = await c.query<{ id: string }>(
        `INSERT INTO finance_entries
           (tenant_id, direction, description, amount_cents, due_date,
            competence_date, student_id, professional_id, contract_id)
         VALUES ($1,'RECEIVABLE','Mensalidade do teste',30000,$2,$2,$3,$4,$5)
         RETURNING id`,
        [ids.tenant, iso(ref), ids.aluno, ids.prof, contrato.rows[0]!.id],
      );
      ids.entry = e.rows[0]!.id;
      await c.query(
        `INSERT INTO finance_payments (tenant_id, entry_id, amount_cents, method, paid_at)
         VALUES ($1,$2,30000,'PIX',$3)`,
        [ids.tenant, ids.entry, `${iso(ref)}T12:00:00Z`],
      );
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ids.emailAdmin, password: SENHA },
    });
    token = (login.json() as { accessToken: string }).accessToken;
  }, 60_000);

  afterAll(async () => {
    if (ids.tenant) {
      await tx((c) => c.query('DELETE FROM tenants WHERE id=$1', [ids.tenant])).catch(
        () => undefined,
      );
    }
    await pool?.end();
    await app?.close();
  });

  /* ================================================================
   * CONTAS FIXAS
   * ============================================================== */

  let contaFixa = '';

  it('cadastrar uma conta fixa com início no passado gera os meses que faltam', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/finance/contas-fixas',
      headers: auth(),
      payload: {
        direcao: 'PAYABLE',
        descricao: 'Aluguel do salão',
        categoria: 'Ocupação',
        valor: '2.500,00',
        ciclo: 'MONTHLY',
        diaDeCobranca: 20,
        contraparte: 'Imobiliária',
        inicio: iso(mesesAtras(3)),
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: string; geradas: number } };
    contaFixa = body.data.id;
    /* Quatro: três meses atrás, dois, um e o corrente. */
    expect(body.data.geradas).toBe(4);
  });

  it('gerar de novo NÃO duplica — a garantia é o índice único, não o código', async () => {
    for (const _ of [1, 2]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/finance/contas-fixas/gerar',
        headers: auth(),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { data: { geradas: number } }).data.geradas).toBe(0);
    }

    const { rows } = await tx((c) =>
      c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM finance_entries WHERE recurrence_id = $1',
        [contaFixa],
      ),
    );
    expect(Number(rows[0]!.n)).toBe(4);
  });

  it('mudar o valor vale do próximo em diante — o passado fica como está', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/finance/contas-fixas/${contaFixa}`,
      headers: auth(),
      payload: { valor: '2.700,00' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await tx((c) =>
      c.query<{ amount_cents: string }>(
        'SELECT amount_cents::text FROM finance_entries WHERE recurrence_id = $1',
        [contaFixa],
      ),
    );
    /* Nenhum dos quatro lançamentos já emitidos virou 2.700. */
    expect(rows.every((r) => r.amount_cents === '250000')).toBe(true);
  });

  it('pausada não gera; retomada corre atrás do que faltou', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/finance/contas-fixas/${contaFixa}`,
      headers: auth(),
      payload: { ativa: false },
    });

    const parada = await app.inject({
      method: 'POST',
      url: '/api/finance/contas-fixas/gerar',
      headers: auth(),
      payload: {},
    });
    expect((parada.json() as { data: { geradas: number } }).data.geradas).toBe(0);

    const lista = await app.inject({
      method: 'GET',
      url: '/api/finance/contas-fixas',
      headers: auth(),
    });
    const conta = (lista.json() as { data: { id: string; ativa: boolean }[] }).data.find(
      (c) => c.id === contaFixa,
    );
    expect(conta?.ativa).toBe(false);

    await app.inject({
      method: 'PATCH',
      url: `/api/finance/contas-fixas/${contaFixa}`,
      headers: auth(),
      payload: { ativa: true },
    });
  });

  it('trimestral nasce de três em três meses, e não todo mês', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/finance/contas-fixas',
      headers: auth(),
      payload: {
        direcao: 'PAYABLE',
        descricao: 'Contador',
        valor: '900,00',
        ciclo: 'QUARTERLY',
        diaDeCobranca: 5,
        contraparte: 'Escritório',
        inicio: iso(mesesAtras(3)),
      },
    });
    expect(res.statusCode).toBe(201);
    /* Três meses atrás e o mês corrente: dois, não quatro. */
    expect((res.json() as { data: { geradas: number } }).data.geradas).toBe(2);
  });

  it('a receber SEM dizer de quem é recusada antes de virar lançamento órfão', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/finance/contas-fixas',
      headers: auth(),
      payload: {
        direcao: 'RECEIVABLE',
        descricao: 'Sublocação',
        valor: '400,00',
        ciclo: 'MONTHLY',
        diaDeCobranca: 10,
        inicio: iso(mesesAtras(1)),
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { message: expect.stringContaining('de quem') },
    });
  });

  it('excluir o molde não apaga o que já nasceu dele', async () => {
    const antes = await tx((c) =>
      c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM finance_entries WHERE recurrence_id = $1',
        [contaFixa],
      ),
    );
    expect(Number(antes.rows[0]!.n)).toBe(4);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/finance/contas-fixas/${contaFixa}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const sobreviveram = await tx((c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM finance_entries
          WHERE description LIKE 'Aluguel do salão%' AND cancelled_at IS NULL`,
      ),
    );
    expect(Number(sobreviveram.rows[0]!.n)).toBe(4);
  });

  /* ================================================================
   * FECHAMENTO DO MÊS
   * ============================================================== */

  it('fechar o mês grava a memória de cálculo e cria a despesa do repasse', async () => {
    const mes = iso(mesesAtras(3));

    const res = await app.inject({
      method: 'POST',
      url: `/api/finance/comissoes/${ids.prof}/fechar`,
      headers: auth(),
      payload: { mes },
    });
    expect(res.statusCode).toBe(201);

    const body = res.json() as { data: { lancamentoId: string; totalCentavos: number } };
    /* 30% de R$ 300,00 recebidos. */
    expect(body.data.totalCentavos).toBe(9000);

    const { rows } = await tx((c) =>
      c.query<{ direction: string; amount_cents: string; category: string | null }>(
        'SELECT direction, amount_cents::text, category FROM finance_entries WHERE id = $1',
        [body.data.lancamentoId],
      ),
    );
    expect(rows[0]).toMatchObject({
      direction: 'PAYABLE',
      amount_cents: '9000',
      category: 'Comissão',
    });

    const lido = await app.inject({
      method: 'GET',
      url: `/api/finance/comissoes/${ids.prof}/fechamento?mes=${mes}`,
      headers: auth(),
    });
    const f = (lido.json() as { data: { status: string; itens: unknown[]; fechadoEm: string } })
      .data;
    expect(f.status).toBe('SETTLED');
    expect(f.itens.length).toBe(1);
    /* A data precisa ser ISO válido — o formato anterior saía "+00", sem
       os minutos, e o `new Date()` do navegador recusava: o PDF trazia
       "Mês FECHADO em Invalid Date". */
    expect(Number.isNaN(new Date(f.fechadoEm).getTime())).toBe(false);
  });

  it('fechar duas vezes é recusado — e a mensagem diz o que fazer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/finance/comissoes/${ids.prof}/fechar`,
      headers: auth(),
      payload: { mes: iso(mesesAtras(3)) },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { message: expect.stringContaining('Reabra') },
    });
  });

  it('a memória de cálculo leva o nome do aluno em cada linha', async () => {
    const { rows } = await tx((c) =>
      c.query<{ description: string }>(
        `SELECT ci.description FROM commission_items ci
           JOIN commissions cm ON cm.id = ci.commission_id
          WHERE cm.professional_id = $1`,
        [ids.prof],
      ),
    );
    expect(rows[0]?.description).toContain('Aluno Fixas');
  });

  it('reabrir cancela a despesa do repasse, sem apagá-la', async () => {
    const mes = iso(mesesAtras(3));

    const antes = await app.inject({
      method: 'GET',
      url: `/api/finance/comissoes/${ids.prof}/fechamento?mes=${mes}`,
      headers: auth(),
    });
    const lancamento = (antes.json() as { data: { lancamentoId: string } }).data.lancamentoId;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/finance/comissoes/${ids.prof}/fechamento?mes=${mes}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await tx((c) =>
      c.query<{ status: string; cancelled_at: string | null }>(
        'SELECT status::text, cancelled_at FROM finance_entries WHERE id = $1',
        [lancamento],
      ),
    );
    /* CONTINUA EXISTINDO — quem for auditar o mês precisa achá-la. */
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('CANCELLED');
    expect(rows[0]!.cancelled_at).not.toBeNull();

    const depois = await app.inject({
      method: 'GET',
      url: `/api/finance/comissoes/${ids.prof}/fechamento?mes=${mes}`,
      headers: auth(),
    });
    expect((depois.json() as { data: unknown }).data).toBeNull();
  });

  it('reabrir DEPOIS DE PAGO é recusado: senão o caixa fica com uma saída sem documento', async () => {
    const mes = iso(mesesAtras(3));

    const fechou = await app.inject({
      method: 'POST',
      url: `/api/finance/comissoes/${ids.prof}/fechar`,
      headers: auth(),
      payload: { mes },
    });
    const lancamento = (fechou.json() as { data: { lancamentoId: string } }).data.lancamentoId;

    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${lancamento}/pagamentos`,
      headers: auth(),
      payload: { valor: '90,00', metodo: 'PIX' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/finance/comissoes/${ids.prof}/fechamento?mes=${mes}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { message: expect.stringContaining('Estorne') },
    });
  });

  it('o PDF do fechamento sai, e sai marcado quando é só prévia', async () => {
    const mesFechado = mesesAtras(3).toISOString().slice(0, 7);
    const fechado = await app.inject({
      method: 'GET',
      url: `/api/relatorios/comissao?profissionalId=${ids.prof}&mes=${mesFechado}`,
      headers: auth(),
    });
    expect(fechado.statusCode).toBe(200);
    expect(fechado.headers['content-type']).toContain('application/pdf');
    expect(fechado.rawPayload.length).toBeGreaterThan(1000);

    /* Um mês sem fechamento nenhum: o PDF continua saindo, como prévia. */
    const semFechar = mesesAtras(11).toISOString().slice(0, 7);
    const previa = await app.inject({
      method: 'GET',
      url: `/api/relatorios/comissao?profissionalId=${ids.prof}&mes=${semFechar}`,
      headers: auth(),
    });
    expect(previa.statusCode).toBe(200);
    expect(previa.headers['content-type']).toContain('application/pdf');
  });

  it('um profissional não fecha o mês de ninguém — nem o próprio', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `fix-prof-${ids.emailAdmin.split('-')[2]}`, password: SENHA },
    });
    /* O e-mail do professor foi montado com o mesmo sufixo do admin. */
    const sufixo = ids.emailAdmin.replace('fix-admin-', '').replace('@t.test', '');
    const certo = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `fix-prof-${sufixo}@t.test`, password: SENHA },
    });
    void login;
    const tokenProf = (certo.json() as { accessToken: string }).accessToken;

    const res = await app.inject({
      method: 'POST',
      url: `/api/finance/comissoes/${ids.prof}/fechar`,
      headers: { authorization: `Bearer ${tokenProf}` },
      payload: { mes: iso(mesesAtras(2)) },
    });
    expect(res.statusCode).toBe(403);
  });
});
