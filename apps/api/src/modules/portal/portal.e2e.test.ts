import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Portal do aluno.
 *
 * O ATACANTE AQUI É O PRÓPRIO ALUNO, autenticado, com o aplicativo na
 * mão. É o perfil mais numeroso do sistema e o menos treinado: basta
 * curiosidade e o DevTools aberto.
 *
 * O que estes testes garantem é que não há parâmetro para ele torcer —
 * o id vem do token — e que as regras que a tela aplica (antecedência,
 * preço, janela de cancelamento) valem também para quem chama a rota
 * direto.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';
const ids = {
  tenant: '',
  slug: '',
  prof: '',
  emailProf: '',
  emailAlunoA: '',
  emailAlunoB: '',
  alunoA: '',
  alunoB: '',
};

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
  if (body.accessToken === undefined) throw new Error(`login falhou ${email}: ${res.body}`);
  cache.set(email, body.accessToken);
  return body.accessToken;
}
const como = (t: string) => ({ authorization: `Bearer ${t}` });

/** Amanhã às 10h — bem além da antecedência mínima. */
function amanha(hora: number): { inicio: Date; fim: Date } {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hora, 0, 0, 0);
  return { inicio: d, fim: new Date(d.getTime() + 3_600_000) };
}

suite('Portal do aluno', () => {
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
    ids.slug = `portal-${sufixo}`;
    ids.emailProf = `pt-prof-${sufixo}@portal.test`;
    ids.emailAlunoA = `pt-a-${sufixo}@portal.test`;
    ids.emailAlunoB = `pt-b-${sufixo}@portal.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia Portal',
        ids.slug,
      ]);

      const prof = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Portal','PROFESSIONAL') RETURNING id`,
        [ids.tenant, ids.emailProf, hash],
      );
      ids.prof = prof.rows[0]!.id;

      /* Dois alunos com login. O B existe para provar que o A não o
         alcança de jeito nenhum. */
      for (const [email, nome, alvo] of [
        [ids.emailAlunoA, 'Aluna A', 'alunoA'],
        [ids.emailAlunoB, 'Aluno B', 'alunoB'],
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
        await c.query(
          `INSERT INTO student_professionals (tenant_id,student_id,professional_id)
           VALUES ($1,$2,$3)`,
          [ids.tenant, s.rows[0]!.id, ids.prof],
        );
      }

      // A aluna A é MENSALISTA: não deve ver preço.
      await c.query(
        `INSERT INTO student_contracts
           (tenant_id, student_id, cycle, amount_cents, is_active, starts_on)
         VALUES ($1,$2,'MONTHLY',24990,true,CURRENT_DATE)`,
        [ids.tenant, ids.alunoA],
      );
      // O aluno B paga por sessão.
      await c.query(
        `INSERT INTO student_contracts
           (tenant_id, student_id, cycle, amount_cents, is_active, starts_on)
         VALUES ($1,$2,'SESSION',9000,true,CURRENT_DATE)`,
        [ids.tenant, ids.alunoB],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('o aluno vê o próprio perfil sem informar id nenhum', async () => {
    const token = await tokenDe(ids.emailAlunoA);
    const res = await app.inject({ method: 'GET', url: '/api/eu', headers: como(token) });

    expect(res.statusCode).toBe(200);
    const d = (res.json() as { data: { nome: string; mensalista: boolean } }).data;
    expect(d.nome).toBe('Aluna A');
    expect(d.mensalista).toBe(true);
  });

  it('não existe rota com id de aluno para adulterar', async () => {
    /* A proteção é a AUSÊNCIA do parâmetro. Tentar alcançar o outro
       aluno pela URL não encontra rota nenhuma. */
    const token = await tokenDe(ids.emailAlunoA);
    const res = await app.inject({
      method: 'GET',
      url: `/api/eu/${ids.alunoB}`,
      headers: como(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('o aluno não alcança as rotas administrativas', async () => {
    const token = await tokenDe(ids.emailAlunoA);

    const lista = await app.inject({ method: 'GET', url: '/api/students', headers: como(token) });
    expect(lista.statusCode).toBe(403);

    const outro = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoB}/ficha`,
      headers: como(token),
    });
    expect(outro.statusCode).toBe(403);
  });

  it('o profissional NÃO usa o portal do aluno', async () => {
    /* Ele tem as rotas dele, com id explícito e auditoria. Se /api/eu
       respondesse para ele, seria uma segunda porta sem esse registro. */
    const token = await tokenDe(ids.emailProf);
    const res = await app.inject({ method: 'GET', url: '/api/eu', headers: como(token) });
    expect(res.statusCode).toBe(403);
  });

  it('o mensalista agenda e NÃO vê preço', async () => {
    /* Mostrar "R$ 90" para quem já pagou o mês gera a ligação mais
       constrangedora que uma recepção recebe. */
    const token = await tokenDe(ids.emailAlunoA);
    const { inicio, fim } = amanha(10);

    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/agendamentos',
      headers: como(token),
      payload: {
        profissionalId: ids.prof,
        inicio: inicio.toISOString(),
        fim: fim.toISOString(),
        observacao: 'Chego 5 minutos antes',
      },
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { precoCentavos: number | null } }).data.precoCentavos).toBeNull();
  });

  it('quem paga por sessão VÊ o preço, e ele vem do contrato', async () => {
    const token = await tokenDe(ids.emailAlunoB);
    const { inicio, fim } = amanha(14);

    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/agendamentos',
      headers: como(token),
      payload: { profissionalId: ids.prof, inicio: inicio.toISOString(), fim: fim.toISOString() },
    });

    expect(res.statusCode).toBe(201);
    // 90,00 do contrato — nada no corpo da requisição falou de dinheiro.
    expect((res.json() as { data: { precoCentavos: number } }).data.precoCentavos).toBe(9000);
  });

  it('o aluno não consegue escolher o próprio preço', async () => {
    /* O corpo não tem campo de preço, e mandar um é ignorado: quem
       decide é o contrato. Sem isso, bastaria `precoCentavos: 0`. */
    const token = await tokenDe(ids.emailAlunoB);
    const { inicio, fim } = amanha(16);

    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/agendamentos',
      headers: como(token),
      payload: {
        profissionalId: ids.prof,
        inicio: inicio.toISOString(),
        fim: fim.toISOString(),
        precoCentavos: 0,
        priceCents: 0,
        isIncludedInPlan: true,
      },
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { precoCentavos: number } }).data.precoCentavos).toBe(9000);
  });

  it('dois alunos no MESMO horário: o segundo recebe 409, não um choque de agenda', async () => {
    /* A EXCLUSION CONSTRAINT do banco torna o duplo agendamento
       fisicamente impossível. A corrida é resolvida lá; aqui só se
       traduz a mensagem. */
    const a = await tokenDe(ids.emailAlunoA);
    const b = await tokenDe(ids.emailAlunoB);
    const { inicio, fim } = amanha(19);
    const corpo = {
      profissionalId: ids.prof,
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
    };

    const primeiro = await app.inject({
      method: 'POST',
      url: '/api/eu/agendamentos',
      headers: como(a),
      payload: corpo,
    });
    const segundo = await app.inject({
      method: 'POST',
      url: '/api/eu/agendamentos',
      headers: como(b),
      payload: corpo,
    });

    expect(primeiro.statusCode).toBe(201);
    expect(segundo.statusCode).toBe(409);
    expect((segundo.json() as { error: { message: string } }).error.message).toContain('horário');
  });

  it('marcar para daqui a pouco é recusado', async () => {
    /* A antecedência é do SERVIDOR. Deixar a tela decidir permitiria
       marcar para daqui a dois minutos com uma requisição direta, e o
       profissional descobriria em cima da hora. */
    const token = await tokenDe(ids.emailAlunoA);
    const daquiAPouco = new Date(Date.now() + 10 * 60_000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/agendamentos',
      headers: como(token),
      payload: {
        profissionalId: ids.prof,
        inicio: daquiAPouco.toISOString(),
        fim: new Date(daquiAPouco.getTime() + 3_600_000).toISOString(),
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('a agenda mostra só os compromissos do próprio aluno', async () => {
    const a = await tokenDe(ids.emailAlunoA);
    const res = await app.inject({ method: 'GET', url: '/api/eu/agenda', headers: como(a) });

    expect(res.statusCode).toBe(200);
    const itens = (res.json() as { data: { profissional: string; precoCentavos: number | null }[] })
      .data;
    expect(itens.length).toBeGreaterThan(0);
    // Mensalista: nenhum item com preço.
    expect(itens.every((i) => i.precoCentavos === null)).toBe(true);
  });

  it('o aluno cancela o próprio horário, mas não o de outro', async () => {
    const a = await tokenDe(ids.emailAlunoA);
    const b = await tokenDe(ids.emailAlunoB);

    const agenda = await app.inject({ method: 'GET', url: '/api/eu/agenda', headers: como(a) });
    const meu = (agenda.json() as { data: { id: string; podeCancelar: boolean }[] }).data.find(
      (i) => i.podeCancelar,
    );
    expect(meu).toBeDefined();

    // O aluno B tenta cancelar o horário da aluna A, com o id em mãos.
    const invasao = await app.inject({
      method: 'DELETE',
      url: `/api/eu/agendamentos/${meu!.id}`,
      headers: como(b),
    });
    expect(invasao.statusCode).toBe(404);

    // A dona cancela normalmente.
    const proprio = await app.inject({
      method: 'DELETE',
      url: `/api/eu/agendamentos/${meu!.id}`,
      headers: como(a),
    });
    expect(proprio.statusCode).toBe(200);
  });

  it('em cima da hora, o cancelamento é recusado com instrução', async () => {
    const token = await tokenDe(ids.emailAlunoA);
    const { inicio, fim } = amanha(11);

    const criou = await app.inject({
      method: 'POST',
      url: '/api/eu/agendamentos',
      headers: como(token),
      payload: { profissionalId: ids.prof, inicio: inicio.toISOString(), fim: fim.toISOString() },
    });
    const id = (criou.json() as { data: { id: string } }).data.id;

    // Aproxima o compromisso para dentro da janela.
    await comTenant(ids.tenant, async (c) => {
      await c.query(
        `UPDATE appointments SET period = tstzrange(now() + interval '2 hours',
                                                    now() + interval '3 hours', '[)')
          WHERE id = $1`,
        [id],
      );
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/eu/agendamentos/${id}`,
      headers: como(token),
    });

    expect(res.statusCode).toBe(409);
    /* A mensagem diz o que fazer a seguir. "Não permitido" deixaria a
       pessoa sem saída e a recepção com uma ligação a mais. */
    expect((res.json() as { error: { message: string } }).error.message).toContain('recepção');
  });

  it('o aluno vê o próprio treino vigente', async () => {
    const plano = await comTenant(ids.tenant, async (c) => {
      const e = await c.query<{ id: string }>(
        `INSERT INTO exercises (tenant_id,name,muscle_group) VALUES ($1,'Agachamento Portal','QUADRICEPS')
         RETURNING id`,
        [ids.tenant],
      );
      const w = await c.query<{ id: string }>(
        `INSERT INTO workout_plans (tenant_id, student_id, professional_id, name, status)
         VALUES ($1,$2,$3,'Treino do App','ACTIVE') RETURNING id`,
        [ids.tenant, ids.alunoA, ids.prof],
      );
      await c.query(
        `INSERT INTO workout_items (tenant_id, plan_id, exercise_id, day_label, sets, reps, load_g)
         VALUES ($1,$2,$3,'A',4,'8-12',40000)`,
        [ids.tenant, w.rows[0]!.id, e.rows[0]!.id],
      );
      return w.rows[0]!.id;
    });
    expect(plano).toBeTruthy();

    const token = await tokenDe(ids.emailAlunoA);
    const res = await app.inject({ method: 'GET', url: '/api/eu/treino', headers: como(token) });

    expect(res.statusCode).toBe(200);
    const d = (res.json() as { data: { nome: string; itens: { exercicio: string }[] } }).data;
    expect(d.nome).toBe('Treino do App');
    expect(d.itens[0]?.exercicio).toBe('Agachamento Portal');
  });

  it('o aluno não vê o treino de outro aluno', async () => {
    const b = await tokenDe(ids.emailAlunoB);
    const res = await app.inject({ method: 'GET', url: '/api/eu/treino', headers: como(b) });
    expect(res.statusCode).toBe(200);
    // O B não tem treino; o da A não pode vazar para cá.
    expect((res.json() as { data: unknown }).data).toBeNull();
  });
});
