import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';
import zlib from 'node:zlib';

/**
 * Os relatórios de gestão.
 *
 * O QUE ESTES TESTES PROTEGEM são as três contas que, se errarem, erram
 * em silêncio — o PDF sai bonito com o número trocado:
 *
 *   1. A taxa de comparecimento é sobre PRESENÇAS + FALTAS, e não sobre
 *      o agendado. Contar cancelamento como falta puniria quem avisou.
 *   2. As horas saem da duração REAL de cada atendimento. Uma média
 *      multiplicada pela contagem esconderia a diferença entre sessão
 *      de 30 e de 60 minutos, que é exatamente o que se quer ver.
 *   3. A inadimplência mostra o SALDO, não o valor cheio: uma conta
 *      paga pela metade inflaria a dívida da academia.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';
const ids = { tenant: '', slug: '', dono: '', prof: '', profId: '', aluno: '', outroProfId: '' };

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

function textoDoPdf(pdf: Buffer): string {
  const bruto = pdf.toString('latin1');
  let conteudo = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bruto)) !== null) {
    try {
      conteudo += zlib.inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      /* fonte ou imagem */
    }
  }
  let saida = '';
  for (const bloco of conteudo.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    saida += Buffer.from(bloco[1]!, 'hex').toString('latin1');
  }
  return saida;
}

/* O período do teste: um mês fixo, para não depender de "hoje". */
const DE = '2026-03-01';
const ATE = '2026-03-31';

