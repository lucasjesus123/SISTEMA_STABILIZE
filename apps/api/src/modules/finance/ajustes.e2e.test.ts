/**
 * Juros, multa, desconto e parcelamento.
 *
 * O QUE ESTE ARQUIVO PRECISA PROVAR — as duas contas que a migração 036
 * separou, e que se erradas erram em cima de dinheiro sem ninguém ver:
 *
 *   CAIXA   = amount_cents               (o que entrou de verdade)
 *   ABATIDO = amount - acrescimo + desconto
 *
 * Se as duas fossem o mesmo número, uma delas mentiria: com juros a
 * conta ficaria com saldo negativo; com desconto ela ficaria
 * eternamente PARTIALLY_PAID e o aluno seria cobrado de novo por
 * dinheiro que a academia perdoou.
 *
 * E a comissão NÃO incide sobre a multa — multa é indenização da
 * academia pelo atraso, não pagamento do atendimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;
let token = '';

const SENHA = 'senha-de-teste-longa-2026';
const ids = { tenant: '', email: '', aluno: '', prof: '', contrato: '' };

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1,$2,true)', ['app.tenant_id', ids.tenant]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const auth = () => ({ authorization: `Bearer ${token}` });

/** Cria uma cobrança e devolve o id. */
async function cobranca(valor: number, vencimento: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/finance/lancamentos',
    headers: auth(),
    payload: {
      direcao: 'RECEIVABLE',
      descricao: 'Mensalidade',
      valor,
      vencimento,
      studentId: ids.aluno,
      professionalId: ids.prof,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { data: { id: string } }).data.id;
}

async function estadoDa(id: string): Promise<{ status: string; paid: number }> {
  const { rows } = await tx((c) =>
    c.query<{ status: string; paid_cents: string }>(
      'SELECT status::text, paid_cents::text FROM finance_entries WHERE id = $1',
      [id],
    ),
  );
  return { status: rows[0]!.status, paid: Number(rows[0]!.paid_cents) };
}

