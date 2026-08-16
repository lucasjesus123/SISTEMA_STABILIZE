import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors.js';
import { fromDatabaseError } from '../../http/errors.js';
import { gerarSlots } from '../schedule/slots.js';
import {
  cancelarCompromisso,
  criarCompromisso,
  listarOcupacoes,
  listarRegras,
} from '../schedule/schedule.repository.js';
import { buscarTreino, listarTreinos } from '../workouts/workouts.repository.js';

/**
 * Portal do aluno.
 *
 * O QUE TORNA ESTAS ROTAS DIFERENTES DAS OUTRAS: aqui o usuário não
 * escolhe SOBRE QUEM está operando. Em toda outra rota o id do aluno vem
 * da URL e é conferido contra o escopo; aqui ele vem do TOKEN e a URL
 * nem o menciona. Não há `/api/eu/:id`, e essa ausência é a proteção —
 * não existe parâmetro para adulterar.
 *
 * O escopo continua sendo resolvido e passado adiante do mesmo jeito,
 * porque a defesa não pode depender de eu ter lembrado de não aceitar um
 * id. Duas camadas dizendo a mesma coisa.
 *
 * PREÇO SÓ PARA QUEM PAGA POR SESSÃO. O mensalista não vê valor nenhum
 * ao marcar: mostrar "R$ 90" para quem já pagou o mês gera a ligação
 * mais constrangedora que uma recepção recebe.
 */

const FUSO = 'America/Sao_Paulo';

/** Antecedência mínima para o aluno marcar. */
const ANTECEDENCIA_MINUTOS = 120;

/** Antecedência mínima para o aluno desmarcar sem falar com ninguém. */
const CANCELAMENTO_HORAS = 12;

