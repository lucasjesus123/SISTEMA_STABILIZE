import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { inTenant } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { badRequest, conflict, notFound, unauthorized, unprocessable } from '../../http/errors.js';
import { verifyPassword } from '../../auth/password.js';
import { REFRESH_COOKIE, hashRefreshToken } from '../../auth/tokens.js';
import { apagar, existe, gravar, ler, tipoDeImagem } from '../attachments/storage.js';
import {
  chaveDaFoto,
  definirFoto,
  espelharNoAluno,
  gravarPerfil,
  lerPerfil,
} from './perfil.repository.js';

/**
 * O perfil de quem está autenticado.
 *
 * NENHUMA ROTA AQUI RECEBE UM ID. Não é economia de digitação: rota que
 * aceita `/perfil/:id` precisa provar, em toda requisição, que aquele id
 * é o de quem pediu — e é justamente essa prova que costuma faltar num
 * dos caminhos. Sem parâmetro não há o que conferir, e não há como
 * esquecer de conferir. O id vem do token, sempre.
 *
 * Por isso também não há `authorize()` com permissão: não existe papel
 * que possa editar o perfil dos outros por aqui. `authenticate` basta, e
 * o recorte "só a minha linha" mora no repositório.
 */

/* Só imagem, e uma lista fechada. O `storage.ts` aceita PDF e Word
   também — o que faz sentido para um exame anexado ao prontuário e
   nenhum para uma foto de perfil. Cada rota estreita o que precisa. */
const TIPOS_DE_FOTO = new Set(['image/jpeg', 'image/png', 'image/webp']);

/* Teto próprio, bem abaixo do limite geral de upload. Uma foto de perfil
   de 15 MB não melhora nada e é servida em toda tela que mostra a
   pessoa. O celular moderno produz JPEG de 3 a 8 MB; 8 MB dá folga sem
   virar desperdício. */
const FOTO_MAX_BYTES = 8 * 1024 * 1024;

/* Texto opcional que chega vazio da tela é AUSENTE, não inválido.
   Um `<input>` não preenchido manda `""`, e um `.nullable()` cru
   guardaria string vazia no banco — que depois aparece como telefone em
   branco em vez de "—". */
const texto = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const perfilSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome completo.').max(160),
  telefone: texto(40),
  /* O mesmo formato que o banco exige em `students`. Validar aqui
     devolve "WhatsApp inválido" no campo certo da tela; deixar só para o
     CHECK devolveria um 500 genérico vindo do driver. */
  whatsapp: z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{7,14}$/, 'Use o formato internacional: +5531988887777.')
    .or(z.literal(''))
    .nullable()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  dataNascimento: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
    .or(z.literal(''))
    .nullable()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  cep: texto(12),
  logradouro: texto(160),
  numero: texto(20),
  complemento: texto(80),
  bairro: texto(80),
  cidade: texto(80),
  uf: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'UF com duas letras.')
    .or(z.literal(''))
    .nullable()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
});

const emailSchema = z.object({
  /* Sem mínimo de tamanho: aqui a senha não está sendo criada, está
     sendo conferida. Uma regra de comprimento nesta ponta só contaria a
     quem chuta quantos caracteres a senha certa tem. */
  senhaAtual: z.string().min(1, 'Informe sua senha atual.').max(128),
  email: z.string().trim().toLowerCase().email('E-mail inválido.').max(160),
});

