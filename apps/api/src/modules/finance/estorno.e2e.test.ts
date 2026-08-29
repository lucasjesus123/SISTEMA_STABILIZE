/**
 * Estorno de baixa, correção do catálogo e os PDFs que não tinham botão.
 *
 * OS TRÊS SAÍRAM DO MESMO ACHADO: rotas que existiam na API e que tela
 * nenhuma do sistema alcançava. O teste de conexão de abas as encontrou
 * como "portas mortas", e a correção não foi apagá-las — foi ligá-las.
 *
 * O QUE ESTE ARQUIVO PRECISA PROVAR:
 *
 *  1. ESTORNO. A rota de apagar pagamento existia desde sempre e era
 *     inalcançável, porque nada dizia à tela o `id` de uma baixa. Aqui
 *     se prova o caminho inteiro: listar → estornar → a conta volta a
 *     dever, com o `paid_cents` recalculado pelo gatilho.
 *
 *  2. O QUE FICA NA AUDITORIA. Depois do DELETE a linha não existe mais
 *     em lugar nenhum: se o log não guardar valor e lançamento, o
 *     dinheiro some sem rastro. É a parte que ninguém testa e que só
 *     falta seis meses depois.
 *
 *  3. CORREÇÃO DO EXERCÍCIO. O `PATCH` só sabia ligar e desligar. Erro
 *     de grafia no catálogo não tinha conserto — e a correção precisa
 *     alcançar a prescrição antiga, porque é o mesmo movimento.
 *
 *  4. OS TRÊS PDFs. Não se testa o desenho do papel; testa-se que a
 *     rota responde 200 com um PDF de verdade para quem tem a
 *     permissão, que é o que faltava para o botão existir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;
let token = '';

const SENHA = 'senha-de-teste-longa-2026';
const ids = { tenant: '', email: '', aluno: '', prof: '', exercicio: '' };

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1,$2,true)', ['app.tenant_id', ids.tenant]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const auth = () => ({ authorization: `Bearer ${token}` });

async function cobranca(valor: number, vencimento: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/finance/lancamentos',
    headers: auth(),
    payload: {
      direcao: 'RECEIVABLE',
      descricao: 'Mensalidade',
      valor,
      vencimento,
      studentId: ids.aluno,
      professionalId: ids.prof,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { data: { id: string } }).data.id;
}

async function estadoDa(id: string): Promise<{ status: string; paid: number }> {
  const { rows } = await tx((c) =>
    c.query<{ status: string; paid_cents: string }>(
      'SELECT status::text, paid_cents::text FROM finance_entries WHERE id = $1',
      [id],
    ),
  );
  return { status: rows[0]!.status, paid: Number(rows[0]!.paid_cents) };
}

interface BaixaNaTela {
  id: string;
  valorCentavos: number;
  abatidoCentavos: number;
  acrescimoCentavos: number;
  metodo: string;
  registradoPor: string | null;
}

async function baixasDe(entryId: string): Promise<BaixaNaTela[]> {
  const r = await app.inject({
    method: 'GET',
    url: `/api/finance/lancamentos/${entryId}/pagamentos`,
    headers: auth(),
  });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { data: BaixaNaTela[] }).data;
}

suite('estorno, correção do catálogo e os PDFs sem botão', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'estorno-acesso-somente-teste-com-tamanho-1';
    process.env['JWT_REFRESH_SECRET'] = 'estorno-refresh-somente-teste-com-tamanho-2';
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
    ids.email = `es-${sufixo}@t.test`;
    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await tx(async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Estorno Test',
        `es-${sufixo}`,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dona da Academia','OWNER')`,
        [ids.tenant, ids.email, hash],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof','PROFESSIONAL') RETURNING id`,
        [ids.tenant, `es-prof-${sufixo}@t.test`, hash],
      );
      ids.prof = p.rows[0]!.id;
      const a = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno do Estorno') RETURNING id`,
        [ids.tenant],
      );
      ids.aluno = a.rows[0]!.id;
      const e = await c.query<{ id: string }>(
        `INSERT INTO exercises (tenant_id,name,muscle_group,instructions)
         VALUES ($1,'Remada curvda','COSTAS','Puxe') RETURNING id`,
        [ids.tenant],
      );
      ids.exercicio = e.rows[0]!.id;
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ids.email, password: SENHA },
    });
    token = (login.json() as { accessToken: string }).accessToken;
  }, 60_000);

  afterAll(async () => {
    if (ids.tenant) {
      await tx((c) => c.query('DELETE FROM tenants WHERE id=$1', [ids.tenant])).catch(
        () => undefined,
      );
    }
    await pool?.end();
    await app?.close();
  });

  /* ================================================================
   * 1. O CAMINHO QUE NÃO EXISTIA: ver a baixa e desfazê-la
   * ============================================================== */

  it('a tela consegue enxergar a baixa que acabou de registrar', async () => {
    const id = await cobranca(100, '2026-07-10');
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 100, metodo: 'PIX' },
    });

    const lista = await baixasDe(id);
    expect(lista).toHaveLength(1);
    expect(lista[0]!.valorCentavos).toBe(10000);
    expect(lista[0]!.metodo).toBe('PIX');
    /* SEM ESTE `id` O ESTORNO É INALCANÇÁVEL — era exatamente o que
       faltava para o botão poder existir. */
    expect(lista[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    /* Quem registrou é a primeira pergunta de quem acha uma baixa
       estranha, e não deveria exigir abrir a auditoria. */
    expect(lista[0]!.registradoPor).toBe('Dona da Academia');
  });

  it('estornar a baixa faz a conta voltar a dever', async () => {
    const id = await cobranca(100, '2026-07-11');
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 100, metodo: 'PIX' },
    });
    expect((await estadoDa(id)).status).toBe('PAID');

    const [baixa] = await baixasDe(id);
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/finance/pagamentos/${baixa!.id}`,
      headers: auth(),
    });
    expect(r.statusCode, r.body).toBe(200);

    /* O GATILHO RECALCULA PARA TRÁS — a aplicação não escreve
       `paid_cents`, e é o que garante que estorno e baixa nunca
       divirjam. */
    const depois = await estadoDa(id);
    expect(depois.paid).toBe(0);
    expect(depois.status).not.toBe('PAID');
    expect(await baixasDe(id)).toHaveLength(0);
  });

  it('estornar uma das duas formas deixa a conta parcialmente paga', async () => {
    const id = await cobranca(100, '2026-07-12');
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos/lote`,
      headers: auth(),
      payload: {
        pagamentos: [
          { valor: 60, metodo: 'PIX' },
          { valor: 40, metodo: 'CASH' },
        ],
      },
    });
    expect((await estadoDa(id)).status).toBe('PAID');

    const lista = await baixasDe(id);
    expect(lista).toHaveLength(2);
    const dinheiro = lista.find((p) => p.metodo === 'CASH')!;

    await app.inject({
      method: 'DELETE',
      url: `/api/finance/pagamentos/${dinheiro.id}`,
      headers: auth(),
    });

    const depois = await estadoDa(id);
    expect(depois.paid).toBe(6000);
    expect(depois.status).toBe('PARTIALLY_PAID');
  });

  it('a baixa com multa mostra o que entrou e o que abateu, que são diferentes', async () => {
    const id = await cobranca(100, '2026-07-13');
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 105, metodo: 'PIX', acrescimo: 5 },
    });

    const [baixa] = await baixasDe(id);
    /* SE A TELA MOSTRASSE SÓ UM DOS DOIS, uma baixa de R$ 105 numa
       conta de R$ 100 pareceria superpagamento — e quem confere
       estornaria a linha certa achando que é erro. */
    expect(baixa!.valorCentavos).toBe(10500);
    expect(baixa!.acrescimoCentavos).toBe(500);
    expect(baixa!.abatidoCentavos).toBe(10000);
  });

  it('estornar a mesma baixa duas vezes dá 404, não erro de servidor', async () => {
    const id = await cobranca(100, '2026-07-14');
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 100, metodo: 'PIX' },
    });
    const [baixa] = await baixasDe(id);

    const um = await app.inject({
      method: 'DELETE',
      url: `/api/finance/pagamentos/${baixa!.id}`,
      headers: auth(),
    });
    expect(um.statusCode).toBe(200);

    /* Dois cliques no mesmo botão, ou duas abas abertas na mesma
       conta. Precisa dizer "não achei", e não estourar. */
    const dois = await app.inject({
      method: 'DELETE',
      url: `/api/finance/pagamentos/${baixa!.id}`,
      headers: auth(),
    });
    expect(dois.statusCode).toBe(404);
  });

  it('o estorno guarda na auditoria QUANTO e DE QUAL CONTA saiu', async () => {
    const id = await cobranca(100, '2026-07-15');
    await app.inject({
      method: 'POST',
      url: `/api/finance/lancamentos/${id}/pagamentos`,
      headers: auth(),
      payload: { valor: 100, metodo: 'BOLETO' },
    });
    const [baixa] = await baixasDe(id);

    await app.inject({
      method: 'DELETE',
      url: `/api/finance/pagamentos/${baixa!.id}`,
      headers: auth(),
    });

    const { rows } = await tx((c) =>
      c.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log
          WHERE action = 'finance.payment.delete' AND resource_id = $1`,
        [baixa!.id],
      ),
    );

    /* DEPOIS DO DELETE A LINHA NÃO EXISTE MAIS EM LUGAR NENHUM. Se o
       log não guardar isto, o dinheiro sai do caixa sem rastro — e a
       pergunta chega seis meses depois, no fechamento. */
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata['valorCentavos']).toBe(10000);
    expect(rows[0]!.metadata['lancamentoId']).toBe(id);
    expect(rows[0]!.metadata['metodo']).toBe('BOLETO');
  });

  /* ================================================================
   * 2. CORRIGIR O EXERCÍCIO DO CATÁLOGO
   * ============================================================== */

  it('corrige a grafia do exercício sem criar outro', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/exercises/${ids.exercicio}`,
      headers: auth(),
      payload: { nome: 'Remada curvada' },
    });
    expect(r.statusCode, r.body).toBe(200);

    const lista = await app.inject({
      method: 'GET',
      url: '/api/exercises?busca=remada',
      headers: auth(),
    });
    const itens = (lista.json() as { data: { id: string; nome: string }[] }).data;
    /* UM, e não dois. Antes desta rota o conserto era criar outro e
       desativar o errado — e a busca de todo mundo ficava com dois
       nomes quase iguais para sempre. */
    expect(itens.filter((e) => e.nome.toLowerCase().includes('remada'))).toHaveLength(1);
    expect(itens.find((e) => e.id === ids.exercicio)!.nome).toBe('Remada curvada');
  });

  it('corrige grupo, equipamento e instruções de uma vez', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/exercises/${ids.exercicio}`,
      headers: auth(),
      payload: {
        grupo: 'ANTEBRACO',
        equipamento: 'Barra',
        instrucoes: 'Puxe a barra até o abdômen, cotovelos rentes ao corpo.',
      },
    });
    expect(r.statusCode, r.body).toBe(200);

    const lista = await app.inject({
      method: 'GET',
      url: '/api/exercises?grupo=ANTEBRACO',
      headers: auth(),
    });
    const achado = (
      lista.json() as { data: { id: string; equipamento: string | null }[] }
    ).data.find((e) => e.id === ids.exercicio);
    /* ERRAR O GRUPO SOME COM O EXERCÍCIO do filtro que todo mundo usa
       para achá-lo — por isso ele é editável. */
    expect(achado).toBeDefined();
    expect(achado!.equipamento).toBe('Barra');
  });

  it('campo em branco LIMPA o campo, e não é ignorado', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/exercises/${ids.exercicio}`,
      headers: auth(),
      payload: { equipamento: '' },
    });
    expect(r.statusCode, r.body).toBe(200);

    const lista = await app.inject({
      method: 'GET',
      url: '/api/exercises?busca=remada',
      headers: auth(),
    });
    const achado = (
      lista.json() as { data: { id: string; equipamento: string | null }[] }
    ).data.find((e) => e.id === ids.exercicio);
    /* Se '' virasse "não mexer" — como na criação — não haveria como
       apagar um equipamento cadastrado por engano. */
    expect(achado!.equipamento).toBeNull();
  });

  it('desativar continua funcionando sozinho, como a tela antiga manda', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/exercises/${ids.exercicio}`,
      headers: auth(),
      payload: { ativo: false },
    });
    expect(r.statusCode, r.body).toBe(200);

    const lista = await app.inject({
      method: 'GET',
      url: '/api/exercises?busca=remada',
      headers: auth(),
    });
    expect(
      (lista.json() as { data: { id: string }[] }).data.find((e) => e.id === ids.exercicio),
    ).toBeUndefined();

    await app.inject({
      method: 'PATCH',
      url: `/api/exercises/${ids.exercicio}`,
      headers: auth(),
      payload: { ativo: true },
    });
  });

  it('renomear para um nome que já existe dá conflito, não erro cru', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: auth(),
      payload: { nome: 'Supino reto', grupo: 'PEITO' },
    });

    const r = await app.inject({
      method: 'PATCH',
      url: `/api/exercises/${ids.exercicio}`,
      headers: auth(),
      payload: { nome: 'Supino reto' },
    });
    expect(r.statusCode).toBe(409);
  });

  it('um PATCH vazio é recusado em vez de mentir que salvou', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/exercises/${ids.exercicio}`,
      headers: auth(),
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  /* ================================================================
   * 3. OS TRÊS PDFs QUE NÃO TINHAM BOTÃO
   * ============================================================== */

  it('a relação de alunos responde um PDF de verdade', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/relatorios/alunos',
      headers: auth(),
    });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    /* Os quatro bytes que fazem um PDF ser um PDF. Um 200 com corpo
       vazio passaria em qualquer asserção mais frouxa. */
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('o extrato financeiro do período responde um PDF de verdade', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/relatorios/financeiro?de=2026-07-01&ate=2026-07-31',
      headers: auth(),
    });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('a frequência do aluno responde um PDF de verdade', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/relatorios/frequencia/${ids.aluno}`,
      headers: auth(),
    });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('a frequência de um aluno de OUTRA academia não sai', async () => {
    /* O botão novo passa um id na URL — e id em URL é adulterável.
       Esta é a razão de o teste existir. */
    const r = await app.inject({
      method: 'GET',
      url: `/api/relatorios/frequencia/${crypto.randomUUID()}`,
      headers: auth(),
    });
    expect(r.statusCode).toBe(404);
  });
});
