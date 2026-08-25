import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Check-in na recepção — ponta a ponta.
 *
 * O QUE ESTES TESTES GUARDAM:
 *
 *   1. A SITUAÇÃO É CONGELADA NA ENTRADA. É a decisão central desta
 *      tabela e a mais fácil de perder numa refatoração: alguém acha que
 *      guardar `situacao` é redundante — "dá para calcular a partir do
 *      aluno" — e apaga a coluna. A partir daí a conferência de março
 *      passa a mostrar a situação de hoje, e quem estava devendo em
 *      março e pagou em abril vira "em dia" no relatório de março. O
 *      teste paga a cobrança DEPOIS do check-in e exige que o registro
 *      continue dizendo DEVENDO.
 *
 *   2. NINGUÉM ENTRA DUAS VEZES. Dois toques no botão criariam duas
 *      entradas abertas e a contagem de quem está na academia agora
 *      ficaria errada para sempre — não só naquele momento, porque a
 *      entrada fantasma nunca recebe saída.
 *
 *   3. BUSCAR NÃO REGISTRA. A recepcionista digita, erra o nome, digita
 *      de novo. Se a busca registrasse entrada, cada tentativa seria um
 *      check-in.
 *
 *   4. A BUSCA NÃO ATRAVESSA A PAREDE. Aluno de outra academia não
 *      aparece nem pelo código exato, que é o caminho mais direto.
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
  emailProf: '',
  vizinha: '',
  emDia: '',
  devendo: '',
  inativo: '',
  daVizinha: '',
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

const como = (token: string) => ({ authorization: `Bearer ${token}` });

interface Achado {
  id: string;
  nome: string;
  codigo: string | null;
  situacao: string;
  devendoCentavos: number;
  diasDeAtraso: number;
  dentro: boolean;
  precisaLiberar: boolean;
}

