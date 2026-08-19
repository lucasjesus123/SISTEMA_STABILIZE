import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';
import { badRequest, notFound } from '../../http/errors.js';
import { assertStudentInScope } from '../students/students.repository.js';
import {
  anexoParaLeitura,
  editarAnexo,
  excluirAnexo,
  listarAnexos,
  registrarAnexo,
} from './attachments.repository.js';
import { apagar, cabecalhoDeNome, existe, gravar, ler, rotuloDeArquivo } from './storage.js';
import type { FastifyRequest } from 'fastify';
import { unauthorized } from '../../http/errors.js';

/**
 * Anexos: exames, laudos, fotos.
 *
 * O download é a rota mais perigosa do sistema — é a única que devolve
 * bytes arbitrários enviados por um usuário. Três cuidados, todos
 * visíveis abaixo:
 *
 *   1. SEMPRE como anexo, nunca inline. Um PDF ou SVG servido inline
 *      roda script no domínio do sistema, e aí o token da sessão de
 *      quem abriu está ao alcance.
 *   2. `X-Content-Type-Options: nosniff`, para o navegador não decidir
 *      sozinho que aquilo é HTML.
 *   3. O nome vai higienizado no cabeçalho — nome com aspas ou quebra
 *      de linha injeta cabeçalho HTTP.
 *
 * E a leitura é auditada, como todo o resto do prontuário: baixar o
 * exame de alguém é justamente o que se quer poder investigar depois.
 */

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });
const anexoParams = z.object({
  id: z.string().uuid('Identificador inválido'),
  anexoId: z.string().uuid('Identificador inválido'),
});

const CATEGORIAS = ['EXAME', 'LAUDO', 'FOTO', 'TERMO', 'OUTRO'] as const;

