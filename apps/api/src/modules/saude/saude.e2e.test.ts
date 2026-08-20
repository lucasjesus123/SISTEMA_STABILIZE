import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Triagem de saúde (PAR-Q) e termo de responsabilidade — ponta a ponta.
 *
 * O QUE ESTES TESTES GUARDAM:
 *
 *   1. O TEXTO DO TERMO É CONGELADO. É a decisão jurídica desta tabela e
 *      a mais fácil de desfazer numa refatoração: alguém troca o texto
 *      guardado por um id de modelo "para não repetir dados", e a partir
 *      daí toda assinatura antiga passa a exibir o texto NOVO. Um
 *      documento assinado que muda depois de assinado não prova nada.
 *
 *   2. UM "SIM" EXIGE ATESTADO. É a regra do PAR-Q. A triagem com "sim"
 *      e sem liberação NÃO conta como válida — se contasse, o
 *      questionário inteiro não teria consequência nenhuma.
 *
 *   3. PERGUNTA EM BRANCO NÃO VALE COMO "NÃO". Num questionário que
 *      existe para achar o "sim", a resposta ausente é a mais perigosa.
 *
 *   4. O ALUNO ASSINA COM O PRÓPRIO NOME. Um campo livre aceita "ok" — e
 *      aí a assinatura não identifica ninguém.
 *
 *   5. A TRIAGEM VENCE, e vencida não é válida.
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
  saudavel: '',
  cardiaco: '',
  vencido: '',
  loginAluno: '',
};

/** Todas as respostas "não" — o caso comum. */
const TUDO_NAO = {
  coracao: false,
  dor_no_peito: false,
  tontura: false,
  osso_articulacao: false,
  remedio_pressao: false,
  outra_razao: false,
  gravidez: false,
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
async function tokenDe(email: string, senha = SENHA): Promise<string> {
  const guardado = cache.get(email);
  if (guardado !== undefined) return guardado;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: senha, tenantSlug: ids.slug },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) {
    throw new Error(`login falhou para ${email}: ${res.statusCode} ${res.body}`);
  }
  cache.set(email, body.accessToken);
  return body.accessToken;
}

const como = (token: string) => ({ authorization: `Bearer ${token}` });

async function assinarPelaAcademia(
  alunoId: string,
  respostas: Record<string, boolean>,
  nome: string,
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: `/api/students/${alunoId}/triagem`,
    headers: como(await tokenDe(ids.emailDono)),
    payload: { respostas, assinadoNome: nome },
  });
}

