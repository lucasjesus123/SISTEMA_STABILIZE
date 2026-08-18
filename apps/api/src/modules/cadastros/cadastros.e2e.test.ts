import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Equipe, espaços, horários e contrato — ponta a ponta.
 *
 * O QUE ESTES TESTES GUARDAM:
 *
 *   1. A LISTA DE PROFISSIONAIS é liberada por `schedule:read` para que a
 *      agenda compartilhada tenha legenda. Isso a coloca ao alcance do
 *      profissional, que NÃO tem `user:read` — então ela não pode
 *      devolver e-mail nem último acesso. Se um dia alguém acrescentar
 *      uma coluna "para facilitar", este teste quebra.
 *
 *   2. CADA UM MEXE NO SEU HORÁRIO. É a regra que a academia pediu para o
 *      calendário, e ela vale igual para a janela de atendimento: um
 *      profissional que edite a do colega muda a agenda do colega por
 *      via indireta.
 *
 *   3. O CONTRATO ANTIGO É ENCERRADO, NÃO REESCRITO. Trocar o plano em
 *      março não pode mudar o que foi cobrado em fevereiro.
 *
 * Requer TEST_DATABASE_URL num papel SEM BYPASSRLS.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';

const ids = {
  tenant: '',
  slug: '',
  emailDono: '',
  emailProfA: '',
  emailProfB: '',
  profA: '',
  profB: '',
  alunoDoA: '',
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

suite('Cadastros da agenda e do financeiro', () => {
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
    ids.slug = `cad-${ids.sufixo}`;
    ids.emailDono = `dono-${ids.sufixo}@cadastros.test`;
    ids.emailProfA = `profa-${ids.sufixo}@cadastros.test`;
    ids.emailProfB = `profb-${ids.sufixo}@cadastros.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia dos Cadastros',
        ids.slug,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono','OWNER')`,
        [ids.tenant, ids.emailDono, hash],
      );
      const a = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof A','PROFESSIONAL') RETURNING id`,
        [ids.tenant, ids.emailProfA, hash],
      );
      const b = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof B','PROFESSIONAL') RETURNING id`,
        [ids.tenant, ids.emailProfB, hash],
      );
      ids.profA = a.rows[0]!.id;
      ids.profB = b.rows[0]!.id;

      const s = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno do A') RETURNING id`,
        [ids.tenant],
      );
      ids.alunoDoA = s.rows[0]!.id;
      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id)
         VALUES ($1,$2,$3)`,
        [ids.tenant, ids.alunoDoA, ids.profA],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ==================================================================
   * Equipe
   * ================================================================ */

  it('o profissional lê a equipe — e a lista não traz e-mail nem último acesso', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/cadastros/profissionais',
      headers: como(await tokenDe(ids.emailProfA)),
    });
    expect(res.statusCode).toBe(200);

    /* A lista existe para pintar o calendário. Quem a lê tem
       `schedule:read`, não `user:read` — se ela passar a devolver
       contato, vira diretório de equipe liberado a quem não deveria
       tê-lo. */
    expect(res.body).not.toContain(ids.emailProfB);
    expect(res.body).not.toContain('ultimoAcesso');

    const { data } = res.json() as { data: { id: string; nome: string }[] };
    expect(data.map((p) => p.nome).sort()).toEqual(['Dono', 'Prof A', 'Prof B']);
  });

  it('a equipe de outra academia não aparece', async () => {
    const outra = crypto.randomUUID();
    await comTenant(outra, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        outra,
        'Vizinha',
        `viz-${ids.sufixo}`,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,'x','Fulano da Vizinha','PROFESSIONAL')`,
        [outra, `viz-${ids.sufixo}@cadastros.test`],
      );
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/cadastros/profissionais',
      headers: como(await tokenDe(ids.emailProfA)),
    });
    expect(res.body).not.toContain('Fulano da Vizinha');
  });

  it('só quem administra troca a cor de um profissional', async () => {
    const negado = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/profissionais/${ids.profB}/cor`,
      headers: como(await tokenDe(ids.emailProfA)),
      payload: { cor: '#123456' },
    });
    expect(negado.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/profissionais/${ids.profB}/cor`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: { cor: '#123456' },
    });
    expect(ok.statusCode).toBe(200);
  });

  /* 422 e não 400: é a resposta que o sistema inteiro dá a corpo bem
     formado com conteúdo inválido — ver o tratador de erros. */
  it('recusa cor que não é hexadecimal', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/profissionais/${ids.profB}/cor`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: { cor: 'vermelho' },
    });
    expect(res.statusCode).toBe(422);
  });

  /* ==================================================================
   * Horários de atendimento
   * ================================================================ */

  it('o profissional grava a PRÓPRIA janela de atendimento', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/profissionais/${ids.profA}/horarios`,
      headers: como(await tokenDe(ids.emailProfA)),
      payload: {
        faixas: [
          { diaDaSemana: 1, inicio: '08:00', fim: '12:00', duracaoMinutos: 60 },
          { diaDaSemana: 1, inicio: '14:00', fim: '18:00', duracaoMinutos: 60 },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const lidas = await app.inject({
      method: 'GET',
      url: `/api/cadastros/profissionais/${ids.profA}/horarios`,
      headers: como(await tokenDe(ids.emailProfA)),
    });
    const { data } = lidas.json() as { data: { inicio: string; fim: string }[] };
    expect(data).toHaveLength(2);
    /* "08:00", não "08:00:00": o <input type="time"> recusa o segundo
       formato em silêncio e o campo aparece vazio. */
    expect(data[0]!.inicio).toBe('08:00');
  });

  it('NÃO grava a janela do colega', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/profissionais/${ids.profB}/horarios`,
      headers: como(await tokenDe(ids.emailProfA)),
      payload: { faixas: [{ diaDaSemana: 3, inicio: '06:00', fim: '23:00' }] },
    });
    expect(res.statusCode).toBe(404);

    /* E a janela do colega continua como estava — a recusa não pode ter
       gravado metade. */
    const doB = await app.inject({
      method: 'GET',
      url: `/api/cadastros/profissionais/${ids.profB}/horarios`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect((doB.json() as { data: unknown[] }).data).toHaveLength(0);
  });

  it('quem administra grava a janela de qualquer um', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/profissionais/${ids.profB}/horarios`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: { faixas: [{ diaDaSemana: 2, inicio: '09:00', fim: '17:00' }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('o PUT SUBSTITUI a semana — faixa apagada na tela some no servidor', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/cadastros/profissionais/${ids.profA}/horarios`,
      headers: como(await tokenDe(ids.emailProfA)),
      payload: { faixas: [{ diaDaSemana: 5, inicio: '10:00', fim: '11:00' }] },
    });

    const lidas = await app.inject({
      method: 'GET',
      url: `/api/cadastros/profissionais/${ids.profA}/horarios`,
      headers: como(await tokenDe(ids.emailProfA)),
    });
    const { data } = lidas.json() as { data: { diaDaSemana: number }[] };
    /* Se fosse INSERT em vez de substituição, as duas faixas da segunda
       continuariam valendo e o profissional seguiria recebendo aluno num
       dia que ele tirou da agenda. */
    expect(data).toHaveLength(1);
    expect(data[0]!.diaDaSemana).toBe(5);
  });

  it('recusa faixa que termina antes de começar', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cadastros/profissionais/${ids.profA}/horarios`,
      headers: como(await tokenDe(ids.emailProfA)),
      payload: { faixas: [{ diaDaSemana: 1, inicio: '18:00', fim: '09:00' }] },
    });
    expect(res.statusCode).toBe(422);
  });

  /* ==================================================================
   * Espaços
   * ================================================================ */

  it('cria espaço, recusa nome repetido e o profissional só lê', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/api/cadastros/salas',
      headers: como(await tokenDe(ids.emailDono)),
      payload: { nome: 'Mezanino', capacidade: 4, cor: '#3f9e6b' },
    });
    expect(criado.statusCode).toBe(201);

    const repetido = await app.inject({
      method: 'POST',
      url: '/api/cadastros/salas',
      headers: como(await tokenDe(ids.emailDono)),
      payload: { nome: 'Mezanino', capacidade: 2 },
    });
    /* 409, e não 500: nome repetido é uma decisão do operador, não uma
       falha do servidor. */
    expect(repetido.statusCode).toBe(409);

    const leitura = await app.inject({
      method: 'GET',
      url: '/api/cadastros/salas',
      headers: como(await tokenDe(ids.emailProfA)),
    });
    expect(leitura.statusCode).toBe(200);
    expect(leitura.body).toContain('Mezanino');

    const escrita = await app.inject({
      method: 'POST',
      url: '/api/cadastros/salas',
      headers: como(await tokenDe(ids.emailProfA)),
      payload: { nome: 'Sala do Prof A', capacidade: 1 },
    });
    expect(escrita.statusCode).toBe(403);
  });

  /* ==================================================================
   * Contrato do aluno
   * ================================================================ */

  it('grava o valor e a porcentagem, e devolve os dois de volta', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/students/${ids.alunoDoA}/contrato`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: {
        ciclo: 'MONTHLY',
        valor: '349,90',
        comissaoPercentual: '42,5',
        diaDeCobranca: 10,
        profissionalId: ids.profA,
        inicioEm: '2026-08-01',
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const lido = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoA}/contrato`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    const { data } = lido.json() as {
      data: {
        valorCentavos: number;
        comissaoBp: number;
        comissaoPercentual: number;
        inicioEm: string;
        profissional: { nome: string };
      };
    };
    expect(data.valorCentavos).toBe(34_990);
    /* 42,5% vira 4250 basis points, e não 0.425: o caminho do dinheiro é
       inteiro do começo ao fim. */
    expect(data.comissaoBp).toBe(4250);
    expect(data.comissaoPercentual).toBe(42.5);
    /* `date` do PostgreSQL vira Date em hora local; formatado por
       `toISOString()` a oeste de Greenwich, dia 1 vira dia 31. */
    expect(data.inicioEm).toBe('2026-08-01');
    expect(data.profissional.nome).toBe('Prof A');
  });

  it('trocar o plano ENCERRA o anterior em vez de reescrevê-lo', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/students/${ids.alunoDoA}/contrato`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: { ciclo: 'MONTHLY', valor: '429,90', comissaoPercentual: 30, inicioEm: '2026-09-01' },
    });

    const linhas = await comTenant(ids.tenant, (c) =>
      c.query<{ amount_cents: string; is_active: boolean; ends_on: Date | null }>(
        `SELECT amount_cents::text AS amount_cents, is_active, ends_on
           FROM student_contracts WHERE student_id = $1 ORDER BY starts_on`,
        [ids.alunoDoA],
      ),
    );

    /* O contrato de agosto continua existindo, com o valor de agosto.
       Sobrescrever a linha faria a comissão do mês passado ser
       recalculada por um preço que só passou a valer agora. */
    expect(linhas.rows).toHaveLength(2);
    expect(linhas.rows[0]!.amount_cents).toBe('34990');
    expect(linhas.rows[0]!.is_active).toBe(false);
    expect(linhas.rows[0]!.ends_on).not.toBeNull();
    expect(linhas.rows[1]!.is_active).toBe(true);
  });

  /* ==================================================================
   * A mensalidade que nasce do contrato
   * ================================================================ */

  it('gera a mensalidade do mês, e rodar de novo NÃO gera a segunda', async () => {
    const { gerarCobrancasDoMes } = await import('../finance/cobranca-recorrente.js');

    /* Aluno próprio: `alunoDoA` já saiu do teste anterior com um
       contrato começando em setembro, e este teste precisa de um que
       comece neste mês. */
    const novoAluno = await comTenant(ids.tenant, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name) VALUES ($1,'Mensalista') RETURNING id`,
        [ids.tenant],
      ),
    );
    const mensalista = novoAluno.rows[0]!.id;

    /* Contrato começando no dia 1 para a cobrança deste mês existir com
       certeza, independentemente do dia em que o teste rodar. */
    const hoje = new Date();
    const primeiro = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
    const criado = await app.inject({
      method: 'PUT',
      url: `/api/students/${mensalista}/contrato`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: {
        ciclo: 'MONTHLY',
        valor: '199,90',
        comissaoPercentual: 20,
        diaDeCobranca: 5,
        inicioEm: primeiro,
      },
    });
    expect(criado.statusCode, criado.body).toBe(200);

    await gerarCobrancasDoMes(app.log);
    /* A SEGUNDA PASSADA É O TESTE. A tarefa roda de hora em hora; se ela
       puder inserir a mesma mensalidade duas vezes, o aluno passa a
       dever o dobro e alguém recebe uma cobrança que não devia. A
       garantia está no índice único (contrato, competência), não numa
       trava do agendador — por isso rodar de novo tem de ser inofensivo. */
    await gerarCobrancasDoMes(app.log);
    await gerarCobrancasDoMes(app.log);

    const linhas = await comTenant(ids.tenant, (c) =>
      c.query<{ n: string; amount_cents: string; due_date: Date }>(
        `SELECT count(*)::text AS n, min(amount_cents)::text AS amount_cents, min(due_date) AS due_date
           FROM finance_entries
          WHERE student_id = $1 AND contract_id IS NOT NULL AND cancelled_at IS NULL`,
        [mensalista],
      ),
    );
    expect(Number(linhas.rows[0]!.n)).toBe(1);
    expect(linhas.rows[0]!.amount_cents).toBe('19990');
  });

  it('a primeira mensalidade vence no dia da matrícula quando ela é depois do dia da cobrança', async () => {
    const { gerarCobrancasDoMes } = await import('../finance/cobranca-recorrente.js');

    const outro = await comTenant(ids.tenant, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name) VALUES ($1,'Entrou no dia 20') RETURNING id`,
        [ids.tenant],
      ),
    );
    const alunoId = outro.rows[0]!.id;

    const hoje = new Date();
    const dia20 = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-20`;
    await app.inject({
      method: 'PUT',
      url: `/api/students/${alunoId}/contrato`,
      headers: como(await tokenDe(ids.emailDono)),
      /* Cobrança no dia 5, matrícula no dia 20: a mensalidade deste mês
         não pode vencer no dia 5, que é antes de o contrato existir. */
      payload: { ciclo: 'MONTHLY', valor: '100,00', diaDeCobranca: 5, inicioEm: dia20 },
    });

    await gerarCobrancasDoMes(app.log);

    const linhas = await comTenant(ids.tenant, (c) =>
      c.query<{ due_date: Date }>(
        `SELECT due_date FROM finance_entries
          WHERE student_id = $1 AND contract_id IS NOT NULL`,
        [alunoId],
      ),
    );
    /* Se o dia 20 já passou no calendário do teste, a cobrança existe e
       vence no dia 20. Se ainda não chegou, o contrato começa no futuro
       e nada é gerado — as duas leituras são corretas, e o que NÃO pode
       acontecer é uma cobrança vencendo no dia 5. */
    for (const l of linhas.rows) {
      expect(l.due_date.getDate()).toBe(20);
    }
  });

  it('recusa contrato que começa antes de um já existente, com a data no aviso', async () => {
    /* `alunoDoA` tem um contrato ativo desde 01/09/2026 do teste da
       troca de plano. Tentar lançar outro começando antes disso fazia o
       CHECK do banco estourar e a tela dizia "erro interno" para o que é
       uma data mal escolhida. */
    const res = await app.inject({
      method: 'PUT',
      url: `/api/students/${ids.alunoDoA}/contrato`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: { ciclo: 'MONTHLY', valor: '150,00', inicioEm: '2026-08-01' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('01/09/2026');
  });

  it('recusa porcentagem acima de 100', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/students/${ids.alunoDoA}/contrato`,
      headers: como(await tokenDe(ids.emailDono)),
      payload: { valor: '100,00', comissaoPercentual: 150 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('o profissional não vê o contrato de um aluno que não é dele', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoA}/contrato`,
      headers: como(await tokenDe(ids.emailProfB)),
    });
    /* `pricing:read` não chega ao PROFESSIONAL, então isto é 403. Se um
       dia chegar, o escopo do ALUNO ainda o barra — e o teste seguinte
       cobre esse caminho pelo lado da recepção. */
    expect([403, 404]).toContain(res.statusCode);
  });
});
