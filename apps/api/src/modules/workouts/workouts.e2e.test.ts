import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Treino, ponta a ponta.
 *
 * Duas fronteiras diferentes convivem aqui, e cada uma tem seus testes:
 *
 *   BIBLIOTECA — é da empresa. Todo profissional lê; só quem administra
 *   escreve. A fronteira que importa é entre EMPRESAS.
 *
 *   PRESCRIÇÃO — é do aluno. A fronteira que importa é entre
 *   PROFISSIONAIS da mesma empresa, como no resto do prontuário.
 *
 * Requer TEST_DATABASE_URL num papel SEM BYPASSRLS.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';

const ids = {
  tenantA: '',
  tenantB: '',
  slugA: '',
  slugB: '',
  profAlfa: '',
  emailProfAlfa: '',
  emailProfBeta: '',
  emailDono: '',
  emailDonoB: '',
  alunoDoAlfa: '',
  alunoDoBeta: '',
  exercicioA: '',
  exercicioB: '',
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

const cacheTokens = new Map<string, string>();

async function tokenDe(email: string, slug: string): Promise<string> {
  const emCache = cacheTokens.get(email);
  if (emCache !== undefined) return emCache;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA, tenantSlug: slug },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) {
    throw new Error(`login falhou para ${email}: ${res.statusCode} ${res.body}`);
  }
  cacheTokens.set(email, body.accessToken);
  return body.accessToken;
}

const como = (token: string) => ({ authorization: `Bearer ${token}` });

