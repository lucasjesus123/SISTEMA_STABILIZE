import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { conflict, notFound, unprocessable } from '../../http/errors.js';

/**
 * Reserva de espaço: mezanino, hall, sala de bike, tatame.
 *
 * O QUE FALTAVA E POR QUÊ ISSO ERA PIOR DO QUE PARECE
 *
 * `availability_blocks` já tinha `room_id`, `period` e `reason`, e o
 * cálculo de horários livres já a lia. Só que NENHUMA ROTA ESCREVIA
 * NELA: era uma tabela de leitura de dados que ninguém podia criar. Do
 * lado do cadastro, `rooms` tinha API completa e nenhuma tela — o que
 * fazia o filtro "Espaço" da agenda sumir em produção, porque ele só
 * aparece quando existem espaços e nunca existiu nenhum.
 *
 * A RESERVA REPETIDA É MATERIALIZADA, e não guardada como regra.
 * "Toda segunda e quarta às 19h a sala de bike é do spinning" é uma
 * frase sobre o futuro inteiro; como regra, a agenda teria que resolver
 * a recorrência a cada consulta e — pior — a exceção não teria lugar. No
 * feriado não tem aula, e regra não sabe disso. Com as ocorrências
 * gravadas, cancelar uma quarta é apagar uma linha, e o `serie_id`
 * resolve o outro lado: cancelar tudo quando a aula acaba.
 *
 * O HORIZONTE É DE 26 SEMANAS. Não é limitação técnica: é o ponto em que
 * "reservar para sempre" deixa de ser útil e passa a encher a agenda de
 * eventos que ninguém confirmou. Meio ano à frente é mais do que
 * qualquer academia planeja, e renovar é um clique.
 */

const idSchema = z.string().uuid('Identificador inválido');

/** Domingo = 0, como `extract(dow)` no Postgres e `getDay()` no JS. */
const diaDaSemanaSchema = z.number().int().min(0).max(6);

const horaSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido. Use HH:MM.');

const SEMANAS_MAXIMAS = 26;

const criarSchema = z
  .object({
    roomId: idSchema,
    titulo: z.string().trim().min(2, 'Diga o que ocupa o espaço.').max(120),
    /* A data em que a reserva começa. Para a avulsa, é o dia dela. */
    de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.'),
    horaInicio: horaSchema,
    horaFim: horaSchema,
    /* Vazio = reserva avulsa, num dia só. Com dias, repete-se neles até
       `ate`. */
    diasDaSemana: z.array(diaDaSemanaSchema).max(7).default([]),
    ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').optional(),
  })
  .refine((v) => v.horaFim > v.horaInicio, {
    message: 'O fim precisa ser depois do início.',
    path: ['horaFim'],
  })
  .refine((v) => v.diasDaSemana.length === 0 || v.ate !== undefined, {
    message: 'Diga até quando a reserva se repete.',
    path: ['ate'],
  });

interface LinhaDaReserva {
  id: string;
  serie_id: string | null;
  inicio: Date;
  fim: Date;
  titulo: string | null;
  room_id: string | null;
  espaco: string | null;
  cor: string | null;
  criado_por_nome: string | null;
}