async function buscar(termo: string, token?: string): Promise<Achado[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/checkin/buscar?termo=${encodeURIComponent(termo)}`,
    headers: como(token ?? (await tokenDe(ids.emailDono))),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: Achado[] }).data;
}

async function entrar(
  studentId: string,
  extra: Record<string, unknown> = {},
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: '/api/checkin',
    headers: como(await tokenDe(ids.emailDono)),
    payload: { studentId, ...extra },
  });
}

suite('Check-in na recepção', () => {
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
    ids.slug = `chk-${ids.sufixo}`;
    ids.emailDono = `dono-${ids.sufixo}@checkin.test`;
    ids.emailProf = `prof-${ids.sufixo}@checkin.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia do Balcão',
        ids.slug,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono','OWNER')`,
        [ids.tenant, ids.emailDono, hash],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Professor','PROFESSIONAL')`,
        [ids.tenant, ids.emailProf, hash],
      );

      const cria = async (nome: string, codigo: string, status: string): Promise<string> => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO students (tenant_id,full_name,codigo,status)
           VALUES ($1,$2,$3,$4::student_status) RETURNING id`,
          [ids.tenant, nome, codigo, status],
        );
        return r.rows[0]!.id;
      };

      /* ACENTO DE PROPÓSITO: quem digita no balcão digita "conceicao". */
      ids.emDia = await cria('Maria Conceição', '10', 'ACTIVE');
      ids.devendo = await cria('João Devedor', '11', 'ACTIVE');
      ids.inativo = await cria('Pedro Trancado', '12', 'INACTIVE');

      /* Contrato ativo só para quem está em dia — sem ele a situação
         seria SEM_CONTRATO e não EM_DIA. */
      for (const aluno of [ids.emDia, ids.devendo]) {
        await c.query(
          `INSERT INTO student_contracts
             (tenant_id,student_id,cycle,amount_cents,starts_on,billing_day)
           VALUES ($1,$2,'MONTHLY',15000,current_date - 60,5)`,
          [ids.tenant, aluno],
        );
      }

      /* Uma cobrança vencida há 20 dias. */
      await c.query(
        `INSERT INTO finance_entries
           (tenant_id,direction,description,amount_cents,due_date,student_id)
         VALUES ($1,'RECEIVABLE','Mensalidade atrasada',15000,
                   /* O DIA DA ACADEMIA, e nao o do servidor.
                      current_date e a data do fuso da SESSAO — UTC no
                      contêiner. O sistema conta o atraso em
                      now() AT TIME ZONE do fuso da academia, que e o dia
                      de quem opera a academia. Entre 21h e meia-noite no
                      Brasil os dois discordam, e o teste falhava com
                      "esperava 19, veio 20" toda noite — acusando o
                      sistema por uma conta que o proprio teste fazia
                      errado. */
                   (SELECT (now() AT TIME ZONE t.timezone)::date - 20
                      FROM tenants t WHERE t.id = $1),
                   $2)`,
        [ids.tenant, ids.devendo],
      );
    });

    await comTenant(ids.vizinha, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.vizinha,
        'Academia Vizinha',
        `viz-${ids.sufixo}`,
      ]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name,codigo) VALUES ($1,'Maria da Vizinha','10')
         RETURNING id`,
        [ids.vizinha],
      );
      ids.daVizinha = r.rows[0]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ==================================================================
   * A busca
   * ================================================================ */

  it('acha pelo nome sem acento e diz a situação de cada um', async () => {
    const achados = await buscar('conceicao');
    expect(achados).toHaveLength(1);
    expect(achados[0]!.nome).toBe('Maria Conceição');
    expect(achados[0]!.situacao).toBe('EM_DIA');
    expect(achados[0]!.devendoCentavos).toBe(0);
  });

  it('quem tem cobrança vencida aparece como DEVENDO, com valor e dias', async () => {
    const achados = await buscar('Devedor');
    expect(achados).toHaveLength(1);
    expect(achados[0]!.situacao).toBe('DEVENDO');
    expect(achados[0]!.devendoCentavos).toBe(15000);
    expect(achados[0]!.diasDeAtraso).toBe(20);
  });

  it('aluno inativo é INATIVO e pede liberação mesmo sem dever nada', async () => {
    const achados = await buscar('Trancado');
    expect(achados[0]!.situacao).toBe('INATIVO');
    expect(achados[0]!.precisaLiberar).toBe(true);
  });

  it('o código exato vem primeiro, na frente de quem só bate por texto', async () => {
    const achados = await buscar('11');
    /* "11" também aparece dentro de outros campos; o que importa é que
       o aluno de código 11 seja o primeiro da lista, porque a recepção
       vai bater enter no primeiro. */
    expect(achados[0]!.codigo).toBe('11');
  });

  it('a busca não atravessa a parede entre academias', async () => {
    const achados = await buscar('Vizinha');
    expect(achados).toHaveLength(0);

    /* Nem pelo código exato, que é o caminho mais curto: as duas
       academias têm um aluno de código 10. */
    const porCodigo = await buscar('10');
    expect(porCodigo.every((a) => a.id !== ids.daVizinha)).toBe(true);
    expect(porCodigo.some((a) => a.id === ids.emDia)).toBe(true);
  });

  it('buscar não registra entrada nenhuma', async () => {
    await buscar('conceicao');
    await buscar('concei');
    await buscar('Maria');

    const r = await comTenant(ids.tenant, (c) =>
      c.query<{ n: string }>('SELECT count(*)::text AS n FROM checkins WHERE student_id = $1', [
        ids.emDia,
      ]),
    );
    expect(Number(r.rows[0]!.n)).toBe(0);
  });

  /* ==================================================================
   * A entrada
   * ================================================================ */

  it('registra a entrada e o aluno passa a aparecer como dentro', async () => {
    const res = await entrar(ids.emDia);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { situacao: string } }).data.situacao).toBe('EM_DIA');

    const achados = await buscar('conceicao');
    expect(achados[0]!.dentro).toBe(true);

    const agora = await app.inject({
      method: 'GET',
      url: '/api/checkin/agora',
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(agora.statusCode).toBe(200);
    const dentro = (agora.json() as { data: { nome: string }[] }).data;
    expect(dentro.map((d) => d.nome)).toContain('Maria Conceição');
  });

  it('a segunda entrada sem saída é recusada com 409', async () => {
    const res = await entrar(ids.emDia);
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('já está na academia');

    const r = await comTenant(ids.tenant, (c) =>
      c.query<{ n: string }>('SELECT count(*)::text AS n FROM checkins WHERE student_id = $1', [
        ids.emDia,
      ]),
    );
    expect(Number(r.rows[0]!.n)).toBe(1);
  });

  it('depois da saída ele pode entrar de novo', async () => {
    const agora = await app.inject({
      method: 'GET',
      url: '/api/checkin/agora',
      headers: como(await tokenDe(ids.emailDono)),
    });
    const aberta = (agora.json() as { data: { id: string; nome: string }[] }).data.find(
      (d) => d.nome === 'Maria Conceição',
    )!;

    const saida = await app.inject({
      method: 'POST',
      url: `/api/checkin/${aberta.id}/saida`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(saida.statusCode).toBe(200);

    /* Fechar duas vezes não é erro do usuário nem sucesso silencioso:
       a entrada já não está aberta. */
    const denovo = await app.inject({
      method: 'POST',
      url: `/api/checkin/${aberta.id}/saida`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(denovo.statusCode).toBe(404);

    expect((await entrar(ids.emDia)).statusCode).toBe(201);
  });

  /* ==================================================================
   * O congelamento — a razão de a coluna existir
   * ================================================================ */

  it('a situação registrada não muda quando o aluno paga depois', async () => {
    const res = await entrar(ids.devendo);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { situacao: string } }).data.situacao).toBe('DEVENDO');

    const gravado = await comTenant(ids.tenant, (c) =>
      c.query<{ situacao: string; devendo_centavos: string }>(
        'SELECT situacao, devendo_centavos FROM checkins WHERE student_id = $1',
        [ids.devendo],
      ),
    );
    expect(gravado.rows[0]!.situacao).toBe('DEVENDO');
    expect(Number(gravado.rows[0]!.devendo_centavos)).toBe(15000);

    /* O aluno paga tudo. A situação DE HOJE muda; a de ontem não. */
    await comTenant(ids.tenant, (c) =>
      c.query(
        `UPDATE finance_entries SET paid_cents = amount_cents, status = 'PAID'
          WHERE student_id = $1`,
        [ids.devendo],
      ),
    );

    const hoje = await buscar('Devedor');
    expect(hoje[0]!.situacao).toBe('EM_DIA');

    const depois = await comTenant(ids.tenant, (c) =>
      c.query<{ situacao: string; devendo_centavos: string }>(
        'SELECT situacao, devendo_centavos FROM checkins WHERE student_id = $1',
        [ids.devendo],
      ),
    );
    expect(depois.rows[0]!.situacao).toBe('DEVENDO');
    expect(Number(depois.rows[0]!.devendo_centavos)).toBe(15000);
  });

  /* ==================================================================
   * O limite de tolerância
   * ================================================================ */

  it('com tolerância zero ninguém é barrado por dever — só avisado', async () => {
    /* Zero é o padrão e significa "avisa mas nunca impede": barrar aluno
       na porta é decisão de negócio, não de software. */
    const achados = await buscar('Trancado');
    expect(achados[0]!.precisaLiberar).toBe(true); // inativo é outro caso

    await comTenant(ids.tenant, (c) =>
      c.query(
        `INSERT INTO finance_entries
           (tenant_id,direction,description,amount_cents,due_date,student_id)
         VALUES ($1,'RECEIVABLE','Nova pendência',9000,
                   /* Pelo relogio da academia, como na outra cobranca. */
                   (SELECT (now() AT TIME ZONE t.timezone)::date - 20
                      FROM tenants t WHERE t.id = $1),
                   $2)`,
        [ids.tenant, ids.devendo],
      ),
    );
    const devedor = await buscar('Devedor');
    expect(devedor[0]!.situacao).toBe('DEVENDO');
    expect(devedor[0]!.precisaLiberar).toBe(false);
  });

  it('configurado o limite, quem passou dele passa a pedir liberação', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/checkin/config',
      headers: como(await tokenDe(ids.emailDono)),
      payload: { bloquearApos: 15 },
    });
    expect(put.statusCode).toBe(200);

    const devedor = await buscar('Devedor');
    expect(devedor[0]!.diasDeAtraso).toBe(20);
    expect(devedor[0]!.precisaLiberar).toBe(true);

    /* Quem está em dia continua passando direto. */
    const emDia = await buscar('conceicao');
    expect(emDia[0]!.precisaLiberar).toBe(false);
  });

  it('a liberação fica registrada com o nome de quem liberou', async () => {
    await comTenant(ids.tenant, (c) => c.query('DELETE FROM checkins WHERE student_id = $1', [ids.inativo]));

    const res = await entrar(ids.inativo, {
      liberadoComAviso: true,
      observacao: 'Veio buscar o cartão',
    });
    expect(res.statusCode).toBe(201);

    const r = await comTenant(ids.tenant, (c) =>
      c.query<{ situacao: string; liberado_por: string | null; observacao: string | null }>(
        'SELECT situacao, liberado_por, observacao FROM checkins WHERE student_id = $1',
        [ids.inativo],
      ),
    );
    expect(r.rows[0]!.situacao).toBe('INATIVO');
    /* Sem isto, "quem deixou o trancado entrar" não tem resposta. */
    expect(r.rows[0]!.liberado_por).not.toBeNull();
    expect(r.rows[0]!.observacao).toBe('Veio buscar o cartão');
  });

  /* ==================================================================
   * Permissão e movimento
   * ================================================================ */

  it('o movimento do dia conta as entradas e quem ainda está dentro', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/checkin/hoje',
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(res.statusCode).toBe(200);
    const d = (res.json() as { data: { total: number; dentro: number; devendo: number } }).data;
    expect(d.total).toBeGreaterThanOrEqual(3);
    expect(d.dentro).toBeGreaterThanOrEqual(3);
    expect(d.devendo).toBeGreaterThanOrEqual(1);
  });

  it('só quem pode mexer em presença configura a tolerância', async () => {
    /* `tenant:settings` é do dono. O professor marca presença o dia
       inteiro e não decide quem a academia barra na porta. */
    const res = await app.inject({
      method: 'PUT',
      url: '/api/checkin/config',
      headers: como(await tokenDe(ids.emailProf)),
      payload: { bloquearApos: 0 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('não registra entrada de aluno que não existe nesta academia', async () => {
    const res = await entrar(ids.daVizinha);
    expect(res.statusCode).toBe(404);
  });
});
