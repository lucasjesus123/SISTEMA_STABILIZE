import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * A tabela de valores.
 *
 * O QUE ESTES TESTES PROTEGEM não é o CRUD — é a regra que faz a tabela
 * valer a pena sem reescrever história: desativar um plano NÃO cancela
 * nem altera os contratos que já o usavam. Se isso quebrar, um reajuste
 * de tabela vira mudança retroativa de mensalidade, e ninguém percebe
 * até o aluno reclamar da cobrança.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';
const ids = { tenant: '', slug: '', dono: '', prof: '', aluno: '' };

async function comTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);
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

const cache = new Map<string, string>();
async function tokenDe(email: string): Promise<string> {
  const emCache = cache.get(email);
  if (emCache !== undefined) return emCache;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA, tenantSlug: ids.slug },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) throw new Error(`login falhou: ${res.body}`);
  cache.set(email, body.accessToken);
  return body.accessToken;
}
const como = (t: string) => ({ authorization: `Bearer ${t}` });

suite('Tabela de valores', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'zK3-acesso-somente-para-teste-com-tamanho-suficiente-01';
    process.env['JWT_REFRESH_SECRET'] = 'qP9-refresh-somente-para-teste-com-tamanho-suficiente-02';
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
    ids.slug = `pln-${sufixo}`;
    ids.dono = `dono-${sufixo}@pln.test`;
    ids.prof = `prof-${sufixo}@pln.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia Planos',
        ids.slug,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono','OWNER')`,
        [ids.tenant, ids.dono, hash],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof','PROFESSIONAL')`,
        [ids.tenant, ids.prof, hash],
      );
      const s = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name) VALUES ($1,'Aluno Plano') RETURNING id`,
        [ids.tenant],
      );
      ids.aluno = s.rows[0]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function criar(nome: string, valor: number, ciclo = 'MONTHLY'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/planos',
      headers: como(await tokenDe(ids.dono)),
      payload: { nome, ciclo, valorCentavos: valor },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { data: { id: string } }).data.id;
  }

  it('cria um plano e devolve na lista', async () => {
    await criar('Mensal', 39_000);
    const res = await app.inject({
      method: 'GET',
      url: '/api/planos',
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(200);
    const lista = (res.json() as { data: { nome: string; valorCentavos: number }[] }).data;
    expect(lista.find((p) => p.nome === 'Mensal')?.valorCentavos).toBe(39_000);
  });

  it('recusa dois planos com o mesmo nome', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/planos',
      headers: como(await tokenDe(ids.dono)),
      payload: { nome: 'Mensal', ciclo: 'MONTHLY', valorCentavos: 42_000 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('aceita os sete ciclos do sistema', async () => {
    for (const ciclo of ['SESSION', 'WEEKLY', 'BIWEEKLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']) {
      await criar(`Plano ${ciclo}`, 10_000, ciclo);
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/planos',
      headers: como(await tokenDe(ids.dono)),
    });
    expect((res.json() as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(7);
  });

  it('recusa valor negativo com 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/planos',
      headers: como(await tokenDe(ids.dono)),
      payload: { nome: 'Negativo', ciclo: 'MONTHLY', valorCentavos: -1 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('o profissional não escreve na tabela de valores', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/planos',
      headers: como(await tokenDe(ids.prof)),
      payload: { nome: 'Do prof', ciclo: 'MONTHLY', valorCentavos: 1000 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('id de outra empresa responde 404, não 403 nem sucesso', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/planos/${crypto.randomUUID()}`,
      headers: como(await tokenDe(ids.dono)),
      payload: { nome: 'Qualquer', ciclo: 'MONTHLY', valorCentavos: 1000 },
    });
    expect(res.statusCode).toBe(404);
  });

  /* ================================================================
   * A REGRA QUE IMPORTA
   * ============================================================== */

  it('desativar um plano NÃO altera nem cancela os contratos que o usavam', async () => {
    const planoId = await criar('Trimestral com contrato', 99_000, 'QUARTERLY');

    await comTenant(ids.tenant, (c) =>
      c.query(
        `INSERT INTO student_contracts
           (tenant_id, student_id, price_plan_id, cycle, amount_cents, starts_on, is_active)
         VALUES ($1,$2,$3,'QUARTERLY',99000, CURRENT_DATE, true)`,
        [ids.tenant, ids.aluno, planoId],
      ),
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/planos/${planoId}`,
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(200);
    const r = (res.json() as { data: { desativado: boolean; contratosMantidos: number } }).data;
    expect(r.desativado).toBe(true);
    /* Avisa quantos contratos seguem cobrando — o que evita achar que
       desativar cancelou mensalidade de alguém. */
    expect(r.contratosMantidos).toBe(1);

    const contrato = await comTenant(ids.tenant, (c) =>
      c.query<{ amount_cents: string; is_active: boolean; price_plan_id: string | null }>(
        'SELECT amount_cents::text, is_active, price_plan_id FROM student_contracts WHERE student_id = $1',
        [ids.aluno],
      ),
    );
    const linha = contrato.rows[0]!;
    expect(linha.is_active).toBe(true);
    expect(Number(linha.amount_cents)).toBe(99_000);
    /* Continua apontando para o plano: a academia precisa poder
       responder "de qual tabela veio este valor?" mesmo depois de o
       plano sair da lista de escolha. */
    expect(linha.price_plan_id).toBe(planoId);
  });

  it('plano desativado some da lista, mas volta com incluirInativos', async () => {
    const semInativos = await app.inject({
      method: 'GET',
      url: '/api/planos',
      headers: como(await tokenDe(ids.dono)),
    });
    const nomes = (semInativos.json() as { data: { nome: string }[] }).data.map((p) => p.nome);
    expect(nomes).not.toContain('Trimestral com contrato');

    const comInativos = await app.inject({
      method: 'GET',
      url: '/api/planos?incluirInativos=true',
      headers: como(await tokenDe(ids.dono)),
    });
    const todos = (comInativos.json() as { data: { nome: string }[] }).data.map((p) => p.nome);
    expect(todos).toContain('Trimestral com contrato');
  });
});
