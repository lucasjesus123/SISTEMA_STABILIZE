import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * As configurações da própria conta — ponta a ponta.
 *
 * O QUE ESTES TESTES GUARDAM:
 *
 *   1. TROCAR O E-MAIL É TROCAR A PORTA DE ENTRADA. Se a coluna mudasse
 *      sem o login acompanhar, a pessoa ficaria de fora do sistema com um
 *      cadastro que parece certo na tela — e a recuperação de senha, que
 *      também passa pelo e-mail, não a traria de volta.
 *
 *   2. SEM A SENHA ATUAL, NÃO. Uma sessão esquecida aberta no computador
 *      da recepção bastaria para mudar o endereço e trancar o dono para
 *      fora da própria conta, de forma permanente.
 *
 *   3. O ÍNDICE ÚNICO DE E-MAIL É POR ACADEMIA. Duas academias diferentes
 *      podem ter a mesma pessoa; a mesma academia, não. Um teste para
 *      cada lado, porque apertar demais aqui quebra o multi-tenant e
 *      afrouxar demais deixa duas contas disputarem o mesmo login.
 *
 *   4. AS OUTRAS SESSÕES CAEM E A DE AGORA FICA. Se o motivo da troca for
 *      justamente uma sessão alheia aberta, deixá-la viva não resolve
 *      nada — e derrubar a própria transformaria a tela de configurações
 *      numa expulsão.
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
  vizinha: '',
  slugVizinha: '',
  emailProf: '',
  emailRecepcao: '',
  emailNaVizinha: '',
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

interface Sessao {
  token: string;
  cookie: string;
}

