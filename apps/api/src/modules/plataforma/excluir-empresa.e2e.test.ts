/**
 * Excluir uma academia pelo painel da plataforma.
 *
 * ESTE ARQUIVO EXISTE POR CAUSA DE UM DEFEITO QUE PASSOU DESPERCEBIDO
 * ATÉ ALGUÉM PRECISAR EXCLUIR DE VERDADE.
 *
 * "Excluir academia" devolvia "Recurso não encontrado" para uma academia
 * que estava na tela, com nome e contagem corretos. A cadeia:
 *
 *   `DELETE FROM tenants` → o cascade apaga as filhas → apagar
 *   `finance_payments` DISPARA o gatilho `recalc_entry_paid()`, que é
 *   gatilho comum e roda com os privilégios de quem apaga → ele lê
 *   `finance_payments`, onde `stabilize_plataforma` não tinha acesso →
 *   `42501` → e `errors.ts` mapeia 42501 para 404 "Recurso não
 *   encontrado", de propósito.
 *
 * O QUE ISSO ENSINA SOBRE O TESTE: uma academia VAZIA é excluída sem
 * problema, porque sem pagamento o gatilho não dispara. Um teste que
 * criasse só o tenant passaria com o defeito presente e não provaria
 * nada. Por isso a academia daqui nasce COM movimento — aluno, cobrança
 * e baixa —, que é a única forma de exercitar o caminho que quebrava.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
/* Pede a credencial de MIGRAÇÃO como o outro teste da plataforma: o
   operador nasce em `platform_admins`, e `stabilize_app` foi
   DELIBERADAMENTE revogado dessa tabela — a API só a alcança pelas
   funções SECURITY DEFINER. Semear pela credencial da aplicação daria
   "permission denied", e o jeito de fazer passar seria conceder à API o
   acesso que o desenho tira dela. */
const TEST_MIGRATION_URL = process.env['TEST_MIGRATION_URL'];
const suite = TEST_DATABASE_URL && TEST_MIGRATION_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;
let raiz: pg.Pool;
let token = '';

const SENHA = 'operador-de-teste-longo-2026';
const ids = { tenant: '', slug: '', emailOperador: '' };

