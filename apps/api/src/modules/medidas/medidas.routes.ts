import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';
import { notFound } from '../../http/errors.js';
import { assertStudentInScope } from '../students/students.repository.js';
import {
  CAMPOS_MEDIDA,
  excluirMedida,
  gravarMedida,
  listarMedidas,
  type CampoMedida,
} from './medidas.repository.js';

/**
 * Avaliação física do aluno.
 *
 * VIVE SOB /api/students/:id porque uma medida não existe solta: ela é
 * DE um aluno, e é o aluno que passa pelo escopo. É a mesma regra que
 * põe a anamnese e os anexos aqui.
 *
 * PERMISSÃO: usa `evolution:read` / `evolution:write`, e não uma
 * permissão nova. Medida corporal é acompanhamento clínico — quem pode
 * registrar a evolução do atendimento é exatamente quem passa a fita
 * métrica. Criar `measurement:write` obrigaria a revisar a matriz de
 * papéis inteira para acrescentar uma linha que sempre acompanharia a
 * de evolução; permissão que nunca diverge de outra é permissão a mais.
 */

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });
const medidaParams = z.object({
  id: z.string().uuid('Identificador inválido'),
  medidaId: z.string().uuid('Identificador inválido'),
});

/**
 * Milímetro inteiro, nunca decimal.
 *
 * A tela envia o que a pessoa digitou em CENTÍMETROS com uma casa
 * ("87,5") já convertido para 875. Aceitar decimal aqui reabriria a
 * porta do ponto flutuante justamente na camada que existe para
 * fechá-la.
 */
const inteiro = (min: number, max: number) =>
  z
    .number()
    .int('Use um número inteiro.')
    .min(min)
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const circunferencias = z.object(
  Object.fromEntries(CAMPOS_MEDIDA.map((c) => [c, inteiro(100, 3000)])) as Record<
    CampoMedida,
    ReturnType<typeof inteiro>
  >,
);

const medidaSchema = z.object({
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.'),
  pesoG: inteiro(1000, 500_000),
  alturaCm: inteiro(50, 260),
  gorduraPctX10: inteiro(10, 700),
  observacoes: z
    .string()
    .trim()
    .max(4000)
    .nullable()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  circunferenciasMm: circunferencias.partial().default({}),
});

export async function medidasRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/students/:id/medidas
   * ---------------------------------------------------------------- */
  app.get('/:id/medidas', { preHandler: [app.authorize('evolution:read')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      if (!(await assertStudentInScope(client, scope, id))) {
        await auditDenied(principal.tenantId, principal.userId, {
          action: 'evolution.read',
          resourceType: 'measurement',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });
        throw notFound('Aluno');
      }
      return { data: await listarMedidas(client, scope, id) };
    });
  });

  /* ------------------------------------------------------------------
   * PUT /api/students/:id/medidas
   *
   * PUT e não POST: a data é a chave. Enviar a mesma data duas vezes
   * corrige a avaliação daquele dia em vez de criar uma segunda, que é
   * o comportamento que o `ON CONFLICT` do repositório garante — e PUT
   * é o verbo que anuncia isso a quem lê a rota.
   * ---------------------------------------------------------------- */
  app.put(
    '/:id/medidas',
    { preHandler: [app.authorize('evolution:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const dados = medidaSchema.parse(request.body);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const medida = await gravarMedida(
          client,
          scope,
          principal.tenantId,
          id,
          principal.userId,
          dados,
        );

        if (medida === null) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'evolution.write',
            resourceType: 'measurement',
            resourceId: id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Aluno');
        }

        await writeAudit(client, principal.tenantId, {
          action: 'evolution.write',
          resourceType: 'measurement',
          resourceId: medida.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          /* QUAIS medidas foram tomadas, nunca os valores. Circunferência
             de aluno é dado de saúde; o log serve para saber que houve
             avaliação e quem a fez, não para guardar o corpo da pessoa
             numa segunda tabela que ninguém pensa em limpar. */
          metadata: {
            aluno: id,
            data: medida.data,
            campos: Object.entries(medida.circunferenciasMm)
              .filter(([, v]) => v !== null)
              .map(([k]) => k).length,
          },
        });

        void reply.status(200);
        return { data: medida };
      });
    },
  );

  /* ------------------------------------------------------------------
   * DELETE /api/students/:id/medidas/:medidaId
   * ---------------------------------------------------------------- */
  app.delete(
    '/:id/medidas/:medidaId',
    { preHandler: [app.authorize('evolution:write')] },
    async (request) => {
      const { id, medidaId } = medidaParams.parse(request.params);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const removida = await excluirMedida(client, scope, id, medidaId);
        if (!removida) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'evolution.write',
            resourceType: 'measurement',
            resourceId: medidaId,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Avaliação');
        }

        await writeAudit(client, principal.tenantId, {
          action: 'evolution.write',
          resourceType: 'measurement',
          resourceId: medidaId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { aluno: id, removida: true },
        });

        return { ok: true };
      });
    },
  );
}
