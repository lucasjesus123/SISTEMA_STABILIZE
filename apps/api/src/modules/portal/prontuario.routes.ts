import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { badRequest, notFound, unprocessable } from '../../http/errors.js';
import { apagar, gravar, ler, tipoDeImagem } from '../attachments/storage.js';
import { registrarAnexo } from '../attachments/attachments.repository.js';
import type { AccessScope } from '../../auth/scope.js';

/**
 * O que o ALUNO alcança do próprio prontuário, pelo aplicativo.
 *
 * TRÊS COISAS, E NENHUMA URL LEVA O ID DELE. O id sai do token, sempre.
 * É a mesma regra do resto do portal e o motivo é simples: o que não é
 * parâmetro não é adulterável, e um aluno curioso trocando um uuid na
 * barra do navegador é o atacante mais provável deste sistema.
 *
 *   CARTEIRINHA — nome, código e foto. É o que ele mostra na catraca.
 *   ANAMNESES   — SOMENTE LEITURA. Ele tem direito de ver o que
 *                 escreveram sobre a saúde dele; não tem direito de
 *                 editar, porque anamnese é registro clínico assinado
 *                 por quem atendeu.
 *   EXAMES      — ele ENVIA e vê o que enviou. Não vê o que a academia
 *                 anexou: laudo, avaliação interna e observação clínica
 *                 não são para o paciente descobrir sozinho pelo
 *                 aplicativo, e sim numa consulta.
 */

function alunoDoToken(scope: AccessScope): string {
  if (scope.kind !== 'SELF') throw notFound('Aluno');
  return scope.studentId;
}

const TIPOS_DE_EXAME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const EXAME_MAX_BYTES = 15 * 1024 * 1024;

