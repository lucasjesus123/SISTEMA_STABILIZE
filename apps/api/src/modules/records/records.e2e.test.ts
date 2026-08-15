import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Prontuário, ponta a ponta.
 *
 * O atacante considerado aqui NÃO é um estranho: é um profissional
 * autenticado, da mesma empresa, tentando ler ou escrever o prontuário
 * de um aluno que não é dele. É o cenário realista numa academia — o
 * colega de sala, com login válido, curioso sobre o histórico clínico
 * de alguém.
 *
 * Cada `it` abaixo é uma garantia que o sistema promete. Se algum deles
 * passar a falhar, a promessa quebrou — não é o teste que está errado.
 *
 * Requer TEST_DATABASE_URL apontando para um papel SEM BYPASSRLS.
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
  profBeta: '',
  emailProfAlfa: '',
  emailProfBeta: '',
  emailAdmin: '',
  emailProfOutraEmpresa: '',
  alunoDoAlfa: '',
  alunoDoBeta: '',
  alunoOutraEmpresa: '',
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

async function tokenDe(email: string, slug?: string): Promise<string> {
  const emCache = cacheTokens.get(email);
  if (emCache !== undefined) return emCache;

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA, ...(slug !== undefined ? { tenantSlug: slug } : {}) },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) {
    throw new Error(`login falhou para ${email}: ${res.statusCode} ${res.body}`);
  }
  cacheTokens.set(email, body.accessToken);
  return body.accessToken;
}

const como = (token: string) => ({ authorization: `Bearer ${token}` });

