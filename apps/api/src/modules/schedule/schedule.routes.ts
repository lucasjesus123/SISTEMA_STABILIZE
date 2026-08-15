import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';
import { badRequest, notFound, unprocessable } from '../../http/errors.js';
import { gerarSlots, horarioEhValido, SlotError } from './slots.js';
import {
  cancelarCompromisso,
  contarPresencas,
  criarCompromisso,
  listarCompromissos,
  listarOcupacoes,
  listarRegras,
  marcarPresenca,
} from './schedule.repository.js';
import { assertStudentInScope } from '../students/students.repository.js';

/** Antecedência mínima para o próprio aluno reservar pelo aplicativo. */
const ANTECEDENCIA_ALUNO_MINUTOS = 120;

/* Base como ZodObject (e não já refinada): .refine() devolve ZodEffects,
   que não expõe .extend(). Cada rota estende a base com os filtros que
   usa e só então aplica a validação de ordem, via periodoValido(). */
const periodoBase = z.object({
  de: z.coerce.date(),
  ate: z.coerce.date(),
});

const ORDEM_DO_PERIODO = {
  check: (v: { de: Date; ate: Date }) => v.ate > v.de,
  msg: { message: 'O fim do período precisa ser depois do início' },
} as const;

const periodoSchema = periodoBase.refine(ORDEM_DO_PERIODO.check, ORDEM_DO_PERIODO.msg);

const idSchema = z.string().uuid('Identificador inválido');