export async function attachmentsRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/students/:id/anexos
   * ---------------------------------------------------------------- */
  app.get('/:id/anexos', { preHandler: [app.authorize('attachment:read')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      if (!(await assertStudentInScope(client, scope, id))) {
        await auditDenied(principal.tenantId, principal.userId, {
          action: 'attachment.read',
          resourceType: 'attachment',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });
        throw notFound('Aluno');
      }

      const itens = await listarAnexos(client, scope, id);

      /* A LISTA é auditada, não só o download: saber que existe um laudo
         psiquiátrico no prontuário já é informação sobre a pessoa. */
      await writeAudit(client, principal.tenantId, {
        action: 'attachment.read',
        resourceType: 'attachment',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { listados: itens.length },
      });

      return {
        data: itens.map((a) => ({ ...a, criadoEm: a.criadoEm.toISOString() })),
      };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/students/:id/anexos   (multipart)
   * ---------------------------------------------------------------- */
  app.post(
    '/:id/anexos',
    { preHandler: [app.authorize('attachment:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const scope = requireScope(request);

      const parte = await request.file();
      if (parte === undefined) throw badRequest('Nenhum arquivo enviado.');

      /* Campos de texto que acompanham o arquivo. Vêm do multipart, e
         por isso passam pelo mesmo rigor de um corpo JSON: lista
         fechada de categorias e teto de tamanho na descrição. */
      const categoria = z
        .enum(CATEGORIAS)
        .optional()
        .parse(valorDeCampo(parte.fields['categoria']));
      const descricao = z
        .string()
        .trim()
        .max(300)
        .optional()
        .parse(valorDeCampo(parte.fields['descricao']));

      /* O arquivo é gravado ANTES da transação. Escrever em disco dentro
         de uma transação de banco significaria segurar uma conexão do
         pool pelo tempo do upload — com 90 usuários simultâneos e um
         exame de 15 MB numa conexão ruim, o pool acaba antes do upload. */
      const nomeOriginal = rotuloDeArquivo(parte.filename);
      const gravado = await gravar(
        tenantDe(request),
        parte.file,
        parte.mimetype,
        () => parte.file.truncated,
      );

      try {
        return await inTenant(request, async (client, principal) => {
          const criado = await registrarAnexo(client, scope, principal.tenantId, id, principal.userId, {
            chave: gravado.chave,
            /* O nome do usuário vai para o BANCO, como rótulo. Nunca
               para o caminho — o caminho vem de `gravado.chave`. */
            nomeOriginal,
            tipo: parte.mimetype,
            tamanhoBytes: gravado.tamanhoBytes,
            checksum: gravado.checksum,
            categoria,
            descricao,
          });

          if (criado === null) {
            await auditDenied(principal.tenantId, principal.userId, {
              action: 'attachment.upload',
              resourceType: 'attachment',
              resourceId: id,
              actorId: principal.userId,
              actorRole: principal.role,
              ip: request.ip,
            });
            throw notFound('Aluno');
          }

          await writeAudit(client, principal.tenantId, {
            action: 'attachment.upload',
            resourceType: 'attachment',
            resourceId: criado.id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
            metadata: { tipo: parte.mimetype, bytes: gravado.tamanhoBytes },
          });

          void reply.status(201);
          return { data: { id: criado.id } };
        });
      } catch (erro) {
        /* Se o registro no banco falhou, os bytes em disco viram órfãos:
           ninguém consegue alcançá-los e ninguém sabe que existem. Um
           arquivo de saúde esquecido num disco é o pior tipo de sobra. */
        await apagar(tenantDe(request), gravado.chave).catch(() => undefined);
        throw erro;
      }
    },
  );

  /* ------------------------------------------------------------------
   * GET /api/students/:id/anexos/:anexoId/conteudo
   * ---------------------------------------------------------------- */
  app.get(
    '/:id/anexos/:anexoId/conteudo',
    { preHandler: [app.authorize('attachment:read')] },
    async (request, reply) => {
      const { id, anexoId } = anexoParams.parse(request.params);
      const scope = requireScope(request);

      const anexo = await inTenant(request, async (client, principal) => {
        const encontrado = await anexoParaLeitura(client, scope, id, anexoId);

        if (encontrado === null) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'attachment.read',
            resourceType: 'attachment',
            resourceId: anexoId,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Anexo');
        }

        await writeAudit(client, principal.tenantId, {
          action: 'attachment.read',
          resourceType: 'attachment',
          resourceId: anexoId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { download: true },
        });

        return encontrado;
      });

      /* A linha no banco e os bytes em disco podem discordar: um restore
         parcial, um disco trocado, uma exclusão interrompida. Sem esta
         conferência o cliente receberia 200 com cabeçalho de download e
         um corpo que morre no meio — um arquivo corrompido, que é pior
         que um erro claro, porque parece ter funcionado. */
      if (!(await existe(tenantDe(request), anexo.chave))) {
        request.log.error(
          { anexoId, tenantId: tenantDe(request) },
          'anexo registrado no banco não encontrado em disco',
        );
        throw notFound('Anexo');
      }

      void reply
        .header('Content-Type', anexo.tipo)
        .header('Content-Length', String(anexo.tamanhoBytes))
        // Sempre download, nunca inline — ver o cabeçalho deste arquivo.
        .header('Content-Disposition', cabecalhoDeNome(anexo.nome))
        .header('X-Content-Type-Options', 'nosniff')
        // Dado de saúde não fica em cache de proxy nem de navegador.
        .header('Cache-Control', 'private, no-store');

      return reply.send(await ler(tenantDe(request), anexo.chave));
    },
  );

  /* ------------------------------------------------------------------
   * DELETE /api/students/:id/anexos/:anexoId
   * ---------------------------------------------------------------- */
  /* ------------------------------------------------------------------
   * PATCH /api/students/:id/anexos/:anexoId — corrige o que descreve
   *
   * SÓ OS METADADOS. O arquivo tem checksum gravado e é peça de
   * prontuário; trocar os bytes por baixo de um registro já lido e
   * auditado apagaria a prova do que estava lá. Exame errado se corrige
   * enviando outro e apagando o primeiro — as duas ações ficam no log.
   * ---------------------------------------------------------------- */
  app.patch(
    '/:id/anexos/:anexoId',
    { preHandler: [app.authorize('attachment:write')] },
    async (request) => {
      const { id, anexoId } = z
        .object({
          id: z.string().uuid('Identificador inválido'),
          anexoId: z.string().uuid('Identificador inválido'),
        })
        .parse(request.params);
      const body = z
        .object({
          descricao: z.string().trim().max(500).nullish().transform((v) => v || null),
          categoria: z.string().trim().max(80).nullish().transform((v) => v || null),
          dataDoDocumento: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
            .nullish()
            .transform((v) => v ?? null),
        })
        .parse(request.body);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const ok = await editarAnexo(client, scope, id, anexoId, body, principal.userId);
        if (!ok) throw notFound('Anexo');

        await writeAudit(client, principal.tenantId, {
          action: 'attachment.upload',
          resourceType: 'attachment',
          resourceId: anexoId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { editou: true, alunoId: id },
        });
        return { ok: true };
      });
    },
  );

  app.delete(
    '/:id/anexos/:anexoId',
    { preHandler: [app.authorize('attachment:delete')] },
    async (request) => {
      const { id, anexoId } = anexoParams.parse(request.params);
      const scope = requireScope(request);

      const removido = await inTenant(request, async (client, principal) => {
        const alvo = await excluirAnexo(client, scope, id, anexoId);

        if (alvo === null) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'attachment.delete',
            resourceType: 'attachment',
            resourceId: anexoId,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Anexo');
        }

        await writeAudit(client, principal.tenantId, {
          action: 'attachment.delete',
          resourceType: 'attachment',
          resourceId: anexoId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          /* O nome do arquivo VAI para o log aqui, e só aqui: sem ele o
             registro de exclusão não responde "o que foi apagado?", que
             é a única pergunta que importa depois. */
          metadata: { arquivo: alvo.nome, aluno: id },
        });

        return alvo;
      });

      /* Os bytes só somem DEPOIS do commit. Na ordem inversa, uma
         transação que falhasse no fim deixaria a linha viva apontando
         para um arquivo que já não existe. */
      await apagar(tenantDe(request), removido.chave);

      return { ok: true };
    },
  );
}

/**
 * O tenant de quem está autenticado.
 *
 * O `authorize` já garantiu que existe, mas a garantia é do preHandler e
 * não do tipo. Falhar fechado aqui é mais barato que um `!` que um dia
 * vira `undefined` numa rota que esqueceu o preHandler.
 */
function tenantDe(request: FastifyRequest): string {
  const p = request.principal;
  if (p === undefined) throw unauthorized('Autenticação necessária.');
  return p.tenantId;
}

/** O multipart entrega campos de texto com metadados; queremos o valor. */
function valorDeCampo(campo: unknown): string | undefined {
  if (campo === undefined || campo === null) return undefined;
  const v = (campo as { value?: unknown }).value;
  if (typeof v !== 'string') return undefined;
  const limpo = v.trim();
  return limpo === '' ? undefined : limpo;
}