suite('juros, desconto e parcelamento', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'ajustes-acesso-somente-teste-com-tamanho-ok-1';
    process.env['JWT_REFRESH_SECRET'] = 'ajustes-refresh-somente-teste-com-tamanho-ok-2';
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
    ids.email = `aj-${sufixo}@t.test`;
    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await tx(async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Ajustes Test',
        `aj-${sufixo}`,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono','OWNER')`,
        [ids.tenant, ids.email, hash],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof','PROFESSIONAL') RETURNING id`,
        [ids.tenant, `aj-prof-${sufixo}@t.test`, hash],
      );
      ids.prof = p.rows[0]!.id;
      const a = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno') RETURNING id`,
        [ids.tenant],
      );
      ids.aluno = a.rows[0]!.id;
      const k = await c.query<{ id: string }>(
        `INSERT INTO student_contracts
           (tenant_id, student_id, professional_id, cycle, amount_cents, commission_bp, starts_on)
         VALUES ($1,$2,$3,'MONTHLY',10000,5000,'2026-01-01') RETURNING id`,
        [ids.tenant, ids.aluno, ids.prof],
      );
      ids.contrato = k.rows[0]!.id;
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ids.email, password: SENHA },
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
   * JUROS E MULTA
   * ============================================================== */

  it('conta de 100 paga com 5 de multa fica QUITADA, sem sobra', async () => {
    const id = await cobranca(100, '2026-07-10');
    const r = await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 105, metodo: 'PIX', acrescimo: 5 },
    });
    expect(r.statusCode, r.body).toBe(201);

    const e = await estadoDa(id);
    /* 105 que entraram, menos 5 de multa = 100 de dívida abatida.
       Sem a migração 036 isto seria 105 e estouraria o CHECK
       `entry_not_overpaid`. */
    expect(e.paid).toBe(10000);
    expect(e.status).toBe('PAID');
  });

  it('o caixa registra os 105 que entraram de verdade', async () => {
    const id = await cobranca(100, '2026-07-11');
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 105, metodo: 'PIX', acrescimo: 5 },
    });
    const { rows } = await tx((c) =>
      c.query<{ amount_cents: string; acrescimo_cents: string }>(
        'SELECT amount_cents::text, acrescimo_cents::text FROM finance_payments WHERE entry_id=$1',
        [id],
      ),
    );
    /* A DÍVIDA ABATIDA É 100, MAS O CAIXA É 105. É a separação inteira
       do desenho: um número só faria uma das duas mentir. */
    expect(Number(rows[0]!.amount_cents)).toBe(10500);
    expect(Number(rows[0]!.acrescimo_cents)).toBe(500);
  });

  it('a multa não pode ser maior que o dinheiro que entrou', async () => {
    const id = await cobranca(100, '2026-07-12');
    const r = await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 50, metodo: 'PIX', acrescimo: 90 },
    });
    /* Dívida abatida seria negativa: a conta ficaria MAIS devedora
       depois de receber dinheiro. */
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  /* ================================================================
   * DESCONTO
   * ============================================================== */

  it('conta de 100 paga com 90 e 10 de desconto fica QUITADA', async () => {
    const id = await cobranca(100, '2026-08-10');
    const r = await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 90, metodo: 'CASH', desconto: 10 },
    });
    expect(r.statusCode, r.body).toBe(201);

    const e = await estadoDa(id);
    /* SEM ISTO O ALUNO SERIA COBRADO DE NOVO. Somando só o dinheiro,
       90 < 100, a conta ficaria PARTIALLY_PAID para sempre e apareceria
       na lista de inadimplentes com R$ 10 que a academia perdoou. */
    expect(e.paid).toBe(10000);
    expect(e.status).toBe('PAID');
  });

  it('o caixa registra os 90 — o desconto não vira receita', async () => {
    const id = await cobranca(100, '2026-08-11');
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 90, metodo: 'CASH', desconto: 10 },
    });
    const { rows } = await tx((c) =>
      c.query<{ amount_cents: string; desconto_cents: string }>(
        'SELECT amount_cents::text, desconto_cents::text FROM finance_payments WHERE entry_id=$1',
        [id],
      ),
    );
    expect(Number(rows[0]!.amount_cents)).toBe(9000);
    expect(Number(rows[0]!.desconto_cents)).toBe(1000);
  });

  /* ================================================================
   * COMISSÃO
   * ============================================================== */

  it('a comissão do professor NÃO incide sobre a multa', async () => {
    /* Contrato de 50% (5000 bp). Mensalidade de 100 paga com 20 de
       multa: o professor recebe metade de 100, e não metade de 120.
       A multa é indenização da academia pelo atraso — ele não atendeu
       mais por causa dela. */
    const mes = '2026-09';
    const id = await cobranca(100, `${mes}-05`);
    await tx((c) =>
      c.query('UPDATE finance_entries SET contract_id = $2 WHERE id = $1', [id, ids.contrato]),
    );
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 120, metodo: 'PIX', acrescimo: 20, pagoEm: `${mes}-20` },
    });

    const r = await app.inject({
      method: 'GET',
      url: `/api/finance/comissoes/${ids.prof}?mes=${mes}-01`,
      headers: auth(),
    });
    expect(r.statusCode, r.body).toBe(200);
    const dados = r.json() as { data: { baseTotalCentavos: number; totalCentavos: number } };
    expect(dados.data.baseTotalCentavos).toBe(10000);
    expect(dados.data.totalCentavos).toBe(5000);
  });

  /* ================================================================
   * PARCELAMENTO
   * ============================================================== */

  it('100 em 3 vezes soma exatamente 100 — a sobra vai na primeira', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/finance/lancamentos',
      headers: auth(),
      payload: {
        direcao: 'PAYABLE',
        descricao: 'Halteres',
        valor: 100,
        vencimento: '2026-10-10',
        parcelas: 3,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const { ids: criados } = (r.json() as { data: { ids: string[] } }).data;
    expect(criados).toHaveLength(3);

    const { rows } = await tx((c) =>
      c.query<{ amount_cents: string; installment_no: number; due_date: string }>(
        `SELECT amount_cents::text, installment_no, due_date::text
           FROM finance_entries WHERE id = ANY($1) ORDER BY installment_no`,
        [criados],
      ),
    );

    /* 33,33 x 3 = 99,99: um centavo sumiria. A sobra vai na PRIMEIRA,
       que é a que a pessoa confere na hora de lançar. */
    expect(rows.map((x) => Number(x.amount_cents))).toEqual([3334, 3333, 3333]);
    expect(rows.reduce((a, x) => a + Number(x.amount_cents), 0)).toBe(10000);

    // Uma por mês, a partir da data escolhida.
    expect(rows.map((x) => x.due_date)).toEqual(['2026-10-10', '2026-11-10', '2026-12-10']);
    expect(rows.map((x) => x.installment_no)).toEqual([1, 2, 3]);
  });

  it('à vista continua criando um lançamento só, sem marca de parcela', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/finance/lancamentos',
      headers: auth(),
      payload: {
        direcao: 'PAYABLE',
        descricao: 'Papel',
        valor: 30,
        vencimento: '2026-10-15',
      },
    });
    expect(r.statusCode).toBe(201);
    const { ids: criados } = (r.json() as { data: { ids: string[] } }).data;
    expect(criados).toHaveLength(1);

    const { rows } = await tx((c) =>
      c.query<{ installment_no: number | null }>(
        'SELECT installment_no FROM finance_entries WHERE id = $1',
        [criados[0]],
      ),
    );
    /* NULL, e não 1/1: "1 de 1" na tela seria ruído em toda conta
       comum da academia. */
    expect(rows[0]!.installment_no).toBeNull();
  });

  it('recusa parcelamento fora dos limites', async () => {
    for (const parcelas of [0, 61]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/finance/lancamentos',
        headers: auth(),
        payload: {
          direcao: 'PAYABLE',
          descricao: 'X',
          valor: 10,
          vencimento: '2026-10-10',
          parcelas,
        },
      });
      expect(r.statusCode, `parcelas=${parcelas}`).toBe(422);
    }
  });
});