export async function perfilRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/perfil
   * ---------------------------------------------------------------- */
  app.get('/', { preHandler: [app.authenticate] }, async (request) =>
    inTenant(request, async (client, principal) => {
      const perfil = await lerPerfil(client, principal.userId);
      /* A conta existe (o token foi verificado) mas a linha sumiu:
         desativada e removida entre a emissão do token e agora. */
      if (perfil === null) throw notFound('Perfil');
      return { data: perfil };
    }),
  );

  /* ------------------------------------------------------------------
   * PUT /api/perfil
   * ---------------------------------------------------------------- */
  app.put('/', { preHandler: [app.authenticate] }, async (request) => {
    const dados = perfilSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      const perfil = await gravarPerfil(client, principal.userId, dados);
      if (perfil === null) throw notFound('Perfil');

      /* O aluno mantém uma ficha na academia além da conta de acesso, e
         é pela ficha que a recepção liga para ele. Ver o comentário em
         `espelharNoAluno`. */
      if (principal.role === 'STUDENT') {
        await espelharNoAluno(client, principal.userId, dados);
      }

      await writeAudit(client, principal.tenantId, {
        action: 'profile.update',
        resourceType: 'user',
        resourceId: principal.userId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        /* O QUE mudou, nunca o VALOR novo. Saber que o WhatsApp foi
           trocado é o que serve numa investigação; guardar o número
           antigo e o novo no log seria espalhar dado pessoal por uma
           tabela que ninguém pensa em limpar. */
        metadata: {
          campos: Object.entries(dados)
            .filter(([, v]) => v !== null)
            .map(([k]) => k),
        },
      });

      return { data: perfil };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/perfil/email
   *
   * Trocar o PRÓPRIO e-mail de acesso.
   *
   * Até aqui isto era operação de administração, e a tela de perfil
   * mostrava o e-mail em cinza. Funcionava enquanto toda academia tinha
   * alguém por perto para pedir; para um profissional que trocou de
   * endereço, virava um chamado.
   *
   * A SENHA ATUAL É O QUE TORNA ISTO SEGURO. O e-mail é a identidade do
   * login: quem o troca decide por onde a conta entra daqui para a
   * frente. Sem a senha, uma sessão esquecida aberta num computador da
   * recepção bastaria para mudar o endereço e trancar o dono para fora
   * da própria conta — de forma permanente, porque a recuperação também
   * passa pelo e-mail.
   *
   * E AS OUTRAS SESSÕES CAEM. Esta continua de pé, que é o normal para
   * quem acabou de digitar a própria senha; as demais não, porque se o
   * motivo da troca for justamente uma sessão alheia aberta, deixá-la
   * viva não resolve nada.
   * ---------------------------------------------------------------- */
  app.post(
    '/email',
    {
      preHandler: [app.authenticate],
      /* Teto porque a rota confere senha, e rota que confere senha sem
         limite é um oráculo de senha.

         DEZ E NÃO CINCO, e a razão é o cliente: um 401 daqui é
         indistinguível, para o navegador, de um token vencido — então o
         `api()` da tela renova a sessão e REPETE a chamada. Cada erro de
         digitação gasta duas fichas. Com cinco, quem errasse a senha
         duas vezes ficava quinze minutos sem poder trocar o próprio
         e-mail; com dez, o limite ainda vale para cinco tentativas de
         verdade, que é o que ele sempre quis dizer. */
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request) => {
      const { senhaAtual, email } = emailSchema.parse(request.body);

      return inTenant(request, async (client, principal) => {
        const { rows } = await client.query<{ password_hash: string; email: string }>(
          'SELECT password_hash, email FROM users WHERE id = $1',
          [principal.userId],
        );
        const eu = rows[0];
        if (eu === undefined) throw notFound('Perfil');

        if (!(await verifyPassword(eu.password_hash, senhaAtual))) {
          throw unauthorized('Senha incorreta.');
        }
        if (eu.email.toLowerCase() === email) {
          throw badRequest('Este já é o seu e-mail.');
        }

        try {
          await client.query('UPDATE users SET email = $1 WHERE id = $2', [
            email,
            principal.userId,
          ]);
        } catch (erro) {
          /* 23505: o índice único é por academia, e a mensagem precisa
             dizer isso — "e-mail já cadastrado" faz procurar no mundo
             inteiro por uma colisão que é da porta ao lado. */
          if ((erro as { code?: string }).code === '23505') {
            throw conflict('Já existe uma conta com este e-mail nesta academia.');
          }
          throw erro;
        }

        const apresentado = request.cookies[REFRESH_COOKIE];
        await client.query(
          `UPDATE user_sessions
              SET revoked_at = now(), revoked_reason = 'e-mail alterado'
            WHERE user_id = $1
              AND revoked_at IS NULL
              AND family_id IS DISTINCT FROM (
                    SELECT family_id FROM user_sessions
                     WHERE token_hash = $2 AND user_id = $1)`,
          [principal.userId, apresentado === undefined ? '' : hashRefreshToken(apresentado)],
        );

        await writeAudit(client, principal.tenantId, {
          action: 'profile.email_changed',
          resourceType: 'user',
          resourceId: principal.userId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          /* O e-mail NOVO fica; o antigo não. Quem lê a auditoria precisa
             saber por onde a conta entra agora — guardar os dois seria
             copiar dado pessoal para uma tabela que ninguém limpa. */
          metadata: { email },
        });

        return { data: { email } };
      });
    },
  );

  /* ------------------------------------------------------------------
   * POST /api/perfil/foto   (multipart)
   * ---------------------------------------------------------------- */
  app.post('/foto', { preHandler: [app.authenticate] }, async (request, reply) => {
    const parte = await request.file();
    if (parte === undefined) throw badRequest('Nenhuma imagem enviada.');

    if (!TIPOS_DE_FOTO.has(parte.mimetype)) {
      /* O fluxo precisa ser drenado antes de responder: sem isso o
         cliente continua enviando bytes num socket que já se decidiu, e
         alguns navegadores mostram "conexão perdida" no lugar da
         mensagem de erro. */
      parte.file.resume();
      throw unprocessable('Envie uma imagem JPG, PNG ou WebP.');
    }

    /* Escreve fora da transação: segurar uma conexão do pool pelo tempo
       de um upload é o caminho para o pool acabar. Mesmo raciocínio dos
       anexos do prontuário. */
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
        const anterior = await chaveDaFoto(client, principal.userId);
        await definirFoto(client, principal.userId, gravado.chave);

        await writeAudit(client, principal.tenantId, {
          action: 'profile.photo',
          resourceType: 'user',
          resourceId: principal.userId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { bytes: gravado.tamanhoBytes, tipo: parte.mimetype },
        });

        /* Os bytes da foto antiga só somem DEPOIS do commit. Na ordem
           inversa, uma transação que falhasse no fim deixaria a linha
           apontando para um arquivo já apagado — e a pessoa sem foto
           nenhuma. */
        if (anterior !== null && anterior !== gravado.chave) {
          void apagar(tenantDe(request), anterior).catch(() => undefined);
        }

        void reply.status(201);
        return { data: { ok: true } };
      });
    } catch (erro) {
      /* Registro no banco falhou: os bytes viram órfãos, alcançáveis por
         ninguém e conhecidos de ninguém. */
      await apagar(tenantDe(request), gravado.chave).catch(() => undefined);
      throw erro;
    }
  });

  /* ------------------------------------------------------------------
   * GET /api/perfil/foto
   *
   * Vai como `inline`, e não como anexo — ao contrário do download de
   * prontuário. A diferença é segura aqui por três motivos que precisam
   * valer TODOS: a lista de tipos aceitos é só de imagem raster (nada de
   * SVG, que é XML com script dentro), o `storage.gravar` confere os
   * primeiros bytes contra a assinatura do formato declarado, e a
   * resposta leva `nosniff` mais uma CSP que proíbe qualquer execução
   * caso um arquivo escape das duas conferências anteriores.
   * ---------------------------------------------------------------- */
  app.get('/foto', { preHandler: [app.authenticate] }, async (request, reply) => {
    const chave = await inTenant(request, (client, principal) =>
      chaveDaFoto(client, principal.userId),
    );
    if (chave === null) throw notFound('Foto');

    if (!(await existe(tenantDe(request), chave))) {
      request.log.error({ tenantId: tenantDe(request) }, 'foto de perfil ausente em disco');
      throw notFound('Foto');
    }

    /* O tipo sai dos bytes do arquivo, não de uma coluna e não do que o
       cliente declarou no upload. Se não é imagem reconhecível, não é
       servida — em vez de sair como octet-stream e virar um `<img>`
       quebrado que ninguém sabe explicar. */
    const tipo = await tipoDeImagem(tenantDe(request), chave);
    if (tipo === null) {
      request.log.error({ tenantId: tenantDe(request) }, 'foto de perfil não é imagem válida');
      throw notFound('Foto');
    }

    void reply
      .header('Content-Type', tipo)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      /* `private`: é a foto de uma pessoa, não passa por cache de proxy.
         O cliente busca por blob e revoga; não há o que reaproveitar. */
      .header('Cache-Control', 'private, no-store');

    return reply.send(await ler(tenantDe(request), chave));
  });

  /* ------------------------------------------------------------------
   * DELETE /api/perfil/foto
   * ---------------------------------------------------------------- */
  app.delete('/foto', { preHandler: [app.authenticate] }, async (request) => {
    const removida = await inTenant(request, async (client, principal) => {
      const chave = await chaveDaFoto(client, principal.userId);
      if (chave === null) return null;

      await definirFoto(client, principal.userId, null);
      await writeAudit(client, principal.tenantId, {
        action: 'profile.photo',
        resourceType: 'user',
        resourceId: principal.userId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { removida: true },
      });
      return chave;
    });

    if (removida !== null) await apagar(tenantDe(request), removida);
    return { ok: true };
  });
}

/**
 * O tenant de quem está autenticado.
 *
 * O `authenticate` já garantiu que existe, mas a garantia é do
 * preHandler e não do tipo. Falhar fechado aqui custa uma linha e evita
 * que um `!` vire `undefined` no dia em que alguém copiar esta rota sem
 * o preHandler.
 */
function tenantDe(request: FastifyRequest): string {
  const p = request.principal;
  if (p === undefined) throw unauthorized('Autenticação necessária.');
  return p.tenantId;
}