suite('excluir academia pelo painel da plataforma', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'excluir-acesso-somente-teste-tamanho-ok-1';
    process.env['JWT_REFRESH_SECRET'] = 'excluir-refresh-somente-teste-tamanho-ok-2';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 5).toString('base64');
    process.env['CORS_ORIGINS'] = 'http://localhost:5173';
    process.env['LOG_LEVEL'] = 'fatal';

    const { resetEnvCache } = await import('../../config/env.js');
    resetEnvCache();
    const { buildApp } = await import('../../app.js');
    app = await buildApp();
    await app.ready();
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    raiz = new pg.Pool({ connectionString: TEST_MIGRATION_URL });

    const sufixo = crypto.randomUUID().slice(0, 8);
    ids.slug = `exc-${sufixo}`;
    ids.emailOperador = `exc-op-${sufixo}@plataforma.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    const op = await raiz.connect();
    try {
      await op.query(
        `INSERT INTO platform_admins (email, password_hash, full_name)
         VALUES ($1,$2,'Operador de Teste')`,
        [ids.emailOperador, hash],
      );
    } finally {
      op.release();
    }

    const login0 = await app.inject({
      method: 'POST',
      url: '/api/plataforma/login',
      payload: { email: ids.emailOperador, senha: SENHA },
    });
    expect(login0.statusCode, login0.body).toBe(200);
    token = (login0.json() as { accessToken: string }).accessToken;

    /* A ACADEMIA NASCE PELA PRÓPRIA API DA PLATAFORMA, e não por SQL.
       Duas razões: o `stabilize_app` não cria academia (é da
       plataforma, de propósito) e o migrador não tem BYPASSRLS para
       driblar a política de `tenants`. Criar pelo caminho real ainda
       exercita a criação de brinde. */
    const criada = await app.inject({
      method: 'POST',
      url: '/api/plataforma/empresas',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        nome: 'Academia a Excluir',
        slug: ids.slug,
        donoNome: 'Dono da Academia',
        donoEmail: `exc-dono-${sufixo}@t.test`,
      },
    });
    expect(criada.statusCode, criada.body).toBe(201);
    ids.tenant = (criada.json() as { data: { empresaId: string } }).data.empresaId;

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1,$2,true)', ['app.tenant_id', ids.tenant]);

      const prof = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof','PROFESSIONAL') RETURNING id`,
        [ids.tenant, `exc-prof-${sufixo}@t.test`, hash],
      );
      const aluno = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno') RETURNING id`,
        [ids.tenant],
      );

      /* O MOVIMENTO QUE FAZ O DEFEITO APARECER. Sem a baixa, o gatilho
         `recalc_entry_paid` não é disparado no cascade e a exclusão
         passaria mesmo com o privilégio faltando. */
      const entrada = await c.query<{ id: string }>(
        `INSERT INTO finance_entries
           (tenant_id, direction, description, amount_cents, due_date, student_id, professional_id)
         VALUES ($1,'RECEIVABLE','Mensalidade',10000,current_date,$2,$3) RETURNING id`,
        [ids.tenant, aluno.rows[0]!.id, prof.rows[0]!.id],
      );
      await c.query(
        `INSERT INTO finance_payments (tenant_id, entry_id, amount_cents, method, paid_at)
         VALUES ($1,$2,10000,'PIX',now())`,
        [ids.tenant, entrada.rows[0]!.id],
      );

      /* `workout_plans.professional_id` é RESTRICT, e é o outro caminho
         que já travou uma exclusão em massa neste projeto. */
      await c.query(
        `INSERT INTO workout_plans (tenant_id, student_id, professional_id, name)
         VALUES ($1,$2,$3,'Treino A')`,
        [ids.tenant, aluno.rows[0]!.id, prof.rows[0]!.id],
      );

      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }

    /* Suspender é pré-requisito de excluir, e tem teste próprio. */
    const susp = await app.inject({
      method: 'POST',
      url: `/api/plataforma/empresas/${ids.tenant}/situacao`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ativa: false, motivo: 'teste' },
    });
    expect(susp.statusCode, susp.body).toBe(200);
  }, 60_000);


  afterAll(async () => {
    await raiz
      ?.query('DELETE FROM tenants WHERE id=$1', [ids.tenant])
      .catch(() => undefined);
    await raiz
      ?.query('DELETE FROM platform_admins WHERE email=$1', [ids.emailOperador])
      .catch(() => undefined);
    await raiz?.end();
    await pool?.end();
    await app?.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('recusa quando o identificador digitado não bate', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/plataforma/empresas/${ids.tenant}`,
      headers: auth(),
      payload: { confirmacao: 'nao-e-esse' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('não é o desta academia');
  });

  it('academia que não existe devolve 404 — e a mensagem DIZ que é a academia', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/plataforma/empresas/99999999-9999-4999-8999-999999999999',
      headers: auth(),
      payload: { confirmacao: 'qualquer' },
    });
    expect(r.statusCode).toBe(404);
    /* A MENSAGEM IMPORTA, e não só o código. "Academia não encontrado" é
       a recusa legítima; "Recurso não encontrado" é o texto genérico
       que `errors.ts` produz ao mascarar um 42501 do banco — foi
       exatamente ele que escondeu o defeito. Distinguir os dois aqui é
       o que faz este teste pegar a volta do problema. */
    expect(r.body).toContain('Academia não encontrado');
    expect(r.body).not.toContain('Recurso não encontrado');
  });

  it('exclui uma academia COM movimento — alunos, baixa e treino', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/plataforma/empresas/${ids.tenant}`,
      headers: auth(),
      payload: { confirmacao: ids.slug },
    });

    /* SE ISTO VOLTAR A DAR 404 com "Recurso não encontrado", é o
       privilégio de `stabilize_plataforma` que sumiu de novo — ver a
       migração 037. */
    expect(r.statusCode, r.body).toBe(200);
    const dados = (r.json() as { data: { nome: string; alunos: number; usuarios: number } }).data;
    expect(dados.nome).toBe('Academia a Excluir');
    expect(dados.alunos).toBe(1);
    /* DOIS: o dono, que a própria criação da academia cria, mais o
       profissional semeado aqui. O número aparece na confirmação da
       tela ("apaga ... 1 aluno, 2 usuários"), então errá-lo seria
       mentir para quem está prestes a apagar tudo. */
    expect(dados.usuarios).toBe(2);

    const { rows } = await raiz.query('SELECT 1 FROM tenants WHERE id=$1', [ids.tenant]);
    expect(rows).toHaveLength(0);
  });

  it('e leva junto tudo o que era dela', async () => {
    for (const tabela of ['students', 'users', 'finance_entries', 'finance_payments', 'workout_plans']) {
      const { rows } = await raiz.query(`SELECT 1 FROM ${tabela} WHERE tenant_id=$1`, [ids.tenant]);
      expect(rows, tabela).toHaveLength(0);
    }
  });
});
