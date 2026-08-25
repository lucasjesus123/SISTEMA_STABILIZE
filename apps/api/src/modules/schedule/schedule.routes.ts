import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cancelarAvisosDoAgendamento,
  enfileirarAvisosDoAgendamento,
} from '../whatsapp/avisos.js';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../http/errors.js';
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

      /* A CONFIRMAÇÃO E O LEMBRETE NASCEM AQUI, dentro da mesma
         transação que criou o agendamento. Se enfileirar numa segunda
         transação, uma falha no meio deixa aula marcada sem aviso
         nenhum — e ninguém descobre até o aluno não aparecer.

         Enfileirar não é enviar: o worker é que fala com o provedor. É
         de propósito, para que uma instabilidade da UAZAPI não derrube
         o agendamento de quem está na tela. */
      const avisos = await enfileirarAvisosDoAgendamento(client, principal.tenantId, criado.id);

      await writeAudit(client, principal.tenantId, {
        action: 'appointment.create',
        resourceType: 'appointment',
        resourceId: criado.id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { avisos },
      });

      void reply.status(201);
      return { data: { id: criado.id } };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/schedule/serie — o mesmo horário, toda semana
   *
   * O QUE ISTO RESOLVE. Um aluno de pilates faz terça e quinta às 9h
   * durante meses, com a mesma professora. Marcar isso uma sessão de
   * cada vez são vinte e quatro passagens pelo mesmo formulário — e
   * ninguém faz: a recepção marca duas semanas, o resto vira combinado
   * de boca, e o calendário deixa de descrever a academia.
   *
   * NÃO É UM "AGENDAMENTO RECORRENTE" NO BANCO, e a escolha é
   * deliberada. Cada semana vira um compromisso NORMAL, independente. O
   * feriado se cancela sozinho, a semana que mudou de horário se
   * arrasta, e o aluno que faltou numa terça não some da série. Um
   * registro-mãe com "toda terça às 9h" obrigaria a inventar exceções
   * para cada uma dessas coisas — que é como calendário vira software
   * complicado e errado.
   *
   * O QUE FALHA NÃO DERRUBA O RESTO. Em doze semanas vai haver um
   * feriado, uma janela que a professora fechou, um horário já ocupado.
   * Recusar a série inteira por causa de uma semana é obrigar quem
   * marca a descobrir qual, tirar do pedido e tentar de novo. Aqui as
   * que dão certo são criadas e a resposta DIZ, uma a uma, quais não
   * couberam e por quê — e a tela mostra isso antes de fechar.
   * ---------------------------------------------------------------- */
  app.post('/serie', { preHandler: [app.authorize('schedule:write')] }, async (request, reply) => {
    const body = criarSchema
      .extend({
        /* O TETO É 52 — um ano. Acima disso a série passa a descrever
           uma intenção, não uma combinação: ninguém sabe hoje o que faz
           em agosto do ano que vem, e o calendário fica cheio de aula
           que vai ser cancelada. */
        semanas: z.coerce.number().int().min(2).max(52),
      })
      .parse(request.body);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      /* SÉRIE NÃO É COISA DE ALUNO. Pelo aplicativo ele marca uma
         sessão por vez, com antecedência mínima; deixar um aluno
         reservar o ano inteiro da professora num toque é dar a ele a
         agenda dela. */
      if (principal.role === 'STUDENT') throw forbidden('Séries são marcadas pela academia.');

      if (!(await assertStudentInScope(client, scope, body.studentId))) {
        throw notFound('Aluno');
      }

      const tz = await fusoDoTenant(client);
      const regras = await listarRegras(client, body.professionalId);
      const duracaoMs = body.fim.getTime() - body.inicio.getTime();

      const criados: { id: string; inicio: string }[] = [];
      const recusados: { inicio: string; motivo: string }[] = [];

      for (let n = 0; n < body.semanas; n += 1) {
        const inicio = new Date(body.inicio.getTime() + n * 7 * 24 * 3_600_000);
        const fim = new Date(inicio.getTime() + duracaoMs);

        /* AS OCUPAÇÕES SÃO RELIDAS A CADA SEMANA, e não uma vez antes do
           laço: as sessões que esta própria série acabou de criar
           precisam contar. Sem isto, pedir a mesma série duas vezes
           criaria tudo em duplicidade — a segunda passada não veria a
           primeira. */
        const ocupacoes = await listarOcupacoes(client, {
          de: new Date(inicio.getTime() - 24 * 3_600_000),
          ate: new Date(fim.getTime() + 24 * 3_600_000),
          professionalId: body.professionalId,
        });

        const veredito = horarioEhValido(
          { inicio, fim },
          { de: inicio, ate: fim, regras, ocupacoes, agora: new Date(), antecedenciaMinutos: 0, timeZone: tz },
        );

        if (!veredito.valido) {
          recusados.push({
            inicio: inicio.toISOString(),
            motivo: veredito.motivo ?? 'Horário indisponível.',
          });
          continue;
        }

        const contrato = await buscarContrato(client, body.studentId);
        const criado = await criarCompromisso(client, principal.tenantId, {
          studentId: body.studentId,
          professionalId: body.professionalId,
          roomId: body.roomId,
          inicio,
          fim,
          notes: body.observacao,
          isIncludedInPlan: contrato?.mensalista ?? false,
          priceCents: contrato?.mensalista === true ? undefined : contrato?.valorSessao,
          createdBy: principal.userId,
        });
        criados.push({ id: criado.id, inicio: inicio.toISOString() });

        /* O AVISO SÓ SAI PARA AS DUAS PRIMEIRAS. Enfileirar doze
           confirmações de uma vez enche o WhatsApp do aluno com o mesmo
           texto doze vezes, muda a data e nada mais — é a definição de
           spam, e queima o número da academia. O lembrete de véspera
           continua valendo para todas: esse chega no dia, que é quando
           ele serve. */
        if (n < 2) {
          await enfileirarAvisosDoAgendamento(client, principal.tenantId, criado.id);
        }
      }

      if (criados.length === 0) {
        /* Nenhuma coube: isto não é "sucesso com zero" — é um pedido que
           não aconteceu, e a tela precisa tratá-lo como recusa. */
        throw unprocessable(
          recusados[0]?.motivo ?? 'Nenhuma das semanas cabe na agenda deste profissional.',
        );
      }

      await writeAudit(client, principal.tenantId, {
        action: 'appointment.create',
        resourceType: 'appointment',
        resourceId: criados[0]!.id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: {
          serie: true,
          pedidas: body.semanas,
          criadas: criados.length,
          recusadas: recusados.length,
        },
      });

      void reply.status(201);
      return {
        data: {
          criadas: criados.length,
          pedidas: body.semanas,
          primeira: criados[0]!.inicio,
          ultima: criados[criados.length - 1]!.inicio,
          recusadas: recusados,
        },
      };
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

        /* O LEMBRETE QUE AINDA NÃO SAIU MORRE COM A AULA. Sem isto o
           aluno desmarca na quarta e recebe "sua aula é hoje às 7h" na
           quinta de manhã — e vai. */
        const avisosCancelados = await cancelarAvisosDoAgendamento(client, id);

        await writeAudit(client, principal.tenantId, {
          action: 'appointment.cancel',
          resourceType: 'appointment',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { avisosCancelados },
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