suite('Prontuário', () => {
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
    ids.slugA = `pront-a-${sufixo}`;
    ids.slugB = `pront-b-${sufixo}`;
    ids.emailProfAlfa = `alfa-${sufixo}@pront.test`;
    ids.emailProfBeta = `beta-${sufixo}@pront.test`;
    ids.emailAdmin = `admin-${sufixo}@pront.test`;
    ids.emailProfOutraEmpresa = `outro-${sufixo}@pront.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenantA, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenantA,
        'Clinica Alfa',
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
         VALUES ($1,$2,$3,'Admin','ADMIN')`,
        [ids.tenantA, ids.emailAdmin, hash],
      );
      ids.profAlfa = pa.rows[0]!.id;
      ids.profBeta = pb.rows[0]!.id;

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
        [ids.tenantA, ids.alunoDoBeta, ids.profBeta],
      );
    });

    await comTenant(ids.tenantB, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenantB,
        'Clinica Beta',
        ids.slugB,
      ]);
      const p = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof de Outra Empresa','PROFESSIONAL') RETURNING id`,
        [ids.tenantB, ids.emailProfOutraEmpresa, hash],
      );
      const s = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno de Fora') RETURNING id`,
        [ids.tenantB],
      );
      ids.alunoOutraEmpresa = s.rows[0]!.id;
      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantB, ids.alunoOutraEmpresa, p.rows[0]!.id],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ================================================================
   * Anamnese
   * ============================================================== */

  it('o profissional grava e relê a anamnese do seu aluno', async () => {
    const token = await tokenDe(ids.emailProfAlfa, ids.slugA);

    const gravou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
      payload: {
        queixaPrincipal: 'Dor lombar ao levantar peso',
        objetivos: 'Voltar a correr sem dor',
        alturaCm: 178,
        pesoG: 82_000,
        respostas: { fumante: false, sonoHoras: 7 },
      },
    });
    expect(gravou.statusCode).toBe(201);

    const leu = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
    });
    expect(leu.statusCode).toBe(200);
    const corpo = leu.json() as {
      data: { vigente: { queixaPrincipal: string; alturaCm: number } | null };
    };
    expect(corpo.data.vigente?.queixaPrincipal).toBe('Dor lombar ao levantar peso');
    expect(corpo.data.vigente?.alturaCm).toBe(178);
  });

  it('gravar de novo cria uma VERSÃO, não sobrescreve a anterior', async () => {
    const token = await tokenDe(ids.emailProfAlfa, ids.slugA);

    await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
      payload: { queixaPrincipal: 'Dor lombar cedeu; agora ombro direito' },
    });

    const leu = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
    });
    const corpo = leu.json() as {
      data: { vigente: { queixaPrincipal: string }; versoes: unknown[] };
    };

    // A vigente é a última...
    expect(corpo.data.vigente.queixaPrincipal).toBe('Dor lombar cedeu; agora ombro direito');
    // ...e a anterior continua existindo.
    expect(corpo.data.versoes.length).toBe(2);
  });

  it('um aluno no escopo SEM anamnese responde 200 com vigente nulo', async () => {
    /* Diferente de 404: "ainda não preencheram" é um estado normal do
       fluxo, e a tela precisa saber a diferença para oferecer o botão
       de criar em vez de dizer que o aluno não existe. */
    const token = await tokenDe(ids.emailProfBeta, ids.slugA);

    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoBeta}/anamnese`,
      headers: como(token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { vigente: unknown } }).data.vigente).toBeNull();
  });

  it('um profissional NÃO lê a anamnese do aluno de um colega — e recebe 404, não 403', async () => {
    const token = await tokenDe(ids.emailProfBeta, ids.slugA);

    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
    });

    /* 404 e não 403 de propósito: um 403 confirmaria que este id existe
       nesta empresa, o que já é informação sobre o aluno de outro. */
    expect(res.statusCode).toBe(404);
  });

  it('um profissional NÃO grava anamnese no aluno de um colega', async () => {
    const token = await tokenDe(ids.emailProfBeta, ids.slugA);

    const res = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
      payload: { queixaPrincipal: 'texto plantado por quem não atende' },
    });
    expect(res.statusCode).toBe(404);

    // E o prontuário do aluno continua intacto.
    const dono = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const leu = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(dono),
    });
    const corpo = leu.json() as { data: { vigente: { queixaPrincipal: string } } };
    expect(corpo.data.vigente.queixaPrincipal).not.toContain('plantado');
  });

  it('o ADMIN lê a anamnese mas NÃO a escreve', async () => {
    /* A matriz de papéis dá `anamnesis:read` ao ADMIN e não
       `anamnesis:write`: quem responde pela conduta clínica é o
       profissional. Este teste é o que impede alguém "resolver" um
       chamado de suporte afrouxando a matriz sem perceber. */
    const token = await tokenDe(ids.emailAdmin, ids.slugA);

    const leu = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
    });
    expect(leu.statusCode).toBe(200);

    const tentou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
      payload: { queixaPrincipal: 'admin escrevendo conduta clínica' },
    });
    expect(tentou.statusCode).toBe(403);
  });

  it('outra EMPRESA não alcança o prontuário nem com id válido em mãos', async () => {
    const token = await tokenDe(ids.emailProfOutraEmpresa, ids.slugB);

    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
    });
    expect(res.statusCode).toBe(404);
  });

  /* ================================================================
   * Evolução
   * ============================================================== */

  it('a evolução é assinada por quem está autenticado, não por quem o corpo disser', async () => {
    const token = await tokenDe(ids.emailProfAlfa, ids.slugA);

    const criou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes`,
      headers: como(token),
      payload: {
        dataSessao: '2026-08-10',
        conteudo: 'Mobilidade de quadril; sem dor ao final.',
        escalaDor: 2,
        // Tentativa de assinar no nome do colega.
        professionalId: ids.profBeta,
        profissionalId: ids.profBeta,
      },
    });
    expect(criou.statusCode).toBe(201);

    const lista = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes`,
      headers: como(token),
    });
    const corpo = lista.json() as {
      data: { profissional: { id: string; nome: string }; conteudo: string }[];
    };
    expect(corpo.data[0]?.profissional.id).toBe(ids.profAlfa);
    expect(corpo.data[0]?.profissional.id).not.toBe(ids.profBeta);
  });

  it('um profissional não lista as evoluções do aluno de um colega', async () => {
    const token = await tokenDe(ids.emailProfBeta, ids.slugA);

    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes`,
      headers: como(token),
    });
    /* 404, e não 200 com lista vazia: lista vazia diria "este aluno
       existe e não tem evolução", que já é informação sobre um aluno
       alheio. */
    expect(res.statusCode).toBe(404);
  });

  it('o autor edita a evolução dentro da janela', async () => {
    const token = await tokenDe(ids.emailProfAlfa, ids.slugA);

    const criou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes`,
      headers: como(token),
      payload: { dataSessao: '2026-08-11', conteudo: 'Texto com erro de digitaçãoo' },
    });
    const { data } = criou.json() as { data: { id: string } };

    const editou = await app.inject({
      method: 'PATCH',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes/${data.id}`,
      headers: como(token),
      payload: { conteudo: 'Texto corrigido', escalaDor: 1 },
    });
    expect(editou.statusCode).toBe(200);
  });

  it('passada a janela, nem o autor edita — e o motivo é 409, não 403', async () => {
    const token = await tokenDe(ids.emailProfAlfa, ids.slugA);

    const criou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes`,
      headers: como(token),
      payload: { dataSessao: '2026-08-01', conteudo: 'Registro antigo do atendimento.' },
    });
    const { data } = criou.json() as { data: { id: string } };

    // Envelhece o registro além da janela.
    await comTenant(ids.tenantA, async (c) => {
      await c.query(`UPDATE evolutions SET created_at = now() - interval '30 hours' WHERE id = $1`, [
        data.id,
      ]);
    });

    const editou = await app.inject({
      method: 'PATCH',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes/${data.id}`,
      headers: como(token),
      payload: { conteudo: 'reescrevendo a história do atendimento' },
    });

    /* 409 e não 403: não falta permissão, mudou o estado do registro
       com o tempo. A tela usa essa diferença para oferecer a saída
       certa — registrar uma retificação. */
    expect(editou.statusCode).toBe(409);
  });

  it('corrigir o texto NÃO apaga a escala de dor', async () => {
    /* PATCH que não menciona um campo não pode zerá-lo. Este teste
       nasceu de um defeito real, visto numa captura de tela: corrigir um
       erro de digitação apagava a dor registrada no atendimento, e
       ninguém notaria até alguém ir comparar a evolução do quadro. */
    const token = await tokenDe(ids.emailProfAlfa, ids.slugA);

    const criou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes`,
      headers: como(token),
      payload: { dataSessao: '2026-08-13', conteudo: 'Sessão com dor relatada.', escalaDor: 7 },
    });
    const { data } = criou.json() as { data: { id: string } };

    await app.inject({
      method: 'PATCH',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes/${data.id}`,
      headers: como(token),
      payload: { conteudo: 'Sessão com dor relatada no ombro direito.' },
    });

    const lista = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes`,
      headers: como(token),
    });
    const itens = (lista.json() as { data: { id: string; escalaDor: number | null }[] }).data;
    expect(itens.find((e) => e.id === data.id)?.escalaDor).toBe(7);
  });

  it('um profissional não edita a evolução escrita por um colega', async () => {
    const tokenAlfa = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const criou = await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes`,
      headers: como(tokenAlfa),
      payload: { dataSessao: '2026-08-12', conteudo: 'Anotação do profissional Alfa.' },
    });
    const { data } = criou.json() as { data: { id: string } };

    const tokenBeta = await tokenDe(ids.emailProfBeta, ids.slugA);
    const tentou = await app.inject({
      method: 'PATCH',
      url: `/api/students/${ids.alunoDoAlfa}/evolucoes/${data.id}`,
      headers: como(tokenBeta),
      payload: { conteudo: 'alterado por outro profissional' },
    });
    expect(tentou.statusCode).toBe(404);
  });

  /* ================================================================
   * Auditoria
   * ============================================================== */

  it('a LEITURA do prontuário fica registrada, não só a escrita', async () => {
    const token = await tokenDe(ids.emailProfAlfa, ids.slugA);

    await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
    });

    const linhas = await comTenant(ids.tenantA, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'anamnesis.read' AND resource_id = $1 AND actor_id = $2`,
        [ids.alunoDoAlfa, ids.profAlfa],
      ),
    );
    expect(Number(linhas.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('a leitura NEGADA também fica registrada — é a que interessa investigar', async () => {
    const token = await tokenDe(ids.emailProfBeta, ids.slugA);

    await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
    });

    /* Esta é a linha que a primeira versão do sistema perdia: o
       registro era escrito com o client da requisição e o `throw` do
       404 dava rollback, apagando justamente a tentativa negada. */
    const linhas = await comTenant(ids.tenantA, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'anamnesis.read' AND resource_id = $1
            AND actor_id = $2 AND outcome = 'DENIED'`,
        [ids.alunoDoAlfa, ids.profBeta],
      ),
    );
    expect(Number(linhas.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('o conteúdo clínico NÃO vai parar no log de auditoria', async () => {
    /* O log é lido por mais gente e guardado por mais tempo que o
       prontuário. Se o texto da anamnese for junto, o dado sensível
       ganha uma segunda casa, menos protegida. */
    const token = await tokenDe(ids.emailProfAlfa, ids.slugA);
    const segredo = `marcador-clinico-${crypto.randomUUID().slice(0, 8)}`;

    await app.inject({
      method: 'POST',
      url: `/api/students/${ids.alunoDoAlfa}/anamnese`,
      headers: como(token),
      payload: { queixaPrincipal: segredo },
    });

    const linhas = await comTenant(ids.tenantA, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE metadata::text LIKE $1`,
        [`%${segredo}%`],
      ),
    );
    expect(Number(linhas.rows[0]!.n)).toBe(0);
  });
});
