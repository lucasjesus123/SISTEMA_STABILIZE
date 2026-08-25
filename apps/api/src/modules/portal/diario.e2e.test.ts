import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * O diário de treino do aluno — a tabela que existia e ninguém escrevia.
 *
 * O QUE ESTES TESTES GUARDAM:
 *
 *   1. DOIS TOQUES NÃO VIRAM DOIS TREINOS. O botão fica num celular, com
 *      conexão ruim, e o toque duplo é a regra. Sem o índice único a
 *      contagem de frequência do aluno fica errada para sempre — e o
 *      erro é invisível, porque ninguém confere o histórico do mês
 *      passado.
 *
 *   2. NÃO SE REGISTRA TREINO NO FUTURO nem no mês passado. Um diário
 *      que aceita qualquer data não é diário, é lista de intenções.
 *
 *   3. O ALUNO SÓ APAGA O PRÓPRIO REGISTRO. A RLS separa academias e não
 *      separa alunos da mesma academia — quem confia só nela deixa um
 *      aluno apagar o histórico do colega trocando o uuid.
 *
 *   4. A MESMA DATA COM LETRAS DIFERENTES É PERMITIDA: quem faz A de
 *      manhã e B à noite fez dois treinos, e isso é verdade.
 *
 * Requer TEST_DATABASE_URL num papel SEM BYPASSRLS.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';

const ids = {
  sufixo: '',
  tenant: '',
  slug: '',
  emailDono: '',
  emailA: '',
  emailB: '',
  alunoA: '',
  alunoB: '',
};

async function comTenant<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

const cache = new Map<string, string>();
async function tokenDe(email: string): Promise<string> {
  const guardado = cache.get(email);
  if (guardado !== undefined) return guardado;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA, tenantSlug: ids.slug },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) {
    throw new Error(`login falhou para ${email}: ${res.statusCode} ${res.body}`);
  }
  cache.set(email, body.accessToken);
  return body.accessToken;
}

const como = (t: string) => ({ authorization: `Bearer ${t}` });

/**
 * O dia PELO RELÓGIO DA ACADEMIA, não pelo do servidor.
 *
 * O sistema resolve "hoje" como (now() AT TIME ZONE fuso_da_academia)::date,
 * porque quem marca treino é o aluno, na cidade dele. Um teste que monta a
 * data com new Date().toISOString() está usando UTC: das 21h à meia-noite no
 * Brasil os dois discordam de um dia, e o "ontem" do teste vira o "hoje" da
 * academia — colidindo com o registro que outro teste já criou e devolvendo
 * 409. O teste passava de dia e quebrava de noite, acusando o sistema de um
 * erro que era só dele.
 */
async function diaDaAcademia(deslocamento = 0): Promise<string> {
  return comTenant(async (c) => {
    const r = await c.query<{ dia: string }>(
      `SELECT to_char((now() AT TIME ZONE t.timezone)::date + $2::int, 'YYYY-MM-DD') AS dia
         FROM tenants t WHERE t.id = $1`,
      [ids.tenant, deslocamento],
    );
    return r.rows[0]!.dia;
  });
}

async function marcar(
  email: string,
  corpo: Record<string, unknown>,
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: '/api/eu/treino/feito',
    headers: como(await tokenDe(email)),
    payload: corpo,
  });
}

interface Diario {
  registros: { id: string; dia: string; quando: string; esforco: number | null }[];
  feitosHoje: string[];
  total: number;
  noMes: number;
  sequenciaDeSemanas: number;
}

async function diario(email: string): Promise<Diario> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/eu/treino/diario',
    headers: como(await tokenDe(email)),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: Diario }).data;
}

