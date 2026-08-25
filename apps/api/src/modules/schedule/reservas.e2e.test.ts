import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';

/**
 * Reserva de espaço — mezanino, hall, sala de bike.
 *
 * O QUE ESTES TESTES GUARDAM:
 *
 *   1. DOIS EVENTOS NÃO OCUPAM O MESMO ESPAÇO NA MESMA HORA. Sem a
 *      restrição de exclusão no banco, duas pessoas clicando ao mesmo
 *      tempo em computadores diferentes reservam as duas — e a segunda
 *      reserva só vira problema quando as duas turmas chegam na porta.
 *
 *   2. A REPETIÇÃO GERA OCORRÊNCIAS DE VERDADE, e o dia da semana é
 *      respeitado. Uma regra guardada só como regra não teria onde
 *      colocar a exceção do feriado.
 *
 *   3. CANCELAR A SÉRIE NÃO APAGA O PASSADO. A aula de terça passada
 *      aconteceu; apagá-la porque a turma acabou hoje reescreveria a
 *      história de ocupação do espaço.
 *
 *   4. O ESPAÇO RESERVADO NÃO É OFERECIDO COMO HORÁRIO LIVRE. É o
 *      motivo pelo qual a tabela existe: se a reserva não tirar o
 *      horário da lista, ela é só um post-it colorido.
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
  bike: '',
  mezanino: '',
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

const como = (t: string) => ({ authorization: `Bearer ${t}` });

/** Uma data futura previsível: a próxima ocorrência do dia da semana. */
function proximo(diaDaSemana: number, semanas = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + semanas * 7);
  while (d.getDay() !== diaDaSemana) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function reservar(
  corpo: Record<string, unknown>,
  email = ids.emailDono,
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: '/api/reservas',
    headers: como(await tokenDe(email)),
    payload: corpo,
  });
}

interface Reserva {
  id: string;
  serieId: string | null;
  inicio: string;
  fim: string;
  titulo: string;
  espaco: string | null;
}

