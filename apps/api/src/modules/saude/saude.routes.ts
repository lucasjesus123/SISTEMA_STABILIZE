import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { notFound, unprocessable } from '../../http/errors.js';
import { assertStudentInScope } from '../students/students.repository.js';
import type { AccessScope } from '../../auth/scope.js';
import { PERGUNTAS_PARQ } from './termo.js';
import {
  assinar,
  historico,
  liberar,
  pendentes,
  RespostaFaltandoError,
  situacaoDoAluno,
  termoVigente,
} from './saude.repository.js';

/**
 * Triagem de saúde: PAR-Q e termo de responsabilidade.
 *
 * DOIS CAMINHOS PARA A MESMA ASSINATURA, e a diferença entre eles fica
 * registrada:
 *
 *   O ALUNO ASSINA PELO APLICATIVO — `/api/eu/triagem`. É o caminho que
 *   vale mais como prova: foi ele quem respondeu, do aparelho dele.
 *
 *   A ACADEMIA REGISTRA PELO BALCÃO — `/api/students/:id/triagem`. É o
 *   caminho de quem não tem o aplicativo, e existe porque negar essa
 *   possibilidade só faria a academia guardar papel numa gaveta, que é
 *   pior. `assinado_pelo_aluno = false` diz depois qual foi qual.
 *
 * AS PERGUNTAS SÃO SERVIDAS PELA API, e não escritas na tela. Duas
 * telas — o aplicativo e o sistema — com a mesma lista copiada é a
 * receita para uma delas ficar para trás numa revisão do questionário, e
 * ninguém percebe porque as duas continuam funcionando.
 */

const idSchema = z.string().uuid('Identificador inválido');

const assinaturaSchema = z.object({
  respostas: z.record(z.string(), z.boolean()),
  observacoes: z.string().trim().max(1000).nullish().transform((v) => v || null),
  /* O nome digitado é a assinatura. Exigimos algo com jeito de nome —
     duas palavras — porque "ok" e "x" também são digitáveis. */
  assinadoNome: z
    .string()
    .trim()
    .min(5, 'Escreva o nome completo.')
    .max(160)
    .refine((v) => v.split(/\s+/).length >= 2, 'Escreva o nome completo, com sobrenome.'),
});

function alunoDoToken(scope: AccessScope): string {
  if (scope.kind !== 'SELF') throw notFound('Aluno');
  return scope.studentId;
}

/* ==================================================================== */

/** O que a ACADEMIA alcança. Prefixo /api/students. */
export async function triagemRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/triagem/perguntas',
    { preHandler: [app.authorize('anamnesis:read')] },
    async (request) =>
      inTenant(request, async (client) => {
        const termo = await termoVigente(client);
        return { data: { perguntas: PERGUNTAS_PARQ, termo } };
      }),
  );

  /* A lista de quem está pendente. É a razão prática de existir tudo
     isto: sem ela a academia sabe que precisa das assinaturas e não sabe
     de quem. */
  app.get(
    '/triagem/pendentes',
    { preHandler: [app.authorize('anamnesis:read')] },
    async (request) => inTenant(request, async (client) => ({ data: await pendentes(client) })),
  );

  app.get(
    '/:id/triagem',
    { preHandler: [app.authorize('anamnesis:read')] },
    async (request) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);
      const scope = requireScope(request);

      return inTenant(request, async (client) => {
        if (!(await assertStudentInScope(client, scope, id))) throw notFound('Aluno');
        return {
          data: {
            atual: await situacaoDoAluno(client, id),
            historico: await historico(client, id),
          },
        };
      });
    },
  );

  app.post(
    '/:id/triagem',
    { preHandler: [app.authorize('anamnesis:write')] },
    async (request, reply) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);
      const body = assinaturaSchema.parse(request.body);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        if (!(await assertStudentInScope(client, scope, id))) throw notFound('Aluno');

        const r = await assinar(client, principal.tenantId, id, {
          respostas: body.respostas,
          observacoes: body.observacoes,
          assinadoNome: body.assinadoNome,
          /* Registrado pela academia: o aluno estava na frente, mas quem
             digitou foi outra pessoa. A prova é mais fraca, e o registro
             diz isso. */
          assinadoPeloAluno: false,
          ip: request.ip,
          agente: request.headers['user-agent'] ?? null,
          registradoPor: principal.userId,
        }).catch(paraErroDeCampo);

        await writeAudit(client, principal.tenantId, {
          action: 'screening.sign',
          resourceType: 'student',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { pelaAcademia: true, precisaLiberacaoMedica: r.precisaLiberacaoMedica },
        });

        void reply.status(201);
        return { data: r };
      });
    },
  );

  /* A liberação médica. Exige `anamnesis:write` porque é uma decisão
     clínica sobre quem pode treinar — não é tarefa de balcão. */
  app.post(
    '/triagem/:triagemId/liberar',
    { preHandler: [app.authorize('anamnesis:write')] },
    async (request) => {
      const { triagemId } = z.object({ triagemId: idSchema }).parse(request.params);
      const body = z
        .object({ atestadoId: idSchema.nullish() })
        .parse(request.body ?? {});

      return inTenant(request, async (client, principal) => {
        const ok = await liberar(
          client,
          triagemId,
          principal.userId,
          body.atestadoId ?? null,
        );
        if (!ok) {
          throw unprocessable(
            'Esta triagem não está aguardando liberação — ou já foi liberada, ou o PAR-Q não pediu atestado.',
          );
        }

        await writeAudit(client, principal.tenantId, {
          action: 'screening.clear',
          resourceType: 'student',
          resourceId: triagemId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });
        return { ok: true };
      });
    },
  );
}

