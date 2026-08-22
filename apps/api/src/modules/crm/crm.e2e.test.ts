import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * CRM.
 *
 * O QUE ESTES TESTES PROTEGEM:
 *
 *   1. A CONVERSÃO É ATÔMICA. Criar o aluno e fechar o lead acontecem na
 *      mesma transação. Se separasse, um aluno já matriculado
 *      continuaria na fila sendo cobrado por telefone.
 *   2. O LEAD CONVERTIDO VIRA HISTÓRIA. Não se edita mais — reescrever
 *      apagaria o registro de como aquele aluno chegou.
 *   3. A TAXA DE CONVERSÃO É SOBRE OS DECIDIDOS. Contar quem ainda está
 *      em conversa como não-convertido faria a taxa piorar sozinha só
 *      porque entraram interessados novos.
 *   4. O ISOLAMENTO. Interessado é dado comercial: quem está negociando
 *      com quem, por quanto, e quem disse não.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';
const a = { tenant: '', slug: '', dono: '', recep: '' };
const b = { tenant: '', slug: '', dono: '' };

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
async function tokenDe(email: string, slug: string): Promise<string> {
  const chave = `${slug}:${email}`;
  const emCache = cache.get(chave);
  if (emCache !== undefined) return emCache;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA, tenantSlug: slug },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) throw new Error(`login falhou: ${res.body}`);
  cache.set(chave, body.accessToken);
  return body.accessToken;
}
const como = (t: string) => ({ authorization: `Bearer ${t}` });