/** Entra e devolve o access token e o cookie de refresh daquela sessão. */
async function entrar(email: string, slug: string, senha = SENHA): Promise<Sessao> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: senha, tenantSlug: slug },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login falhou para ${email}: ${res.statusCode} ${res.body}`);
  }
  const bruto = res.headers['set-cookie'];
  const cookies = Array.isArray(bruto) ? bruto : bruto === undefined ? [] : [bruto];
  return {
    token: (res.json() as { accessToken: string }).accessToken,
    cookie: cookies.find((c) => c.startsWith('stz_rt='))?.split(';')[0] ?? '',
  };
}

const como = (t: string) => ({ authorization: `Bearer ${t}` });

/*
 * A rota de e-mail confere senha, e por isso tem teto por IP — uma rota
 * que confere senha sem limite é um oráculo de senha. A suíte inteira
 * precisa de mais chamadas que o teto, então cada uma sai de um IP
 * próprio: o limitador tem um teste só dele, logo abaixo, e esse sim
 * repete o mesmo IP.
 */
let proximoIp = 0;
const ipDeTeste = (): string => `198.51.100.${(proximoIp++ % 250) + 1}`;

async function trocarEmail(
  s: Sessao,
  senhaAtual: string,
  email: string,
  remoteAddress = ipDeTeste(),
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: '/api/perfil/email',
    remoteAddress,
    headers: { ...como(s.token), cookie: s.cookie },
    payload: { senhaAtual, email },
  });
}

async function emailNoBanco(email: string): Promise<string> {
  const { rows } = await comTenant(ids.tenant, (c) =>
    c.query<{ email: string }>('SELECT email FROM users WHERE email = $1', [email]),
  );
  return rows[0]?.email ?? '';
}

suite('Configurações da própria conta', () => {
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
    ids.vizinha = crypto.randomUUID();
    ids.slug = `cfg-${ids.sufixo}`;
    ids.slugVizinha = `cfg-viz-${ids.sufixo}`;
    ids.emailProf = `prof-${ids.sufixo}@config.test`;
    ids.emailRecepcao = `recep-${ids.sufixo}@config.test`;
    ids.emailNaVizinha = `prof-${ids.sufixo}@config.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia das Configurações',
        ids.slug,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Professora Original','PROFESSIONAL')`,
        [ids.tenant, ids.emailProf, hash],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Recepção','RECEPTION')`,
        [ids.tenant, ids.emailRecepcao, hash],
      );
    });

    /* A vizinha existe para um teste só, e é o mais importante deles: o
       índice de e-mail é POR ACADEMIA, e a mesma pessoa pode trabalhar em
       duas. */
    await comTenant(ids.vizinha, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.vizinha,
        'Academia Vizinha',
        ids.slugVizinha,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Mesma Pessoa','PROFESSIONAL')`,
        [ids.vizinha, `outra-${ids.sufixo}@config.test`, hash],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ================================================================== */

  it('senha errada não troca o e-mail — e devolve 401', async () => {
    const s = await entrar(ids.emailProf, ids.slug);
    const res = await trocarEmail(s, 'nao-e-a-minha-senha', `tentativa-${ids.sufixo}@config.test`);
    expect(res.statusCode).toBe(401);

    /* O QUE ESTE TESTE REALMENTE GUARDA: que a recusa aconteceu ANTES do
       UPDATE. Uma versão que gravasse e só depois conferisse devolveria o
       mesmo 401 e teria trocado o e-mail assim mesmo. */
    expect(await emailNoBanco(ids.emailProf)).toBe(ids.emailProf);
    expect(await emailNoBanco(`tentativa-${ids.sufixo}@config.test`)).toBe('');
  });

  it('recusa o e-mail de outra pessoa da MESMA academia', async () => {
    const s = await entrar(ids.emailProf, ids.slug);
    const res = await trocarEmail(s, SENHA, ids.emailRecepcao);
    expect(res.statusCode).toBe(409);
    /* A mensagem diz "nesta academia": sem isso, a pessoa procura no
       mundo inteiro por uma colisão que é da porta ao lado. */
    expect(res.body).toContain('academia');
  });

  it('recusa trocar pelo e-mail que já é o seu', async () => {
    const s = await entrar(ids.emailProf, ids.slug);
    const res = await trocarEmail(s, SENHA, ids.emailProf.toUpperCase());
    expect(res.statusCode).toBe(400);
  });

  it('aceita um e-mail que já existe em OUTRA academia', async () => {
    /* O índice único é (tenant_id, email). A mesma pessoa pode dar aula
       em duas academias, e apertar isto para o banco inteiro quebraria o
       multi-tenant de um jeito que só aparece no segundo cliente. */
    const s = await entrar(`outra-${ids.sufixo}@config.test`, ids.slugVizinha);
    const res = await trocarEmail(s, SENHA, ids.emailNaVizinha);
    expect(res.statusCode).toBe(200);
  });

  it('troca o e-mail: entra pelo novo e não entra mais pelo antigo', async () => {
    const s = await entrar(ids.emailProf, ids.slug);
    const novo = `nova-caixa-${ids.sufixo}@config.test`;

    const res = await trocarEmail(s, SENHA, novo);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { email: string } }).data.email).toBe(novo);

    await expect(entrar(novo, ids.slug)).resolves.toBeDefined();

    const antigo = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ids.emailProf, password: SENHA, tenantSlug: ids.slug },
    });
    expect(antigo.statusCode).toBe(401);

    ids.emailProf = novo;
  });

  it('derruba as OUTRAS sessões e mantém a de quem trocou', async () => {
    const outroAparelho = await entrar(ids.emailProf, ids.slug);
    const meu = await entrar(ids.emailProf, ids.slug);

    const res = await trocarEmail(meu, SENHA, `mais-uma-${ids.sufixo}@config.test`);
    expect(res.statusCode).toBe(200);

    /* A sessão do outro aparelho morreu. Se o motivo da troca foi uma
       sessão alheia aberta, deixá-la viva não resolveria nada. */
    const dele = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: outroAparelho.cookie },
    });
    expect(dele.statusCode).toBe(401);

    /* E a minha continua: quem acabou de digitar a própria senha não
       precisa ser expulso da tela em que está. */
    const minha = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: meu.cookie },
    });
    expect(minha.statusCode).toBe(200);

    ids.emailProf = `mais-uma-${ids.sufixo}@config.test`;
  });

  it('a troca fica na auditoria da academia, com o e-mail novo', async () => {
    const { rows } = await comTenant(ids.tenant, (c) =>
      c.query<{ metadata: { email?: string } | null }>(
        `SELECT metadata FROM audit_log
          WHERE tenant_id = $1 AND action = 'profile.email_changed'
          ORDER BY created_at DESC LIMIT 1`,
        [ids.tenant],
      ),
    );
    expect(rows[0]?.metadata?.email).toBe(ids.emailProf);
  });

  it('sem token, ninguém troca e-mail nenhum', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/perfil/email',
      remoteAddress: ipDeTeste(),
      payload: { senhaAtual: SENHA, email: `anonimo-${ids.sufixo}@config.test` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('chutar senha na troca de e-mail esbarra no limite, e não vira um oráculo', async () => {
    /* MESMO IP de propósito: é o limitador que está sendo testado. Sem
       ele, quem pegasse uma sessão aberta poderia adivinhar a senha da
       pessoa uma tentativa por vez, com a própria rota dizendo quando
       acertou. */
    const s = await entrar(ids.emailProf, ids.slug);
    const ip = '198.51.100.254';
    const respostas: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await trocarEmail(s, `chute-${i}`, `chute-${i}-${ids.sufixo}@config.test`, ip);
      respostas.push(r.statusCode);
    }
    expect(respostas).toContain(429);
    /* 429 e não 500: o limite é uma resposta prevista, não um acidente. */
    expect(respostas.filter((c) => c >= 500)).toHaveLength(0);
  });

  /* ==================================================================
   * Trocar a própria senha
   * ================================================================ */

  it('troca a própria senha, e a antiga para de valer', async () => {
    const s = await entrar(ids.emailProf, ids.slug);
    const nova = 'outra-senha-de-teste-2026';

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: como(s.token),
      payload: { currentPassword: SENHA, newPassword: nova },
    });
    expect(res.statusCode).toBe(200);

    const velha = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ids.emailProf, password: SENHA, tenantSlug: ids.slug },
    });
    expect(velha.statusCode).toBe(401);

    await expect(entrar(ids.emailProf, ids.slug, nova)).resolves.toBeDefined();
  });
});
