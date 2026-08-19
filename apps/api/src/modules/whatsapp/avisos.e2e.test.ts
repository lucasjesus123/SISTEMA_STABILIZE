import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Confirmação e lembrete de agendamento — a fila que ninguém escrevia.
 *
 * O QUE ESTES TESTES GUARDAM:
 *
 *   1. AS DUAS MENSAGENS NASCEM COM HORAS DIFERENTES. A confirmação sai
 *      agora; o lembrete, N horas antes da aula. Se as duas nascerem com
 *      `now()` — que é o default da coluna — o aluno recebe o lembrete
 *      no mesmo minuto em que marca, e o recurso vira ruído.
 *
 *   2. O LEMBRETE ATRASADO NÃO NASCE. Aula daqui a uma hora com lembrete
 *      de três horas antes teria hora de envio no passado.
 *
 *   3. CANCELAR A AULA MATA O LEMBRETE PENDENTE e preserva o que já
 *      saiu. É o defeito mais caro deste módulo: quem recebe "sua aula é
 *      hoje" depois de ter desmarcado não acredita na próxima mensagem.
 *
 *   4. SEM TELEFONE NÃO ENTRA NA FILA — senão a fila enche de linhas que
 *      só podem falhar.
 *
 * Requer TEST_DATABASE_URL num papel SEM BYPASSRLS.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let pool: pg.Pool;
let enfileirar: typeof import('./avisos.js').enfileirarAvisosDoAgendamento;
let cancelar: typeof import('./avisos.js').cancelarAvisosDoAgendamento;
let withTenant: typeof import('../../db/pool.js').withTenant;

const ids = { tenant: '', prof: '', comZap: '', semZap: '' };

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

