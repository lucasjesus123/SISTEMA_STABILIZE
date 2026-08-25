import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * O recorte por pessoa — ponta a ponta.
 *
 * O papel diz o que alguém PODE ser autorizado a fazer; a área diz o que
 * essa pessoa de fato faz na academia. Quem cuida do financeiro não abre
 * prontuário de aluno, e até então a única forma de conseguir isso era
 * não dar acesso nenhum.
 *
 * O QUE ESTES TESTES GUARDAM:
 *
 *   1. O CORTE VALE NO SERVIDOR. Esconder a seção no menu não protege
 *      rota nenhuma — uma área que só existisse na tela seria enfeite, e
 *      quem chamasse a rota direto entraria. Por isso todo teste aqui
 *      bate na API, nunca no menu.
 *
 *   2. ÁREA ESTREITA, NUNCA ALARGA. No dia em que marcar uma área puder
 *      acrescentar permissão fora do papel, a matriz de papéis deixa de
 *      responder "o que este papel enxerga?".
 *
 *   3. MUDAR O ACESSO DERRUBA A SESSÃO. As áreas viajam no token para a
 *      autorização não custar uma consulta por requisição; sem derrubar
 *      a sessão, tirar o financeiro de alguém só valeria no token
 *      seguinte.
 *
 *   4. NINGUÉM SE TRANCA FORA. Um administrador que recortasse a si
 *      mesmo e deixasse "Usuários" de fora perderia a tela que devolve o
 *      acesso.
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
  emailFinanceiro: '',
  idFinanceiro: '',
  senhaFinanceiro: '',
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

interface Sessao {
  token: string;
  cookie: string;
}

async function entrar(email: string, senha = SENHA): Promise<Sessao> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: senha, tenantSlug: ids.slug },
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

/** Cadastra alguém pela API da academia, como o administrador faria. */
async function cadastrar(
  s: Sessao,
  dados: { nome: string; email: string; papel: string; areas?: string[] | null },
): Promise<{ status: number; id: string; senha: string; corpo: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/cadastros/usuarios',
    headers: como(s.token),
    payload: dados,
  });
  const corpo = res.body;
  if (res.statusCode !== 201) return { status: res.statusCode, id: '', senha: '', corpo };
  const d = (res.json() as { data: { id: string; senhaProvisoria: string } }).data;
  return { status: res.statusCode, id: d.id, senha: d.senhaProvisoria, corpo };
}

/** Tira a exigência de troca de senha, para poder usar a conta no teste. */
async function liberar(id: string): Promise<void> {
  await comTenant((c) =>
    c.query('UPDATE users SET must_change_password = false WHERE id = $1', [id]),
  );
}