async function listar(de: string, ate: string): Promise<Reserva[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/reservas?de=${de}&ate=${ate}`,
    headers: como(await tokenDe(ids.emailDono)),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: Reserva[] }).data;
}

suite('Reserva de espaço', () => {
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
    ids.slug = `esp-${ids.sufixo}`;
    ids.emailDono = `dono-${ids.sufixo}@espaco.test`;
    ids.emailProf = `prof-${ids.sufixo}@espaco.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id,name,slug,timezone)
         VALUES ($1,'Academia dos Espaços',$2,'America/Sao_Paulo')`,
        [ids.tenant, ids.slug],
      );
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

      const bike = await c.query<{ id: string }>(
        `INSERT INTO rooms (tenant_id,name,capacity,color)
         VALUES ($1,'Sala de Bike',20,'#2e9aa1') RETURNING id`,
        [ids.tenant],
      );
      ids.bike = bike.rows[0]!.id;

      const mez = await c.query<{ id: string }>(
        `INSERT INTO rooms (tenant_id,name,capacity) VALUES ($1,'Mezanino',12) RETURNING id`,
        [ids.tenant],
      );
      ids.mezanino = mez.rows[0]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ==================================================================
   * Reserva avulsa
   * ================================================================ */

  it('reserva um espaço num dia e horário', async () => {
    const dia = proximo(2); // terça
    const res = await reservar({
      roomId: ids.mezanino,
      titulo: 'Avaliação da turma nova',
      de: dia,
      horaInicio: '19:00',
      horaFim: '20:00',
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { criadas: number } }).data.criadas).toBe(1);

    const lista = await listar(dia, dia);
    expect(lista).toHaveLength(1);
    expect(lista[0]!.titulo).toBe('Avaliação da turma nova');
    expect(lista[0]!.espaco).toBe('Mezanino');
    /* A hora é gravada no fuso da ACADEMIA, não no do servidor. Às 19h
       em São Paulo são 22h em UTC. */
    expect(new Date(lista[0]!.inicio).toISOString()).toContain('T22:00');
  });

  it('o mesmo espaço no mesmo horário é recusado com 409', async () => {
    const dia = proximo(2);
    const res = await reservar({
      roomId: ids.mezanino,
      titulo: 'Outra coisa',
      de: dia,
      horaInicio: '19:30',
      horaFim: '20:30',
    });
    /* Sobrepõe em meia hora. Sem a restrição de exclusão no banco, as
       duas turmas chegariam na porta ao mesmo tempo. */
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('já está reservado');
  });

  it('outro espaço no mesmo horário é permitido', async () => {
    const dia = proximo(2);
    const res = await reservar({
      roomId: ids.bike,
      titulo: 'Spinning',
      de: dia,
      horaInicio: '19:00',
      horaFim: '20:00',
    });
    expect(res.statusCode).toBe(201);
  });

  it('o fim precisa ser depois do início', async () => {
    const res = await reservar({
      roomId: ids.bike,
      titulo: 'Invertido',
      de: proximo(4),
      horaInicio: '20:00',
      horaFim: '19:00',
    });
    expect(res.statusCode).toBe(422);
  });

  /* ==================================================================
   * Reserva que se repete
   * ================================================================ */

  it('repete nos dias da semana pedidos e gera uma ocorrência por dia', async () => {
    const inicio = proximo(1, 2); // uma segunda daqui a duas semanas
    const fim = new Date(inicio);
    fim.setDate(fim.getDate() + 27); // quatro semanas
    const ate = `${fim.getFullYear()}-${String(fim.getMonth() + 1).padStart(2, '0')}-${String(fim.getDate()).padStart(2, '0')}`;

    const res = await reservar({
      roomId: ids.bike,
      titulo: 'Spinning das 7h',
      de: inicio,
      ate,
      horaInicio: '07:00',
      horaFim: '08:00',
      diasDaSemana: [1, 3], // segunda e quarta
    });
    expect(res.statusCode).toBe(201);

    const { criadas, serieId } = (res.json() as {
      data: { criadas: number; serieId: string };
    }).data;
    /* Quatro semanas de segundas e quartas: oito ocorrências. */
    expect(criadas).toBe(8);
    expect(serieId).not.toBeNull();

    const lista = await listar(inicio, ate);
    const daSerie = lista.filter((r) => r.serieId === serieId);
    expect(daSerie).toHaveLength(8);

    /* TODAS caem em segunda ou quarta. Se o `generate_series` filtrasse
       errado, apareceriam terças aqui — e ninguém confere oito datas à
       mão depois de criar. */
    const diasGerados = new Set(daSerie.map((r) => new Date(r.inicio).getDay()));
    expect([...diasGerados].sort()).toEqual([1, 3]);
  });

  it('repetir sem dizer até quando é recusado', async () => {
    const res = await reservar({
      roomId: ids.mezanino,
      titulo: 'Sem fim',
      de: proximo(5),
      horaInicio: '10:00',
      horaFim: '11:00',
      diasDaSemana: [5],
    });
    expect(res.statusCode).toBe(422);
  });

  it('dia da semana que não cai no intervalo devolve erro, e não sucesso vazio', async () => {
    const terca = proximo(2, 6);
    /* "Toda segunda, de terça a terça." Devolver 201 com zero reservas
       seria dizer que deu certo. */
    const res = await reservar({
      roomId: ids.mezanino,
      titulo: 'Impossível',
      de: terca,
      ate: terca,
      horaInicio: '10:00',
      horaFim: '11:00',
      diasDaSemana: [1],
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Nenhuma data');
  });

  /* ==================================================================
   * Cancelamento
   * ================================================================ */

  it('cancela uma ocorrência sem derrubar a série — o caso do feriado', async () => {
    const inicio = proximo(1, 10);
    const fim = new Date(inicio);
    fim.setDate(fim.getDate() + 20);
    const ate = `${fim.getFullYear()}-${String(fim.getMonth() + 1).padStart(2, '0')}-${String(fim.getDate()).padStart(2, '0')}`;

    const criada = await reservar({
      roomId: ids.mezanino,
      titulo: 'Funcional',
      de: inicio,
      ate,
      horaInicio: '18:00',
      horaFim: '19:00',
      diasDaSemana: [1],
    });
    const serieId = (criada.json() as { data: { serieId: string } }).data.serieId;

    const antes = (await listar(inicio, ate)).filter((r) => r.serieId === serieId);
    expect(antes.length).toBeGreaterThanOrEqual(3);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/reservas/${antes[1]!.id}`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(res.statusCode).toBe(200);

    const depois = (await listar(inicio, ate)).filter((r) => r.serieId === serieId);
    expect(depois).toHaveLength(antes.length - 1);
    expect(depois.some((r) => r.id === antes[1]!.id)).toBe(false);
  });

  it('cancelar a série apaga o futuro e preserva o passado', async () => {
    const serieId = crypto.randomUUID();
    /* Uma ocorrência ontem e duas nas próximas semanas, montadas direto
       no banco: a rota recusaria criar reserva no passado, e é o passado
       que este teste precisa ter.

       SALA PRÓPRIA, E NÃO A SALA DE BIKE. Os períodos aqui saem de
       `now()`, então a hora em que a suíte roda entra na conta: rodando
       entre 21h e 22h UTC, `now() + 7 dias` caía em cima do "Spinning"
       que outro teste deste mesmo arquivo reservou na bike, e a
       restrição de exclusão recusava o INSERT. O teste quebrava pelo
       relógio da máquina, não pelo código — o pior tipo de teste
       vermelho, porque ensina a ignorar teste vermelho. Uma sala só
       deste teste não disputa horário com ninguém. */
    const sala = await comTenant((c) =>
      c.query<{ id: string }>(
        `INSERT INTO rooms (tenant_id,name,capacity) VALUES ($1,'Sala da Série',8) RETURNING id`,
        [ids.tenant],
      ),
    );
    const salaId = sala.rows[0]!.id;

    await comTenant((c) =>
      c.query(
        `INSERT INTO availability_blocks (tenant_id, room_id, period, reason, serie_id)
         VALUES
           ($1,$2, tstzrange(now() - interval '1 day', now() - interval '23 hours','[)'),'Antiga',$3),
           ($1,$2, tstzrange(now() + interval '7 days', now() + interval '7 days 1 hour','[)'),'Antiga',$3),
           ($1,$2, tstzrange(now() + interval '14 days', now() + interval '14 days 1 hour','[)'),'Antiga',$3)`,
        [ids.tenant, salaId, serieId],
      ),
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/reservas/serie/${serieId}`,
      headers: como(await tokenDe(ids.emailDono)),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { canceladas: number } }).data.canceladas).toBe(2);

    /* A aula de ontem aconteceu. Apagá-la porque a turma acabou hoje
       reescreveria a história de ocupação do espaço — que é justamente o
       que alguém consulta para decidir se mantém a turma. */
    const restou = await comTenant((c) =>
      c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM availability_blocks WHERE serie_id = $1',
        [serieId],
      ),
    );
    expect(Number(restou.rows[0]!.n)).toBe(1);
  });

  /* ==================================================================
   * A reserva tira o horário da lista de livres
   * ================================================================ */

  it('o espaço reservado deixa de aparecer como horário livre', async () => {
    /* SE ISTO FALHAR, a reserva é só um post-it colorido: aparece na
       grade e não impede ninguém de marcar em cima. */
    const dia = proximo(4, 3); // quinta
    await comTenant((c) =>
      c.query(
        `INSERT INTO availability_rules
           (tenant_id, professional_id, weekday, start_time, end_time, room_id, slot_minutes)
         VALUES ($1, (SELECT id FROM users WHERE email=$2), 4, '08:00','12:00', $3, 60)`,
        [ids.tenant, ids.emailProf, ids.bike],
      ),
    );

    /* `/ocupacao` exige `ate > de` — é um intervalo de tempo, e não uma
       faixa de dias como em `/api/reservas`. */
    const seguinte = new Date(dia);
    seguinte.setDate(seguinte.getDate() + 1);
    const diaSeguinte = seguinte.toISOString().slice(0, 10);

    const livres = async (): Promise<number> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/schedule/ocupacao?de=${dia}&ate=${diaSeguinte}`,
        headers: como(await tokenDe(ids.emailDono)),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { data: unknown[] }).data.length;
    };

    const antes = await livres();

    await reservar({
      roomId: ids.bike,
      titulo: 'Manutenção das bikes',
      de: dia,
      horaInicio: '09:00',
      horaFim: '11:00',
    });

    const depois = await livres();
    expect(depois).toBeGreaterThan(antes);
  });

  /* ==================================================================
   * Permissão e isolamento
   * ================================================================ */

  it('o professor não reserva espaço', async () => {
    /* `room:write` é de dono e administrador. Reservar o mezanino da
       sexta à noite é decisão de quem toca a academia. */
    const res = await reservar(
      {
        roomId: ids.bike,
        titulo: 'Minha aula',
        de: proximo(6, 4),
        horaInicio: '10:00',
        horaFim: '11:00',
      },
      ids.emailProf,
    );
    expect(res.statusCode).toBe(403);
  });

  it('o professor VÊ as reservas — senão marca em cima', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reservas?de=${proximo(2)}&ate=${proximo(2)}`,
      headers: como(await tokenDe(ids.emailProf)),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  it('não reserva espaço de outra academia', async () => {
    const outra = crypto.randomUUID();
    const salaDeFora = await (async (): Promise<string> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', outra]);
        await client.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
          outra,
          'Vizinha',
          `viz-esp-${ids.sufixo}`,
        ]);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO rooms (tenant_id,name,capacity) VALUES ($1,'Sala Deles',10) RETURNING id`,
          [outra],
        );
        await client.query('COMMIT');
        return rows[0]!.id;
      } finally {
        client.release();
      }
    })();

    const res = await reservar({
      roomId: salaDeFora,
      titulo: 'Invasão',
      de: proximo(3, 5),
      horaInicio: '10:00',
      horaFim: '11:00',
    });
    expect(res.statusCode).toBe(404);
  });
});