/* ==================================================================== */

/** O que o ALUNO alcança. Prefixo /api/eu. Nenhuma URL leva o id dele. */
export async function triagemDoAlunoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/triagem', { preHandler: [app.authorize('self:read')] }, async (request) => {
    const alunoId = alunoDoToken(requireScope(request));
    return inTenant(request, async (client) => ({
      data: {
        perguntas: PERGUNTAS_PARQ,
        termo: await termoVigente(client),
        atual: await situacaoDoAluno(client, alunoId),
      },
    }));
  });

  app.post('/triagem', { preHandler: [app.authorize('self:write')] }, async (request, reply) => {
    const alunoId = alunoDoToken(requireScope(request));
    const body = assinaturaSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      /* O NOME ASSINADO É CONFERIDO CONTRA O CADASTRO. Sem isto, o
         campo aceita qualquer coisa e a assinatura não identifica
         ninguém — que é o mesmo que não ter assinatura. A comparação é
         frouxa de propósito (sem acento, sem caixa): recusar "Joao" de
         quem está cadastrado como "João" seria transformar um controle
         de identidade num teste de digitação. */
      const { rows } = await client.query<{ nome: string }>(
        'SELECT full_name AS nome FROM students WHERE id = $1',
        [alunoId],
      );
      const cadastrado = rows[0]?.nome;
      if (cadastrado === undefined) throw notFound('Aluno');
      if (normalizar(cadastrado) !== normalizar(body.assinadoNome)) {
        throw unprocessable(
          `Assine com o nome do seu cadastro: ${cadastrado}. Se ele está errado, fale com a academia.`,
        );
      }

      const r = await assinar(client, principal.tenantId, alunoId, {
        respostas: body.respostas,
        observacoes: body.observacoes,
        assinadoNome: body.assinadoNome,
        assinadoPeloAluno: true,
        ip: request.ip,
        agente: request.headers['user-agent'] ?? null,
        registradoPor: null,
      }).catch(paraErroDeCampo);

      await writeAudit(client, principal.tenantId, {
        action: 'screening.sign',
        resourceType: 'student',
        resourceId: alunoId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { pelaAcademia: false, precisaLiberacaoMedica: r.precisaLiberacaoMedica },
      });

      void reply.status(201);
      return { data: r };
    });
  });
}

/* ==================================================================== */

function paraErroDeCampo(e: unknown): never {
  if (e instanceof RespostaFaltandoError) {
    /* PULAR UMA PERGUNTA NÃO PODE VALER COMO "NÃO". Num questionário
       que existe para detectar o "sim", a resposta em branco é a mais
       perigosa das três. */
    throw unprocessable('Responda todas as perguntas antes de assinar.');
  }
  throw e;
}

function normalizar(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
