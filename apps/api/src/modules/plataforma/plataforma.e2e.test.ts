import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Painel da plataforma, ponta a ponta.
 *
 * O QUE ESTES TESTES GUARDAM é a fronteira mais cara do sistema: quem
 * opera o SaaS não pertence a academia nenhuma, e mesmo assim consegue
 * entrar em qualquer uma. As duas metades disso precisam ser verdade ao
 * mesmo tempo —
 *
 *   1. o token do painel NÃO abre rota de academia, e o token de
 *      academia NÃO abre rota do painel (audiências separadas);
 *   2. o acesso de suporte funciona E deixa rastro na academia visitada,
 *      onde o dono dela enxerga.
 *
 * Um acesso de suporte sem rastro seria pior que nenhum: o dono da
 * academia perde a única prova de que alguém de fora esteve lá dentro.
 *
 * Requer TEST_DATABASE_URL num papel SEM BYPASSRLS.
 *
 * E requer TEST_MIGRATION_URL, que os outros testes não pedem: o
 * operador nasce em `platform_admins`, e `stabilize_app` foi
 * DELIBERADAMENTE revogado dessa tabela — a API só a alcança pelas
 * funções SECURITY DEFINER. Semear pela credencial da aplicação daria
 * "permission denied", e o jeito de fazer o teste passar seria conceder
 * à API o acesso que o desenho tira dela. Semear pela credencial de
 * migração mantém a revogação de pé; se ela cair um dia, o teste de
 * separação de audiência continua sendo quem avisa.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const TEST_MIGRATION_URL = process.env['TEST_MIGRATION_URL'];
const suite = TEST_DATABASE_URL && TEST_MIGRATION_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;
/** Conexão de migração — usada SÓ para semear e conferir. */
let raiz: pg.Pool;

const SENHA_OPERADOR = 'senha-de-operador-para-teste-2026';
const SENHA_ACADEMIA = 'senha-de-teste-longa-2026';

const ids = {
  operador: '',
  emailOperador: '',
  tenant: '',
  slug: '',
  emailDono: '',
  donoId: '',
  sufixo: '',
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

const como = (token: string) => ({ authorization: `Bearer ${token}` });

/*
 * O login do painel aceita 10 tentativas por IP a cada 15 minutos, e a
 * suíte inteira precisa de mais que isso. Cada chamada sai de um IP
 * próprio para que o limitador não vire o assunto de todos os testes —
 * ele tem um teste só dele, logo abaixo, que sim usa o mesmo IP.
 */
let proximoIp = 0;
const ipDeTeste = (): string => `203.0.113.${(proximoIp++ % 250) + 1}`;

/** Entra no painel e devolve o access token e o cookie de refresh. */
async function entrarNoPainel(
  senha = SENHA_OPERADOR,
  remoteAddress = ipDeTeste(),
): Promise<{ status: number; token: string; cookie: string; corpo: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/plataforma/login',
    remoteAddress,
    payload: { email: ids.emailOperador, senha },
  });
  const corpo = res.json() as Record<string, unknown>;
  const bruto = res.headers['set-cookie'];
  const cookies = Array.isArray(bruto) ? bruto : bruto === undefined ? [] : [bruto];
  const stz = cookies.find((c) => c.startsWith('stz_plt='));
  return {
    status: res.statusCode,
    token: (corpo['accessToken'] as string | undefined) ?? '',
    cookie: stz?.split(';')[0] ?? '',
    corpo,
  };
}