/** Cria um agendamento daqui a `horas` horas e devolve o id. */
async function marcar(studentId: string, horas: number): Promise<string> {
  return comTenant(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO appointments (tenant_id, student_id, professional_id, period)
       VALUES ($1, $2, $3,
               tstzrange(now() + make_interval(hours => $4::int),
                         now() + make_interval(hours => $4::int) + interval '50 minutes'))
       RETURNING id`,
      [ids.tenant, studentId, ids.prof, horas],
    );
    return rows[0]!.id;
  });
}

interface NaFila {
  kind: string;
  body: string;
  status: string;
  enviar_apos: Date;
  minutos_ate_envio: number;
}

async function fila(appointmentId: string): Promise<NaFila[]> {
  return comTenant(async (c) => {
    const { rows } = await c.query<NaFila>(
      `SELECT kind, body, status, enviar_apos,
              round(extract(epoch FROM (enviar_apos - now())) / 60)::int AS minutos_ate_envio
         FROM whatsapp_messages WHERE appointment_id = $1 ORDER BY enviar_apos`,
      [appointmentId],
    );
    return rows;
  });
}

suite('Avisos de agendamento no WhatsApp', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'zK3-acesso-somente-para-teste-com-tamanho-suficiente-01';
    process.env['JWT_REFRESH_SECRET'] = 'qP9-refresh-somente-para-teste-com-tamanho-suficiente-02';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    process.env['LOG_LEVEL'] = 'fatal';

    const { resetEnvCache } = await import('../../config/env.js');
    resetEnvCache();
    ({ enfileirarAvisosDoAgendamento: enfileirar, cancelarAvisosDoAgendamento: cancelar } =
      await import('./avisos.js'));
    ({ withTenant } = await import('../../db/pool.js'));

    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    ids.tenant = crypto.randomUUID();
    const sufixo = crypto.randomUUID().slice(0, 8);

    await comTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id,name,slug,timezone,wa_confirmar_agendamento,wa_lembrete_horas)
         VALUES ($1,'Academia dos Avisos',$2,'America/Sao_Paulo',true,3)`,
        [ids.tenant, `avisos-${sufixo}`],
      );
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,'x','Carla Menezes','PROFESSIONAL') RETURNING id`,
        [ids.tenant, `prof-${sufixo}@avisos.test`],
      );
      ids.prof = u.rows[0]!.id;

      const a = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name,whatsapp)
         VALUES ($1,'Renata Souza Lima','+5511999990001') RETURNING id`,
        [ids.tenant],
      );
      ids.comZap = a.rows[0]!.id;

      const b = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Sem Telefone') RETURNING id`,
        [ids.tenant],
      );
      ids.semZap = b.rows[0]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('enfileira confirmação para agora e lembrete para N horas antes da aula', async () => {
    const agendamento = await marcar(ids.comZap, 48);
    const r = await withTenant({ tenantId: ids.tenant }, (c) =>
      enfileirar(c, ids.tenant, agendamento),
    );
    expect(r).toEqual({ confirmacao: true, lembrete: true });

    const linhas = await fila(agendamento);
    expect(linhas.map((l) => l.kind)).toEqual(['BOOKING', 'REMINDER']);
    expect(linhas.every((l) => l.status === 'PENDING')).toBe(true);

    /* A confirmação sai agora; o lembrete, 45 h à frente (48 da aula
       menos as 3 configuradas). Se as duas nascessem com `now()` — que é
       o default da coluna — este é o teste que quebraria. */
    expect(linhas[0]!.minutos_ate_envio).toBeLessThanOrEqual(1);
    expect(linhas[1]!.minutos_ate_envio).toBeGreaterThan(44 * 60);
    expect(linhas[1]!.minutos_ate_envio).toBeLessThan(46 * 60);
  });

  it('o texto traz o primeiro nome, a hora no fuso da academia e quem atende', async () => {
    const agendamento = await marcar(ids.comZap, 30);
    await withTenant({ tenantId: ids.tenant }, (c) => enfileirar(c, ids.tenant, agendamento));
    const linhas = await fila(agendamento);

    const confirmacao = linhas.find((l) => l.kind === 'BOOKING')!;
    expect(confirmacao.body).toContain('Renata');
    /* Primeiro nome, não o nome inteiro: "Renata Souza Lima, seu horário
       está marcado" é como banco fala com cliente, não como academia
       fala com aluno. */
    expect(confirmacao.body).not.toContain('Renata Souza Lima');
    expect(confirmacao.body).toContain('Carla');
    expect(confirmacao.body).toContain('Academia dos Avisos');
    /* A hora vem formatada do banco no fuso da empresa. */
    expect(confirmacao.body).toMatch(/às \d{2}:\d{2}/);

    /* O DIA DA SEMANA EM PORTUGUÊS. O primeiro envio real saiu com
       "monday, 24/08": `to_char(..., 'TMday')` usa o `lc_time` da
       conexão, e na VPS ele é o que o Postgres herdou do sistema. */
    expect(confirmacao.body).toMatch(
      /(domingo|segunda|terça|quarta|quinta|sexta|sábado) \d{2}\/\d{2}/,
    );
    expect(confirmacao.body.toLowerCase()).not.toMatch(
      /monday|tuesday|wednesday|thursday|friday|saturday|sunday/,
    );
  });

  it('o tratamento do profissional não engole o nome dele', async () => {
    /* "Dr. Paulo Ferreira" tem "Dr." como primeira palavra. Pegar a
       primeira palavra fazia a mensagem sair "com Dr..", que foi o que
       apareceu no primeiro envio de verdade. */
    const doutor = await comTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,'x','Dr. Paulo Ferreira','PROFESSIONAL') RETURNING id`,
        [ids.tenant, `dr-${crypto.randomUUID().slice(0, 8)}@avisos.test`],
      );
      return rows[0]!.id;
    });

    const agendamento = await comTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO appointments (tenant_id, student_id, professional_id, period)
         VALUES ($1,$2,$3, tstzrange(now() + interval '20 hours',
                                     now() + interval '21 hours'))
         RETURNING id`,
        [ids.tenant, ids.comZap, doutor],
      );
      return rows[0]!.id;
    });

    await withTenant({ tenantId: ids.tenant }, (c) => enfileirar(c, ids.tenant, agendamento));
    const corpo = (await fila(agendamento))[0]!.body;
    expect(corpo).toContain('Dr. Paulo');
    expect(corpo).not.toContain('Dr..');
  });

  it('não enfileira lembrete quando a hora dele já passou', async () => {
    /* Aula daqui a uma hora, lembrete de três horas antes: a hora de
       envio seria no passado, e a mensagem sairia junto com a
       confirmação dizendo "lembrete". */
    const agendamento = await marcar(ids.comZap, 1);
    const r = await withTenant({ tenantId: ids.tenant }, (c) =>
      enfileirar(c, ids.tenant, agendamento),
    );
    expect(r).toEqual({ confirmacao: true, lembrete: false });
    expect((await fila(agendamento)).map((l) => l.kind)).toEqual(['BOOKING']);
  });

  it('aluno sem telefone não entra na fila', async () => {
    const agendamento = await marcar(ids.semZap, 24);
    const r = await withTenant({ tenantId: ids.tenant }, (c) =>
      enfileirar(c, ids.tenant, agendamento),
    );
    expect(r).toEqual({ confirmacao: false, lembrete: false });
    expect(await fila(agendamento)).toHaveLength(0);
  });

  it('enfileirar duas vezes não gera mensagem repetida', async () => {
    const agendamento = await marcar(ids.comZap, 72);
    await withTenant({ tenantId: ids.tenant }, (c) => enfileirar(c, ids.tenant, agendamento));
    const segunda = await withTenant({ tenantId: ids.tenant }, (c) =>
      enfileirar(c, ids.tenant, agendamento),
    );
    expect(segunda).toEqual({ confirmacao: false, lembrete: false });
    expect(await fila(agendamento)).toHaveLength(2);
  });

  it('cancelar a aula apaga o pendente e preserva o que já saiu', async () => {
    const agendamento = await marcar(ids.comZap, 96);
    await withTenant({ tenantId: ids.tenant }, (c) => enfileirar(c, ids.tenant, agendamento));

    /* A confirmação já saiu — é verdade histórica: o horário FOI
       marcado. O lembrete ainda não, e esse tem que morrer com a aula. */
    await comTenant((c) =>
      c.query(
        `UPDATE whatsapp_messages SET status = 'SENT', sent_at = now()
          WHERE appointment_id = $1 AND kind = 'BOOKING'`,
        [agendamento],
      ),
    );

    const apagadas = await withTenant({ tenantId: ids.tenant }, (c) => cancelar(c, agendamento));
    expect(apagadas).toBe(1);

    const restou = await fila(agendamento);
    expect(restou).toHaveLength(1);
    expect(restou[0]!.kind).toBe('BOOKING');
    expect(restou[0]!.status).toBe('SENT');
  });

  it('com a confirmação desligada só o lembrete é enfileirado', async () => {
    await comTenant((c) =>
      c.query('UPDATE tenants SET wa_confirmar_agendamento = false WHERE id = $1', [ids.tenant]),
    );
    const agendamento = await marcar(ids.comZap, 36);
    const r = await withTenant({ tenantId: ids.tenant }, (c) =>
      enfileirar(c, ids.tenant, agendamento),
    );
    expect(r).toEqual({ confirmacao: false, lembrete: true });

    /* E com `wa_lembrete_horas = 0` — que a migração documenta como
       "desliga o lembrete" — nenhuma das duas sai. */
    await comTenant((c) =>
      c.query('UPDATE tenants SET wa_lembrete_horas = 0 WHERE id = $1', [ids.tenant]),
    );
    /* Outra hora: o banco recusa dois agendamentos sobrepostos do mesmo
       profissional, e é assim que tem que ser. */
    const outro = await marcar(ids.comZap, 60);
    const r2 = await withTenant({ tenantId: ids.tenant }, (c) =>
      enfileirar(c, ids.tenant, outro),
    );
    expect(r2).toEqual({ confirmacao: false, lembrete: false });
  });
});