suite('Diário de treino do aluno', () => {
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

    ids.sufixo = crypto.randomUUID().slice(0, 8);
    ids.tenant = crypto.randomUUID();
    ids.slug = `diario-${ids.sufixo}`;
    ids.emailDono = `dono-${ids.sufixo}@diario.test`;
    ids.emailA = `a-${ids.sufixo}@diario.test`;
    ids.emailB = `b-${ids.sufixo}@diario.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id,name,slug,timezone)
         VALUES ($1,'Academia do Diário',$2,'America/Sao_Paulo')`,
        [ids.tenant, ids.slug],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono','OWNER')`,
        [ids.tenant, ids.emailDono, hash],
      );

      for (const [email, nome, alvo] of [
        [ids.emailA, 'Aluno A', 'alunoA'],
        [ids.emailB, 'Aluno B', 'alunoB'],
      ] as const) {
        const u = await c.query<{ id: string }>(
          `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
           VALUES ($1,$2,$3,$4,'STUDENT') RETURNING id`,
          [ids.tenant, email, hash, nome],
        );
        const s = await c.query<{ id: string }>(
          `INSERT INTO students (tenant_id, full_name, user_id) VALUES ($1,$2,$3) RETURNING id`,
          [ids.tenant, nome, u.rows[0]!.id],
        );
        ids[alvo] = s.rows[0]!.id;
      }
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ================================================================== */

  it('marca o treino de hoje e ele aparece no diário', async () => {
    const res = await marcar(ids.emailA, { dia: 'A', esforco: 4 });
    expect(res.statusCode).toBe(201);

    const d = await diario(ids.emailA);
    expect(d.feitosHoje).toEqual(['A']);
    expect(d.total).toBe(1);
    expect(d.registros[0]!.esforco).toBe(4);
  });

  it('marcar duas vezes o mesmo treino no mesmo dia é recusado com 409', async () => {
    const res = await marcar(ids.emailA, { dia: 'A' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('já marcou');

    /* O que este teste realmente protege: a contagem. Um duplo toque que
       passasse deixaria o histórico do aluno errado para sempre, e
       ninguém confere o mês passado. */
    expect((await diario(ids.emailA)).total).toBe(1);
  });

  it('o mesmo dia com outra letra é permitido — quem faz A e B fez dois', async () => {
    const res = await marcar(ids.emailA, { dia: 'B', esforco: 5 });
    expect(res.statusCode).toBe(201);

    const d = await diario(ids.emailA);
    expect(d.feitosHoje.sort()).toEqual(['A', 'B']);
    expect(d.total).toBe(2);
  });

  it('data no futuro é puxada para hoje, e não aceita', async () => {
    const daquiUmMes = new Date();
    daquiUmMes.setDate(daquiUmMes.getDate() + 30);
    const iso = daquiUmMes.toISOString().slice(0, 10);

    const res = await marcar(ids.emailB, { dia: 'C', quando: iso });
    expect(res.statusCode).toBe(201);

    /* Preencher o mês inteiro na segunda-feira não é registrar, é
       declarar intenção — e o histórico deixaria de significar o que
       diz significar. */
    const gravado = (res.json() as { data: { quando: string } }).data.quando;
    expect(gravado).not.toBe(iso);
    expect(new Date(gravado).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('data antiga demais é puxada para ontem', async () => {
    const res = await marcar(ids.emailB, { dia: 'D', quando: '2020-01-01' });
    expect(res.statusCode).toBe(201);
    const gravado = (res.json() as { data: { quando: string } }).data.quando;
    expect(gravado.startsWith('2020')).toBe(false);
  });

  it('ontem é aceito — quem esqueceu de marcar na terça marca na quarta', async () => {
    const iso = await diaDaAcademia(-1);

    const res = await marcar(ids.emailA, { dia: 'A', quando: iso });
    expect(res.statusCode).toBe(201);

    const d = await diario(ids.emailA);
    /* Dois "A": um de hoje, um de ontem. O índice único inclui a data,
       então isto não colide com o primeiro teste. */
    expect(d.registros.filter((r) => r.dia === 'A')).toHaveLength(2);
  });

  it('esforço fora de 1 a 5 é recusado', async () => {
    /* A ESCALA É 1 A 5, e está no schema original desde o começo. Uma
       primeira versão desta migração acrescentou um segundo CHECK de 1 a
       10 por cima; os dois conviveram e o mais restrito venceu, fazendo
       toda marcação com esforço 6 ser recusada com a mensagem genérica
       "os dados não atendem às regras do sistema". Este teste existe
       para que a escala do código e a do banco não voltem a divergir. */
    expect((await marcar(ids.emailB, { dia: 'E', esforco: 8 })).statusCode).toBe(422);
    expect((await marcar(ids.emailB, { dia: 'E', esforco: 0 })).statusCode).toBe(422);
    expect((await marcar(ids.emailB, { dia: 'E', esforco: 5 })).statusCode).toBe(201);
  });

  it('o aluno desmarca o próprio registro', async () => {
    const antes = await diario(ids.emailB);
    const alvo = antes.registros[0]!;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/eu/treino/feito/${alvo.id}`,
      headers: como(await tokenDe(ids.emailB)),
    });
    expect(res.statusCode).toBe(200);

    const depois = await diario(ids.emailB);
    expect(depois.registros.some((r) => r.id === alvo.id)).toBe(false);
  });

  it('um aluno NÃO apaga o registro de outro da mesma academia', async () => {
    const doA = (await diario(ids.emailA)).registros[0]!;

    /* A RLS separa academias; ela NÃO separa alunos da mesma academia.
       Sem o `student_id` no WHERE do DELETE, este teste passaria a
       apagar o histórico do colega. */
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/eu/treino/feito/${doA.id}`,
      headers: como(await tokenDe(ids.emailB)),
    });
    expect(res.statusCode).toBe(404);

    expect((await diario(ids.emailA)).registros.some((r) => r.id === doA.id)).toBe(true);
  });

  it('o dono não consegue marcar treino no lugar do aluno', async () => {
    /* O diário é do aluno. Quem da academia precisar corrigir alguma
       coisa faz pela evolução, que é registro assinado por quem atendeu. */
    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/treino/feito',
      headers: como(await tokenDe(ids.emailDono)),
      payload: { dia: 'A' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  /* ==================================================================
   * O lado do professor
   * ================================================================ */

  it('o professor vê o que o aluno marcou, com esforço e média', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoA}/treino-feito`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(res.statusCode).toBe(200);

    const d = (res.json() as {
      data: { registros: unknown[]; ultimos7: number; esforcoMedio: number | null };
    }).data;
    expect(d.registros.length).toBeGreaterThanOrEqual(3);
    expect(d.ultimos7).toBeGreaterThanOrEqual(3);
    /* Três treinos seguidos com esforço alto num programa de adaptação
       significam que a carga passou do ponto — e isso não aparece em
       nenhum outro lugar do sistema. */
    expect(d.esforcoMedio).not.toBeNull();
  });

  it('o diário de aluno de outra academia não é alcançável', async () => {
    const outra = crypto.randomUUID();
    const alunoDeFora = await (async (): Promise<string> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', outra]);
        await client.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
          outra,
          'Vizinha',
          `viz-diario-${ids.sufixo}`,
        ]);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO students (tenant_id,full_name) VALUES ($1,'De Fora') RETURNING id`,
          [outra],
        );
        await client.query('COMMIT');
        return rows[0]!.id;
      } finally {
        client.release();
      }
    })();

    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${alunoDeFora}/treino-feito`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(res.statusCode).toBe(404);
  });

  /* ==================================================================
   * A tela inicial do aplicativo
   * ================================================================ */

  it('a tela inicial passa a contar entradas na recepção e treinos marcados', async () => {
    /* Até aqui a frequência contava só sessões agendadas — e quem faz
       musculação não tem nenhuma. O app dizia "0 presenças" para quem
       treinava toda semana. */
    await comTenant((c) =>
      c.query(
        `INSERT INTO checkins (tenant_id, student_id, situacao) VALUES ($1,$2,'EM_DIA')`,
        [ids.tenant, ids.alunoA],
      ),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/eu',
      headers: como(await tokenDe(ids.emailA)),
    });
    expect(res.statusCode).toBe(200);

    const d = (res.json() as {
      data: {
        frequencia: { entradas: number; treinosFeitos: number };
        devendoCentavos: number;
      };
    }).data;
    expect(d.frequencia.entradas).toBe(1);
    expect(d.frequencia.treinosFeitos).toBeGreaterThanOrEqual(2);
    expect(d.devendoCentavos).toBe(0);
  });

  it('o aluno vê o que deve — e vê só o que já venceu', async () => {
    await comTenant((c) =>
      c.query(
        `INSERT INTO finance_entries
           (tenant_id,direction,description,amount_cents,due_date,student_id)
         VALUES ($1,'RECEIVABLE','Vencida',12000,current_date - 5,$2),
                ($1,'RECEIVABLE','A vencer',30000,current_date + 5,$2)`,
        [ids.tenant, ids.alunoA],
      ),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/eu',
      headers: como(await tokenDe(ids.emailA)),
    });
    /* A mensalidade que vence dia 10 não é dívida no dia 3 — mostrá-la
       como dívida faria o aluno achar que está inadimplente e ligar para
       a recepção perguntando por quê. */
    expect((res.json() as { data: { devendoCentavos: number } }).data.devendoCentavos).toBe(12000);
  });
});
