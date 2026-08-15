import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import {
  GRUPOS_MUSCULARES,
  adicionarItem,
  alternarExercicio,
  ativarTreino,
  buscarTreino,
  criarExercicio,
  criarTreino,
  listarExercicios,
  listarTreinos,
  removerItem,
} from './workouts.repository.js';

/**
 * Biblioteca de exercícios e prescrição de treino.
 *
 * Duas rotas raiz, porque são duas coisas:
 *
 *   /api/exercises          catálogo da EMPRESA
 *   /api/students/:id/treinos  prescrição do ALUNO
 *
 * A URL diz de quem é a coisa, e de quem é a coisa determina como ela é
 * protegida — o catálogo por permissão, a prescrição por escopo.
 */

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });

const exercicioSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome do exercício').max(120),
  grupo: z.enum(GRUPOS_MUSCULARES),
  equipamento: z.string().trim().max(80).optional().or(z.literal('')),
  instrucoes: z.string().trim().max(2000).optional().or(z.literal('')),
  /* Só https, e o mesmo CHECK existe no banco. O endereço nunca é
     renderizado como iframe pela aplicação: link de terceiro virando
     embed é conteúdo externo rodando dentro da sessão de quem abriu. */
  video: z
    .string()
    .trim()
    .url('Endereço inválido')
    .startsWith('https://', 'O endereço precisa começar com https://')
    .max(500)
    .optional()
    .or(z.literal('')),
});

const treinoSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome ao treino').max(120),
  objetivo: z.string().trim().max(300).optional().or(z.literal('')),
  inicioEm: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').optional().or(z.literal('')),
  fimEm: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').optional().or(z.literal('')),
  observacoes: z.string().trim().max(2000).optional().or(z.literal('')),
});

const itemSchema = z.object({
  exercicioId: z.string().uuid('Escolha um exercício'),
  dia: z.string().trim().min(1).max(40).optional(),
  posicao: z.number().int().min(0).max(999).optional(),
  series: z.number().int().min(1).max(20).optional(),
  repeticoes: z.string().trim().min(1).max(40).optional(),
  /* O cliente manda QUILOS; o banco guarda gramas inteiros. A conversão
     é aqui, arredondada, pelo mesmo motivo do dinheiro em centavos:
     12,5 kg em ponto flutuante não fecha a conta na hora de comparar
     progressão. */
  cargaKg: z.number().min(0).max(1000).optional(),
  descansoSegundos: z.number().int().min(0).max(900).optional(),
  observacoes: z.string().trim().max(500).optional(),
});

/** Campo em branco vira ausente — o repositório trata ausente como NULL. */
function semVazios<T extends Record<string, unknown>>(o: T): T {
  const saida = { ...o };
  for (const chave of Object.keys(saida)) {
    if (saida[chave] === '') delete saida[chave];
  }
  return saida;
}

/* ====================================================================
 * /api/exercises — o catálogo
 * ================================================================== */