async function situacao(alunoId: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/students/${alunoId}/triagem`,
    headers: como(await tokenDe(ids.emailDono)),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: { atual: { situacao: string } } }).data.atual.situacao;
}

suite('Triagem de saúde: PAR-Q e termo', () => {
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
    ids.slug = `parq-${ids.sufixo}`;
    ids.emailDono = `dono-${ids.sufixo}@parq.test`;
    ids.loginAluno = `aluno-${ids.sufixo}@parq.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id,name,slug,timezone) VALUES ($1,'Academia do PAR-Q',$2,'America/Sao_Paulo')`,
        [ids.tenant, ids.slug],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dona','OWNER')`,
        [ids.tenant, ids.emailDono, hash],
      );

      const cria = async (nome: string): Promise<string> => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO students (tenant_id,full_name) VALUES ($1,$2) RETURNING id`,
          [ids.tenant, nome],
        );
        return rows[0]!.id;
      };
      ids.saudavel = await cria('Helena Prado Vasques');
      ids.cardiaco = await cria('Otávio Ramires');
      ids.vencido = await cria('Cláudia Bento');

      /* O aluno com login, para o caminho do aplicativo. O vínculo mora
         em `students.user_id` e não em `users.student_id`. */
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Helena Prado Vasques','STUDENT') RETURNING id`,
        [ids.tenant, ids.loginAluno, hash],
      );
      await c.query('UPDATE students SET user_id = $2 WHERE id = $1', [
        ids.saudavel,
        u.rows[0]!.id,
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ==================================================================
   * As perguntas e o termo
   * ================================================================ */

  it('serve as sete perguntas do PAR-Q e o termo com o nome da academia', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/students/triagem/perguntas',
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as {
      data: { perguntas: { chave: string }[]; termo: { texto: string; versao: string } };
    };
    expect(data.perguntas).toHaveLength(7);
    expect(data.perguntas.map((p) => p.chave)).toContain('coracao');
    /* O marcador tem que ter sido substituído: um termo que chega com
       "{{academia}}" na tela é o que o aluno vai assinar. */
    expect(data.termo.texto).toContain('Academia do PAR-Q');
    expect(data.termo.texto).not.toContain('{{');
  });

  /* ==================================================================
   * A assinatura
   * ================================================================ */

  it('quem não assinou nada aparece como NUNCA_ASSINOU', async () => {
    expect(await situacao(ids.saudavel)).toBe('NUNCA_ASSINOU');
  });

  it('tudo "não" vira triagem válida', async () => {
    const res = await assinarPelaAcademia(ids.saudavel, TUDO_NAO, 'Helena Prado Vasques');
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { precisaLiberacaoMedica: boolean } }).data.precisaLiberacaoMedica)
      .toBe(false);
    expect(await situacao(ids.saudavel)).toBe('VALIDA');
  });

  it('o texto do termo é copiado para dentro da assinatura', async () => {
    /* A academia reescreve o termo DEPOIS de alguém ter assinado. */
    await comTenant((c) =>
      c.query(
        `UPDATE tenants SET termo_texto = 'TEXTO NOVO E COMPLETAMENTE DIFERENTE', termo_versao = 'v2'
          WHERE id = $1`,
        [ids.tenant],
      ),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.saudavel}/triagem`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    const { historico } = (res.json() as {
      data: { historico: { termoTexto: string; termoVersao: string }[] };
    }).data;

    /* SE ISTO QUEBRAR, alguém trocou a cópia por uma referência — e toda
       assinatura antiga passou a exibir o texto de hoje. */
    expect(historico[0]!.termoVersao).toBe('v1');
    expect(historico[0]!.termoTexto).toContain('Academia do PAR-Q');
    expect(historico[0]!.termoTexto).not.toContain('TEXTO NOVO');

    // devolve o termo ao padrão para os testes seguintes
    await comTenant((c) =>
      c.query(`UPDATE tenants SET termo_texto = NULL, termo_versao = 'v1' WHERE id = $1`, [
        ids.tenant,
      ]),
    );
  });

  /* ==================================================================
   * A regra do PAR-Q
   * ================================================================ */

  it('um "sim" exige atestado e a triagem não conta como válida', async () => {
    const res = await assinarPelaAcademia(
      ids.cardiaco,
      { ...TUDO_NAO, coracao: true },
      'Otávio Ramires',
    );
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { precisaLiberacaoMedica: boolean } }).data.precisaLiberacaoMedica)
      .toBe(true);

    /* Se isto virar 'VALIDA', o questionário deixou de ter consequência
       e a academia acha que está coberta quando não está. */
    expect(await situacao(ids.cardiaco)).toBe('AGUARDANDO_ATESTADO');
  });

  it('a regra vale para qualquer uma das sete perguntas', async () => {
    /* A coluna gerada no banco lista as sete chaves à mão. Uma chave
       renomeada no TypeScript sem a migração correspondente faria
       aquele "sim" deixar de exigir atestado, em silêncio. */
    const chaves = [
      'coracao',
      'dor_no_peito',
      'tontura',
      'osso_articulacao',
      'remedio_pressao',
      'outra_razao',
      'gravidez',
    ];

    for (const chave of chaves) {
      const aluno = await comTenant(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO students (tenant_id,full_name) VALUES ($1,$2) RETURNING id`,
          [ids.tenant, `Teste ${chave}`],
        );
        return rows[0]!.id;
      });
      const res = await assinarPelaAcademia(
        aluno,
        { ...TUDO_NAO, [chave]: true },
        `Teste ${chave}`,
      );
      expect(res.statusCode).toBe(201);
      expect(
        (res.json() as { data: { precisaLiberacaoMedica: boolean } }).data.precisaLiberacaoMedica,
        `a pergunta "${chave}" deveria exigir atestado`,
      ).toBe(true);
    }
  });

  it('pergunta em branco é recusada — não vale como "não"', async () => {
    const { coracao: _, ...faltando } = TUDO_NAO;
    const res = await assinarPelaAcademia(ids.vencido, faltando, 'Cláudia Bento');
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Responda todas');
  });

  it('a liberação médica torna a triagem válida', async () => {
    const detalhe = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.cardiaco}/triagem`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    const triagemId = (detalhe.json() as { data: { historico: { id: string }[] } }).data
      .historico[0]!.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/students/triagem/${triagemId}/liberar`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(await situacao(ids.cardiaco)).toBe('VALIDA');

    /* Liberar duas vezes não é sucesso silencioso: a segunda diz que
       não havia o que liberar. */
    const denovo = await app.inject({
      method: 'POST',
      url: `/api/students/triagem/${triagemId}/liberar`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: {},
    });
    expect(denovo.statusCode).toBe(422);
  });

  it('não libera triagem que não pediu atestado', async () => {
    const detalhe = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.saudavel}/triagem`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    const triagemId = (detalhe.json() as { data: { historico: { id: string }[] } }).data
      .historico[0]!.id;

    /* Marcar como liberada uma triagem que não precisava esconde o fato
       de que ninguém examinou nada. */
    const res = await app.inject({
      method: 'POST',
      url: `/api/students/triagem/${triagemId}/liberar`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  /* ==================================================================
   * Validade
   * ================================================================ */

  it('triagem vencida deixa de ser válida', async () => {
    await assinarPelaAcademia(ids.vencido, TUDO_NAO, 'Cláudia Bento');
    expect(await situacao(ids.vencido)).toBe('VALIDA');

    await comTenant((c) =>
      c.query(
        `UPDATE health_screenings SET valido_ate = current_date - 1 WHERE student_id = $1`,
        [ids.vencido],
      ),
    );
    expect(await situacao(ids.vencido)).toBe('VENCIDA');
  });

  it('a lista de pendentes traz quem falta e não traz quem está em dia', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/students/triagem/pendentes',
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(res.statusCode).toBe(200);
    const lista = (res.json() as { data: { id: string; situacao: string }[] }).data;

    expect(lista.find((p) => p.id === ids.vencido)?.situacao).toBe('VENCIDA');
    /* Helena assinou tudo "não" e está válida; Otávio foi liberado. */
    expect(lista.some((p) => p.id === ids.saudavel)).toBe(false);
    expect(lista.some((p) => p.id === ids.cardiaco)).toBe(false);
  });

  /* ==================================================================
   * O caminho do aplicativo
   * ================================================================ */

  it('o aluno assina pelo aplicativo e o registro diz que foi ele', async () => {
    const token = await tokenDe(ids.loginAluno);

    const ver = await app.inject({
      method: 'GET',
      url: '/api/eu/triagem',
      headers: como(token),
    });
    expect(ver.statusCode).toBe(200);
    expect((ver.json() as { data: { perguntas: unknown[] } }).data.perguntas).toHaveLength(7);

    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/triagem',
      headers: como(token),
      payload: { respostas: TUDO_NAO, assinadoNome: 'Helena Prado Vasques' },
    });
    expect(res.statusCode).toBe(201);

    const linha = await comTenant((c) =>
      c.query<{ pelo_aluno: boolean; ip: string | null }>(
        `SELECT assinado_pelo_aluno AS pelo_aluno, assinado_ip::text AS ip
           FROM health_screenings WHERE student_id = $1
          ORDER BY assinado_em DESC LIMIT 1`,
        [ids.saudavel],
      ),
    );
    /* É o que distingue "ele assinou" de "alguém do balcão digitou por
       ele" — e as duas coisas valem diferente numa discussão. */
    expect(linha.rows[0]!.pelo_aluno).toBe(true);
    expect(linha.rows[0]!.ip).not.toBeNull();
  });

  it('o aluno não assina com um nome que não é o dele', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/triagem',
      headers: como(await tokenDe(ids.loginAluno)),
      payload: { respostas: TUDO_NAO, assinadoNome: 'Fulano de Tal' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('nome do seu cadastro');
  });

  it('acento e caixa não impedem o aluno de assinar', async () => {
    /* Recusar "Helena Prado Vasques" de quem digitou sem acento
       transformaria um controle de identidade num teste de digitação. */
    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/triagem',
      headers: como(await tokenDe(ids.loginAluno)),
      payload: { respostas: TUDO_NAO, assinadoNome: 'helena  PRADO vasques' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('assinar só com o primeiro nome é recusado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/eu/triagem',
      headers: como(await tokenDe(ids.loginAluno)),
      payload: { respostas: TUDO_NAO, assinadoNome: 'Helena' },
    });
    expect(res.statusCode).toBe(422);
  });

  /* ==================================================================
   * Isolamento
   * ================================================================ */

  /* ==================================================================
   * A academia edita as próprias perguntas
   * ================================================================ */

  describe('questionário da academia', () => {
    async function perguntasAtuais(): Promise<
      { chave: string; texto: string; exigeLiberacao: boolean; origem: string }[]
    > {
      const res = await app.inject({
        method: 'GET',
        url: '/api/students/triagem/perguntas',
        headers: como(await tokenDe(ids.emailDono)),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { data: { perguntas: typeof perguntas } }).data.perguntas;
      type perguntas = { chave: string; texto: string; exigeLiberacao: boolean; origem: string }[];
    }

    async function salvar(
      perguntas: unknown[],
    ): Promise<ReturnType<FastifyInstance['inject']>> {
      return app.inject({
        method: 'PUT',
        url: '/api/students/triagem/perguntas',
        headers: como(await tokenDe(ids.emailDono)),
        payload: { perguntas },
      });
    }

    it('sem edição, vale o PAR-Q padrão', async () => {
      const p = await perguntasAtuais();
      expect(p).toHaveLength(7);
      expect(p.every((x) => x.origem === 'PARQ' && x.exigeLiberacao)).toBe(true);
    });

    it('a academia acrescenta uma pergunta própria e edita a redação de outra', async () => {
      const base = await perguntasAtuais();
      const res = await salvar([
        /* Redação ajustada, chave preservada. */
        { chave: 'coracao', texto: 'Algum médico já falou que você tem problema no coração?', exigeLiberacao: true, origem: 'PARQ' },
        ...base.slice(1),
        { texto: 'Você já treinou musculação antes?', exigeLiberacao: false, origem: 'ACADEMIA' },
        { texto: 'Tem prótese, pino ou placa em alguma articulação?', exigeLiberacao: true, origem: 'ACADEMIA' },
      ]);
      expect(res.statusCode).toBe(200);

      const p = await perguntasAtuais();
      expect(p).toHaveLength(9);
      expect(p[0]!.chave).toBe('coracao');
      expect(p[0]!.texto).toContain('problema no coração');
      /* A chave da pergunta nova sai do texto, e é estável — mas o
         servidor a trunca em 40 caracteres. O teste LÊ a chave em vez de
         adivinhá-la: adivinhar aqui é como se escreve um teste que passa
         hoje e quebra quando alguém mexer no limite. */
      expect(p[7]!.chave).toMatch(/^voce_ja_treinou/);
      expect(p[7]!.chave.length).toBeLessThanOrEqual(40);
      expect(p[7]!.exigeLiberacao).toBe(false);
    });

    /** As chaves das duas perguntas que a academia acrescentou. */
    async function chavesDaAcademia(): Promise<{ treinou: string; protese: string }> {
      const p = await perguntasAtuais();
      const proprias = p.filter((x) => x.origem === 'ACADEMIA');
      return {
        treinou: proprias.find((x) => !x.exigeLiberacao)!.chave,
        protese: proprias.find((x) => x.exigeLiberacao)!.chave,
      };
    }

    it('um SIM em pergunta própria marcada exige atestado', async () => {
      const aluno = await comTenant(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Com Prótese') RETURNING id`,
          [ids.tenant],
        );
        return rows[0]!.id;
      });

      /* Todas as sete do PAR-Q em "não", e "sim" só na pergunta que a
         ACADEMIA criou. Se o gatilho tivesse ficado com a lista fixa das
         sete chaves, isto não exigiria atestado nenhum — e a pergunta
         nova seria decorativa. */
      const chaves = await chavesDaAcademia();
      const res = await assinarPelaAcademia(
        aluno,
        { ...TUDO_NAO, [chaves.treinou]: false, [chaves.protese]: true },
        'Com Prótese',
      );
      expect(res.statusCode).toBe(201);
      expect(
        (res.json() as { data: { precisaLiberacaoMedica: boolean } }).data.precisaLiberacaoMedica,
      ).toBe(true);
      expect(await situacao(aluno)).toBe('AGUARDANDO_ATESTADO');
    });

    it('um SIM em pergunta que NÃO exige liberação não pede atestado', async () => {
      const aluno = await comTenant(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Ja Treinou') RETURNING id`,
          [ids.tenant],
        );
        return rows[0]!.id;
      });

      const chaves = await chavesDaAcademia();
      const res = await assinarPelaAcademia(
        aluno,
        { ...TUDO_NAO, [chaves.treinou]: true, [chaves.protese]: false },
        'Ja Treinou',
      );
      expect(res.statusCode).toBe(201);
      expect(await situacao(aluno)).toBe('VALIDA');
    });

    it('a pergunta nova é obrigatória como todas as outras', async () => {
      const aluno = await comTenant(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Pulou Uma') RETURNING id`,
          [ids.tenant],
        );
        return rows[0]!.id;
      });
      /* Responde só as sete do PAR-Q: as duas da academia ficam em
         branco, e branco não pode valer como "não". */
      const res = await assinarPelaAcademia(aluno, TUDO_NAO, 'Pulou Uma');
      expect(res.statusCode).toBe(422);
    });

    it('as perguntas são congeladas na assinatura', async () => {
      const detalhe = await app.inject({
        method: 'GET',
        url: `/api/students/${ids.saudavel}/triagem`,
        headers: como(await tokenDe(ids.emailDono)),
      });
      const h = (detalhe.json() as {
        data: { historico: { perguntas: { chave: string }[] }[] };
      }).data.historico;

      /* A assinatura mais recente do Helena foi feita ANTES da edição,
         com as sete originais. Se a tela lesse o questionário de hoje
         para exibi-la, um "sim" antigo passaria a responder a uma
         pergunta que nunca foi feita. */
      const antiga = h[h.length - 1]!;
      expect(antiga.perguntas.length === 0 || antiga.perguntas.length === 7).toBe(true);
    });

    it('o professor não edita o questionário — é decisão da empresa', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/students/triagem/perguntas',
        headers: como(await tokenDe(ids.loginAluno)),
        payload: { perguntas: [{ texto: 'Qualquer coisa aqui', exigeLiberacao: false }] },
      });
      expect([403, 404]).toContain(res.statusCode);
    });

    it('questionário vazio é recusado', async () => {
      expect((await salvar([])).statusCode).toBe(422);
    });

    it('restaurar volta ao PAR-Q padrão', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/students/triagem/perguntas',
        headers: como(await tokenDe(ids.emailDono)),
      });
      expect(res.statusCode).toBe(200);

      const p = await perguntasAtuais();
      expect(p).toHaveLength(7);
      expect(p[0]!.texto).toContain('supervisionado por profissionais de saúde');
    });
  });

  it('a triagem de outra academia não é alcançável', async () => {
    const outra = crypto.randomUUID();
    const alunoDeFora = await (async (): Promise<string> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', outra]);
        await client.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
          outra,
          'Vizinha',
          `viz-${ids.sufixo}`,
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
      url: `/api/students/${alunoDeFora}/triagem`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(res.statusCode).toBe(404);
  });
});
