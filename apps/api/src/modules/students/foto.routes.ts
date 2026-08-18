import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';
import { badRequest, notFound, unauthorized, unprocessable } from '../../http/errors.js';
import { apagar, existe, gravar, ler, tipoDeImagem } from '../attachments/storage.js';
import { assertStudentInScope } from './students.repository.js';
import type { TenantClient } from '../../db/pool.js';

/**
 * A foto do aluno, gerenciada por quem atende.
 *
 * Separada de `attachments.routes.ts` de propósito, apesar de guardar os
 * bytes no mesmo lugar. Um anexo é um DOCUMENTO do prontuário: tem
 * categoria, descrição, histórico, e a lista inteira é auditada porque
 * saber que existe um laudo já é informação sobre a pessoa. A foto é um
 * ATRIBUTO do cadastro: existe uma, some quando trocada, e aparece na
 * lista de alunos ao lado do nome.
 *
 * Misturar as duas faria a foto entrar na lista de exames e o exame
 * virar candidato a avatar. Cada uma na sua rota.
 *
 * O ESCOPO CONTINUA VALENDO: `assertStudentInScope` antes de qualquer
 * coisa. Um profissional só troca a foto dos alunos vinculados a ele —
 * a mesma regra que vale para ler a ficha.
 */

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });

const TIPOS_DE_FOTO = new Set(['image/jpeg', 'image/png', 'image/webp']);
const FOTO_MAX_BYTES = 8 * 1024 * 1024;

export async function fotoAlunoRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * POST /api/students/:id/foto   (multipart)
   * ---------------------------------------------------------------- */
  app.post('/:id/foto', { preHandler: [app.authorize('student:write')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    const parte = await request.file();
    if (parte === undefined) throw badRequest('Nenhuma imagem enviada.');

    if (!TIPOS_DE_FOTO.has(parte.mimetype)) {
      parte.file.resume();
      throw unprocessable('Envie uma imagem JPG, PNG ou WebP.');
    }

    const gravado = await gravar(
      tenantDe(request),
      parte.file,
      parte.mimetype,
      () => parte.file.truncated,
    );

    if (gravado.tamanhoBytes > FOTO_MAX_BYTES) {
      await apagar(tenantDe(request), gravado.chave).catch(() => undefined);
      throw badRequest(
        `Imagem maior que ${Math.floor(FOTO_MAX_BYTES / 1024 / 1024)} MB. Envie uma menor.`,
      );
    }

    try {
      return await inTenant(request, async (client, principal) => {
        if (!(await assertStudentInScope(client, scope, id))) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'student.update',
            resourceType: 'student',
            resourceId: id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Aluno');
        }

        const anterior = await chaveDaFotoDoAluno(client, id);
        await client.query('UPDATE students SET photo_path = $2 WHERE id = $1', [
          id,
          gravado.chave,
        ]);
        /* Se o aluno tem conta no aplicativo, a foto é a mesma pessoa e
           passa a ser a mesma imagem nos dois lugares. Manter duas seria
           garantir que uma fica velha. */
        await client.query(
          'UPDATE users SET avatar_path = $2 WHERE id = (SELECT user_id FROM students WHERE id = $1)',
          [id, gravado.chave],
        );

        await writeAudit(client, principal.tenantId, {
          action: 'student.update',
          resourceType: 'student',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { foto: true, bytes: gravado.tamanhoBytes },
        });

        if (anterior !== null && anterior !== gravado.chave) {
          void apagar(tenantDe(request), anterior).catch(() => undefined);
        }

        void reply.status(201);
        return { data: { ok: true } };
      });
    } catch (erro) {
      await apagar(tenantDe(request), gravado.chave).catch(() => undefined);
      throw erro;
    }
  });

  /* ------------------------------------------------------------------
   * GET /api/students/:id/foto
   *
   * Serve a imagem com o tipo lido dos bytes. Ver o comentário longo em
   * `perfil.routes.ts`: `inline` só é seguro porque a lista de formatos
   * é de imagem raster, a assinatura é conferida na gravação e a
   * resposta leva `nosniff` mais CSP que proíbe execução.
   * ---------------------------------------------------------------- */
  app.get('/:id/foto', { preHandler: [app.authorize('student:read')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    const chave = await inTenant(request, async (client, principal) => {
      if (!(await assertStudentInScope(client, scope, id))) {
        await auditDenied(principal.tenantId, principal.userId, {
          action: 'student.read',
          resourceType: 'student',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });
        throw notFound('Aluno');
      }
      return chaveDaFotoDoAluno(client, id);
    });

    if (chave === null) throw notFound('Foto');
    if (!(await existe(tenantDe(request), chave))) throw notFound('Foto');

    const tipo = await tipoDeImagem(tenantDe(request), chave);
    if (tipo === null) {
      request.log.error({ aluno: id }, 'foto de aluno não é imagem válida');
      throw notFound('Foto');
    }

    void reply
      .header('Content-Type', tipo)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store');

    return reply.send(ler(tenantDe(request), chave));
  });

  /* ------------------------------------------------------------------
   * DELETE /api/students/:id/foto
   * ---------------------------------------------------------------- */
  app.delete('/:id/foto', { preHandler: [app.authorize('student:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    const removida = await inTenant(request, async (client, principal) => {
      if (!(await assertStudentInScope(client, scope, id))) {
        await auditDenied(principal.tenantId, principal.userId, {
          action: 'student.update',
          resourceType: 'student',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });
        throw notFound('Aluno');
      }

      const chave = await chaveDaFotoDoAluno(client, id);
      if (chave === null) return null;

      await client.query('UPDATE students SET photo_path = NULL WHERE id = $1', [id]);
      await client.query(
        'UPDATE users SET avatar_path = NULL WHERE id = (SELECT user_id FROM students WHERE id = $1)',
        [id],
      );

      await writeAudit(client, principal.tenantId, {
        action: 'student.update',
        resourceType: 'student',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { foto: 'removida' },
      });

      return chave;
    });

    if (removida !== null) await apagar(tenantDe(request), removida);
    return { ok: true };
  });
}

/**
 * A chave da foto, já dentro do escopo conferido pelo chamador.
 *
 * Recebe o `client` da transação em curso porque `assertStudentInScope`
 * já rodou nela: repetir a checagem de escopo aqui custaria uma consulta
 * a mais por foto sem acrescentar garantia nenhuma.
 */
async function chaveDaFotoDoAluno(client: TenantClient, id: string): Promise<string | null> {
  const { rows } = await client.query<{ photo_path: string | null }>(
    'SELECT photo_path FROM students WHERE id = $1',
    [id],
  );
  return rows[0]?.photo_path ?? null;
}

function tenantDe(request: FastifyRequest): string {
  const p = request.principal;
  if (p === undefined) throw unauthorized('Autenticação necessária.');
  return p.tenantId;
}
