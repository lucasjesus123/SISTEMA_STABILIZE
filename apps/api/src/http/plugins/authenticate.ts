import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '@stabilize/shared';
import { verifyAccessToken } from '../../auth/tokens.js';
import { resolveScope, type AccessScope, type Principal } from '../../auth/scope.js';
import { forbidden, unauthorized } from '../errors.js';
import { withTenant, type TenantClient } from '../../db/pool.js';
import { writeAudit } from '../../audit/audit.js';

/**
 * Autenticação e autorização no ciclo do request.
 *
 * O desenho persegue uma propriedade: **é impossível criar uma rota
 * desprotegida por esquecimento**.
 *
 * Não existe hook global que autentique "todas as rotas menos algumas" —
 * essa forma erra sempre no mesmo lugar, porque a lista de exceções
 * cresce e alguém acaba adicionando uma rota nova sem perceber que ela
 * caiu na lista errada. Aqui é o contrário: a rota declara a permissão
 * que exige, e uma rota que não declara nada simplesmente não tem acesso
 * a dado — não recebe `principal` nem cliente de banco.
 */

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
  interface FastifyInstance {
    /** Exige sessão válida. Popula `request.principal`. */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** Exige sessão + permissão. Devolve o escopo já resolvido. */
    authorize(
      permission: Permission,
    ): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** Escopo resolvido pela permissão declarada na rota. */
    accessScope?: AccessScope;
  }
}

function extrairBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const [esquema, valor, ...resto] = header.split(' ');
  // Rejeita "Bearer a b" — token com espaço é malformado, não é para ser
  // "consertado" pegando só o primeiro pedaço.
  if (resto.length > 0) return null;
  if (esquema?.toLowerCase() !== 'bearer') return null;
  if (valor === undefined || valor.length === 0) return null;
  return valor;
}

async function authenticate(request: FastifyRequest): Promise<void> {
  const token = extrairBearer(request.headers.authorization);
  if (token === null) {
    throw unauthorized('Autenticação necessária.');
  }

  const claims = await verifyAccessToken(token);

  request.principal = {
    userId: claims.sub,
    tenantId: claims.tid,
    role: claims.role,
    studentId: claims.sid,
  };
}

const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('principal', undefined);
  app.decorateRequest('accessScope', undefined);

  app.decorate('authenticate', async (request: FastifyRequest) => {
    await authenticate(request);
  });

  app.decorate('authorize', (permission: Permission) => {
    return async (request: FastifyRequest): Promise<void> => {
      await authenticate(request);

      const principal = request.principal;
      /* istanbul ignore next — authenticate lança se não popular */
      if (principal === undefined) throw unauthorized();

      try {
        request.accessScope = resolveScope(principal, permission);
      } catch (error) {
        /* Toda negação de autorização vira registro de auditoria, em
           transação PRÓPRIA. É o rastro que permite responder depois
           "alguém andou tentando abrir o que não devia?" — e por isso
           precisa sobreviver ao rollback da requisição que falhou. */
        await withTenant({ tenantId: principal.tenantId, userId: principal.userId }, (c) =>
          writeAudit(c, principal.tenantId, {
            action: 'access.denied',
            resourceType: 'permission',
            resourceId: permission,
            outcome: 'DENIED',
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
            metadata: { method: request.method, url: request.url },
          }),
        ).catch(() => {
          /* Falha ao auditar não pode transformar um 403 correto em 500:
             o usuário continua sem acesso, que é o essencial. O erro de
             gravação aparece no log do processo. */
          request.log.error('falha ao registrar negativa de acesso na auditoria');
        });

        throw error;
      }
    };
  });
});

export default authPlugin;

/**
 * Abre a transação já no contexto do tenant do request.
 *
 * Açúcar sobre `withTenant()`, mas com um efeito importante: os handlers
 * não precisam pescar `tenantId` de lugar nenhum — e portanto não têm
 * como pescá-lo do lugar errado, como o corpo da requisição.
 */
export async function inTenant<T>(
  request: FastifyRequest,
  fn: (client: TenantClient, principal: Principal) => Promise<T>,
): Promise<T> {
  const principal = request.principal;
  if (principal === undefined) {
    throw unauthorized('Autenticação necessária.');
  }
  return withTenant({ tenantId: principal.tenantId, userId: principal.userId }, (client) =>
    fn(client, principal),
  );
}

/** Recupera o escopo resolvido; lança se a rota esqueceu de declarar. */
export function requireScope(request: FastifyRequest): AccessScope {
  const scope = request.accessScope;
  if (scope === undefined) {
    /* Rota que chama isto sem ter declarado `authorize()` está mal
       construída. Falhar fechado (403) é o único comportamento seguro:
       assumir 'ALL' entregaria a empresa inteira por causa de um
       preHandler esquecido. */
    throw forbidden('Rota sem escopo declarado.');
  }
  return scope;
}