const criarSchema = z.object({
  studentId: idSchema,
  professionalId: idSchema,
  roomId: idSchema.optional(),
  inicio: z.coerce.date(),
  fim: z.coerce.date(),
  observacao: z.string().trim().max(500).optional(),
});

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/schedule/slots — horários livres de um profissional
   * ---------------------------------------------------------------- */
  app.get(
    '/slots',
    { preHandler: [app.authorize('availability:read')] },
    async (request) => {
      const query = periodoBase
        .extend({ professionalId: idSchema, roomId: idSchema.optional() })
        .refine(ORDEM_DO_PERIODO.check, ORDEM_DO_PERIODO.msg)
        .parse(request.query);

      return inTenant(request, async (client, principal) => {
        const tz = await fusoDoTenant(client);
        const regras = await listarRegras(client, query.professionalId);
        const ocupacoes = await listarOcupacoes(client, {
          de: query.de,
          ate: query.ate,
          professionalId: query.professionalId,
          roomId: query.roomId,
        });

        /* O aluno tem antecedência mínima; a recepção e o profissional
           não — eles precisam poder encaixar alguém que acabou de
           chegar, e é uma decisão que a pessoa toma na frente do balcão. */
        const antecedencia = principal.role === 'STUDENT' ? ANTECEDENCIA_ALUNO_MINUTOS : 0;

        try {
          const slots = gerarSlots({
            de: query.de,
            ate: query.ate,
            regras,
            ocupacoes,
            agora: new Date(),
            antecedenciaMinutos: antecedencia,
            timeZone: tz,
          });

          return {
            data: slots.map((s) => ({
              inicio: s.inicio.toISOString(),
              fim: s.fim.toISOString(),
              salaId: s.roomId,
            })),
          };
        } catch (error) {
          if (error instanceof SlotError) throw badRequest(error.message);
          throw error;
        }
      });
    },
  );

  /* ------------------------------------------------------------------
   * GET /api/schedule — compromissos do período
   * ---------------------------------------------------------------- */
  app.get('/', { preHandler: [app.authorize('schedule:read')] }, async (request) => {
    const query = periodoBase
      .extend({ professionalId: idSchema.optional(), roomId: idSchema.optional() })
      .refine(ORDEM_DO_PERIODO.check, ORDEM_DO_PERIODO.msg)
      .parse(request.query);
    const scope = requireScope(request);

    return inTenant(request, async (client) => {
      const linhas = await listarCompromissos(client, scope, {
        de: query.de,
        ate: query.ate,
        professionalId: query.professionalId,
        roomId: query.roomId,
      });

      return {
        data: linhas.map((a) => ({
          id: a.id,
          inicio: a.inicio.toISOString(),
          fim: a.fim.toISOString(),
          status: a.status,
          aluno: { id: a.student_id, nome: a.student_name },
          profissional: { id: a.professional_id, nome: a.professional_name },
          sala: a.room_id === null ? null : { id: a.room_id, nome: a.room_name },
          observacao: a.notes,
          observacaoAluno: a.student_note,
          valorCentavos: a.price_cents,
          incluidoNoPlano: a.is_included_in_plan,
          presencaEm: a.checked_in_at?.toISOString() ?? null,
        })),
      };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/schedule/ocupacao — visão anonimizada do estabelecimento
   *
   * Devolve apenas início e fim. Um profissional precisa saber que a
   * Sala 2 está ocupada às 9h para não marcar em cima; não precisa
   * saber quem está lá nem de qual colega é o aluno.
   * ---------------------------------------------------------------- */
  app.get('/ocupacao', { preHandler: [app.authorize('availability:read')] }, async (request) => {
    const query = periodoBase
      .extend({ professionalId: idSchema.optional(), roomId: idSchema.optional() })
      .refine(ORDEM_DO_PERIODO.check, ORDEM_DO_PERIODO.msg)
      .parse(request.query);

    return inTenant(request, async (client) => {
      const blocos = await listarOcupacoes(client, {
        de: query.de,
        ate: query.ate,
        professionalId: query.professionalId,
        roomId: query.roomId,
      });
      return {
        data: blocos.map((b) => ({ inicio: b.inicio.toISOString(), fim: b.fim.toISOString() })),
      };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/schedule — marcar
   * ---------------------------------------------------------------- */
  app.post('/', { preHandler: [app.authorize('schedule:write')] }, async (request, reply) => {
    const body = criarSchema.parse(request.body);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      /* O aluno pelo aplicativo só marca para SI MESMO. Sem esta
         checagem, trocar o studentId no corpo marcaria aula na agenda
         de outro aluno — e ainda por cima cobraria dele. */
      if (principal.role === 'STUDENT') {
        if (principal.studentId !== body.studentId) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'appointment.create',
            resourceType: 'appointment',
            resourceId: body.studentId,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
            metadata: { motivo: 'tentou agendar para outro aluno' },
          });
          throw notFound('Aluno');
        }
      } else if (!(await assertStudentInScope(client, scope, body.studentId))) {
        // Profissional só marca para os próprios alunos.
        throw notFound('Aluno');
      }

      const tz = await fusoDoTenant(client);
      const regras = await listarRegras(client, body.professionalId);
      const ocupacoes = await listarOcupacoes(client, {
        de: new Date(body.inicio.getTime() - 24 * 3_600_000),
        ate: new Date(body.fim.getTime() + 24 * 3_600_000),
        professionalId: body.professionalId,
      });

      /* A lista de slots é sugestão para a tela; o corpo do POST pode
         trazer qualquer horário. Sem esta checagem, marca-se às 3h da
         manhã, fora de qualquer janela declarada. */
      const veredito = horarioEhValido(
        { inicio: body.inicio, fim: body.fim },
        {
          de: body.inicio,
          ate: body.fim,
          regras,
          ocupacoes,
          agora: new Date(),
          antecedenciaMinutos: principal.role === 'STUDENT' ? ANTECEDENCIA_ALUNO_MINUTOS : 0,
          timeZone: tz,
        },
      );
      if (!veredito.valido) {
        throw unprocessable(veredito.motivo ?? 'Horário indisponível.');
      }

      const contrato = await buscarContrato(client, body.studentId);

      const criado = await criarCompromisso(client, principal.tenantId, {
        studentId: body.studentId,
        professionalId: body.professionalId,
        roomId: body.roomId,
        inicio: body.inicio,
        fim: body.fim,
        studentNote: principal.role === 'STUDENT' ? body.observacao : undefined,
        notes: principal.role === 'STUDENT' ? undefined : body.observacao,
        /* Mensalista não vê valor por sessão — já está no contrato.
           Avulso recebe o valor negociado, não o da tabela atual: é o
           contrato que manda, e ele preserva o histórico. */
        isIncludedInPlan: contrato?.mensalista ?? false,
        priceCents: contrato?.mensalista === true ? undefined : contrato?.valorSessao,
        createdBy: principal.userId,
      });

      await writeAudit(client, principal.tenantId, {
        action: 'appointment.create',
        resourceType: 'appointment',
        resourceId: criado.id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
      });

      void reply.status(201);
      return { data: { id: criado.id } };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/schedule/:id/cancelar
   * ---------------------------------------------------------------- */
  app.post(
    '/:id/cancelar',
    { preHandler: [app.authorize('schedule:cancel')] },
    async (request) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);
      const body = z.object({ motivo: z.string().trim().max(300).optional() }).parse(
        request.body ?? {},
      );
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const ok = await cancelarCompromisso(client, scope, id, principal.userId, body.motivo);
        if (!ok) throw notFound('Agendamento');

        await writeAudit(client, principal.tenantId, {
          action: 'appointment.cancel',
          resourceType: 'appointment',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });

        return { ok: true };
      });
    },
  );

  /* ------------------------------------------------------------------
   * POST /api/schedule/:id/presenca
   * ---------------------------------------------------------------- */
  app.post(
    '/:id/presenca',
    { preHandler: [app.authorize('attendance:write')] },
    async (request) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);
      const body = z.object({ compareceu: z.boolean() }).parse(request.body);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const ok = await marcarPresenca(client, scope, id, body.compareceu);
        if (!ok) throw notFound('Agendamento');

        await writeAudit(client, principal.tenantId, {
          action: 'attendance.mark',
          resourceType: 'appointment',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { compareceu: body.compareceu },
        });

        return { ok: true };
      });
    },
  );

  /* ------------------------------------------------------------------
   * GET /api/schedule/presencas/:studentId — contador do aluno
   * ---------------------------------------------------------------- */
  app.get(
    '/presencas/:studentId',
    { preHandler: [app.authorize('attendance:read')] },
    async (request) => {
      const { studentId } = z.object({ studentId: idSchema }).parse(request.params);
      const query = periodoSchema.parse(request.query);
      const scope = requireScope(request);

      return inTenant(request, async (client) => {
        const resumo = await contarPresencas(client, scope, studentId, query.de, query.ate);
        const total = resumo.presencas + resumo.faltas;
        return {
          data: {
            ...resumo,
            total,
            /* Percentual em inteiro: uma fração de ponto flutuante aqui
               acabaria formatada como "83.33333333333334%" em algum
               lugar da tela. */
            frequenciaPercentual: total === 0 ? null : Math.round((resumo.presencas / total) * 100),
          },
        };
      });
    },
  );
}

/* -------------------------------------------------------------------- */

async function fusoDoTenant(client: {
  query: (t: string, v?: readonly unknown[]) => Promise<{ rows: { timezone: string }[] }>;
}): Promise<string> {
  const r = await client.query('SELECT timezone FROM tenants LIMIT 1');
  return r.rows[0]?.timezone ?? 'America/Sao_Paulo';
}

async function buscarContrato(
  client: { query: (t: string, v?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  studentId: string,
): Promise<{ mensalista: boolean; valorSessao: number | undefined } | null> {
  const r = await client.query(
    `SELECT cycle::text AS cycle, amount_cents
       FROM student_contracts
      WHERE student_id = $1 AND is_active
        AND starts_on <= CURRENT_DATE
        AND (ends_on IS NULL OR ends_on >= CURRENT_DATE)
      ORDER BY starts_on DESC
      LIMIT 1`,
    [studentId],
  );

  const linha = r.rows[0];
  if (linha === undefined) return null;

  const ciclo = String(linha['cycle']);
  return {
    // Qualquer ciclo que não seja por sessão é plano: o valor já está pago.
    mensalista: ciclo !== 'SESSION',
    valorSessao: ciclo === 'SESSION' ? Number(linha['amount_cents']) : undefined,
  };
}