suite('CRM', () => {
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

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    for (const [emp, nome] of [
      [a, 'Academia CRM A'],
      [b, 'Academia CRM B'],
    ] as const) {
      const sufixo = crypto.randomUUID().slice(0, 8);
      emp.tenant = crypto.randomUUID();
      emp.slug = `crm-${sufixo}`;
      emp.dono = `dono-${sufixo}@crm.test`;
      await comTenant(emp.tenant, async (c) => {
        await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
          emp.tenant,
          nome,
          emp.slug,
        ]);
        await c.query(
          `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
           VALUES ($1,$2,$3,'Dono','OWNER')`,
          [emp.tenant, emp.dono, hash],
        );
      });
    }

    /* A recepção precisa alcançar o módulo: é ela quem atende quem
       liga. Se este login falhar, a permissão foi escolhida errada. */
    a.recep = `recep-${crypto.randomUUID().slice(0, 8)}@crm.test`;
    await comTenant(a.tenant, (c) =>
      c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Recepcao','RECEPTION')`,
        [a.tenant, a.recep, hash],
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function criar(
    empresa: typeof a,
    nome: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/crm',
      headers: como(await tokenDe(empresa.dono, empresa.slug)),
      payload: { nome, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { data: { id: string } }).data.id;
  }

  it('cadastra um interessado com o mínimo — só o nome', async () => {
    const id = await criar(a, 'Interessado Minimo');
    const res = await app.inject({
      method: 'GET',
      url: `/api/crm/${id}`,
      headers: como(await tokenDe(a.dono, a.slug)),
    });
    expect(res.statusCode).toBe(200);
    const d = (res.json() as { data: { nome: string; status: string; origem: string } }).data;
    expect(d.nome).toBe('Interessado Minimo');
    expect(d.status).toBe('NOVO');
    expect(d.origem).toBe('OUTRO');
  });

  it('a RECEPÇÃO alcança o módulo — é ela quem atende quem liga', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/crm/fila',
      headers: como(await tokenDe(a.recep, a.slug)),
    });
    expect(res.statusCode).toBe(200);
  });

  it('recusa WhatsApp fora de E.164 com 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/crm',
      headers: como(await tokenDe(a.dono, a.slug)),
      payload: { nome: 'Telefone Torto', whatsapp: '51999998888' },
    });
    expect(res.statusCode).toBe(422);
  });

  /* ================================================================
   * A FILA — a rota que faz o módulo ser usado
   * ============================================================== */

  it('a fila ordena pelo mais atrasado, e quem não tem data vai para o fim', async () => {
    await criar(a, 'Sem data marcada');
    await criar(a, 'Atrasado ha muito', { proximoContato: '2020-01-01' });
    await criar(a, 'Atrasado ha pouco', { proximoContato: '2025-01-01' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/crm/fila',
      headers: como(await tokenDe(a.dono, a.slug)),
    });
    const fila = (res.json() as { data: { nome: string; atrasoDias: number | null }[] }).data;
    const nomes = fila.map((l) => l.nome);

    expect(nomes.indexOf('Atrasado ha muito')).toBeLessThan(nomes.indexOf('Atrasado ha pouco'));
    /* Sem data não é urgente, mas também não pode sumir: é justamente
       o interessado que se perde. */
    expect(nomes).toContain('Sem data marcada');
    expect(nomes.indexOf('Sem data marcada')).toBeGreaterThan(nomes.indexOf('Atrasado ha pouco'));

    const atrasado = fila.find((l) => l.nome === 'Atrasado ha muito');
    expect(atrasado?.atrasoDias).toBeGreaterThan(300);
  });

  it('registrar um contato marca o próximo na MESMA ação', async () => {
    const id = await criar(a, 'Conversa Registrada');
    const res = await app.inject({
      method: 'POST',
      url: `/api/crm/${id}/contato`,
      headers: como(await tokenDe(a.dono, a.slug)),
      payload: {
        texto: 'Ligou perguntando valor do mensal. Vai pensar.',
        proximoContato: '2026-12-01',
        status: 'CONTATADO',
      },
    });
    expect(res.statusCode).toBe(201);

    const lido = await app.inject({
      method: 'GET',
      url: `/api/crm/${id}`,
      headers: como(await tokenDe(a.dono, a.slug)),
    });
    const d = (
      lido.json() as {
        data: { status: string; proximoContato: string; historico: { texto: string }[] };
      }
    ).data;
    expect(d.status).toBe('CONTATADO');
    expect(d.proximoContato).toBe('2026-12-01');
    expect(d.historico[0]?.texto).toContain('valor do mensal');
  });

  /* ================================================================
   * A CONVERSÃO
   * ============================================================== */

  it('converter cria o aluno e fecha o lead na mesma ação', async () => {
    const id = await criar(a, 'Vai Matricular', { whatsapp: '+5551988887777' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/crm/${id}/converter`,
      headers: como(await tokenDe(a.dono, a.slug)),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const alunoId = (res.json() as { data: { alunoId: string } }).data.alunoId;

    /* O aluno existe, com os dados que vieram do lead. */
    const aluno = await comTenant(a.tenant, (c) =>
      c.query<{ full_name: string; whatsapp: string | null }>(
        'SELECT full_name, whatsapp FROM students WHERE id = $1',
        [alunoId],
      ),
    );
    expect(aluno.rows[0]?.full_name).toBe('Vai Matricular');
    expect(aluno.rows[0]?.whatsapp).toBe('+5551988887777');

    /* E saiu da fila — senão continuaria sendo cobrado por telefone
       por alguém que já é cliente. */
    const fila = await app.inject({
      method: 'GET',
      url: '/api/crm/fila',
      headers: como(await tokenDe(a.dono, a.slug)),
    });
    const nomes = (fila.json() as { data: { nome: string }[] }).data.map((l) => l.nome);
    expect(nomes).not.toContain('Vai Matricular');
  });

  it('lead já convertido não é editado nem convertido de novo', async () => {
    const id = await criar(a, 'Converte Uma Vez');
    await app.inject({
      method: 'POST',
      url: `/api/crm/${id}/converter`,
      headers: como(await tokenDe(a.dono, a.slug)),
      payload: {},
    });

    const editar = await app.inject({
      method: 'PUT',
      url: `/api/crm/${id}`,
      headers: como(await tokenDe(a.dono, a.slug)),
      payload: { nome: 'Nome Trocado' },
    });
    expect(editar.statusCode).toBe(409);

    const denovo = await app.inject({
      method: 'POST',
      url: `/api/crm/${id}/converter`,
      headers: como(await tokenDe(a.dono, a.slug)),
      payload: {},
    });
    expect(denovo.statusCode).toBe(409);
  });

  it('perdido precisa ser reaberto antes de converter', async () => {
    const id = await criar(a, 'Disse Que Nao', { status: 'PERDIDO' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/crm/${id}/converter`,
      headers: como(await tokenDe(a.dono, a.slug)),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('perdido');
  });

  /* ================================================================
   * O funil e o isolamento
   * ============================================================== */

  it('a conversão é sobre os DECIDIDOS, não sobre o total', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/crm/funil',
      headers: como(await tokenDe(a.dono, a.slug)),
    });
    expect(res.statusCode).toBe(200);
    const d = (
      res.json() as {
        data: { total: number; decididos: number; conversao: number | null };
      }
    ).data;

    /* Há mais leads que decididos — vários seguem em conversa. Se a
       taxa fosse sobre o total, ela seria menor que a real. */
    expect(d.total).toBeGreaterThan(d.decididos);
    expect(d.conversao).not.toBeNull();
  });

  it('a academia B não enxerga interessado da academia A', async () => {
    const idDeA = await criar(a, 'Segredo Comercial de A');

    const lista = await app.inject({
      method: 'GET',
      url: '/api/crm',
      headers: como(await tokenDe(b.dono, b.slug)),
    });
    const nomes = (lista.json() as { data: { nome: string }[] }).data.map((l) => l.nome);
    expect(nomes).not.toContain('Segredo Comercial de A');

    /* E nem trocando o id na URL. */
    const direto = await app.inject({
      method: 'GET',
      url: `/api/crm/${idDeA}`,
      headers: como(await tokenDe(b.dono, b.slug)),
    });
    expect(direto.statusCode).toBe(404);
  });
});