export async function exercisesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [app.authorize('exercise:read')] }, async (request) => {
    const query = z
      .object({
        busca: z.string().trim().max(80).optional(),
        grupo: z.enum(GRUPOS_MUSCULARES).optional(),
        incluirInativos: z.coerce.boolean().optional(),
      })
      .parse(request.query);

    return inTenant(request, async (client) => {
      const itens = await listarExercicios(client, {
        busca: query.busca,
        grupo: query.grupo,
        incluirInativos: query.incluirInativos === true,
      });
      /* Catálogo não é dado pessoal: sem auditoria de leitura aqui. O
         log de auditoria é caro e é lido em investigação; enchê-lo de
         "fulano abriu a lista de exercícios" afogaria o que importa. */
      return { data: itens };
    });
  });

  app.post('/', { preHandler: [app.authorize('exercise:write')] }, async (request, reply) => {
    const dados = semVazios(exercicioSchema.parse(request.body));

    return inTenant(request, async (client, principal) => {
      try {
        const criado = await criarExercicio(client, principal.tenantId, dados);

        await writeAudit(client, principal.tenantId, {
          action: 'exercise.write',
          resourceType: 'exercise',
          resourceId: criado.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { nome: dados.nome },
        });

        void reply.status(201);
        return { data: { id: criado.id } };
      } catch (erro) {
        /* 23505 = violação de unicidade. Mensagem específica porque o
           caso é comum e tem conserto óbvio: o exercício já existe. */
        if ((erro as { code?: string }).code === '23505') {
          throw conflict(`Já existe um exercício chamado "${dados.nome}".`);
        }
        throw erro;
      }
    });
  });

  app.patch('/:id', { preHandler: [app.authorize('exercise:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { ativo } = z.object({ ativo: z.boolean() }).parse(request.body);

    return inTenant(request, async (client, principal) => {
      const ok = await alternarExercicio(client, id, ativo);
      if (!ok) throw notFound('Exercício');

      await writeAudit(client, principal.tenantId, {
        action: 'exercise.write',
        resourceType: 'exercise',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { ativo },
      });

      return { ok: true };
    });
  });
}

/* ====================================================================
 * /api/students/:id/treinos — a prescrição
 * ================================================================== */

export async function workoutsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/treinos', { preHandler: [app.authorize('workout:read')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    return inTenant(request, async (client) => {
      const itens = await listarTreinos(client, scope, id);
      return {
        data: itens.map((t) => ({ ...t, criadoEm: t.criadoEm.toISOString() })),
      };
    });
  });

  app.get(
    '/:id/treinos/:treinoId',
    { preHandler: [app.authorize('workout:read')] },
    async (request) => {
      const { id, treinoId } = z
        .object({
          id: z.string().uuid('Identificador inválido'),
          treinoId: z.string().uuid('Identificador inválido'),
        })
        .parse(request.params);
      const scope = requireScope(request);

      return inTenant(request, async (client) => {
        const treino = await buscarTreino(client, scope, id, treinoId);
        if (treino === null) throw notFound('Treino');
        return { data: { ...treino, criadoEm: treino.criadoEm.toISOString() } };
      });
    },
  );

  app.post(
    '/:id/treinos',
    { preHandler: [app.authorize('workout:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const dados = semVazios(treinoSchema.parse(request.body));
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        /* O autor é sempre quem está autenticado, como na evolução:
           prescrição assinada é responsabilidade técnica. */
        const criado = await criarTreino(
          client,
          scope,
          principal.tenantId,
          id,
          principal.userId,
          dados,
        );
        if (criado === null) throw notFound('Aluno');

        await writeAudit(client, principal.tenantId, {
          action: 'workout.write',
          resourceType: 'workout',
          resourceId: criado.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });

        void reply.status(201);
        return { data: { id: criado.id } };
      });
    },
  );

  app.post(
    '/:id/treinos/:treinoId/itens',
    { preHandler: [app.authorize('workout:write')] },
    async (request, reply) => {
      const { id, treinoId } = z
        .object({
          id: z.string().uuid('Identificador inválido'),
          treinoId: z.string().uuid('Identificador inválido'),
        })
        .parse(request.params);
      const corpo = itemSchema.parse(request.body);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const criado = await adicionarItem(client, scope, principal.tenantId, id, treinoId, {
          exercicioId: corpo.exercicioId,
          dia: corpo.dia,
          posicao: corpo.posicao,
          series: corpo.series,
          repeticoes: corpo.repeticoes,
          cargaG: corpo.cargaKg === undefined ? undefined : Math.round(corpo.cargaKg * 1000),
          descansoSegundos: corpo.descansoSegundos,
          observacoes: corpo.observacoes,
        });

        /* Um só 404 para "treino não é seu" e "exercício não existe": a
           consulta confere os dois na mesma instrução justamente para
           não dar ao cliente um oráculo que distinga os casos. */
        if (criado === null) throw notFound('Treino ou exercício');

        void reply.status(201);
        return { data: { id: criado.id } };
      });
    },
  );

  app.delete(
    '/:id/treinos/:treinoId/itens/:itemId',
    { preHandler: [app.authorize('workout:write')] },
    async (request) => {
      const { id, treinoId, itemId } = z
        .object({
          id: z.string().uuid('Identificador inválido'),
          treinoId: z.string().uuid('Identificador inválido'),
          itemId: z.string().uuid('Identificador inválido'),
        })
        .parse(request.params);
      const scope = requireScope(request);

      return inTenant(request, async (client) => {
        const ok = await removerItem(client, scope, id, treinoId, itemId);
        if (!ok) throw notFound('Exercício do treino');
        return { ok: true };
      });
    },
  );

  app.post(
    '/:id/treinos/:treinoId/ativar',
    { preHandler: [app.authorize('workout:write')] },
    async (request) => {
      const { id, treinoId } = z
        .object({
          id: z.string().uuid('Identificador inválido'),
          treinoId: z.string().uuid('Identificador inválido'),
        })
        .parse(request.params);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const resultado = await ativarTreino(client, scope, id, treinoId);

        if (resultado === 'inexistente') throw notFound('Treino');
        if (resultado === 'sem-itens') {
          throw unprocessable(
            'Acrescente pelo menos um exercício antes de publicar o treino.',
          );
        }

        await writeAudit(client, principal.tenantId, {
          action: 'workout.write',
          resourceType: 'workout',
          resourceId: treinoId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { ativado: true, aluno: id },
        });

        return { ok: true };
      });
    },
  );
}