suite('Relatórios de gestão', () => {
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
    ids.slug = `gst-${sufixo}`;
    ids.dono = `dono-${sufixo}@gst.test`;
    ids.prof = `prof-${sufixo}@gst.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia Gestao',
        ids.slug,
      ]);
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono Gestao','OWNER')`,
        [ids.tenant, ids.dono, hash],
      );
      const p = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Alvo','PROFESSIONAL') RETURNING id`,
        [ids.tenant, ids.prof, hash],
      );
      ids.profId = p.rows[0]!.id;

      const p2 = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Outro','PROFESSIONAL') RETURNING id`,
        [ids.tenant, `outro-${sufixo}@gst.test`, hash],
      );
      ids.outroProfId = p2.rows[0]!.id;

      const s = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name) VALUES ($1,'Aluno Gestao') RETURNING id`,
        [ids.tenant],
      );
      ids.aluno = s.rows[0]!.id;

      /* MASSA COM NÚMEROS QUE SE DISTINGUEM:
         - 2 realizados de 60 min  = 120
         - 1 realizado  de 30 min  =  30   → total 2h30
         - 1 falta      (não conta nas horas)
         - 1 cancelado  (não conta nas horas NEM no comparecimento) */
      const marcar = (dia: number, hora: number, min: number, status: string, prof: string) =>
        c.query(
          `INSERT INTO appointments
             (tenant_id, student_id, professional_id, period, status, cancelled_at)
           VALUES ($1,$2,$3,
                   tstzrange(
                     ('2026-03-${String(dia).padStart(2, '0')} ${String(hora).padStart(2, '0')}:00:00-03')::timestamptz,
                     ('2026-03-${String(dia).padStart(2, '0')} ${String(hora).padStart(2, '0')}:00:00-03')::timestamptz + ($4 || ' minutes')::interval,
                     '[)'),
                   $5::appointment_status,
                   /* O schema exige coerencia: cancelado TEM data de
                      cancelamento, o resto NAO tem. E a regra certa —
                      "cancelado sem quando" e um registro que ninguem
                      consegue auditar depois. */
                   CASE WHEN $5 = 'CANCELLED' THEN now() ELSE NULL END)`,
          [ids.tenant, ids.aluno, prof, String(min), status],
        );

      await marcar(3, 8, 60, 'ATTENDED', ids.profId);
      await marcar(5, 8, 60, 'ATTENDED', ids.profId);
      await marcar(10, 9, 30, 'ATTENDED', ids.profId);
      await marcar(12, 8, 60, 'NO_SHOW', ids.profId);
      await marcar(17, 8, 60, 'CANCELLED', ids.profId);
      /* Do outro professor, para provar que o filtro separa. */
      await marcar(19, 7, 60, 'ATTENDED', ids.outroProfId);

      /* Cobrança vencida com pagamento PARCIAL: 300,00 devidos, 100,00
         pagos. O relatório tem que mostrar 200,00, não 300,00. */
      const e = await c.query<{ id: string }>(
        `INSERT INTO finance_entries
           (tenant_id, direction, description, amount_cents, due_date, student_id, status)
         VALUES ($1,'RECEIVABLE','Mensalidade marco',30000,'2026-03-10',$2,'PARTIALLY_PAID') RETURNING id`,
        [ids.tenant, ids.aluno],
      );
      await c.query(
        `INSERT INTO finance_payments (tenant_id, entry_id, amount_cents, paid_at, method)
         VALUES ($1,$2,10000,'2026-03-15 12:00:00-03','PIX')`,
        [ids.tenant, e.rows[0]!.id],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ================================================================
   * Presença
   * ============================================================== */

  it('presença geral traz o aluno e a taxa sobre o REALIZADO', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/presenca?de=${DE}&ate=${ATE}`,
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(200);
    const t = textoDoPdf(res.rawPayload);

    expect(t).toContain('Aluno Gestao');
    /* 4 realizados (3 presenças + 1 falta) de 5 agendados; o cancelado
       fica de fora da conta. 3/4 = 75%. Se alguém trocar para 3/5, sai
       60% e este teste falha. */
    expect(t).toContain('75%');
    expect(t).not.toContain('60%');
  });

  it('presença por professor separa um do outro', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/presenca?de=${DE}&ate=${ATE}&profissionalId=${ids.outroProfId}`,
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(200);
    const t = textoDoPdf(res.rawPayload);
    expect(t).toContain('Prof Outro');
    expect(t).not.toContain('Prof Alvo');
  });

  it('período sem nada não quebra — diz que não há', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/presenca?de=2020-01-01&ate=2020-01-31',
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(200);
    expect(textoDoPdf(res.rawPayload)).toContain('Nenhum atendimento');
  });

  it('data fora do formato é recusada com 422', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/presenca?de=01/03/2026&ate=2026-03-31',
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(422);
  });

  /* ================================================================
   * Ocupação
   * ============================================================== */

  it('as horas somam a DURAÇÃO real, e ignoram falta e cancelado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/ocupacao?de=${DE}&ate=${ATE}`,
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(200);
    const t = textoDoPdf(res.rawPayload);

    expect(t).toContain('Prof Alvo');
    /* 60 + 60 + 30 = 150 min = 2h30. A falta (60) e o cancelado (60)
       ficam de fora: se entrassem, daria 4h30. */
    expect(t).toContain('2h30');
    expect(t).not.toContain('4h30');
  });

  it('a ocupação conta os dois professores', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/ocupacao?de=${DE}&ate=${ATE}`,
      headers: como(await tokenDe(ids.dono)),
    });
    const t = textoDoPdf(res.rawPayload);
    expect(t).toContain('Prof Alvo');
    expect(t).toContain('Prof Outro');
  });

  /* ================================================================
   * Inadimplência
   * ============================================================== */

  it('a inadimplência mostra o SALDO, não o valor cheio', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/inadimplencia',
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(200);
    const t = textoDoPdf(res.rawPayload);

    expect(t).toContain('Mensalidade marco');
    /* 300,00 devidos - 100,00 pagos = 200,00. O valor cheio inflaria a
       dívida da academia em 50%. */
    expect(t).toContain('200,00');
    expect(t).not.toContain('300,00');
  });

  /* ================================================================
   * Regressão: o relatório de frequência estava QUEBRADO
   *
   * Ele consultava `a.starts_at`, coluna que nunca existiu — o horário
   * mora em `period tstzrange`. Qualquer chamada devolvia 500 desde que
   * o relatório foi escrito, e ninguém percebeu porque NENHUM teste
   * cobria o caminho de sucesso: os que existiam testavam só permissão,
   * onde a consulta nem chega a rodar.
   *
   * Este teste existe para que isso não volte em silêncio.
   * ============================================================== */
  it('o relatório de frequência de um aluno gera de verdade', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/relatorios/frequencia/${ids.aluno}`,
      headers: como(await tokenDe(ids.dono)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const t = textoDoPdf(res.rawPayload);
    expect(t).toContain('Aluno Gestao');
    expect(t).toContain('Frequ');
  });

  it('o profissional não emite o relatório de inadimplência', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/inadimplencia',
      headers: como(await tokenDe(ids.prof)),
    });
    expect(res.statusCode).toBe(403);
  });
});
