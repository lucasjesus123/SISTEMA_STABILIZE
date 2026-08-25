import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { inTenant } from '../../http/plugins/authenticate.js';
import { badRequest, notFound, unauthorized, unprocessable } from '../../http/errors.js';
import { writeAudit } from '../../audit/audit.js';
import { apagar, existe, gravar as gravarArquivo, ler, tipoDeImagem } from '../attachments/storage.js';
import {
  chaveDoLogo,
  definirLogo,
  gravar,
  identidade,
  removerLogo,
} from './academia.repository.js';

/**
 * A identidade da academia.
 *
 * QUEM PODE MEXER: `user:write` — só OWNER e ADMIN, o mesmo nível de
 * conectar o WhatsApp. Não é rigor decorativo: o telefone daqui vai
 * impresso no rodapé de todo relatório que sai da casa, e trocá-lo
 * desvia a ligação do aluno para outro número.
 *
 * QUEM PODE LER: qualquer pessoa autenticada na empresa. O logo aparece
 * na carteirinha do próprio aluno, então prendê-lo a um papel
 * administrativo quebraria o app de quem paga.
 *
 * O LOGO ACEITA MENOS FORMATOS QUE O RESTO DO SISTEMA, e isso é
 * intencional. Exames aceitam WebP; o logo não. O PDFKit embute apenas
 * JPEG e PNG — um logo WebP seria salvo sem reclamação e quebraria o
 * RELATÓRIO depois, longe daqui, com quem subiu o arquivo sem ligar uma
 * coisa à outra. O erro nasce onde é compreensível.
 */

/* 2 MB. Um logo é uma marca, não uma fotografia: o que passa disso é
   quase sempre um PNG exportado sem redimensionar, e ele seria embutido
   em toda página de todo relatório. */
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const TIPOS_DE_LOGO = new Set(['image/png', 'image/jpeg']);

const vazioParaNulo = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

/**
 * O tenant do token, para as operações de disco — que acontecem FORA da
 * transação e por isso não recebem o `principal` do `inTenant`.
 *
 * Copiado de `perfil.routes.ts` e `students/foto.routes.ts`, que têm o
 * mesmo helper. É a terceira cópia, e a hora de extrair para um lugar
 * comum — mas isso tocaria dois arquivos fora do escopo deste item, e
 * fica registrado como follow-up em vez de virar mudança silenciosa.
 *
 * Falha fechado: se o preHandler não correu, o erro é de autenticação e
 * não um `undefined` viajando até virar caminho de disco.
 */
function tenantDe(request: FastifyRequest): string {
  const p = request.principal;
  if (p === undefined) throw unauthorized('Autenticação necessária.');
  return p.tenantId;
}

const identidadeSchema = z.object({
  nome: z.string().trim().min(2, 'O nome da academia é obrigatório').max(120),
  documento: z.string().trim().max(20).optional(),
  telefone: z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{7,14}$/, 'Telefone precisa vir em formato internacional, com o +')
    .nullable()
    .optional(),
  cep: z
    .string()
    .trim()
    .regex(/^[0-9]{8}$/, 'CEP precisa ter 8 dígitos')
    .nullable()
    .optional(),
  logradouro: z.string().trim().max(160).optional(),
  numero: z.string().trim().max(20).optional(),
  complemento: z.string().trim().max(80).optional(),
  bairro: z.string().trim().max(80).optional(),
  cidade: z.string().trim().max(80).optional(),
  uf: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'UF tem duas letras')
    .nullable()
    .optional(),
});