/** O id do aluno vem SEMPRE do token. */
function alunoDoToken(scope: ReturnType<typeof requireScope>): string {
  if (scope.kind !== 'SELF') {
    /* Um profissional que chamar /api/eu não deve receber dado de
       ninguém: ele tem as rotas dele, com id explícito e auditoria. */
    throw forbidden('Esta área é do aplicativo do aluno.');
  }
  return scope.studentId;
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/eu — quem sou, meu plano, minha frequência
   * ---------------------------------------------------------------- */
  app.get('/', { preHandler: [app.authorize('self:read')] }, async (request) => {
    const alunoId = alunoDoToken(requireScope(request));

    return inTenant(request, async (client) => {
      const { rows } = await client.query<{
        nome: string;
        foto: string | null;
        ciclo: string | null;
        valor_centavos: string | null;
        sessoes_incluidas: number | null;
        presencas: string;
        faltas: string;
        proximos: string;
      }>(
        `SELECT s.full_name AS nome, s.photo_path AS foto,
                c.cycle::text AS ciclo,
                c.amount_cents::text AS valor_centavos,
                c.sessions_included AS sessoes_incluidas,
                (SELECT count(*) FROM appointments a
                  WHERE a.student_id = s.id AND a.status = 'ATTENDED') AS presencas,
                (SELECT count(*) FROM appointments a
                  WHERE a.student_id = s.id AND a.status = 'NO_SHOW') AS faltas,
                (SELECT count(*) FROM appointments a
                  WHERE a.student_id = s.id AND a.status IN ('SCHEDULED','CONFIRMED')
                    AND lower(a.period) > now()) AS proximos
           FROM students s
           LEFT JOIN student_contracts c
                  ON c.student_id = s.id AND c.is_active
          WHERE s.id = $1`,
        [alunoId],
      );

      const l = rows[0];
      if (l === undefined) throw notFound('Aluno');

      /* Mensalista é quem tem contrato recorrente. Só o avulso vê preço,
         e é esta linha que decide isso no sistema inteiro. */
      const mensalista = l.ciclo !== null && l.ciclo !== 'SESSION';

      return {
        data: {
          nome: l.nome,
          foto: l.foto,
          mensalista,
          plano:
            l.ciclo === null
              ? null
              : {
                  ciclo: l.ciclo,
                  valorCentavos: Number(l.valor_centavos ?? 0),
                  sessoesIncluidas: l.sessoes_incluidas,
                },
          frequencia: {
            presencas: Number(l.presencas),
            faltas: Number(l.faltas),
            proximos: Number(l.proximos),
          },
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/eu/treino
   * ---------------------------------------------------------------- */
  app.get('/treino', { preHandler: [app.authorize('workout:read')] }, async (request) => {
    const scope = requireScope(request);
    const alunoId = alunoDoToken(scope);

    return inTenant(request, async (client) => {
      const treinos = await listarTreinos(client, scope, alunoId);
      const ativo = treinos.find((t) => t.status === 'ACTIVE');
      /* Só o VIGENTE. O aluno não precisa navegar por histórico de
         prescrição — precisa saber o que fazer hoje. */
      if (ativo === undefined) return { data: null };

      const treino = await buscarTreino(client, scope, alunoId, ativo.id);
      if (treino === null) return { data: null };

      return {
        data: {
          nome: treino.nome,
          objetivo: treino.objetivo,
          observacoes: treino.observacoes,
          profissional: treino.profissional.nome,
          itens: treino.itens.map((i) => ({
            dia: i.dia,
            exercicio: i.exercicio,
            equipamento: i.equipamento,
            instrucoes: null,
            series: i.series,
            repeticoes: i.repeticoes,
            cargaG: i.cargaG,
            descansoSegundos: i.descansoSegundos,
          })),
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/eu/agenda
   * ---------------------------------------------------------------- */
  app.get('/agenda', { preHandler: [app.authorize('self:read')] }, async (request) => {
    const alunoId = alunoDoToken(requireScope(request));

    return inTenant(request, async (client) => {
      const { rows } = await client.query<{
        id: string;
        inicio: Date;
        fim: Date;
        status: string;
        profissional: string;
        sala: string | null;
        preco: string | null;
        no_plano: boolean;
        observacao: string | null;
      }>(
        `SELECT a.id, lower(a.period) AS inicio, upper(a.period) AS fim,
                a.status::text AS status, u.full_name AS profissional,
                r.name AS sala, a.price_cents::text AS preco,
                a.is_included_in_plan AS no_plano, a.student_note AS observacao
           FROM appointments a
           JOIN users u ON u.id = a.professional_id
           LEFT JOIN rooms r ON r.id = a.room_id
          WHERE a.student_id = $1
            AND lower(a.period) > now() - interval '60 days'
          ORDER BY lower(a.period) DESC
          LIMIT 100`,
        [alunoId],
      );

      const limite = Date.now() + CANCELAMENTO_HORAS * 3_600_000;

      return {
        data: rows.map((l) => ({
          id: l.id,
          inicio: l.inicio.toISOString(),
          fim: l.fim.toISOString(),
          status: l.status,
          profissional: l.profissional,
          sala: l.sala,
          /* O preço só aparece quando existe: para o mensalista a coluna
             é nula por construção (ver `criarCompromisso`). */
          precoCentavos: l.no_plano ? null : l.preco === null ? null : Number(l.preco),
          observacao: l.observacao,
          /* Quem decide se dá para desmarcar é o servidor. A tela usa
             isto para esconder o botão; se alguém chamar direto, a rota
             recusa de novo. */
          podeCancelar:
            (l.status === 'SCHEDULED' || l.status === 'CONFIRMED') &&
            l.inicio.getTime() > limite,
        })),
      };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/eu/horarios — o que está livre
   * ---------------------------------------------------------------- */
  app.get('/horarios', { preHandler: [app.authorize('self:booking')] }, async (request) => {
    const { de, ate, profissionalId } = z
      .object({
        de: z.string().datetime(),
        ate: z.string().datetime(),
        profissionalId: z.string().uuid().optional(),
      })
      .parse(request.query);

    alunoDoToken(requireScope(request));

    const inicio = new Date(de);
    const fim = new Date(ate);
    /* Sem teto, um cliente pede um ano de slots e o servidor gera
       dezenas de milhares de intervalos para desenhar uma tela. */
    if (fim.getTime() - inicio.getTime() > 31 * 86_400_000) {
      throw badRequest('Consulte no máximo 31 dias por vez.');
    }

    return inTenant(request, async (client) => {
      const profissionais = await client.query<{ id: string; nome: string }>(
        `SELECT id, full_name AS nome FROM users
          WHERE role = 'PROFESSIONAL' AND is_active
            AND ($1::uuid IS NULL OR id = $1)
          ORDER BY full_name`,
        [profissionalId ?? null],
      );

      const saida: {
        profissional: { id: string; nome: string };
        horarios: { inicio: string; fim: string }[];
      }[] = [];

      for (const p of profissionais.rows) {
        const regras = await listarRegras(client, p.id);
        const ocupacoes = await listarOcupacoes(client, {
          de: inicio,
          ate: fim,
          professionalId: p.id,
        });

        const slots = gerarSlots({
          de: inicio,
          ate: fim,
          regras,
          ocupacoes,
          agora: new Date(),
          /* A antecedência mínima é do SERVIDOR. Deixar a tela decidir
             permitiria marcar para daqui a dois minutos com uma
             requisição direta — e o profissional descobriria em cima da
             hora. */
          antecedenciaMinutos: ANTECEDENCIA_MINUTOS,
          timeZone: FUSO,
        });

        if (slots.length > 0) {
          saida.push({
            profissional: { id: p.id, nome: p.nome },
            horarios: slots.map((s) => ({
              inicio: s.inicio.toISOString(),
              fim: s.fim.toISOString(),
            })),
          });
        }
      }

      return { data: saida };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/eu/agendamentos
   * ---------------------------------------------------------------- */
  app.post(
    '/agendamentos',
    { preHandler: [app.authorize('self:booking')] },
    async (request, reply) => {
      const corpo = z
        .object({
          profissionalId: z.string().uuid('Escolha um profissional'),
          inicio: z.string().datetime(),
          fim: z.string().datetime(),
          observacao: z.string().trim().max(300).optional(),
        })
        .parse(request.body);

      const alunoId = alunoDoToken(requireScope(request));
      const inicio = new Date(corpo.inicio);
      const fim = new Date(corpo.fim);

      if (fim <= inicio) throw badRequest('O horário final precisa ser depois do inicial.');
      if (inicio.getTime() < Date.now() + ANTECEDENCIA_MINUTOS * 60_000) {
        throw badRequest(
          `Marque com pelo menos ${ANTECEDENCIA_MINUTOS / 60} horas de antecedência.`,
        );
      }

      return inTenant(request, async (client, principal) => {
        /* O CONTRATO DECIDE O PREÇO, não o cliente. Nada no corpo da
           requisição fala de dinheiro — se falasse, bastaria mandar
           `precoCentavos: 0`. */
        const { rows: contrato } = await client.query<{
          ciclo: string | null;
          valor: string | null;
        }>(
          /* No contrato SESSION o valor da sessão é o próprio
             `amount_cents` — não há coluna separada. Presumir uma coluna
             de preço por sessão era erro meu de leitura do schema. */
          `SELECT cycle::text AS ciclo, amount_cents::text AS valor
             FROM student_contracts
            WHERE student_id = $1 AND is_active
            LIMIT 1`,
          [alunoId],
        );

        const ciclo = contrato[0]?.ciclo ?? null;
        const mensalista = ciclo !== null && ciclo !== 'SESSION';
        const preco = contrato[0]?.valor === null || contrato[0]?.valor === undefined
          ? null
          : Number(contrato[0].valor);

        let criado: { id: string };
        try {
          criado = await criarCompromisso(client, principal.tenantId, {
            studentId: alunoId,
            professionalId: corpo.profissionalId,
            inicio,
            fim,
            studentNote: corpo.observacao,
            isIncludedInPlan: mensalista,
            ...(preco === null ? {} : { priceCents: preco }),
            createdBy: principal.userId,
          });
        } catch (erro) {
          /* 23P01 é a EXCLUSION CONSTRAINT do banco: dois agendamentos no
             mesmo profissional e horário são FISICAMENTE impossíveis, não
             importa quantos alunos apertem o botão no mesmo instante. A
             corrida é resolvida lá, e aqui só se traduz a mensagem. */
          const app = fromDatabaseError(erro);
          if (app.code === 'CONFLICT') {
            throw conflict('Este horário acabou de ser preenchido. Escolha outro.');
          }
          throw erro;
        }

        await writeAudit(client, principal.tenantId, {
          action: 'appointment.create',
          resourceType: 'appointment',
          resourceId: criado.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { pelo_aluno: true },
        });

        void reply.status(201);
        return {
          data: {
            id: criado.id,
            precoCentavos: mensalista ? null : preco,
          },
        };
      });
    },
  );

  /* ------------------------------------------------------------------
   * DELETE /api/eu/agendamentos/:id
   * ---------------------------------------------------------------- */
  app.delete(
    '/agendamentos/:id',
    { preHandler: [app.authorize('self:booking')] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid('Identificador inválido') }).parse(
        request.params,
      );
      const scope = requireScope(request);
      alunoDoToken(scope);

      return inTenant(request, async (client, principal) => {
        /* A JANELA É CONFERIDA NO SERVIDOR, na mesma consulta que localiza
           o compromisso. A tela esconde o botão fora do prazo, mas
           esconder botão não é regra — é conveniência. */
        const { rows } = await client.query<{ id: string; no_prazo: boolean }>(
          `SELECT a.id, (lower(a.period) > now() + ($2 || ' hours')::interval) AS no_prazo
             FROM appointments a
            WHERE a.id = $1
              AND a.student_id = $3
              AND a.status IN ('SCHEDULED','CONFIRMED')`,
          [id, String(CANCELAMENTO_HORAS), scope.kind === 'SELF' ? scope.studentId : ''],
        );

        const alvo = rows[0];
        if (alvo === undefined) throw notFound('Agendamento');
        if (!alvo.no_prazo) {
          throw conflict(
            `Faltam menos de ${CANCELAMENTO_HORAS} horas. Fale com a recepção para desmarcar.`,
          );
        }

        await cancelarCompromisso(client, scope, id, principal.userId, 'Cancelado pelo aluno');

        await writeAudit(client, principal.tenantId, {
          action: 'appointment.cancel',
          resourceType: 'appointment',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { pelo_aluno: true },
        });

        return { ok: true };
      });
    },
  );
}
