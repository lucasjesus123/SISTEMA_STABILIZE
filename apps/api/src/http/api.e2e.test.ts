import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Teste ponta a ponta da API.
 *
 * Usa `app.inject()`, que percorre o MESMO caminho de plugins, hooks e
 * handlers de uma requisição real — sem abrir porta. A diferença em
 * relação a chamar o serviço direto é que aqui a autenticação, o rate
 * limit, os cabeçalhos e o handler de erro são exercitados de verdade,
 * em vez de contornados.
 *
 * É este arquivo que responde à pergunta que importa: *um usuário
 * autenticado de uma empresa consegue alcançar dado de outra?*
 *
 * Requer TEST_DATABASE_URL com as migrations aplicadas, num papel sem
 * BYPASSRLS.
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
  emailAdminA: '',
  emailProf1: '',
  emailProf2: '',
  emailSessao: '',
  emailLogout: '',
  studentA1: '',
  studentA2: '',
  studentB1: '',
};

async function withTenantRaw<T>(
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
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

async function fazerLogin(email: string, senha = SENHA, slug?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: senha, ...(slug !== undefined ? { tenantSlug: slug } : {}) },
  });
}

/**
 * Token por usuário, reaproveitado entre os casos.
 *
 * Fazer login a cada asserção esgotaria o limite de tentativas — que é
 * exatamente o comportamento desejado da API, e foi assim que a
 * primeira versão deste arquivo descobriu que o rate limit respondia
 * 500 em vez de 429. O teste do limite ficou explícito, no seu próprio
 * bloco, com um e-mail que só ele usa.
 */
const cacheTokens = new Map<string, string>();

async function tokenDe(email: string, slug?: string): Promise<string> {
  const emCache = cacheTokens.get(email);
  if (emCache !== undefined) return emCache;

  const res = await fazerLogin(email, SENHA, slug);
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) {
    throw new Error(`login falhou para ${email}: ${res.statusCode} ${res.body}`);
  }
  cacheTokens.set(email, body.accessToken);
  return body.accessToken;
}