export async function reservasRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/reservas?de=&ate=
   *
   * Liberada por `schedule:read` e não por `room:write`: a grade da
   * agenda precisa desenhar as reservas para qualquer um que a enxergue.
   * Um professor que não vê o mezanino ocupado marca em cima.
   * ---------------------------------------------------------------- */
  app.get('/', { preHandler: [app.authorize('schedule:read')] }, async (request) => {
    /* DATAS, E NÃO TIMESTAMPS — e `ate` é INCLUSIVO.
       A primeira versão recebia timestamps e montava `tstzrange(de, ate)`.
       Quem consultasse um dia só passava a mesma data nos dois campos, o
       intervalo saía VAZIO, e a resposta vinha com zero reservas sem
       erro nenhum: a tela mostrava o dia livre com o mezanino ocupado.
       Uma tela de calendário pensa em dias ("de 17 a 23 de agosto"), e é
       assim que esta rota passou a receber. */
    const { de, ate } = z
      .object({
        de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.'),
        ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.'),
      })
      .refine((v) => v.ate >= v.de, {
        message: 'O fim do período não pode ser antes do início.',
        path: ['ate'],
      })
      .parse(request.query);

    return inTenant(request, async (client) => {
      const { rows } = await client.query<LinhaDaReserva>(
        `WITH tz AS (SELECT timezone FROM tenants WHERE id = current_tenant_id())
         SELECT b.id, b.serie_id,
                lower(b.period) AS inicio, upper(b.period) AS fim,
                b.reason AS titulo,
                b.room_id, r.name AS espaco, r.color AS cor,
                u.full_name AS criado_por_nome
           FROM availability_blocks b
           LEFT JOIN rooms r ON r.id = b.room_id
           LEFT JOIN users u ON u.id = b.criado_por
          WHERE b.room_id IS NOT NULL
            /* O dia inteiro do fim entra: o intervalo vai do começo da
               data inicial ao começo do dia SEGUINTE à final, no fuso da
               academia.

               O ::timestamp NO MEIO NÃO É ENFEITE. Sem ele, o operando
               de AT TIME ZONE é uma date, que o Postgres promove a
               timestamptz — e aí a expressão resolve para a variante
               timestamptz -> timestamp, que CONVERTE DE VOLTA usando o
               fuso da sessão. O resultado é uma dupla conversão: para
               São Paulo, o intervalo saía seis horas deslocado, e a
               consulta de um dia devolvia lista vazia com a reserva
               gravada no banco. Com o ::timestamp explícito, a variante
               escolhida é timestamp -> timestamptz, que é a certa. */
            AND b.period && tstzrange(
                  (($1::date)::timestamp AT TIME ZONE (SELECT timezone FROM tz)),
                  ((($2::date + 1))::timestamp AT TIME ZONE (SELECT timezone FROM tz)),
                  '[)')
          ORDER BY lower(b.period)`,
        [de, ate],
      );

      return {
        data: rows.map((l) => ({
          id: l.id,
          serieId: l.serie_id,
          inicio: l.inicio.toISOString(),
          fim: l.fim.toISOString(),
          titulo: l.titulo ?? 'Reservado',
          espacoId: l.room_id,
          espaco: l.espaco,
          cor: l.cor,
          reservadoPor: l.criado_por_nome,
        })),
      };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/reservas
   * ---------------------------------------------------------------- */
  app.post('/', { preHandler: [app.authorize('room:write')] }, async (request, reply) => {
    const body = criarSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      const { rows: espaco } = await client.query<{ nome: string }>(
        'SELECT name AS nome FROM rooms WHERE id = $1 AND is_active',
        [body.roomId],
      );
      if (espaco[0] === undefined) throw notFound('Espaço');

      const repetida = body.diasDaSemana.length > 0;
      const serieId = repetida ? crypto.randomUUID() : null;

      /* AS DATAS SÃO GERADAS NO BANCO, no fuso da academia.
         Calcular "toda segunda às 19h" em JavaScript com o relógio do
         servidor erra por uma hora duas vezes por ano — e erra
         justamente na semana do horário de verão, que é quando ninguém
         está olhando. `generate_series` sobre datas e `AT TIME ZONE`
         resolvem no único lugar que conhece o fuso de cada empresa. */
      const { rows: criadas } = await client
        .query<{ id: string }>(
          `WITH tz AS (SELECT timezone FROM tenants WHERE id = current_tenant_id()),
                dias AS (
                  SELECT d::date AS dia
                    FROM generate_series(
                           $2::date,
                           /* Sem repetição, um dia só. Com repetição, até
                              a data pedida — limitada a 26 semanas. */
                           LEAST(COALESCE($3::date, $2::date), $2::date + $8::int * 7),
                           interval '1 day'
                         ) AS d
                   WHERE $4::int[] = '{}'::int[]
                      OR extract(dow FROM d)::int = ANY($4::int[])
                )
           INSERT INTO availability_blocks
             (tenant_id, room_id, period, reason, serie_id, criado_por)
           SELECT current_tenant_id(), $1,
                  tstzrange(
                    ((dia + $5::time) AT TIME ZONE (SELECT timezone FROM tz)),
                    ((dia + $6::time) AT TIME ZONE (SELECT timezone FROM tz)),
                    '[)'
                  ),
                  $7, $9, $10
             FROM dias
           RETURNING id`,
          [
            body.roomId,
            body.de,
            body.ate ?? null,
            body.diasDaSemana,
            body.horaInicio,
            body.horaFim,
            body.titulo,
            SEMANAS_MAXIMAS,
            serieId,
            principal.userId,
          ],
        )
        .catch((e: unknown) => {
          /* 23P01 é a violação do EXCLUDE: o espaço já está reservado
             naquele horário. A mensagem diz o que fazer, porque "erro de
             restrição de exclusão" não ajuda ninguém no balcão. */
          if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23P01') {
            throw conflict(
              `O espaço ${espaco[0]!.nome} já está reservado em pelo menos um desses horários. Confira a agenda antes de repetir.`,
            );
          }
          throw e;
        });

      if (criadas.length === 0) {
        /* Acontece quando os dias da semana pedidos não caem dentro do
           intervalo — "toda segunda, de terça a quinta". Devolver 201
           com zero reservas seria dizer que deu certo. */
        throw unprocessable(
          'Nenhuma data caiu nesse intervalo. Confira os dias da semana e o período.',
        );
      }

      await writeAudit(client, principal.tenantId, {
        action: 'availability.write',
        resourceType: 'room',
        resourceId: body.roomId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { reservas: criadas.length, serieId, titulo: body.titulo },
      });

      void reply.status(201);
      return { data: { criadas: criadas.length, serieId } };
    });
  });

  /* ------------------------------------------------------------------
   * DELETE /api/reservas/:id — cancela UMA ocorrência
   *
   * É o caso do feriado: a aula existe toda quarta e nesta não tem.
   * ---------------------------------------------------------------- */
  app.delete('/:id', { preHandler: [app.authorize('room:write')] }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);

    return inTenant(request, async (client, principal) => {
      const { rowCount } = await client.query(
        'DELETE FROM availability_blocks WHERE id = $1 AND room_id IS NOT NULL',
        [id],
      );
      if ((rowCount ?? 0) === 0) throw notFound('Reserva');

      await writeAudit(client, principal.tenantId, {
        action: 'availability.write',
        resourceType: 'room',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { cancelou: 'ocorrencia' },
      });
      return { ok: true };
    });
  });

  /* ------------------------------------------------------------------
   * DELETE /api/reservas/serie/:serieId — cancela a série daqui pra frente
   *
   * O PASSADO NÃO É APAGADO. A aula de terça passada aconteceu, e apagar
   * o registro dela porque a turma acabou hoje reescreveria a história da
   * ocupação do espaço — que é justamente o que alguém vai consultar
   * quando quiser saber se vale a pena manter aquela turma.
   * ---------------------------------------------------------------- */
  app.delete(
    '/serie/:serieId',
    { preHandler: [app.authorize('room:write')] },
    async (request) => {
      const { serieId } = z.object({ serieId: idSchema }).parse(request.params);

      return inTenant(request, async (client, principal) => {
        const { rowCount } = await client.query(
          `DELETE FROM availability_blocks
            WHERE serie_id = $1 AND lower(period) > now()`,
          [serieId],
        );
        if ((rowCount ?? 0) === 0) {
          throw notFound('Reservas futuras desta série');
        }

        await writeAudit(client, principal.tenantId, {
          action: 'availability.write',
          resourceType: 'room',
          resourceId: serieId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { cancelou: 'serie', ocorrencias: rowCount },
        });
        return { data: { canceladas: rowCount } };
      });
    },
  );
}