export async function academiaRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/academia
   * ---------------------------------------------------------------- */
  app.get('/', { preHandler: [app.authenticate] }, async (request) => {
    const data = await inTenant(request, (client) => identidade(client));
    return { data };
  });

  /* ------------------------------------------------------------------
   * PUT /api/academia
   * ---------------------------------------------------------------- */
  /* `tenant:settings`, E NÃO `user:write`. A identidade da academia — nome,
   endereço, telefone do rodapé, logo — não é cadastro de gente, e usar a
   permissão de mexer em usuário aqui tinha uma consequência concreta:
   quem recebe SÓ a área "A academia" ganha `tenant:settings` e não ganha
   `user:write`, então levava 403 em tudo o que essa área existe para
   fazer. A área era inteiramente inútil, e ninguém tinha como saber por
   quê — o menu também a escondia. */
  app.put('/', { preHandler: [app.authorize('tenant:settings')] }, async (request) => {
    const corpo = identidadeSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      const data = await gravar(client, {
        nome: corpo.nome,
        documento: vazioParaNulo(corpo.documento),
        telefone: corpo.telefone ?? null,
        cep: corpo.cep ?? null,
        logradouro: vazioParaNulo(corpo.logradouro),
        numero: vazioParaNulo(corpo.numero),
        complemento: vazioParaNulo(corpo.complemento),
        bairro: vazioParaNulo(corpo.bairro),
        cidade: vazioParaNulo(corpo.cidade),
        uf: corpo.uf === null || corpo.uf === undefined ? null : corpo.uf.toUpperCase(),
      });

      await writeAudit(client, principal.tenantId, {
        action: 'academia.update',
        resourceType: 'tenant',
        resourceId: principal.tenantId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        /* Sem os valores: o que importa na trilha é quem mexeu e quando.
           Guardar o telefone antigo aqui duplicaria dado de contato num
           lugar que ninguém lembra de limpar. */
        metadata: { campos: Object.keys(corpo).length },
      });

      return { data };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/academia/logo   (multipart)
   * ---------------------------------------------------------------- */
  app.post('/logo', { preHandler: [app.authorize('tenant:settings')] }, async (request, reply) => {
    const parte = await request.file();
    if (parte === undefined) throw badRequest('Nenhuma imagem enviada.');

    if (!TIPOS_DE_LOGO.has(parte.mimetype)) {
      /* Drenar antes de responder: sem isso o cliente segue enviando
         bytes num socket já decidido, e alguns navegadores mostram
         "conexão perdida" no lugar da mensagem. */
      parte.file.resume();
      throw unprocessable(
        'O logo precisa ser PNG ou JPEG. WebP e SVG não entram no PDF do relatório.',
      );
    }

    /* Fora da transação: segurar conexão do pool pelo tempo de um upload
       é como o pool acaba. Mesmo raciocínio dos anexos e da foto. */
    const gravado = await gravarArquivo(
      tenantDe(request),
      parte.file,
      parte.mimetype,
      () => parte.file.truncated,
    );

    if (gravado.tamanhoBytes > LOGO_MAX_BYTES) {
      await apagar(tenantDe(request), gravado.chave).catch(() => undefined);
      throw badRequest(
        `Logo maior que ${Math.floor(LOGO_MAX_BYTES / 1024 / 1024)} MB. Envie uma imagem menor.`,
      );
    }

    try {
      return await inTenant(request, async (client, principal) => {
        /* A chave velha é lida ANTES de gravar a nova — ver o comentário
           de `definirLogo`. */
        const anterior = await chaveDoLogo(client);
        await definirLogo(client, gravado.chave, parte.mimetype);

        await writeAudit(client, principal.tenantId, {
          action: 'academia.logo',
          resourceType: 'tenant',
          resourceId: principal.tenantId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { bytes: gravado.tamanhoBytes, tipo: parte.mimetype },
        });

        /* Os bytes antigos só somem DEPOIS do commit. Na ordem inversa,
           uma transação que falhasse no fim deixaria a linha apontando
           para um arquivo já apagado — e a academia sem logo nenhum. */
        if (anterior !== null && anterior.chave !== gravado.chave) {
          void apagar(tenantDe(request), anterior.chave).catch(() => undefined);
        }

        void reply.status(201);
        return { data: { ok: true } };
      });
    } catch (erro) {
      /* O registro no banco falhou: os bytes viram órfãos, alcançáveis
         por ninguém e conhecidos de ninguém. */
      await apagar(tenantDe(request), gravado.chave).catch(() => undefined);
      throw erro;
    }
  });

  /* ------------------------------------------------------------------
   * GET /api/academia/logo
   *
   * `inline`, como a foto de perfil. É seguro pelos mesmos três motivos,
   * e eles precisam valer TODOS: a lista de tipos é raster apenas (nada
   * de SVG, que é XML com script dentro), o `storage.gravar` confere os
   * primeiros bytes contra o formato declarado, e a resposta leva
   * `nosniff` mais uma CSP que proíbe execução caso um arquivo escape
   * das duas conferências anteriores.
   * ---------------------------------------------------------------- */
  app.get('/logo', { preHandler: [app.authenticate] }, async (request, reply) => {
    /* A chave vem do BANCO, sob RLS, a partir do tenant do token. Nunca
       da URL. É por isso que não existe `/academia/:id/logo`: sem id no
       caminho, não há id para trocar. */
    const logo = await inTenant(request, (client) => chaveDoLogo(client));
    if (logo === null) throw notFound('Logo');

    if (!(await existe(tenantDe(request), logo.chave))) {
      request.log.error({ tenantId: tenantDe(request) }, 'logo da academia ausente em disco');
      throw notFound('Logo');
    }

    const tipo = await tipoDeImagem(tenantDe(request), logo.chave);
    if (tipo === null) throw notFound('Logo');

    void reply
      .type(tipo)
      .header('Cache-Control', 'private, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox");

    return ler(tenantDe(request), logo.chave);
  });

  /* ------------------------------------------------------------------
   * DELETE /api/academia/logo
   * ---------------------------------------------------------------- */
  app.delete('/logo', { preHandler: [app.authorize('tenant:settings')] }, async (request, reply) => {
    const anterior = await inTenant(request, async (client, principal) => {
      const atual = await chaveDoLogo(client);
      if (atual === null) return null;

      await removerLogo(client);
      await writeAudit(client, principal.tenantId, {
        action: 'academia.logo',
        resourceType: 'tenant',
        resourceId: principal.tenantId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { removido: true },
      });
      return atual.chave;
    });

    if (anterior !== null) {
      void apagar(tenantDe(request), anterior).catch(() => undefined);
    }

    void reply.status(204);
    return null;
  });
}