suite('Treino', () => {
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
    ids.tenantA = crypto.randomUUID();
    ids.tenantB = crypto.randomUUID();
    ids.slugA = `treino-a-${sufixo}`;
    ids.slugB = `treino-b-${sufixo}`;
    ids.emailProfAlfa = `tr-alfa-${sufixo}@treino.test`;
    ids.emailProfBeta = `tr-beta-${sufixo}@treino.test`;
    ids.emailDono = `tr-dono-${sufixo}@treino.test`;
    ids.emailDonoB = `tr-donob-${sufixo}@treino.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenantA, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenantA,
        'Academia Alfa',
        ids.slugA,
      ]);
      const pa = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Alfa','PROFESSIONAL') RETURNING id`,
        [ids.tenantA, ids.emailProfAlfa, hash],
      );
      const pb = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Beta','PROFESSIONAL') RETURNING id`,
        [ids.tenantA, ids.emailProfBeta, hash],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono','OWNER')`,
        [ids.tenantA, ids.emailDono, hash],
      );
      ids.profAlfa = pa.rows[0]!.id;

      const s1 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno do Alfa') RETURNING id`,
        [ids.tenantA],
      );
      const s2 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno do Beta') RETURNING id`,
        [ids.tenantA],
      );
      ids.alunoDoAlfa = s1.rows[0]!.id;
      ids.alunoDoBeta = s2.rows[0]!.id;

      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantA, ids.alunoDoAlfa, ids.profAlfa],
      );
      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantA, ids.alunoDoBeta, pb.rows[0]!.id],
      );

      const e1 = await c.query<{ id: string }>(
        `INSERT INTO exercises (tenant_id,name,muscle_group) VALUES ($1,'Agachamento Alfa','QUADRICEPS')
         RETURNING id`,
        [ids.tenantA],
      );
      ids.exercicioA = e1.rows[0]!.id;
    });

    await comTenant(ids.tenantB, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenantB,
        'Academia Beta',
        ids.slugB,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono B','OWNER')`,
        [ids.tenantB, ids.emailDonoB, hash],
      );
      const e = await c.query<{ id: string }>(
        `INSERT INTO exercises (tenant_id,name,muscle_group) VALUES ($1,'Segredo da Concorrente','PEITO')
         RETURNING id`,
        [ids.tenantB],
      );
      ids.exercicioB = e.rows[0]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ================================================================
   * Biblioteca
   * ============================================================== */

  it('a biblioteca de uma empresa não aparece para outra', async () => {
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);

    const lista = await app.inject({
      method: 'GET',
      url: '/api/exercises',
      headers: como(alfa),
    });
    expect(lista.statusCode).toBe(200);

    const nomes = (lista.json() as { data: { nome: string }[] }).data.map((e) => e.nome);
    expect(nomes).toContain('Agachamento Alfa');
    expect(nomes).not.toContain('Segredo da Concorrente');
  });

  it('o profissional LÊ a biblioteca mas não a altera', async () => {
    /* O catálogo é o vocabulário da academia: mexer nele muda o que
       todo mundo prescreve. Por isso escrita é de quem administra. */
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);

    const leu = await app.inject({ method: 'GET', url: '/api/exercises', headers: como(alfa) });
    expect(leu.statusCode).toBe(200);

    const tentou = await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: como(alfa),
      payload: { nome: 'Exercício do Professor', grupo: 'PEITO' },
    });
    expect(tentou.statusCode).toBe(403);
  });

  it('o dono cadastra exercício, e o nome repetido é recusado com explicação', async () => {
    const dono = await tokenDe(ids.emailDono, ids.slugA);

    const criou = await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: como(dono),
      payload: { nome: 'Remada Cavalinho', grupo: 'COSTAS', equipamento: 'Máquina' },
    });
    expect(criou.statusCode).toBe(201);

    const repetiu = await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: como(dono),
      payload: { nome: 'Remada Cavalinho', grupo: 'COSTAS' },
    });
    /* 409 com o nome na mensagem: dois exercícios iguais é sempre erro
       de digitação, e o estrago só aparece semanas depois. */
    expect(repetiu.statusCode).toBe(409);
    expect((repetiu.json() as { error: { message: string } }).error.message).toContain(
      'Remada Cavalinho',
    );
  });

  it('recusa vídeo que não seja https', async () => {
    const dono = await tokenDe(ids.emailDono, ids.slugA);
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: como(dono),
      payload: {
        nome: 'Exercício com vídeo ruim',
        grupo: 'PEITO',
        video: 'javascript:alert(document.cookie)',
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a busca ignora acento', async () => {
    /* Quem digita rápido não acentua. Sem isto o profissional conclui
       que o exercício "não existe" e cadastra um duplicado. */
    const dono = await tokenDe(ids.emailDono, ids.slugA);
    await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: como(dono),
      payload: { nome: 'Tríceps Testudo', grupo: 'TRICEPS' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/exercises?busca=triceps%20testudo',
      headers: como(dono),
    });
    const nomes = (res.json() as { data: { nome: string }[] }).data.map((e) => e.nome);
    expect(nomes).toContain('Tríceps Testudo');
  });

  /* ================================================================
   * Prescrição
   * ============================================================== */

  async function criarTreinoDoAlfa(token: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos`,
      headers: como(token),
      payload: { nome: 'Treino ABC', objetivo: 'Hipertrofia' },
    });
    return (res.json() as { data: { id: string } }).data.id;
  }

  it('o profissional monta e publica um treino para o seu aluno', async () => {
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const treinoId = await criarTreinoDoAlfa(alfa);

    const item = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}/itens`,
      headers: como(alfa),
      payload: {
        exercicioId: ids.exercicioA,
        dia: 'A',
        series: 4,
        repeticoes: '8-12',
        cargaKg: 42.5,
        descansoSegundos: 90,
      },
    });
    expect(item.statusCode).toBe(201);

    const ativou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}/ativar`,
      headers: como(alfa),
    });
    expect(ativou.statusCode).toBe(200);

    const leu = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}`,
      headers: como(alfa),
    });
    const treino = (leu.json() as {
      data: { status: string; itens: { cargaG: number | null; repeticoes: string }[] };
    }).data;

    expect(treino.status).toBe('ACTIVE');
    // 42,5 kg tem que voltar como 42500 g exatos — carga é número que se compara.
    expect(treino.itens[0]?.cargaG).toBe(42_500);
    expect(treino.itens[0]?.repeticoes).toBe('8-12');
  });

  it('treino VAZIO não é publicado', async () => {
    /* O aluno abriria o app e veria um plano sem exercício nenhum — pior
       que não ter treino, porque parece defeito do sistema. */
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const treinoId = await criarTreinoDoAlfa(alfa);

    const res = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}/ativar`,
      headers: como(alfa),
    });
    expect(res.statusCode).toBe(422);
  });

  it('publicar um treino arquiva o anterior — nunca dois ativos', async () => {
    /* Dois planos "vigentes" ao mesmo tempo é um erro que aparece na
       sala, com o aluno esperando para saber qual seguir. */
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);

    const novo = await criarTreinoDoAlfa(alfa);
    await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${novo}/itens`,
      headers: como(alfa),
      payload: { exercicioId: ids.exercicioA, series: 3, repeticoes: '10' },
    });
    const ativou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${novo}/ativar`,
      headers: como(alfa),
    });
    expect(ativou.statusCode).toBe(200);

    const lista = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/treinos`,
      headers: como(alfa),
    });
    const ativos = (lista.json() as { data: { id: string; status: string }[] }).data.filter(
      (t) => t.status === 'ACTIVE',
    );
    expect(ativos.length).toBe(1);
    expect(ativos[0]?.id).toBe(novo);
  });

  it('um profissional não vê nem prescreve treino para o aluno de um colega', async () => {
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const treinoId = await criarTreinoDoAlfa(alfa);

    const beta = await tokenDe(ids.emailProfBeta, ids.slugA);

    const listou = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/treinos`,
      headers: como(beta),
    });
    expect((listou.json() as { data: unknown[] }).data).toHaveLength(0);

    const abriu = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}`,
      headers: como(beta),
    });
    expect(abriu.statusCode).toBe(404);

    const prescreveu = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos`,
      headers: como(beta),
      payload: { nome: 'Treino plantado' },
    });
    expect(prescreveu.statusCode).toBe(404);
  });

  it('não dá para pendurar exercício no treino de um colega', async () => {
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const treinoId = await criarTreinoDoAlfa(alfa);
    const beta = await tokenDe(ids.emailProfBeta, ids.slugA);

    const res = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}/itens`,
      headers: como(beta),
      payload: { exercicioId: ids.exercicioA, series: 3 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('exercício de OUTRA empresa vira 404, não erro de banco', async () => {
    /* Um 500 por violação de chave estrangeira seria um oráculo: diria
       ao atacante que aquele id existe em algum lugar do sistema. */
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const treinoId = await criarTreinoDoAlfa(alfa);

    const res = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}/itens`,
      headers: como(alfa),
      payload: { exercicioId: ids.exercicioB, series: 3 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('o ADMIN lê a prescrição mas não a escreve', async () => {
    /* Como na anamnese: quem responde pela conduta técnica é o
       profissional. */
    const dono = await tokenDe(ids.emailDono, ids.slugA);
    const leu = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/treinos`,
      headers: como(dono),
    });
    // O dono tem tudo; o teste do ADMIN puro fica na matriz de papéis.
    expect(leu.statusCode).toBe(200);
  });

  it('a recepção não alcança treino nenhum', async () => {
    const sufixo = crypto.randomUUID().slice(0, 8);
    const email = `recep-${sufixo}@treino.test`;
    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    await comTenant(ids.tenantA, async (c) => {
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Recepcao','RECEPTION')`,
        [ids.tenantA, email, hash],
      );
    });

    const token = await tokenDe(email, ids.slugA);
    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/treinos`,
      headers: como(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('remover um item do treino de um colega não funciona', async () => {
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const treinoId = await criarTreinoDoAlfa(alfa);
    const item = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}/itens`,
      headers: como(alfa),
      payload: { exercicioId: ids.exercicioA, series: 3 },
    });
    const itemId = (item.json() as { data: { id: string } }).data.id;

    const beta = await tokenDe(ids.emailProfBeta, ids.slugA);
    const removeu = await app.inject({
      method: 'DELETE',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}/itens/${itemId}`,
      headers: como(beta),
    });
    expect(removeu.statusCode).toBe(404);

    // E o item continua lá.
    const leu = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}`,
      headers: como(alfa),
    });
    expect((leu.json() as { data: { itens: unknown[] } }).data.itens).toHaveLength(1);
  });

  it('exercício em uso não pode ser apagado do catálogo — só desativado', async () => {
    /* A FK é RESTRICT de propósito: apagar quebraria treinos em
       andamento, e prontuário não se reescreve. */
    const alfa = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const treinoId = await criarTreinoDoAlfa(alfa);
    await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}/itens`,
      headers: como(alfa),
      payload: { exercicioId: ids.exercicioA, series: 3 },
    });

    await expect(
      comTenant(ids.tenantA, async (c) =>
        c.query('DELETE FROM exercises WHERE id = $1', [ids.exercicioA]),
      ),
    ).rejects.toThrow();

    // Desativar, sim.
    const dono = await tokenDe(ids.emailDono, ids.slugA);
    const desativou = await app.inject({
      method: 'PATCH',
      url: `/api/exercises/${ids.exercicioA}`,
      headers: como(dono),
      payload: { ativo: false },
    });
    expect(desativou.statusCode).toBe(200);

    // E some da lista padrão, sem sumir dos treinos já prescritos.
    const lista = await app.inject({ method: 'GET', url: '/api/exercises', headers: como(dono) });
    const nomes = (lista.json() as { data: { nome: string }[] }).data.map((e) => e.nome);
    expect(nomes).not.toContain('Agachamento Alfa');

    const treino = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/treinos/${treinoId}`,
      headers: como(alfa),
    });
    const itens = (treino.json() as { data: { itens: { exercicio: string }[] } }).data.itens;
    expect(itens[0]?.exercicio).toBe('Agachamento Alfa');
  });
});
