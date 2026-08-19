import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Financeiro pela API.
 *
 * O que este arquivo precisa provar, e que o enunciado pediu
 * explicitamente: **um profissional vê o próprio fechamento e nada
 * além** — nem o caixa da empresa, nem a comissão do colega.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';

const ids = {
  tenant: '',
  admin: '',
  prof1: '',
  prof2: '',
  emailAdmin: '',
  emailProf1: '',
  emailProf2: '',
  aluno1: '',
  aluno2: '',
  entry1: '',
  entry2: '',
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

const tokens = new Map<string, string>();
async function tokenDe(email: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached !== undefined) return cached;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) {
    throw new Error(`login falhou para ${email}: ${res.statusCode} ${res.body}`);
  }
  tokens.set(email, body.accessToken);
  return body.accessToken;
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

suite('financeiro e comissões pela API', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'fin-acesso-somente-para-teste-com-tamanho-suficiente-1';
    process.env['JWT_REFRESH_SECRET'] = 'fin-refresh-somente-para-teste-com-tamanho-suficiente-2';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 9).toString('base64');
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
    ids.emailAdmin = `fin-admin-${sufixo}@t.test`;
    ids.emailProf1 = `fin-p1-${sufixo}@t.test`;
    ids.emailProf2 = `fin-p2-${sufixo}@t.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await tx(async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Fin Test',
        `fin-${sufixo}`,
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
      ids.prof1 = await mk(ids.emailProf1, 'Prof Um', 'PROFESSIONAL');
      ids.prof2 = await mk(ids.emailProf2, 'Prof Dois', 'PROFESSIONAL');

      const a1 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno Um') RETURNING id`,
        [ids.tenant],
      );
      const a2 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno Dois') RETURNING id`,
        [ids.tenant],
      );
      ids.aluno1 = a1.rows[0]!.id;
      ids.aluno2 = a2.rows[0]!.id;

      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenant, ids.aluno1, ids.prof1],
      );
      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenant, ids.aluno2, ids.prof2],
      );

      // Contratos com alíquotas diferentes: 40% e 50%.
      const mkContrato = async (studentId: string, profId: string, bp: number) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO student_contracts
             (tenant_id, student_id, professional_id, cycle, amount_cents, commission_bp, starts_on)
           VALUES ($1,$2,$3,'MONTHLY',29990,$4,'2026-01-01') RETURNING id`,
          [ids.tenant, studentId, profId, bp],
        );
        return r.rows[0]!.id;
      };
      const c1 = await mkContrato(ids.aluno1, ids.prof1, 4000);
      const c2 = await mkContrato(ids.aluno2, ids.prof2, 5000);

      // Um lançamento recebido para cada professor, no mesmo mês.
      const mkEntry = async (
        studentId: string,
        profId: string,
        contratoId: string,
      ): Promise<string> => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO finance_entries
             (tenant_id, direction, description, amount_cents, due_date,
              competence_date, student_id, professional_id, contract_id)
           VALUES ($1,'RECEIVABLE','Mensalidade março',29990,'2026-03-10','2026-03-01',$2,$3,$4)
           RETURNING id`,
          [ids.tenant, studentId, profId, contratoId],
        );
        return r.rows[0]!.id;
      };
      ids.entry1 = await mkEntry(ids.aluno1, ids.prof1, c1);
      ids.entry2 = await mkEntry(ids.aluno2, ids.prof2, c2);

      for (const e of [ids.entry1, ids.entry2]) {
        await c.query(
          `INSERT INTO finance_payments (tenant_id, entry_id, amount_cents, method, paid_at)
           VALUES ($1,$2,29990,'PIX','2026-03-12T10:00:00Z')`,
          [ids.tenant, e],
        );
      }
    });
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

  // ==================================================================
  describe('o caixa da empresa é fechado para o profissional', () => {
    it('profissional recebe 403 ao listar lançamentos', async () => {
      const t = await tokenDe(ids.emailProf1);
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/lancamentos',
        headers: auth(t),
      });
      expect(res.statusCode).toBe(403);
    });

    it('profissional recebe 403 no resumo financeiro', async () => {
      const t = await tokenDe(ids.emailProf1);
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/resumo?de=2026-03-01&ate=2026-03-31',
        headers: auth(t),
      });
      expect(res.statusCode).toBe(403);
    });

    it('a negativa é barrada ANTES de qualquer consulta, e fica auditada', async () => {
      const t = await tokenDe(ids.emailProf1);
      await app.inject({
        method: 'GET',
        url: '/api/finance/lancamentos',
        headers: auth(t),
      });

      const n = await tx(async (c) => {
        const r = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log
            WHERE tenant_id=$1 AND outcome='DENIED' AND action='access.denied'
              AND actor_id=$2`,
          [ids.tenant, ids.prof1],
        );
        return r.rows[0]!.n;
      });
      expect(n).toBeGreaterThan(0);
    });

    it('o admin enxerga o caixa normalmente', async () => {
      const t = await tokenDe(ids.emailAdmin);
      const res = await app.inject({
        method: 'GET',
        url: '/api/finance/lancamentos',
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { pagination: { total: number } }).pagination.total).toBe(2);
    });
  });

  // ==================================================================
  describe('comissão: cada profissional vê apenas o próprio fechamento', () => {
    it('o Prof Um vê o próprio, com a memória de cálculo', async () => {
      const t = await tokenDe(ids.emailProf1);
      const res = await app.inject({
        method: 'GET',
        url: `/api/finance/comissoes/${ids.prof1}?mes=2026-03-01`,
        headers: auth(t),
      });

      expect(res.statusCode).toBe(200);
      const d = (res.json() as { data: Record<string, unknown> }).data;
      // 40% de R$ 299,90 = R$ 119,96
      expect(d['totalCentavos']).toBe(11996);
      expect(d['totalFormatado']).toBe('R$ 119,96');
      expect((d['itens'] as unknown[]).length).toBe(1);
    });

    it('o Prof Um NÃO abre o fechamento do Prof Dois', async () => {
      const t = await tokenDe(ids.emailProf1);
      const res = await app.inject({
        method: 'GET',
        url: `/api/finance/comissoes/${ids.prof2}?mes=2026-03-01`,
        headers: auth(t),
      });
      // 404 e não 403: um 403 confirmaria que aquele profissional existe.
      expect(res.statusCode).toBe(404);
    });

    it('o Prof Dois vê o próprio, com a alíquota do próprio contrato', async () => {
      const t = await tokenDe(ids.emailProf2);
      const res = await app.inject({
        method: 'GET',
        url: `/api/finance/comissoes/${ids.prof2}?mes=2026-03-01`,
        headers: auth(t),
      });
      // 50% de R$ 299,90 = R$ 149,95
      expect((res.json() as { data: { totalCentavos: number } }).data.totalCentavos).toBe(14995);
    });

    it('o admin consulta o fechamento de qualquer profissional', async () => {
      const t = await tokenDe(ids.emailAdmin);
      for (const [prof, esperado] of [
        [ids.prof1, 11996],
        [ids.prof2, 14995],
      ] as const) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/finance/comissoes/${prof}?mes=2026-03-01`,
          headers: auth(t),
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as { data: { totalCentavos: number } }).data.totalCentavos).toBe(
          esperado,
        );
      }
    });

    it('mês sem movimento devolve fechamento zerado, não erro', async () => {
      const t = await tokenDe(ids.emailProf1);
      const res = await app.inject({
        method: 'GET',
        url: `/api/finance/comissoes/${ids.prof1}?mes=2026-07-01`,
        headers: auth(t),
      });
      expect(res.statusCode).toBe(200);
      const d = (res.json() as { data: { totalCentavos: number; itens: unknown[] } }).data;
      expect(d.totalCentavos).toBe(0);
      expect(d.itens).toEqual([]);
    });
  });

  // ==================================================================
  describe('dinheiro entra pela API sem passar por float', () => {
    it('aceita valor em texto pt-BR e grava centavos inteiros', async () => {
      const t = await tokenDe(ids.emailAdmin);
      const res = await app.inject({
        method: 'POST',
        url: '/api/finance/lancamentos',
        headers: auth(t),
        payload: {
          direcao: 'PAYABLE',
          descricao: 'Aluguel março',
          valor: '3.450,75',
          vencimento: '2026-03-05',
        },
      });
      expect(res.statusCode).toBe(201);

      const id = (res.json() as { data: { id: string } }).data.id;
      const gravado = await tx(async (c) => {
        const r = await c.query<{ amount_cents: string }>(
          'SELECT amount_cents FROM finance_entries WHERE id=$1',
          [id],
        );
        return Number(r.rows[0]!.amount_cents);
      });
      expect(gravado).toBe(345_075);
    });

    it('recusa valor ambíguo em vez de adivinhar', async () => {
      const t = await tokenDe(ids.emailAdmin);
      const res = await app.inject({
        method: 'POST',
        url: '/api/finance/lancamentos',
        headers: auth(t),
        payload: {
          direcao: 'PAYABLE',
          descricao: 'Ambíguo',
          valor: '1,234',
          vencimento: '2026-03-05',
        },
      });
      // "1,234" pode ser R$ 1.234,00 ou R$ 1,23 — erro de 1000x.
      expect(res.statusCode).toBe(422);
    });

    it('recusa valor zero ou negativo', async () => {
      const t = await tokenDe(ids.emailAdmin);
      for (const valor of ['0,00', '-50,00']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/finance/lancamentos',
          headers: auth(t),
          payload: {
            direcao: 'PAYABLE',
            descricao: 'Inválido',
            valor,
            vencimento: '2026-03-05',
          },
        });
        expect(res.statusCode).toBe(422);
      }
    });
  });

  // ==================================================================
  describe('baixa de pagamento', () => {
    it('o status e o saldo são recalculados pelo banco, não pela aplicação', async () => {
      const t = await tokenDe(ids.emailAdmin);

      const criado = await app.inject({
        method: 'POST',
        url: '/api/finance/lancamentos',
        headers: auth(t),
        payload: {
          direcao: 'RECEIVABLE',
          descricao: 'Avulsa',
          valor: '120,00',
          vencimento: '2026-03-20',
          studentId: ids.aluno1,
        },
      });
      const entryId = (criado.json() as { data: { id: string } }).data.id;

      const pago = await app.inject({
        method: 'POST',
        url: `/api/finance/lancamentos/${entryId}/pagamentos`,
        headers: auth(t),
        payload: { valor: '50,00', metodo: 'PIX' },
      });
      expect(pago.statusCode).toBe(201);

      const parcial = await tx(async (c) => {
        const r = await c.query<{ status: string; paid_cents: string }>(
          'SELECT status::text, paid_cents FROM finance_entries WHERE id=$1',
          [entryId],
        );
        return r.rows[0]!;
      });
      expect(parcial.status).toBe('PARTIALLY_PAID');
      expect(Number(parcial.paid_cents)).toBe(5000);

      // Superpagamento é recusado pelo CHECK do banco.
      const demais = await app.inject({
        method: 'POST',
        url: `/api/finance/lancamentos/${entryId}/pagamentos`,
        headers: auth(t),
        payload: { valor: '100,00', metodo: 'CASH' },
      });
      expect(demais.statusCode).toBe(422);
    });

    it('o profissional pode lançar recebimento, como o enunciado pediu', async () => {
      const tAdmin = await tokenDe(ids.emailAdmin);
      const criado = await app.inject({
        method: 'POST',
        url: '/api/finance/lancamentos',
        headers: auth(tAdmin),
        payload: {
          direcao: 'RECEIVABLE',
          descricao: 'Sessão avulsa',
          valor: '120,00',
          vencimento: '2026-03-25',
          studentId: ids.aluno1,
          professionalId: ids.prof1,
        },
      });
      const entryId = (criado.json() as { data: { id: string } }).data.id;

      const tProf = await tokenDe(ids.emailProf1);
      const pago = await app.inject({
        method: 'POST',
        url: `/api/finance/lancamentos/${entryId}/pagamentos`,
        headers: auth(tProf),
        payload: { valor: '120,00', metodo: 'PIX' },
      });
      // Ele movimenta o recebimento sem enxergar o caixa da empresa.
      expect(pago.statusCode).toBe(201);
    });
  });

  /* ==================================================================
   * Baixa dividida em mais de uma forma
   *
   * Metade no PIX e metade no cartão é rotina de balcão. Até aqui a
   * tela mandava um pagamento por vez, e a pessoa dava duas baixas
   * seguidas — o que funcionava até a segunda falhar e deixar a conta
   * meio paga sem que ninguém soubesse.
   * ================================================================ */
  describe('baixa em várias formas', () => {
    async function umaCobranca(valor: string): Promise<string> {
      const t = await tokenDe(ids.emailAdmin);
      const criado = await app.inject({
        method: 'POST',
        url: '/api/finance/lancamentos',
        headers: auth(t),
        payload: {
          direcao: 'RECEIVABLE',
          descricao: 'Mensalidade dividida',
          valor,
          vencimento: '2026-04-10',
          studentId: ids.aluno1,
        },
      });
      expect(criado.statusCode).toBe(201);
      return (criado.json() as { data: { id: string } }).data.id;
    }

    it('registra as duas formas e quita a conta', async () => {
      const entryId = await umaCobranca('300,00');
      const res = await app.inject({
        method: 'POST',
        url: `/api/finance/lancamentos/${entryId}/pagamentos/lote`,
        headers: auth(await tokenDe(ids.emailAdmin)),
        payload: {
          pagamentos: [
            { valor: '180,00', metodo: 'PIX' },
            { valor: '120,00', metodo: 'CREDIT_CARD' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { data: { ids: string[] } }).data.ids).toHaveLength(2);

      const linha = await tx((c) =>
        c.query<{ status: string; pago: string }>(
          'SELECT status::text, paid_cents::text AS pago FROM finance_entries WHERE id = $1',
          [entryId],
        ),
      );
      expect(linha.rows[0]!.status).toBe('PAID');
      expect(Number(linha.rows[0]!.pago)).toBe(30000);

      /* DOIS PAGAMENTOS, e não um somado. É o que faz o relatório por
         forma de pagamento dizer a verdade: R$ 180 entraram no PIX e
         R$ 120 no cartão, não R$ 300 em algum lugar. */
      const pagamentos = await tx((c) =>
        c.query<{ method: string; amount_cents: string }>(
          'SELECT method::text, amount_cents::text FROM finance_payments WHERE entry_id = $1 ORDER BY amount_cents DESC',
          [entryId],
        ),
      );
      expect(pagamentos.rows.map((r) => r.method)).toEqual(['PIX', 'CREDIT_CARD']);
    });

    it('ou entram todas as formas ou não entra nenhuma', async () => {
      const entryId = await umaCobranca('300,00');
      const res = await app.inject({
        method: 'POST',
        url: `/api/finance/lancamentos/${entryId}/pagamentos/lote`,
        headers: auth(await tokenDe(ids.emailAdmin)),
        payload: {
          pagamentos: [
            { valor: '180,00', metodo: 'PIX' },
            /* Método que não existe: o segundo INSERT falha. */
            { valor: '120,00', metodo: 'BITCOIN' },
          ],
        },
      });
      expect(res.statusCode).toBe(422);

      /* Se a transação não abraçasse o lote, os R$ 180 do PIX teriam
         entrado e a conta ficaria meio paga por causa de um erro de
         digitação na segunda linha. */
      const pagamentos = await tx((c) =>
        c.query('SELECT 1 FROM finance_payments WHERE entry_id = $1', [entryId]),
      );
      expect(pagamentos.rowCount).toBe(0);

      const linha = await tx((c) =>
        c.query<{ status: string }>('SELECT status::text FROM finance_entries WHERE id = $1', [
          entryId,
        ]),
      );
      expect(linha.rows[0]!.status).not.toBe('PAID');
    });

    it('recusa lote vazio e lote grande demais', async () => {
      const entryId = await umaCobranca('300,00');
      const t = auth(await tokenDe(ids.emailAdmin));

      const vazio = await app.inject({
        method: 'POST',
        url: `/api/finance/lancamentos/${entryId}/pagamentos/lote`,
        headers: t,
        payload: { pagamentos: [] },
      });
      expect(vazio.statusCode).toBe(422);

      /* Sete formas de pagamento numa cobrança só não é "dividiu a
         conta", é outra coisa — e merece lançamentos separados. */
      const demais = await app.inject({
        method: 'POST',
        url: `/api/finance/lancamentos/${entryId}/pagamentos/lote`,
        headers: t,
        payload: {
          pagamentos: Array.from({ length: 7 }, () => ({ valor: '10,00', metodo: 'CASH' })),
        },
      });
      expect(demais.statusCode).toBe(422);
    });
  });
});