suite('Painel da plataforma', () => {
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
    raiz = new pg.Pool({ connectionString: TEST_MIGRATION_URL });

    ids.sufixo = crypto.randomUUID().slice(0, 8);
    ids.emailOperador = `op-${ids.sufixo}@plataforma.test`;
    ids.tenant = crypto.randomUUID();
    ids.slug = `plt-${ids.sufixo}`;
    ids.emailDono = `dono-${ids.sufixo}@plataforma.test`;

    const opcoes = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;
    const hashOperador = await argon2.hash(SENHA_OPERADOR, opcoes);
    const hashAcademia = await argon2.hash(SENHA_ACADEMIA, opcoes);

    /* `platform_admins` não tem tenant e não tem RLS por empresa: é
       tabela do serviço, não de cliente. Por isso entra por conexão
       normal, sem contexto. */
    const cliente = await raiz.connect();
    try {
      const r = await cliente.query<{ id: string }>(
        `INSERT INTO platform_admins (email, password_hash, full_name, must_change_password)
         VALUES ($1,$2,'Operador de Teste', true) RETURNING id`,
        [ids.emailOperador, hashOperador],
      );
      ids.operador = r.rows[0]!.id;
    } finally {
      cliente.release();
    }

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia da Plataforma',
        ids.slug,
      ]);
      const d = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono da Academia','OWNER') RETURNING id`,
        [ids.tenant, ids.emailDono, hashAcademia],
      );
      ids.donoId = d.rows[0]!.id;
      await c.query(`INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluna Reservada')`, [
        ids.tenant,
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await raiz?.end();
  });

  /* ==================================================================
   * Entrada
   * ================================================================ */

  it('recusa senha errada e não diz qual dos dois campos errou', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plataforma/login',
      remoteAddress: ipDeTeste(),
      payload: { email: ids.emailOperador, senha: 'senha-que-nao-e-a-dele' },
    });
    expect(res.statusCode).toBe(401);
    /* A mensagem não pode confirmar que o e-mail existe: isso transforma
       o login numa lista de operadores válidos. */
    expect(res.body.toLowerCase()).not.toContain('senha incorreta');
  });

  it('recusa e-mail que não existe com o MESMO 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plataforma/login',
      remoteAddress: ipDeTeste(),
      payload: { email: `nao-existe-${ids.sufixo}@plataforma.test`, senha: SENHA_OPERADOR },
    });
    expect(res.statusCode).toBe(401);
  });

  it('entra e anuncia que a senha ainda é a provisória', async () => {
    const { status, token, corpo } = await entrarNoPainel();
    expect(status).toBe(200);
    expect(token).not.toBe('');
    expect((corpo['admin'] as { precisaTrocarSenha: boolean }).precisaTrocarSenha).toBe(true);
  });

  it('trava a força bruta: o mesmo IP não passa de dez tentativas', async () => {
    /* IP fixo aqui de propósito — é o único teste que exercita o
       limitador, e o resto da suíte sai de IPs distintos justamente
       para não esbarrar nele por acidente. */
    const ip = '198.51.100.7';
    const respostas: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plataforma/login',
        remoteAddress: ip,
        payload: { email: `forca-bruta-${i}@plataforma.test`, senha: 'chute' },
      });
      respostas.push(res.statusCode);
    }
    expect(respostas.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(respostas.slice(10)).toEqual([429, 429]);
  }, 30_000);

  /* ==================================================================
   * Separação de audiência — as duas direções
   * ================================================================ */

  it('token do painel NÃO abre rota de academia', async () => {
    const { token } = await entrarNoPainel();
    const res = await app.inject({ method: 'GET', url: '/api/students', headers: como(token) });
    expect(res.statusCode).toBe(401);
  });

  it('token de academia NÃO abre rota do painel', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ids.emailDono, password: SENHA_ACADEMIA, tenantSlug: ids.slug },
    });
    const tokenDono = (login.json() as { accessToken: string }).accessToken;

    for (const url of ['/api/plataforma/metricas', '/api/plataforma/empresas']) {
      const res = await app.inject({ method: 'GET', url, headers: como(tokenDono) });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('sem token nenhum, o painel responde 401 e não 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plataforma/metricas' });
    expect(res.statusCode).toBe(401);
  });

  /* ==================================================================
   * Refresh
   * ================================================================ */

  it('o refresh devolve quem é, e a senha provisória continua pendente', async () => {
    const { cookie } = await entrarNoPainel();
    const res = await app.inject({
      method: 'POST',
      url: '/api/plataforma/refresh',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as { admin?: { nome: string; precisaTrocarSenha: boolean } };
    /* Sem isto, recarregar a página vira um desvio da troca obrigatória:
       a tela reabria já dentro do painel com a senha provisória ainda
       valendo. */
    expect(corpo.admin?.precisaTrocarSenha).toBe(true);
    expect(corpo.admin?.nome).toBe('Operador de Teste');
  });

  it('refresh usado duas vezes derruba a família inteira', async () => {
    const { cookie } = await entrarNoPainel();
    const primeiro = await app.inject({
      method: 'POST',
      url: '/api/plataforma/refresh',
      headers: { cookie },
    });
    expect(primeiro.statusCode).toBe(200);

    /* O MESMO cookie de novo: é o que um token roubado produziria. */
    const segundo = await app.inject({
      method: 'POST',
      url: '/api/plataforma/refresh',
      headers: { cookie },
    });
    expect(segundo.statusCode).toBe(401);

    /* E o token legítimo que veio do primeiro refresh também morre —
       não há como saber qual dos dois é o ladrão. */
    const bruto = primeiro.headers['set-cookie'];
    const lista = Array.isArray(bruto) ? bruto : bruto === undefined ? [] : [bruto];
    const novo = lista.find((c) => c.startsWith('stz_plt='))?.split(';')[0] ?? '';
    const terceiro = await app.inject({
      method: 'POST',
      url: '/api/plataforma/refresh',
      headers: { cookie: novo },
    });
    expect(terceiro.statusCode).toBe(401);
  });

  /* ==================================================================
   * O que o painel mostra — e o que não mostra
   * ================================================================ */

  it('as métricas são contagens e não trazem nome de aluno', async () => {
    const { token } = await entrarNoPainel();
    const res = await app.inject({
      method: 'GET',
      url: '/api/plataforma/metricas',
      headers: como(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Aluna Reservada');

    const { data } = res.json() as { data: Record<string, number> };
    /* `count(*)` volta como bigint, que o driver entrega em texto. Se
       alguém esquecer o `Number()`, a tela soma strings e mostra
       "12" + "3" = "123". */
    for (const [chave, valor] of Object.entries(data)) {
      expect(typeof valor, chave).toBe('number');
    }
    expect(data['empresas']).toBeGreaterThan(0);
  });

  it('a lista de academias traz a nossa, com contagem de alunos', async () => {
    const { token } = await entrarNoPainel();
    const res = await app.inject({
      method: 'GET',
      url: '/api/plataforma/empresas',
      headers: como(token),
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { slug: string; alunos: number }[] };
    const nossa = data.find((e) => e.slug === ids.slug);
    expect(nossa).toBeDefined();
    expect(nossa!.alunos).toBe(1);
  });

  /* ==================================================================
   * Cadastro de academia
   * ================================================================ */

  it('cadastra academia, e o responsável entra com a senha provisória', async () => {
    const { token } = await entrarNoPainel();
    const slug = `nova-${ids.sufixo}`;
    const email = `resp-${ids.sufixo}@plataforma.test`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/plataforma/empresas',
      headers: como(token),
      payload: {
        nome: 'Academia Recém-Nascida',
        slug,
        donoNome: 'Responsável Novo',
        donoEmail: email,
      },
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json() as {
      data: { empresaId: string; dono: { senhaProvisoria: string } };
    };
    const senha = data.dono.senhaProvisoria;
    expect(senha.length).toBeGreaterThanOrEqual(12);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: senha, tenantSlug: slug },
    });
    expect(login.statusCode).toBe(200);
    expect((login.json() as { user: { mustChangePassword?: boolean } }).user.mustChangePassword).toBe(
      true,
    );

    /* A academia nasce com a biblioteca pronta. Sem isso o primeiro
       treino do primeiro cliente começa numa tela vazia. */
    const exercicios = await comTenant(data.empresaId, (c) =>
      c.query<{ n: string }>('SELECT count(*)::text AS n FROM exercises WHERE tenant_id = $1', [
        data.empresaId,
      ]),
    );
    expect(Number(exercicios.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('recusa slug repetido em vez de criar duas academias com o mesmo endereço', async () => {
    const { token } = await entrarNoPainel();
    const res = await app.inject({
      method: 'POST',
      url: '/api/plataforma/empresas',
      headers: como(token),
      payload: {
        nome: 'Outra Qualquer',
        slug: ids.slug,
        donoNome: 'Alguém',
        donoEmail: `repetido-${ids.sufixo}@plataforma.test`,
      },
    });
    expect(res.statusCode).toBe(409);
  });

  /* ==================================================================
   * Acesso de suporte
   * ================================================================ */

  it('entra como usuário da academia, e o acesso fica registrado LÁ', async () => {
    const { token } = await entrarNoPainel();

    const antes = await comTenant(ids.tenant, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log
          WHERE tenant_id = $1 AND action = 'auth.support_access'`,
        [ids.tenant],
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/plataforma/usuarios/${ids.donoId}/entrar`,
      headers: como(token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const { data } = res.json() as { data: { accessToken: string; empresa: string } };
    expect(data.empresa).toBe('Academia da Plataforma');

    /* O token de suporte é token de academia de verdade: abre as rotas
       do papel de quem foi visitado. */
    const alunos = await app.inject({
      method: 'GET',
      url: '/api/students',
      headers: como(data.accessToken),
    });
    expect(alunos.statusCode).toBe(200);
    expect(alunos.body).toContain('Aluna Reservada');

    /* E o rastro é o ponto: o dono da academia precisa conseguir ver
       que alguém de fora entrou. */
    const depois = await comTenant(ids.tenant, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log
          WHERE tenant_id = $1 AND action = 'auth.support_access'`,
        [ids.tenant],
      ),
    );
    expect(Number(depois.rows[0]!.n)).toBe(Number(antes.rows[0]!.n) + 1);
  });

  it('o token de suporte NÃO vem com cookie de refresh', async () => {
    const { token } = await entrarNoPainel();
    const res = await app.inject({
      method: 'POST',
      url: `/api/plataforma/usuarios/${ids.donoId}/entrar`,
      headers: como(token),
    });
    const bruto = res.headers['set-cookie'];
    const lista = Array.isArray(bruto) ? bruto : bruto === undefined ? [] : [bruto];
    /* Sessão de suporte que se renova sozinha é sessão esquecida
       aberta. Ela dura o tempo do access token e acaba. */
    expect(lista.some((c) => c.startsWith('stz_refresh='))).toBe(false);
  });

  it('não entra em usuário de academia suspensa', async () => {
    const { token } = await entrarNoPainel();
    const empresas = await app.inject({
      method: 'GET',
      url: '/api/plataforma/empresas',
      headers: como(token),
    });
    const nossa = (empresas.json() as { data: { id: string; slug: string }[] }).data.find(
      (e) => e.slug === ids.slug,
    )!;

    const suspender = await app.inject({
      method: 'POST',
      url: `/api/plataforma/empresas/${nossa.id}/situacao`,
      headers: como(token),
      payload: { ativa: false, motivo: 'teste' },
    });
    expect(suspender.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/plataforma/usuarios/${ids.donoId}/entrar`,
      headers: como(token),
    });
    expect(res.statusCode).toBe(403);

    await app.inject({
      method: 'POST',
      url: `/api/plataforma/empresas/${nossa.id}/situacao`,
      headers: como(token),
      payload: { ativa: true, motivo: null },
    });
  });

  /* ==================================================================
   * Configuração do WhatsApp
   * ================================================================ */

  it('grava o token da uazapi e NUNCA o devolve para a tela', async () => {
    const { token } = await entrarNoPainel();
    const segredo = `tok-secreto-${ids.sufixo}`;

    const gravar = await app.inject({
      method: 'PUT',
      url: '/api/plataforma/config',
      headers: como(token),
      payload: { uazapiBaseUrl: 'https://free.uazapi.com', uazapiAdminToken: segredo },
    });
    expect(gravar.statusCode).toBe(200);

    const ler = await app.inject({
      method: 'GET',
      url: '/api/plataforma/config',
      headers: como(token),
    });
    expect(ler.statusCode).toBe(200);
    expect(ler.body).not.toContain(segredo);
    expect((ler.json() as { data: { temToken: boolean } }).data.temToken).toBe(true);

    /* E no banco ele está cifrado, não em claro. */
    const cliente = await raiz.connect();
    try {
      const { rows } = await cliente.query<{ v: string | null }>(
        'SELECT uazapi_admin_encrypted AS v FROM platform_settings LIMIT 1',
      );
      expect(rows[0]?.v ?? '').not.toContain(segredo);
    } finally {
      cliente.release();
    }
  });

  /* ==================================================================
   * Editar o usuário da academia
   * ================================================================ */

  it('edita nome, e-mail e papel — e a pessoa passa a entrar pelo e-mail novo', async () => {
    const { token } = await entrarNoPainel();

    /* Um segundo gestor, para o dono original não ser o único dono
       ativo: rebaixá-lo esbarraria na trava do último proprietário, que
       tem teste próprio logo abaixo. */
    const emailSocio = `socio-${ids.sufixo}@plataforma.test`;
    const criado = await app.inject({
      method: 'POST',
      url: `/api/plataforma/empresas/${ids.tenant}/gestores`,
      headers: como(token),
      payload: { nome: 'Sócio Silva', email: emailSocio, papel: 'OWNER' },
    });
    expect(criado.statusCode).toBe(201);
    const socioId = (criado.json() as { data: { id: string } }).data.id;

    const emailNovo = `socio-novo-${ids.sufixo}@plataforma.test`;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/plataforma/usuarios/${socioId}`,
      headers: como(token),
      payload: { nome: 'Sócia Andrade', email: emailNovo, papel: 'ADMIN' },
    });
    expect(res.statusCode).toBe(200);

    const lista = await app.inject({
      method: 'GET',
      url: `/api/plataforma/empresas/${ids.tenant}/usuarios`,
      headers: como(token),
    });
    const u = (lista.json() as { data: { id: string; nome: string; email: string; papel: string }[] })
      .data.find((x) => x.id === socioId);
    expect(u).toMatchObject({ nome: 'Sócia Andrade', email: emailNovo, papel: 'ADMIN' });

    /* O QUE O TESTE REALMENTE GUARDA: o e-mail é a identidade de login.
       Trocar o campo sem que o login acompanhe deixaria a pessoa de fora
       do sistema com um cadastro que parece certo na tela. */
    const senha = (
      (await app.inject({
        method: 'POST',
        url: `/api/plataforma/usuarios/${socioId}/senha`,
        headers: como(token),
      })).json() as { data: { senhaProvisoria: string } }
    ).data.senhaProvisoria;

    const entrou = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: emailNovo, password: senha, tenantSlug: ids.slug },
    });
    expect(entrou.statusCode).toBe(200);
  });

  it('não deixa a academia sem proprietário', async () => {
    const { token } = await entrarNoPainel();

    /* O dono original é agora o único OWNER ativo — o sócio virou ADMIN
       no teste anterior. Rebaixá-lo criaria uma academia onde ninguém
       pode nomear outro dono, e a saída seria um chamado. */
    const res = await app.inject({
      method: 'PUT',
      url: `/api/plataforma/usuarios/${ids.donoId}`,
      headers: como(token),
      payload: { nome: 'Dono da Academia', email: ids.emailDono, papel: 'ADMIN' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('proprietário');

    /* E não mexeu em nada: uma recusa que já tivesse gravado metade da
       alteração seria pior do que não recusar. */
    const lista = await app.inject({
      method: 'GET',
      url: `/api/plataforma/empresas/${ids.tenant}/usuarios`,
      headers: como(token),
    });
    const dono = (lista.json() as { data: { id: string; papel: string }[] }).data.find(
      (x) => x.id === ids.donoId,
    );
    expect(dono!.papel).toBe('OWNER');
  });

  it('recusa e-mail que já é de outra pessoa da mesma academia', async () => {
    const { token } = await entrarNoPainel();
    const outro = await app.inject({
      method: 'POST',
      url: `/api/plataforma/empresas/${ids.tenant}/gestores`,
      headers: como(token),
      payload: {
        nome: 'Terceiro Nome',
        email: `terceiro-${ids.sufixo}@plataforma.test`,
        papel: 'ADMIN',
      },
    });
    const outroId = (outro.json() as { data: { id: string } }).data.id;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/plataforma/usuarios/${outroId}`,
      headers: como(token),
      payload: { nome: 'Terceiro Nome', email: ids.emailDono, papel: 'ADMIN' },
    });
    expect(res.statusCode).toBe(409);
  });

  /* ==================================================================
   * Excluir a academia
   *
   * A única ação do sistema que destrói dado de cliente. Os testes daqui
   * existem para as DUAS TRANCAS não sumirem numa refatoração: elas são
   * duas linhas de guarda que passariam despercebidas no diff, e sem
   * elas um clique errado na lista apaga uma academia inteira.
   * ================================================================ */

  it('não exclui academia que ainda está no ar', async () => {
    const { token } = await entrarNoPainel();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/plataforma/empresas/${ids.tenant}`,
      headers: como(token),
      payload: { confirmacao: ids.slug },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Suspenda');

    const ainda = await comTenant(ids.tenant, (c) =>
      c.query('SELECT 1 FROM tenants WHERE id = $1', [ids.tenant]),
    );
    expect(ainda.rowCount).toBe(1);
  });

  it('exclui a academia suspensa quando o identificador confere, e leva os dados junto', async () => {
    const { token } = await entrarNoPainel();

    /* Uma academia descartável, criada pela própria API: excluir a
       academia principal levaria junto o resto da suíte. */
    const slug = `descartavel-${ids.sufixo}`;
    const criada = await app.inject({
      method: 'POST',
      url: '/api/plataforma/empresas',
      headers: como(token),
      payload: {
        nome: 'Academia Descartável',
        slug,
        donoNome: 'Dono Passageiro',
        donoEmail: `passageiro-${ids.sufixo}@plataforma.test`,
      },
    });
    expect(criada.statusCode).toBe(201);
    const empresaId = (criada.json() as { data: { empresaId: string } }).data.empresaId;

    await comTenant(empresaId, (c) =>
      c.query(`INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno Que Some')`, [empresaId]),
    );

    /* Suspender primeiro — é o que a trava exige. */
    const suspensa = await app.inject({
      method: 'POST',
      url: `/api/plataforma/empresas/${empresaId}/situacao`,
      headers: como(token),
      payload: { ativa: false, motivo: 'encerrou o contrato' },
    });
    expect(suspensa.statusCode).toBe(200);

    /* O identificador errado não passa, mesmo com a academia suspensa.
       Confirmar com "sim" é reflexo; digitar o slug é leitura. */
    const errado = await app.inject({
      method: 'DELETE',
      url: `/api/plataforma/empresas/${empresaId}`,
      headers: como(token),
      payload: { confirmacao: `${slug}-quase` },
    });
    expect(errado.statusCode).toBe(400);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/plataforma/empresas/${empresaId}`,
      headers: como(token),
      payload: { confirmacao: slug },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { alunos: number } }).data.alunos).toBe(1);

    /* Foi mesmo, e levou junto: as chaves são ON DELETE CASCADE, e é
       essa cascata que faz a exclusão significar o que promete. */
    const sobrou = await comTenant(empresaId, async (c) => ({
      tenant: (await c.query('SELECT 1 FROM tenants WHERE id = $1', [empresaId])).rowCount,
      alunos: (await c.query('SELECT 1 FROM students WHERE tenant_id = $1', [empresaId])).rowCount,
      usuarios: (await c.query('SELECT 1 FROM users WHERE tenant_id = $1', [empresaId])).rowCount,
    }));
    expect(sobrou).toEqual({ tenant: 0, alunos: 0, usuarios: 0 });

    /* O REGISTRO SOBREVIVE À ACADEMIA. `platform_audit.tenant_id` não
       tem chave estrangeira justamente para isto: quem excluiu, quando,
       e o tamanho do que foi apagado continuam legíveis depois que não
       há mais nada para juntar à linha. */
    const historico = await app.inject({
      method: 'GET',
      url: '/api/plataforma/historico',
      headers: como(token),
    });
    const linhas = (historico.json() as { data: { acao: string; alvo: string | null }[] }).data;
    expect(linhas.some((m) => m.acao === 'plataforma.empresa_excluida' && m.alvo === slug)).toBe(
      true,
    );
  });

  /* ==================================================================
   * Troca de senha
   * ================================================================ */

  it('troca a senha, derruba a sessão antiga e a nova senha passa a valer', async () => {
    const nova = 'senha-nova-do-operador-2026';
    const { token, cookie } = await entrarNoPainel();

    const res = await app.inject({
      method: 'POST',
      url: '/api/plataforma/senha',
      headers: como(token),
      payload: { atual: SENHA_OPERADOR, nova },
    });
    expect(res.statusCode).toBe(200);

    /* A TROCA JÁ DEIXA O OPERADOR DENTRO. Ele digitou a senha antiga e a
       nova na mesma tela; mandá-lo para o login em seguida era uma parede
       que não guardava nada. A resposta traz a sessão nova, e ela é uma
       sessão de verdade: abre rota autenticada e a exigência de troca já
       consta cumprida. */
    const depois = res.json() as {
      accessToken: string;
      admin: { precisaTrocarSenha: boolean };
    };
    expect(depois.admin.precisaTrocarSenha).toBe(false);

    const dentro = await app.inject({
      method: 'GET',
      url: '/api/plataforma/metricas',
      headers: como(depois.accessToken),
    });
    expect(dentro.statusCode).toBe(200);

    /* E o que estava aberto ANTES continua encerrado — é justamente o
       cenário em que se troca uma senha. A sessão nova nasceu depois da
       revogação; a velha não ressuscita com ela. */
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/plataforma/refresh',
      headers: { cookie },
    });
    expect(refresh.statusCode).toBe(401);

    const velha = await entrarNoPainel(SENHA_OPERADOR);
    expect(velha.status).toBe(401);

    const nova2 = await entrarNoPainel(nova);
    expect(nova2.status).toBe(200);
    /* E a exigência de troca some: ela já foi feita. */
    expect((nova2.corpo['admin'] as { precisaTrocarSenha: boolean }).precisaTrocarSenha).toBe(false);
  });
});
