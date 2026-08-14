import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { findStudentById, listStudents } from './students.repository.js';
import { notFound } from '../../http/errors.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';

/**
 * Rotas de alunos.
 *
 * Padrão que toda rota de domínio deve seguir:
 *
 *   1. `preHandler: [app.authorize('permissao')]` — autentica E resolve
 *      o escopo. Sem isto, o handler não recebe principal nem escopo.
 *   2. `requireScope(request)` — recupera o escopo já resolvido. Falha
 *      fechado se a rota esqueceu o passo 1.
 *   3. `inTenant(request, ...)` — abre a transação já com o contexto do
 *      tenant, tirando do handler qualquer chance de pescar o tenant do
 *      lugar errado.
 *   4. Repassar o escopo ao repositório, que não compila sem ele.
 */

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'LEAD']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * UUID validado no schema, não só no banco.
 *
 * Sem isto, um id malformado chega ao PostgreSQL e volta como erro
 * 22P02 — que o handler traduziria em 500. Um 500 distinguível de um
 * 404 é um oráculo: diz ao atacante que o formato estava certo mas o
 * registro não existe, ou vice-versa.
 */
const idParamSchema = z.object({ id: z.string().uuid('Identificador inválido') });

export async function studentsRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/students
   * ---------------------------------------------------------------- */
  app.get(
    '/',
    { preHandler: [app.authorize('student:read')] },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const { rows, total } = await listStudents(client, {
          scope,
          search: query.search,
          status: query.status,
          limit: query.pageSize,
          offset: (query.page - 1) * query.pageSize,
        });

        await writeAudit(client, principal.tenantId, {
          action: 'student.list',
          resourceType: 'student',
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          // Registramos QUANTOS resultados, nunca QUAIS nem o termo
          // buscado — o termo costuma ser o nome de um aluno.
          metadata: { retornados: rows.length, total, pagina: query.page },
        });

        return {
          data: rows.map(apresentar),
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total,
            totalPages: Math.ceil(total / query.pageSize),
          },
        };
      });
    },
  );

  /* ------------------------------------------------------------------
   * GET /api/students/:id
   * ---------------------------------------------------------------- */
  app.get(
    '/:id',
    { preHandler: [app.authorize('student:read')] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        const aluno = await findStudentById(client, scope, id);

        if (aluno === null) {
          /* Em transação PRÓPRIA (auditDenied), não com este `client`.
             O throw logo abaixo dá rollback nesta transação e levaria o
             registro junto — fazendo com que toda tentativa negada
             sumisse e só as bem-sucedidas ficassem. Exatamente o
             inverso do que uma investigação precisa. */
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'student.read',
            resourceType: 'student',
            resourceId: id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
          });
          // 404, nunca 403: um 403 confirmaria que este id existe.
          throw notFound('Aluno');
        }

        await writeAudit(client, principal.tenantId, {
          action: 'student.read',
          resourceType: 'student',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });

        return { data: apresentar(aluno) };
      });
    },
  );
}

/** Converte a linha do banco na forma exposta pela API. */
function apresentar(row: {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  birth_date: string | null;
  status: string;
  photo_path: string | null;
  created_at: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    nome: row.full_name,
    email: row.email,
    telefone: row.phone,
    whatsapp: row.whatsapp,
    dataNascimento: row.birth_date,
    status: row.status,
    foto: row.photo_path,
    criadoEm: row.created_at.toISOString(),
  };
}