suite('Recorte de acesso por pessoa', () => {
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
    ids.slug = `areas-${ids.sufixo}`;
    ids.emailDono = `dono-${ids.sufixo}@areas.test`;
    ids.emailFinanceiro = `fin-${ids.sufixo}@areas.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia das Áreas',
        ids.slug,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dona da Academia','OWNER')`,
        [ids.tenant, ids.emailDono, hash],
      );
      await c.query(`INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluna Qualquer')`, [
        ids.tenant,
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ================================================================== */

  it('a pessoa do financeiro entra no financeiro e NÃO alcança os alunos', async () => {
    const dona = await entrar(ids.emailDono);

    const criado = await cadastrar(dona, {
      nome: 'Financeiro da Casa',
      email: ids.emailFinanceiro,
      papel: 'ADMIN',
      areas: ['financeiro'],
    });
    expect(criado.status).toBe(201);
    ids.idFinanceiro = criado.id;
    ids.senhaFinanceiro = criado.senha;

    await liberar(criado.id);
    const fin = await entrar(ids.emailFinanceiro, criado.senha);

    /* O QUE ELA FAZ. */
    const caixa = await app.inject({
      method: 'GET',
      url: '/api/finance/recorrencias',
      headers: como(fin.token),
    });
    expect(caixa.statusCode).toBe(200);

    /* O QUE ELA NÃO FAZ — e a recusa vem do SERVIDOR, não do menu. Um
       ADMIN sem recorte abre todas estas; é o recorte que fecha. */
    for (const url of [
      '/api/cadastros/usuarios',
      '/api/schedule/',
      '/api/crm/',
    ]) {
      const r = await app.inject({ method: 'GET', url, headers: como(fin.token) });
      expect(r.statusCode, `deveria barrar ${url}`).toBe(403);
    }

    /* A LISTA DE ALUNOS ELA ALCANÇA, e isto é decisão e não descuido:
       uma cobrança precisa dizer de quem é, e a tela do financeiro tem
       um seletor de aluno. `student:read` está na área financeira por
       isso.

       O QUE ELA NÃO ALCANÇA É O PRONTUÁRIO — anamnese, evolução, anexo —,
       que é o dado clínico e o motivo da separação existir. E a seção
       "Alunos" não aparece no menu dela: o recorte também chega à tela,
       porque `student:read` sozinho a abriria. */
    const lista = await app.inject({
      method: 'GET',
      url: '/api/students',
      headers: como(fin.token),
    });
    expect(lista.statusCode).toBe(200);

    const alunoId = (lista.json() as { data: { id: string }[] }).data[0]?.id;
    expect(alunoId).toBeDefined();
    for (const url of [
      `/api/students/${alunoId!}/anamnese`,
      `/api/students/${alunoId!}/evolucoes`,
      `/api/students/${alunoId!}/anexos`,
    ]) {
      const r = await app.inject({ method: 'GET', url, headers: como(fin.token) });
      expect(r.statusCode, `deveria barrar ${url}`).toBe(403);
    }

    const eu = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: como(fin.token),
    });
    expect((eu.json() as { areas: string[] | null }).areas).toEqual(['financeiro']);
  });

  it('o menu que a tela recebe é o mesmo recorte', async () => {
    const fin = await entrar(ids.emailFinanceiro, ids.senhaFinanceiro);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: como(fin.token) });
    expect(res.statusCode).toBe(200);

    const { permissions } = res.json() as { permissions: string[] };
    expect(permissions).toContain('finance:report:read');
    expect(permissions).not.toContain('anamnesis:read');
    expect(permissions).not.toContain('user:read');
    /* Se o `/me` mandasse o papel inteiro e só a rota barrasse, a tela
       desenharia seções que respondem 403 ao primeiro clique. */
  });

  it('NÃO ALARGA: marcar financeiro numa recepção não inventa financeiro', async () => {
    const dona = await entrar(ids.emailDono);
    const criado = await cadastrar(dona, {
      nome: 'Recepção Curiosa',
      email: `recep-${ids.sufixo}@areas.test`,
      papel: 'RECEPTION',
      areas: ['financeiro', 'recepcao'],
    });
    expect(criado.status).toBe(201);
    await liberar(criado.id);

    const recep = await entrar(`recep-${ids.sufixo}@areas.test`, criado.senha);
    const caixa = await app.inject({
      method: 'GET',
      url: '/api/finance/recorrencias',
      headers: como(recep.token),
    });
    /* A área pede `finance:*`; o papel RECEPTION não tem. Interseção é
       vazia, e o resultado é 403 — não o financeiro da academia na mão
       de quem atende o balcão. */
    expect(caixa.statusCode).toBe(403);
  });

  it('sem recorte, o papel continua inteiro — ninguém perdeu acesso', async () => {
    const dona = await entrar(ids.emailDono);
    const criado = await cadastrar(dona, {
      nome: 'Administrador Completo',
      email: `full-${ids.sufixo}@areas.test`,
      papel: 'ADMIN',
      areas: null,
    });
    expect(criado.status).toBe(201);
    await liberar(criado.id);

    const adm = await entrar(`full-${ids.sufixo}@areas.test`, criado.senha);
    for (const url of ['/api/students', '/api/finance/recorrencias', '/api/cadastros/usuarios']) {
      const r = await app.inject({ method: 'GET', url, headers: como(adm.token) });
      expect(r.statusCode, url).toBe(200);
    }
  });

  it('mexer no acesso derruba a sessão da pessoa — o corte é na hora', async () => {
    const dona = await entrar(ids.emailDono);
    const fin = await entrar(ids.emailFinanceiro, ids.senhaFinanceiro);

    /* Antes: a sessão dela renova normalmente. */
    const antes = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: fin.cookie },
    });
    expect(antes.statusCode).toBe(200);

    const editado = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/usuarios/${ids.idFinanceiro}`,
      headers: como(dona.token),
      payload: {
        nome: 'Financeiro da Casa',
        papel: 'ADMIN',
        cor: '#2E6F6F',
        areas: ['financeiro', 'agenda'],
      },
    });
    expect(editado.statusCode, editado.body).toBe(200);

    /* Depois: caiu. Sem isto, tirar o financeiro de alguém só valeria
       quando o token vencesse — e o token dura o suficiente para a
       pessoa terminar o que estava fazendo. */
    const depois = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: fin.cookie },
    });
    expect(depois.statusCode).toBe(401);

    /* E ao entrar de novo, o acesso novo já vale. */
    const denovo = await entrar(ids.emailFinanceiro, ids.senhaFinanceiro);
    const agenda = await app.inject({
      method: 'GET',
      url: '/api/schedule/?de=2026-01-01&ate=2026-01-31',
      headers: como(denovo.token),
    });
    expect(agenda.statusCode, agenda.body).toBe(200);
  });

  it('ninguém se tranca fora do próprio sistema', async () => {
    const dona = await entrar(ids.emailDono);
    const eu = (
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: como(dona.token) })).json() as {
        id: string;
      }
    ).id;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/usuarios/${eu}`,
      headers: como(dona.token),
      payload: { nome: 'Dona da Academia', papel: 'OWNER', cor: '#2E6F6F', areas: ['financeiro'] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Usuários');

    /* Marcar "Usuários" junto é permitido: aí a saída continua existindo. */
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/usuarios/${eu}`,
      headers: como(dona.token),
      payload: {
        nome: 'Dona da Academia',
        papel: 'OWNER',
        cor: '#2E6F6F',
        areas: ['financeiro', 'equipe'],
      },
    });
    expect(ok.statusCode).toBe(200);

    /* E desfaz, para não deixar a dona recortada para os testes
       seguintes desta suíte. */
    await app.inject({
      method: 'PUT',
      url: `/api/cadastros/usuarios/${eu}`,
      headers: como(dona.token),
      payload: { nome: 'Dona da Academia', papel: 'OWNER', cor: '#2E6F6F', areas: null },
    });
  });

  it('área inventada não vira acesso nenhum — nem tudo, nem metade', async () => {
    const dona = await entrar(ids.emailDono);
    const criado = await cadastrar(dona, {
      nome: 'Digitação Errada',
      email: `erro-${ids.sufixo}@areas.test`,
      papel: 'ADMIN',
      areas: ['financiero', 'alunos'],
    });
    expect(criado.status).toBe(201);
    await liberar(criado.id);

    const p = await entrar(`erro-${ids.sufixo}@areas.test`, criado.senha);

    /* "financiero" foi descartado na entrada — o banco tem CHECK contra
       valor desconhecido, e a rota filtra antes de gravar. Sobrou
       "alunos", e só. */
    expect(
      (await app.inject({ method: 'GET', url: '/api/students', headers: como(p.token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/finance/recorrencias', headers: como(p.token) }))
        .statusCode,
    ).toBe(403);
  });
});
