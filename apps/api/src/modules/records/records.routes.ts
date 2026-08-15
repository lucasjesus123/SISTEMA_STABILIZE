import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';
import { conflict, notFound } from '../../http/errors.js';
import { assertStudentInScope } from '../students/students.repository.js';
import {
  anamneseVigente,
  criarEvolucao,
  editarEvolucao,
  gravarAnamnese,
  historicoAnamnese,
  listarEvolucoes,
} from './records.repository.js';

/**
 * Rotas do prontuário.
 *
 * Montadas sob /api/students para que a URL diga a verdade sobre a
 * hierarquia: uma anamnese não existe solta, existe DE um aluno. Toda
 * rota carrega o id do aluno, e é ele que passa pelo escopo — não há
 * caminho que chegue a um dado clínico sem antes provar acesso ao
 * aluno.
 *
 * TODA LEITURA É AUDITADA, o que não fazemos nas telas comuns. Dado de
 * saúde é categoria sensível na LGPD (art. 5º, II), e o incidente que
 * se quer poder investigar não é "alteraram o prontuário": é "alguém
 * abriu o prontuário de quem não devia". Sem log de leitura, essa
 * pergunta não tem resposta.
 */

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });

/**
 * jsonb com teto.
 *
 * `answers` e `measurements` são abertos de propósito — o formulário
 * clínico muda com a prática. Aberto não é ilimitado: sem teto de
 * chaves e de tamanho, um cliente grava megabytes por linha e o custo
 * cai sobre todo mundo que lê a tabela depois.
 */
const jsonLimitado = z
  .record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((o) => Object.keys(o).length <= 60, {
    message: 'Muitos campos no formulário (máximo 60).',
  });

const anamneseSchema = z.object({
  queixaPrincipal: z.string().trim().max(2000).optional(),
  historicoClinico: z.string().trim().max(5000).optional(),
  medicamentos: z.string().trim().max(2000).optional(),
  cirurgias: z.string().trim().max(2000).optional(),
  lesoes: z.string().trim().max(2000).optional(),
  objetivos: z.string().trim().max(2000).optional(),
  contraindicacoes: z.string().trim().max(2000).optional(),
  /* Os limites são os mesmos do CHECK no banco. Validar aqui devolve
     mensagem em português; deixar só para o banco devolveria um 422
     genérico e a pessoa não saberia qual campo corrigir. */
  alturaCm: z.number().int().min(50).max(260).optional(),
  pesoG: z.number().int().min(1000).max(500_000).optional(),
  respostas: jsonLimitado.optional(),
});

const evolucaoSchema = z.object({
  dataSessao: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida'),
  conteudo: z.string().trim().min(3, 'Descreva o atendimento').max(10_000),
  escalaDor: z.number().int().min(0).max(10).optional(),
  medidas: jsonLimitado.optional(),
});

const listaQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function recordsRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/students/:id/anamnese
   * ---------------------------------------------------------------- */
  app.get('/:id/anamnese', { preHandler: [app.authorize('anamnesis:read')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      /* O aluno é conferido ANTES de qualquer leitura clínica, e é o
         único motivo de 404 aqui. Um aluno no escopo que ainda não tem
         anamnese responde 200 com `vigente: null` — "não existe ainda"
         e "não é seu" são situações diferentes para quem está no
         balcão, e só a segunda deve esconder o aluno. */
      if (!(await assertStudentInScope(client, scope, id))) {
        await auditDenied(principal.tenantId, principal.userId, {
          action: 'anamnesis.read',
          resourceType: 'anamnesis',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });
        throw notFound('Aluno');
      }

      const vigente = await anamneseVigente(client, scope, id);
      const historico = await historicoAnamnese(client, scope, id);

      await writeAudit(client, principal.tenantId, {
        action: 'anamnesis.read',
        resourceType: 'anamnesis',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
      });

      return {
        data: {
          vigente:
            vigente === null
              ? null
              : {
                  ...vigente,
                  realizadaEm: vigente.realizadaEm.toISOString(),
                  criadaEm: vigente.criadaEm.toISOString(),
                },
          versoes: historico.map((h) => ({
            id: h.id,
            realizadaEm: h.realizadaEm.toISOString(),
            profissional: h.profissional,
          })),
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/students/:id/anamnese — grava uma versão nova
   * ---------------------------------------------------------------- */
  app.post(
    '/:id/anamnese',
    { preHandler: [app.authorize('anamnesis:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const dados = anamneseSchema.parse(request.body);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const criada = await gravarAnamnese(
          client,
          scope,
          principal.tenantId,
          id,
          dados,
          principal.userId,
        );

        if (criada === null) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'anamnesis.write',
            resourceType: 'anamnesis',
            resourceId: id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Aluno');
        }

        await writeAudit(client, principal.tenantId, {
          action: 'anamnesis.write',
          resourceType: 'anamnesis',
          resourceId: criada.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          /* Registramos QUAIS SEÇÕES foram preenchidas, nunca o
             conteúdo. O log não pode virar uma segunda cópia do
             prontuário — seria ampliar a superfície do dado sensível
             justamente na tabela que mais gente lê. */
          metadata: { secoes: Object.keys(dados).filter((k) => dados[k as keyof typeof dados] !== undefined) },
        });

        void reply.status(201);
        return { data: { id: criada.id } };
      });
    },
  );

  /* ------------------------------------------------------------------
   * GET /api/students/:id/evolucoes
   * ---------------------------------------------------------------- */
  app.get('/:id/evolucoes', { preHandler: [app.authorize('evolution:read')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const query = listaQuery.parse(request.query);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      /* Mesma razão da anamnese: fora do escopo é 404, e não uma lista
         vazia. Lista vazia diria "este aluno existe e não tem
         evolução", que já é informação sobre um aluno alheio. */
      if (!(await assertStudentInScope(client, scope, id))) {
        await auditDenied(principal.tenantId, principal.userId, {
          action: 'evolution.read',
          resourceType: 'evolution',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });
        throw notFound('Aluno');
      }

      const { itens, total } = await listarEvolucoes(
        client,
        scope,
        id,
        principal.userId,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      );

      await writeAudit(client, principal.tenantId, {
        action: 'evolution.read',
        resourceType: 'evolution',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { retornadas: itens.length, total },
      });

      return {
        data: itens.map((e) => ({
          ...e,
          criadaEm: e.criadaEm.toISOString(),
          atualizadaEm: e.atualizadaEm.toISOString(),
        })),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/students/:id/evolucoes
   * ---------------------------------------------------------------- */
  app.post(
    '/:id/evolucoes',
    { preHandler: [app.authorize('evolution:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const dados = evolucaoSchema.parse(request.body);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        /* O autor é sempre quem está autenticado. Aceitar um
           `profissionalId` do corpo permitiria assinar atendimento no
           nome de um colega — e evolução assinada é o que sustenta
           comissão e responsabilidade técnica. */
        const criada = await criarEvolucao(
          client,
          scope,
          principal.tenantId,
          id,
          principal.userId,
          dados,
        );

        if (criada === null) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'evolution.write',
            resourceType: 'evolution',
            resourceId: id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Aluno');
        }

        await writeAudit(client, principal.tenantId, {
          action: 'evolution.write',
          resourceType: 'evolution',
          resourceId: criada.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });

        void reply.status(201);
        return { data: { id: criada.id } };
      });
    },
  );

  /* ------------------------------------------------------------------
   * PATCH /api/students/:id/evolucoes/:evolucaoId
   * ---------------------------------------------------------------- */
  app.patch(
    '/:id/evolucoes/:evolucaoId',
    { preHandler: [app.authorize('evolution:write')] },
    async (request) => {
      const { id, evolucaoId } = z
        .object({
          id: z.string().uuid('Identificador inválido'),
          evolucaoId: z.string().uuid('Identificador inválido'),
        })
        .parse(request.params);
      const dados = evolucaoSchema.pick({ conteudo: true, escalaDor: true }).parse(request.body);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const resultado = await editarEvolucao(
          client,
          scope,
          evolucaoId,
          principal.userId,
          dados,
        );

        if (resultado === 'inexistente') {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'evolution.write',
            resourceType: 'evolution',
            resourceId: evolucaoId,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Evolução');
        }

        if (resultado === 'janela-expirada') {
          /* 409, não 403: não é falta de permissão, é o estado do
             registro que mudou com o tempo. A tela precisa dessa
             diferença para oferecer a saída certa — escrever uma
             retificação em vez de mandar pedir acesso a alguém. */
          throw conflict(
            'Esta evolução não pode mais ser editada. Registre uma nova evolução com a correção.',
          );
        }

        await writeAudit(client, principal.tenantId, {
          action: 'evolution.write',
          resourceType: 'evolution',
          resourceId: evolucaoId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { edicao: true, aluno: id },
        });

        return { ok: true };
      });
    },
  );
}
