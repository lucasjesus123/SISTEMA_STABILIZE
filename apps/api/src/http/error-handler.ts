import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, fromDatabaseError } from './errors.js';
import { TenantContextError } from '../db/pool.js';

/**
 * Handler de erro.
 *
 * Uma regra: **o cliente recebe a mensagem que nós escrevemos; o log
 * recebe a verdade.**
 *
 * Stack trace, texto de query, nome de restrição e caminho de arquivo
 * são mapa do sistema para quem está sondando. Um 500 que devolve
 * "erro na coluna students.tenant_id" entrega o schema de graça.
 */

interface RespostaErro {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    // ---------------------------------------------------------------
    // Erro de validação — é seguro e útil dizer qual campo falhou.
    // ---------------------------------------------------------------
    if (error instanceof ZodError) {
      const campos = error.issues.map((i) => ({
        campo: i.path.join('.'),
        problema: i.message,
      }));
      request.log.info({ requestId, campos }, 'validação recusou a entrada');
      return reply.status(422).send({
        error: {
          code: 'UNPROCESSABLE',
          message: 'Os dados enviados são inválidos.',
          details: campos,
          requestId,
        },
      } satisfies RespostaErro);
    }

    // ---------------------------------------------------------------
    // Erro de domínio — mensagem já foi escrita por nós.
    // ---------------------------------------------------------------
    if (error instanceof AppError) {
      const nivel = error.statusCode >= 500 ? 'error' : 'warn';
      request.log[nivel](
        {
          requestId,
          code: error.code,
          ...error.logContext,
          actorId: request.principal?.userId,
          tenantId: request.principal?.tenantId,
        },
        error.message,
      );

      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
          requestId,
        },
      } satisfies RespostaErro);
    }

    // ---------------------------------------------------------------
    // Contexto de tenant inválido — nunca deveria acontecer. Se
    // acontecer, é bug nosso e potencialmente uma tentativa de
    // manipulação. Nível de log alto, resposta genérica.
    // ---------------------------------------------------------------
    if (error instanceof TenantContextError) {
      request.log.error({ requestId, err: error }, 'contexto de tenant inválido');
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Requisição inválida.', requestId },
      } satisfies RespostaErro);
    }

    // ---------------------------------------------------------------
    // Erro do PostgreSQL — traduzido sem vazar detalhe interno.
    // ---------------------------------------------------------------
    if (typeof (error as { code?: unknown }).code === 'string' && /^\d{5}$/.test(String(error.code))) {
      const traduzido = fromDatabaseError(error);
      const nivel = traduzido.statusCode >= 500 ? 'error' : 'warn';
      request.log[nivel](
        {
          requestId,
          ...traduzido.logContext,
          actorId: request.principal?.userId,
          tenantId: request.principal?.tenantId,
        },
        'erro do banco de dados',
      );
      return reply.status(traduzido.statusCode).send({
        error: { code: traduzido.code, message: traduzido.message, requestId },
      } satisfies RespostaErro);
    }

    // ---------------------------------------------------------------
    // Erros do próprio Fastify (payload grande demais, JSON malformado).
    // ---------------------------------------------------------------
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      request.log.warn({ requestId, code: error.code }, error.message);
      return reply.status(error.statusCode).send({
        error: {
          code: error.code ?? 'BAD_REQUEST',
          message:
            error.statusCode === 413
              ? 'Arquivo ou requisição grande demais.'
              : 'Requisição inválida.',
          requestId,
        },
      } satisfies RespostaErro);
    }

    // ---------------------------------------------------------------
    // Desconhecido. O log leva tudo; a resposta não leva nada além do
    // requestId, que é o que permite achar este log depois sem que o
    // usuário precise entender o erro.
    // ---------------------------------------------------------------
    request.log.error(
      {
        requestId,
        err: error,
        actorId: request.principal?.userId,
        tenantId: request.principal?.tenantId,
        method: request.method,
        url: request.url,
      },
      'erro não tratado',
    );

    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Erro interno. Se persistir, informe o código abaixo ao suporte.',
        requestId,
      },
    } satisfies RespostaErro);
  });

  // -----------------------------------------------------------------
  // Rota inexistente: 404 com o mesmo formato, sem listar rotas válidas.
  // -----------------------------------------------------------------
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Recurso não encontrado', requestId: request.id },
    } satisfies RespostaErro);
  });
}