export async function prontuarioDoAlunoRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/eu/carteirinha
   * ---------------------------------------------------------------- */
  app.get('/carteirinha', { preHandler: [app.authorize('self:read')] }, async (request) => {
    const alunoId = alunoDoToken(requireScope(request));

    return inTenant(request, async (client) => {
      const { rows } = await client.query<{
        nome: string;
        codigo: string | null;
        status: string;
        tem_foto: boolean;
        academia: string;
        desde: string | null;
      }>(
        `SELECT s.full_name AS nome, s.codigo, s.status::text AS status,
                (s.photo_path IS NOT NULL) AS tem_foto,
                t.name AS academia,
                s.started_at::text AS desde
           FROM students s
           JOIN tenants t ON t.id = s.tenant_id
          WHERE s.id = $1`,
        [alunoId],
      );
      const l = rows[0];
      if (l === undefined) throw notFound('Aluno');

      return {
        data: {
          nome: l.nome,
          codigo: l.codigo,
          status: l.status,
          temFoto: l.tem_foto,
          academia: l.academia,
          desde: l.desde,
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * A foto do próprio aluno: ler e trocar
   *
   * ELE TROCA A PRÓPRIA FOTO porque a academia pediu que a foto fosse
   * obrigatória no aplicativo — e obrigar sem dar como cumprir seria
   * uma parede. O que ele NÃO faz é apagar: uma carteirinha sem foto é
   * exatamente o que a exigência existe para impedir.
   * ---------------------------------------------------------------- */
  app.get('/foto', { preHandler: [app.authorize('self:read')] }, async (request, reply) => {
    const alunoId = alunoDoToken(requireScope(request));

    const { chave, tenantId } = await inTenant(request, async (client, principal) => {
      const { rows } = await client.query<{ photo_path: string | null }>(
        'SELECT photo_path FROM students WHERE id = $1',
        [alunoId],
      );
      return { chave: rows[0]?.photo_path ?? null, tenantId: principal.tenantId };
    });
    if (chave === null) throw notFound('Foto');

    const tipo = await tipoDeImagem(tenantId, chave);
    if (tipo === null) throw notFound('Foto');

    void reply.header('Content-Type', tipo);
    void reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(await ler(tenantId, chave));
  });

  app.post('/foto', { preHandler: [app.authorize('self:write')] }, async (request, reply) => {
    const alunoId = alunoDoToken(requireScope(request));

    const parte = await request.file();
    if (parte === undefined) throw badRequest('Nenhuma imagem enviada.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(parte.mimetype)) {
      parte.file.resume();
      throw unprocessable('Envie uma foto JPG, PNG ou WebP.');
    }

    const tenantId = (request.principal?.tenantId ?? '') as string;
    const gravado = await gravar(tenantId, parte.file, parte.mimetype, () => parte.file.truncated);
    if (gravado.tamanhoBytes > 8 * 1024 * 1024) {
      await apagar(tenantId, gravado.chave).catch(() => undefined);
      throw badRequest('Imagem maior que 8 MB. Envie uma menor.');
    }

    return inTenant(request, async (client, principal) => {
      const { rows } = await client.query<{ photo_path: string | null }>(
        'SELECT photo_path FROM students WHERE id = $1',
        [alunoId],
      );
      const anterior = rows[0]?.photo_path ?? null;

      await client.query('UPDATE students SET photo_path = $2 WHERE id = $1', [
        alunoId,
        gravado.chave,
      ]);
      /* A foto trocada sai do disco. Sem isto, cada troca deixa a
         anterior guardada e cifrada para sempre. */
      if (anterior !== null) await apagar(tenantId, anterior).catch(() => undefined);

      await writeAudit(client, principal.tenantId, {
        action: 'profile.photo',
        resourceType: 'student',
        resourceId: alunoId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { peloAplicativo: true },
      });

      void reply.status(201);
      return { ok: true };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/eu/anamneses — leitura, e só
   * ---------------------------------------------------------------- */
  app.get('/anamneses', { preHandler: [app.authorize('self:read')] }, async (request) => {
    const alunoId = alunoDoToken(requireScope(request));

    return inTenant(request, async (client, principal) => {
      const { rows } = await client.query<{
        id: string;
        respostas: unknown;
        criado_em: Date;
        profissional: string | null;
      }>(
        `SELECT a.id, a.answers AS respostas, a.created_at AS criado_em,
                u.full_name AS profissional
           FROM anamneses a
           LEFT JOIN users u ON u.id = a.created_by
          WHERE a.student_id = $1
          ORDER BY a.created_at DESC
          LIMIT 20`,
        [alunoId],
      );

      /* LEITURA DE PRONTUÁRIO PELO PRÓPRIO PACIENTE TAMBÉM É AUDITADA.
         Não é desconfiança dele: é que o log precisa explicar todo
         acesso ao dado clínico, e um acesso sem registro vira o buraco
         por onde qualquer investigação passa. */
      await writeAudit(client, principal.tenantId, {
        action: 'anamnesis.read',
        resourceType: 'anamnesis',
        resourceId: alunoId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { peloAplicativo: true, versoes: rows.length },
      });

      return {
        data: rows.map((r) => ({
          id: r.id,
          respostas: r.respostas,
          criadoEm: r.criado_em.toISOString(),
          profissional: r.profissional,
        })),
      };
    });
  });

  /* ------------------------------------------------------------------
   * Exames que o próprio aluno envia
   * ---------------------------------------------------------------- */
  app.get('/exames', { preHandler: [app.authorize('self:read')] }, async (request) => {
    const alunoId = alunoDoToken(requireScope(request));

    return inTenant(request, async (client) => {
      const { rows } = await client.query<{
        id: string;
        original_name: string;
        mime_type: string;
        size_bytes: string;
        description: string | null;
        document_date: string | null;
        created_at: Date;
      }>(
        /* SÓ O QUE ELE MESMO ENVIOU. Laudo, avaliação interna e
           observação clínica não são para o paciente descobrir sozinho
           pelo aplicativo — são para uma consulta, com alguém do lado
           para explicar. */
        `SELECT id, original_name, mime_type, size_bytes, description,
                document_date::text AS document_date, created_at
           FROM attachments
          WHERE student_id = $1 AND deleted_at IS NULL AND enviado_pelo_aluno
          ORDER BY COALESCE(document_date, created_at::date) DESC
          LIMIT 100`,
        [alunoId],
      );

      return {
        data: rows.map((r) => ({
          id: r.id,
          nome: r.original_name,
          tipo: r.mime_type,
          tamanhoBytes: Number(r.size_bytes),
          descricao: r.description,
          dataDoDocumento: r.document_date,
          criadoEm: r.created_at.toISOString(),
        })),
      };
    });
  });

  app.post('/exames', { preHandler: [app.authorize('self:write')] }, async (request, reply) => {
    const alunoId = alunoDoToken(requireScope(request));

    const parte = await request.file();
    if (parte === undefined) throw badRequest('Nenhum arquivo enviado.');
    if (!TIPOS_DE_EXAME.has(parte.mimetype)) {
      parte.file.resume();
      throw unprocessable('Envie um PDF ou uma foto (JPG, PNG ou WebP).');
    }

    /* A descrição vem no mesmo multipart, como campo de texto. */
    const descricao =
      typeof parte.fields['descricao'] === 'object' &&
      parte.fields['descricao'] !== null &&
      'value' in parte.fields['descricao']
        ? String((parte.fields['descricao'] as { value: unknown }).value).slice(0, 300)
        : null;

    const tenantId = (request.principal?.tenantId ?? '') as string;
    const gravado = await gravar(tenantId, parte.file, parte.mimetype, () => parte.file.truncated);
    if (gravado.tamanhoBytes > EXAME_MAX_BYTES) {
      await apagar(tenantId, gravado.chave).catch(() => undefined);
      throw badRequest(
        `Arquivo maior que ${Math.floor(EXAME_MAX_BYTES / 1024 / 1024)} MB. Envie um menor.`,
      );
    }

    return inTenant(request, async (client, principal) => {
      const criado = await registrarAnexo(
        client,
        requireScope(request),
        principal.tenantId,
        alunoId,
        principal.userId,
        {
          chave: gravado.chave,
          nomeOriginal: parte.filename,
          tipo: parte.mimetype,
          tamanhoBytes: gravado.tamanhoBytes,
          checksum: gravado.checksum,
          categoria: 'Exame',
          ...(descricao !== null ? { descricao } : {}),
        },
      );
      if (criado === null) {
        /* O escopo recusou. O arquivo já foi para o disco — apagar aqui
           é o que impede o armazenamento de acumular órfãos. */
        await apagar(tenantId, gravado.chave).catch(() => undefined);
        throw notFound('Aluno');
      }

      /* A MARCA DE "VEIO DO ALUNO" é o que permite ao prontuário
         distinguir, na leitura, o que a academia anexou do que o
         paciente mandou — sem cruzar o id com a tabela de usuários. */
      await client.query('UPDATE attachments SET enviado_pelo_aluno = true WHERE id = $1', [
        criado.id,
      ]);

      await writeAudit(client, principal.tenantId, {
        action: 'attachment.upload',
        resourceType: 'attachment',
        resourceId: criado.id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { peloAplicativo: true, alunoId },
      });

      void reply.status(201);
      return { data: { id: criado.id } };
    });
  });
}