suite('API ponta a ponta', () => {
  beforeAll(async () => {
    // Configuração mínima válida. Segredos de teste, descartáveis.
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'zK3-acesso-somente-para-teste-com-tamanho-suficiente-01';
    process.env['JWT_REFRESH_SECRET'] = 'qP9-refresh-somente-para-teste-com-tamanho-suficiente-02';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    process.env['CORS_ORIGINS'] = 'http://localhost:5173';
    process.env['LOG_LEVEL'] = 'fatal';

    const { resetEnvCache } = await import('../config/env.js');
    resetEnvCache();
    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();

    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    const sufixo = crypto.randomUUID().slice(0, 8);
    ids.tenantA = crypto.randomUUID();
    ids.tenantB = crypto.randomUUID();
    ids.slugA = `alfa-${sufixo}`;
    ids.slugB = `beta-${sufixo}`;
    ids.emailAdminA = `admin-${sufixo}@alfa.test`;
    ids.emailProf1 = `prof1-${sufixo}@alfa.test`;
    ids.emailProf2 = `prof2-${sufixo}@alfa.test`;
    /* Usuários dedicados aos testes de sessão. A cota do rate limit é
       por (IP, e-mail), então separar os e-mails impede que um bloco de
       testes esgote a cota de outro — e mantém o limite ATIVO durante
       todos eles, em vez de afrouxá-lo só para o teste passar. */
    ids.emailSessao = `sessao-${sufixo}@alfa.test`;
    ids.emailLogout = `logout-${sufixo}@alfa.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await withTenantRaw(ids.tenantA, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenantA,
        'Alfa',
        ids.slugA,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role) VALUES ($1,$2,$3,'Admin Alfa','ADMIN')`,
        [ids.tenantA, ids.emailAdminA, hash],
      );
      const p1 = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Um','PROFESSIONAL') RETURNING id`,
        [ids.tenantA, ids.emailProf1, hash],
      );
      const p2 = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Dois','PROFESSIONAL') RETURNING id`,
        [ids.tenantA, ids.emailProf2, hash],
      );

      for (const email of [ids.emailSessao, ids.emailLogout]) {
        await c.query(
          `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
           VALUES ($1,$2,$3,'Usuario Sessao','ADMIN')`,
          [ids.tenantA, email, hash],
        );
      }

      const s1 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Ana Aluna') RETURNING id`,
        [ids.tenantA],
      );
      const s2 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Bruno Aluno') RETURNING id`,
        [ids.tenantA],
      );
      ids.studentA1 = s1.rows[0]!.id;
      ids.studentA2 = s2.rows[0]!.id;

      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantA, ids.studentA1, p1.rows[0]!.id],
      );
      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantA, ids.studentA2, p2.rows[0]!.id],
      );
    });

    await withTenantRaw(ids.tenantB, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenantB,
        'Beta',
        ids.slugB,
      ]);
      const s = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Carla Concorrente') RETURNING id`,
        [ids.tenantB],
      );
      ids.studentB1 = s.rows[0]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    for (const t of [ids.tenantA, ids.tenantB]) {
      if (!t) continue;
      await withTenantRaw(t, (c) => c.query('DELETE FROM tenants WHERE id=$1', [t])).catch(
        () => undefined,
      );
    }
    await pool?.end();
    await app?.close();
  });

  // ==================================================================
  describe('cabeçalhos de segurança', () => {
    it('a resposta traz os cabeçalhos que desligam classes inteiras de ataque', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);

      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('o healthcheck não revela nada sobre o sistema', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      // Um sistema saudável e um doente devem ser indistinguíveis para
      // quem está sondando: sem versão, sem hostname, sem contagens.
      expect(res.json()).toEqual({ status: 'ok' });
    });
  });

  // ==================================================================
  describe('login', () => {
    it('entra com credencial correta e devolve o cookie HttpOnly', async () => {
      const res = await fazerLogin(ids.emailAdminA);
      expect(res.statusCode).toBe(200);

      const body = res.json() as { accessToken: string; user: { role: string } };
      expect(body.accessToken).toBeTruthy();
      expect(body.user.role).toBe('ADMIN');

      const cookie = res.headers['set-cookie'];
      const raw = Array.isArray(cookie) ? cookie.join(';') : String(cookie);
      expect(raw).toContain('stz_rt=');
      // HttpOnly é o que impede um XSS de ler o refresh token.
      expect(raw).toContain('HttpOnly');
      expect(raw).toContain('SameSite=Strict');
    });

    it('o access token NÃO vai em cookie — precisa ficar em memória no cliente', async () => {
      const res = await fazerLogin(ids.emailAdminA);
      const raw = String(res.headers['set-cookie']);
      expect(raw).not.toContain('accessToken');
    });

    it('senha errada e e-mail inexistente respondem IGUAL', async () => {
      const senhaErrada = await fazerLogin(ids.emailAdminA, 'senha-completamente-errada');
      const naoExiste = await fazerLogin('ninguem-aqui-existe@nada.test', SENHA);

      expect(senhaErrada.statusCode).toBe(401);
      expect(naoExiste.statusCode).toBe(401);
      // Respostas idênticas: qualquer diferença enumera contas.
      expect(senhaErrada.json()).toMatchObject({
        error: { code: 'UNAUTHORIZED', message: 'E-mail ou senha incorretos.' },
      });
      expect((naoExiste.json() as { error: { message: string } }).error.message).toBe(
        (senhaErrada.json() as { error: { message: string } }).error.message,
      );
    });

    it('e-mail inexistente gasta tempo comparável ao de senha errada', async () => {
      // Sem o hash descartável, "não existe" responderia em ~1ms e
      // "senha errada" em ~100ms — e o relógio vira um oráculo.
      const t0 = performance.now();
      await fazerLogin('outro-que-nao-existe@nada.test', SENHA);
      const semUsuario = performance.now() - t0;

      const t1 = performance.now();
      await fazerLogin(ids.emailAdminA, 'senha-errada-mesmo');
      const comUsuario = performance.now() - t1;

      // Tolerância generosa: o que importa é não haver ordem de
      // grandeza de diferença.
      const razao = Math.max(semUsuario, comUsuario) / Math.max(Math.min(semUsuario, comUsuario), 1);
      expect(razao).toBeLessThan(5);
    });

    it('força bruta esbarra no limite e recebe 429 — não 500', async () => {
      /* Regressão registrada: o plugin de rate limit LANÇA o que o
         errorResponseBuilder devolve. Devolvendo um objeto simples, o
         handler tratava como erro desconhecido e respondia 500 — o
         cliente não distinguia "diminua o ritmo" de "servidor
         quebrado", e o monitoramento contava excesso de requisição
         como erro interno. */
      const alvo = `bruteforce-${crypto.randomUUID().slice(0, 8)}@alfa.test`;
      const status: number[] = [];

      for (let i = 0; i < 13; i += 1) {
        const res = await fazerLogin(alvo, 'tentativa-de-senha-errada');
        status.push(res.statusCode);
        if (res.statusCode === 429) break;
      }

      expect(status).toContain(429);
      expect(status).not.toContain(500);

      const ultima = await fazerLogin(alvo, 'tentativa-de-senha-errada');
      expect(ultima.statusCode).toBe(429);
      expect(ultima.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      // A mensagem diz quando tentar de novo, sem revelar se a conta existe.
      expect((ultima.json() as { error: { message: string } }).error.message).toMatch(/segundo/);
    });

    it('recusa payload inválido com 422 e diz qual campo', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nao-e-email', password: '' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: 'UNPROCESSABLE' } });
    });
  });

  // ==================================================================
  describe('autenticação obrigatória', () => {
    it('rota protegida sem token responde 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/students' });
      expect(res.statusCode).toBe(401);
    });

    it('token adulterado é recusado', async () => {
      const token = await tokenDe(ids.emailAdminA);
      const partes = token.split('.');
      // Mexe no payload mantendo a estrutura — a assinatura não fecha.
      const adulterado = `${partes[0]}.${Buffer.from('{"sub":"x","tid":"y","role":"OWNER"}').toString('base64url')}.${partes[2]}`;

      const res = await app.inject({
        method: 'GET',
        url: '/api/students',
        headers: { authorization: `Bearer ${adulterado}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('token com alg "none" é recusado', async () => {
      // O ataque clássico de JWT: trocar o algoritmo por "none".
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: crypto.randomUUID(),
          tid: ids.tenantB,
          role: 'OWNER',
          iss: 'stabilize',
          aud: 'stabilize-api',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      const res = await app.inject({
        method: 'GET',
        url: '/api/students',
        headers: { authorization: `Bearer ${header}.${payload}.` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('cabeçalho Authorization malformado é recusado', async () => {
      for (const header of ['Bearer', 'Basic abc', 'Bearer a b', 'abc']) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/students',
          headers: { authorization: header },
        });
        expect(res.statusCode).toBe(401);
      }
    });
  });

  // ==================================================================
  describe('isolamento entre empresas pela API', () => {
    it('o admin da Alfa não vê a aluna da Beta na listagem', async () => {
      const token = await tokenDe(ids.emailAdminA);
      const res = await app.inject({
        method: 'GET',
        url: '/api/students',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { nome: string }[]; pagination: { total: number } };
      const nomes = body.data.map((a) => a.nome);
      expect(nomes).toEqual(expect.arrayContaining(['Ana Aluna', 'Bruno Aluno']));
      expect(nomes).not.toContain('Carla Concorrente');
      expect(body.pagination.total).toBe(2);
    });

    it('IDOR: trocar o id na URL pelo de outra empresa devolve 404, não 403', async () => {
      const token = await tokenDe(ids.emailAdminA);
      const res = await app.inject({
        method: 'GET',
        url: `/api/students/${ids.studentB1}`,
        headers: { authorization: `Bearer ${token}` },
      });

      // 404 e não 403: um 403 confirmaria que este id existe e
      // permitiria mapear a base alheia por diferença de resposta.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });

    it('id inexistente e id de outra empresa são indistinguíveis', async () => {
      const token = await tokenDe(ids.emailAdminA);
      const inexistente = await app.inject({
        method: 'GET',
        url: `/api/students/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const deOutraEmpresa = await app.inject({
        method: 'GET',
        url: `/api/students/${ids.studentB1}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(inexistente.statusCode).toBe(deOutraEmpresa.statusCode);
      expect((inexistente.json() as { error: { message: string } }).error.message).toBe(
        (deOutraEmpresa.json() as { error: { message: string } }).error.message,
      );
    });

    it('id malformado responde 422, sem virar 500 do banco', async () => {
      const token = await tokenDe(ids.emailAdminA);
      const res = await app.inject({
        method: 'GET',
        url: '/api/students/nao-e-uuid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  // ==================================================================
  describe('recorte entre profissionais da mesma empresa', () => {
    it('cada professor lista apenas os próprios alunos', async () => {
      const t1 = await tokenDe(ids.emailProf1);
      const t2 = await tokenDe(ids.emailProf2);

      const r1 = await app.inject({
        method: 'GET',
        url: '/api/students',
        headers: { authorization: `Bearer ${t1}` },
      });
      const r2 = await app.inject({
        method: 'GET',
        url: '/api/students',
        headers: { authorization: `Bearer ${t2}` },
      });

      expect((r1.json() as { data: { nome: string }[] }).data.map((a) => a.nome)).toEqual([
        'Ana Aluna',
      ]);
      expect((r2.json() as { data: { nome: string }[] }).data.map((a) => a.nome)).toEqual([
        'Bruno Aluno',
      ]);
    });

    it('o Prof Um recebe 404 ao abrir a ficha do aluno do colega', async () => {
      const token = await tokenDe(ids.emailProf1);
      const res = await app.inject({
        method: 'GET',
        url: `/api/students/${ids.studentA2}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('a negativa de acesso fica registrada na auditoria', async () => {
      const token = await tokenDe(ids.emailProf1);
      await app.inject({
        method: 'GET',
        url: `/api/students/${ids.studentA2}`,
        headers: { authorization: `Bearer ${token}` },
      });

      const registros = await withTenantRaw(ids.tenantA, async (c) => {
        const r = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log
            WHERE tenant_id=$1 AND outcome='DENIED' AND resource_id=$2`,
          [ids.tenantA, ids.studentA2],
        );
        return r.rows[0]!.n;
      });
      // Uma sequência de negativas do mesmo usuário é o padrão de quem
      // está varrendo a base; sem registro não haveria como perceber.
      expect(registros).toBeGreaterThan(0);
    });
  });

  // ==================================================================
  describe('rotação de refresh token', () => {
    it('troca o token e invalida o anterior', async () => {
      const login = await fazerLogin(ids.emailSessao);
      const cookie1 = extrairCookie(login);

      const r1 = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: `stz_rt=${cookie1}` },
      });
      expect(r1.statusCode).toBe(200);
      const cookie2 = extrairCookie(r1);
      expect(cookie2).not.toBe(cookie1);

      // O novo funciona.
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: `stz_rt=${cookie2}` },
      });
      expect(r2.statusCode).toBe(200);
    });

    it('reapresentar um token já usado derruba a família inteira', async () => {
      const login = await fazerLogin(ids.emailSessao);
      const original = extrairCookie(login);

      const rotacionado = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: `stz_rt=${original}` },
      });
      const atual = extrairCookie(rotacionado);

      // Reuso do antigo: sinal de roubo.
      const reuso = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: `stz_rt=${original}` },
      });
      expect(reuso.statusCode).toBe(401);

      /* E o token ATUAL também cai. Não há como saber qual das duas
         partes é a legítima, então ambas são deslogadas. */
      const depois = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: `stz_rt=${atual}` },
      });
      expect(depois.statusCode).toBe(401);
    });

    it('refresh sem cookie responde 401', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ==================================================================
  describe('sessão e permissões', () => {
    it('/me devolve o papel e as permissões para o front montar o menu', async () => {
      const token = await tokenDe(ids.emailProf1);
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { role: string; permissions: string[] };
      expect(body.role).toBe('PROFESSIONAL');
      // O profissional não recebe permissão de financeiro da empresa —
      // e o menu não vai nem exibir a aba.
      expect(body.permissions).not.toContain('finance:receivable:read');
      expect(body.permissions).toContain('commission:read');
    });

    it('logout revoga a sessão', async () => {
      const login = await fazerLogin(ids.emailLogout);
      const cookie = extrairCookie(login);
      const token = (login.json() as { accessToken: string }).accessToken;

      const out = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: `Bearer ${token}`, cookie: `stz_rt=${cookie}` },
      });
      expect(out.statusCode).toBe(200);

      const depois = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: `stz_rt=${cookie}` },
      });
      expect(depois.statusCode).toBe(401);
    });
  });

  // ==================================================================
  describe('tratamento de erro', () => {
    it('rota inexistente responde 404 sem listar rotas válidas', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/nao-existe' });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('/api/students');
    });

    it('nenhuma resposta de erro vaza stack trace ou detalhe interno', async () => {
      const respostas = await Promise.all([
        app.inject({ method: 'GET', url: '/api/students' }),
        app.inject({ method: 'GET', url: '/api/nao-existe' }),
        app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x' } }),
      ]);

      for (const res of respostas) {
        const corpo = res.body.toLowerCase();
        expect(corpo).not.toContain('at object.');
        expect(corpo).not.toContain('node_modules');
        expect(corpo).not.toContain('select ');
        expect(corpo).not.toContain('tenant_id');
        expect(corpo).not.toContain('/home/');
      }
    });

    it('toda resposta traz o X-Request-Id para rastrear no log', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/students' });
      expect(res.headers['x-request-id']).toBeTruthy();
      expect((res.json() as { error: { requestId: string } }).error.requestId).toBeTruthy();
    });
  });
});

function extrairCookie(res: { headers: Record<string, unknown> }): string {
  const bruto = res.headers['set-cookie'];
  const lista = Array.isArray(bruto) ? bruto : [String(bruto)];
  const alvo = lista.find((c) => c.startsWith('stz_rt='));
  if (alvo === undefined) throw new Error('cookie stz_rt ausente na resposta');
  return alvo.split(';')[0]!.replace('stz_rt=', '');
}
