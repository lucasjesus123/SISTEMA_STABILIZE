import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';
import { textoDoPdf } from '../../testes/texto-do-pdf.js';

/**
 * Relatórios em PDF.
 *
 * O TESTE QUE IMPORTA não é o desenho — é que o PDF não seja uma PORTA
 * LATERAL. Se o profissional não pode ler o prontuário de um aluno na
 * tela, também não pode baixá-lo em PDF; e o que entra no arquivo tem que
 * respeitar o papel de quem pediu, não o de quem vai ler depois.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';
const ids = {
  tenant: '',
  slug: '',
  emailProfAlfa: '',
  emailProfBeta: '',
  emailRecepcao: '',
  emailDono: '',
  alunoDoAlfa: '',
};

const SEGREDO_CLINICO = 'hernia-de-disco-marcador-unico';

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
  const emCache = cache.get(email);
  if (emCache !== undefined) return emCache;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA, tenantSlug: ids.slug },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) throw new Error(`login falhou: ${res.body}`);
  cache.set(email, body.accessToken);
  return body.accessToken;
}
const como = (t: string) => ({ authorization: `Bearer ${t}` });


suite('Relatórios', () => {
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
    ids.tenant = crypto.randomUUID();
    ids.slug = `rel-${sufixo}`;
    ids.emailProfAlfa = `rel-alfa-${sufixo}@rel.test`;
    ids.emailProfBeta = `rel-beta-${sufixo}@rel.test`;
    ids.emailRecepcao = `rel-recep-${sufixo}@rel.test`;
    ids.emailDono = `rel-dono-${sufixo}@rel.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia Relatórios',
        ids.slug,
      ]);
      const pa = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Alfa','PROFESSIONAL') RETURNING id`,
        [ids.tenant, ids.emailProfAlfa, hash],
      );
      const pb = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Beta','PROFESSIONAL') RETURNING id`,
        [ids.tenant, ids.emailProfBeta, hash],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Recepcao','RECEPTION')`,
        [ids.tenant, ids.emailRecepcao, hash],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono','OWNER')`,
        [ids.tenant, ids.emailDono, hash],
      );

      const s = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name, whatsapp)
         VALUES ($1,'Marina Relatorio','+5531977776666') RETURNING id`,
        [ids.tenant],
      );
      ids.alunoDoAlfa = s.rows[0]!.id;

      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenant, ids.alunoDoAlfa, pa.rows[0]!.id],
      );
      // O Beta existe e não atende esta aluna.
      void pb;

      await c.query(
        `INSERT INTO anamneses (tenant_id, student_id, professional_id, clinical_history, height_cm, weight_g)
         VALUES ($1,$2,$3,$4,168,61000)`,
        [ids.tenant, ids.alunoDoAlfa, pa.rows[0]!.id, SEGREDO_CLINICO],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('gera a ficha do aluno em PDF de verdade', async () => {
    const token = await tokenDe(ids.emailProfAlfa);
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/aluno/${ids.alunoDoAlfa}`,
      headers: como(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    // Assinatura de PDF: os quatro primeiros bytes.
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(res.rawPayload.length).toBeGreaterThan(1000);
  });

  it('o PDF sai como anexo e sem cache', async () => {
    /* Mesma regra dos anexos: PDF servido inline executa JavaScript no
       domínio do sistema em vários leitores. */
    const token = await tokenDe(ids.emailProfAlfa);
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/aluno/${ids.alunoDoAlfa}`,
      headers: como(token),
    });

    expect(res.headers['content-disposition']).toContain('attachment;');
    expect(res.headers['content-disposition']).toContain('.pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('um profissional NÃO baixa a ficha do aluno de um colega', async () => {
    /* O relatório não é uma porta lateral: passa pelo mesmo escopo da
       tela. */
    const beta = await tokenDe(ids.emailProfBeta);
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/aluno/${ids.alunoDoAlfa}`,
      headers: como(beta),
    });
    expect(res.statusCode).toBe(404);
  });

  it('a ficha do profissional CONTÉM a anamnese', async () => {
    const token = await tokenDe(ids.emailProfAlfa);
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/aluno/${ids.alunoDoAlfa}`,
      headers: como(token),
    });
    expect(textoDoPdf(res.rawPayload)).toContain(SEGREDO_CLINICO);
  });

  it('a ficha da RECEPÇÃO não contém dado clínico', async () => {
    /* A recepcionista pode ver o cadastro para atender no balcão — e não
       pode levar o histórico clínico para casa num PDF. O papel de quem
       PEDE decide o conteúdo. */
    const token = await tokenDe(ids.emailRecepcao);
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/aluno/${ids.alunoDoAlfa}`,
      headers: como(token),
    });

    expect(res.statusCode).toBe(200);
    const texto = textoDoPdf(res.rawPayload);
    expect(texto).toContain('Marina');
    expect(texto).not.toContain(SEGREDO_CLINICO);
  });

  it('a geração do relatório fica registrada', async () => {
    const token = await tokenDe(ids.emailProfAlfa);
    await app.inject({
      method: 'GET',
      url: `/api/relatorios/aluno/${ids.alunoDoAlfa}`,
      headers: como(token),
    });

    /* Um PDF SAI do sistema: depois de baixado não há revogação nem
       expiração. O log é o que resta para responder quem levou o
       prontuário desta pessoa daqui. */
    const { rows } = await comTenant(ids.tenant, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'report.generate' AND resource_id = $1`,
        [ids.alunoDoAlfa],
      ),
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('a tentativa NEGADA de baixar também fica registrada', async () => {
    const beta = await tokenDe(ids.emailProfBeta);
    await app.inject({
      method: 'GET',
      url: `/api/relatorios/aluno/${ids.alunoDoAlfa}`,
      headers: como(beta),
    });

    const { rows } = await comTenant(ids.tenant, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'report.generate' AND resource_id = $1 AND outcome = 'DENIED'`,
        [ids.alunoDoAlfa],
      ),
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('as datas saem em pt-BR, não em inglês', async () => {
    /* Defeito real, achado ao ABRIR o PDF e não nos testes: o
       repositório fazia `String(Date).slice(0,10)` e devolvia
       "Sun Mar 2" como se fosse ISO. O campo continuava sendo string não
       vazia, então nada quebrava — só ficava errado na folha, e também
       na tela. */
    await comTenant(ids.tenant, async (c) => {
      await c.query(`UPDATE students SET birth_date = '1993-03-28' WHERE id = $1`, [
        ids.alunoDoAlfa,
      ]);
    });

    const token = await tokenDe(ids.emailProfAlfa);
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/aluno/${ids.alunoDoAlfa}`,
      headers: como(token),
    });

    const texto = textoDoPdf(res.rawPayload);
    expect(texto).toContain('28/03/1993');
    expect(texto).not.toContain('Mar 2');
  });

  it('o financeiro exige permissão de relatório financeiro', async () => {
    const prof = await tokenDe(ids.emailProfAlfa);
    const negado = await app.inject({
      method: 'GET',
      url: '/api/relatorios/financeiro?de=2026-01-01&ate=2026-12-31',
      headers: como(prof),
    });
    expect(negado.statusCode).toBe(403);

    const dono = await tokenDe(ids.emailDono);
    const permitido = await app.inject({
      method: 'GET',
      url: '/api/relatorios/financeiro?de=2026-01-01&ate=2026-12-31',
      headers: como(dono),
    });
    expect(permitido.statusCode).toBe(200);
    expect(permitido.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('a relação de alunos do profissional traz só os dele', async () => {
    const beta = await tokenDe(ids.emailProfBeta);
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/alunos',
      headers: como(beta),
    });

    expect(res.statusCode).toBe(200);
    // O Beta não atende a Marina: ela não pode aparecer na relação dele.
    expect(textoDoPdf(res.rawPayload)).not.toContain('Marina');
  });
});
