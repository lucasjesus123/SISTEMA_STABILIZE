import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { permissionsOf, ROLE_LABELS } from '@stabilize/shared';
import { REFRESH_COOKIE, refreshCookieOptions } from '../../auth/tokens.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/password.js';
import { changePassword, login, logout, refresh } from './auth.service.js';
import { env } from '../../config/env.js';
import { withTenant } from '../../db/pool.js';
import { AppError, unauthorized } from '../../http/errors.js';
import { LoginGuard } from '../../http/login-guard.js';

/**
 * O identificador de quem entra: e-mail OU CPF.
 *
 * O ALUNO ENTRA PELO CPF. Foi o pedido da academia, e é a decisão certa:
 * um aluno de musculação não tem e-mail cadastrado com frequência, mas
 * todo mundo sabe o próprio CPF de cor. Os dois convivem na mesma coluna
 * porque o que ela guarda é o LOGIN, não um endereço — e nunca houve
 * restrição de formato ali.
 *
 * A pontuação é descartada: quem digita 123.456.789-09 e quem digita
 * 12345678909 são a mesma pessoa, e obrigá-la a lembrar como digitou no
 * cadastro seria uma senha a mais.
 */
const identificadorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(160)
  .transform((v) => (/^[\d.\-\s]+$/.test(v) ? v.replace(/\D/g, '') : v))
  .refine((v) => /^\d{11}$/.test(v) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
    message: 'Informe um e-mail válido ou o CPF.',
  });

const loginSchema = z.object({
  email: identificadorSchema,
  password: z.string().min(1, 'Informe a senha').max(PASSWORD_MAX_LENGTH),
  tenantSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Identificador de empresa inválido')
    .optional(),
});

/**
 * Senha forte, medida por comprimento e não por "um maiúsculo, um
 * símbolo".
 *
 * As regras de composição empurram para `Senha@123`, que é previsível.
 * Comprimento é o fator que realmente aumenta o custo de um ataque, e é
 * a recomendação atual do NIST (SP 800-63B). A única regra de conteúdo
 * é recusar senha de uma só repetição.
 */
const senhaForte = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A senha precisa de pelo menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(PASSWORD_MAX_LENGTH, `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres`)
  .refine((v) => new Set(v).size >= 4, {
    message: 'A senha é repetitiva demais. Use uma frase que só você lembre.',
  });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: senhaForte,
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const config = env();

  /* Segundo anel: conta tentativas por IP somando TODOS os e-mails.
     O limite da rota (por IP + e-mail) não enxerga pulverização de
     senha — testar uma senha comum em cinquenta contas estreia
     cinquenta baldes vazios. Ver login-guard.ts. */
  const guardaIp = new LoginGuard({
    maxPorJanela: config.RATE_LIMIT_LOGIN_PER_15MIN * 3,
    janelaMs: 15 * 60 * 1000,
  });

  /* ------------------------------------------------------------------
   * POST /api/auth/login
   *
   * Limite muito mais apertado que o global: força bruta de senha é o
   * ataque que mais importa aqui. A chave é IP + e-mail, para que
   * tentar mil senhas num e-mail não consuma a cota de quem
   * compartilha o mesmo IP de saída — e vice-versa.
   *
   * `hook: 'preHandler'` é essencial e não é detalhe. O rate limit roda
   * em `onRequest` por padrão, ANTES do corpo ser parseado — ali
   * `request.body` é undefined, o e-mail sai como "sem-email" e todos
   * os logins caem num único balde por IP. O efeito prático seria um
   * atacante mirando UMA conta trancar a academia inteira que
   * compartilha o mesmo IP de saída. Em `preHandler` o corpo já existe.
   * ---------------------------------------------------------------- */
  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: config.RATE_LIMIT_LOGIN_PER_15MIN,
          timeWindow: '15 minutes',
          hook: 'preHandler' as const,
          keyGenerator(request) {
            const body = request.body as { email?: unknown } | undefined;
            const email = typeof body?.email === 'string' ? body.email.toLowerCase().trim() : '';
            return `login:${request.ip}:${email}`;
          },
        },
      },
    },
    async (request, reply) => {
      const limiteIp = guardaIp.registrar(request.ip);
      if (limiteIp.bloqueado) {
        throw new AppError(
          'RATE_LIMITED',
          `Muitas tentativas a partir deste endereço. Tente novamente em ${limiteIp.retryEmSegundos} segundos.`,
          { logContext: { ip: request.ip, motivo: 'pulverizacao-de-senha' } },
        );
      }

      const body = loginSchema.parse(request.body);

      const resultado = await login({
        email: body.email,
        password: body.password,
        tenantSlug: body.tenantSlug,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      // Login válido zera o contador: quem entrou não é o atacante.
      guardaIp.liberar(request.ip);

      /* O refresh vai em cookie HttpOnly — fora do alcance de
         JavaScript, então um XSS não consegue lê-lo. O access token vai
         no corpo e o cliente o mantém em MEMÓRIA, nunca em
         localStorage, que é legível por qualquer script da página. */
      void reply.setCookie(REFRESH_COOKIE, resultado.refresh.token, refreshCookieOptions());

      return {
        accessToken: resultado.accessToken,
        expiresIn: resultado.expiresIn,
        user: {
          id: resultado.user.id,
          name: resultado.user.name,
          role: resultado.user.role,
          roleLabel: ROLE_LABELS[resultado.user.role],
          mustChangePassword: resultado.user.mustChangePassword,
          permissions: permissionsOf(resultado.user.role),
        },
      };
    },
  );

  /* ------------------------------------------------------------------
   * POST /api/auth/refresh
   *
   * Não exige access token — é justamente o endpoint para quando ele
   * expirou. A credencial é o cookie.
   * ---------------------------------------------------------------- */
  app.post(
    '/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE];
      if (token === undefined) {
        throw unauthorized('Sessão não encontrada. Entre novamente.');
      }

      try {
        const resultado = await refresh(token, {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        void reply.setCookie(REFRESH_COOKIE, resultado.refresh.token, refreshCookieOptions());
        return { accessToken: resultado.accessToken, expiresIn: resultado.expiresIn };
      } catch (error) {
        // Sessão inválida: limpa o cookie para o cliente não insistir
        // num token que nunca mais vai funcionar.
        void reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
        throw error;
      }
    },
  );

  /* ------------------------------------------------------------------
   * POST /api/auth/logout
   * ---------------------------------------------------------------- */
  app.post('/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    const principal = request.principal!;
    await logout(request.cookies[REFRESH_COOKIE], principal, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    void reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    return { ok: true };
  });

  /* ------------------------------------------------------------------
   * GET /api/auth/me
   *
   * Devolve as permissões do papel para o front montar o menu. Isto é
   * conveniência de interface, NÃO controle de acesso: esconder um
   * botão não protege nada. A autorização real acontece em cada rota,
   * no servidor.
   * ---------------------------------------------------------------- */
  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const principal = request.principal!;

    /* O NOME vem do banco, não do token.
       Poderia viajar como claim e evitar esta consulta, mas nome muda —
       casamento, correção de digitação — e um claim só se atualiza no
       próximo login. Uma consulta por carregamento de página é barata; a
       pessoa ser chamada pelo nome errado por duas semanas, não. */
    const { rows } = await withTenant(
      { tenantId: principal.tenantId, userId: principal.userId },
      (client) =>
        client.query<{
          full_name: string;
          timezone: string;
          must_change_password: boolean;
          tenant_nome: string;
        }>(
          `SELECT u.full_name, u.must_change_password, t.timezone, t.name AS tenant_nome
             FROM users u JOIN tenants t ON t.id = u.tenant_id
            WHERE u.id = $1`,
          [principal.userId],
        ),
    );

    return {
      id: principal.userId,
      name: rows[0]?.full_name ?? '',
      role: principal.role,
      roleLabel: ROLE_LABELS[principal.role],
      permissions: permissionsOf(principal.role),
      /* O FUSO DA ACADEMIA, e não o do navegador.
         A agenda é validada no servidor contra a janela de atendimento
         convertida para ESTE fuso. Se a tela conferir a mesma coisa no
         fuso de quem está olhando, os dois discordam para qualquer
         pessoa que abra o sistema de fora do país — e a tela promete um
         horário que o servidor recusa. */
      timezone: rows[0]?.timezone ?? 'America/Sao_Paulo',
      /* A TROCA OBRIGATÓRIA VEM DO `/me`, e não só da resposta do login.
         A senha inicial de um aluno é o CPF dele, que não é segredo — se
         a exigência só existisse no instante do login, bastaria
         recarregar a página para contorná-la e entrar no prontuário com
         uma senha que meia academia conhece. */
      mustChangePassword: rows[0]?.must_change_password === true,
      /* O NOME DA ACADEMIA. Num SaaS a mesma tela serve dezenas de
         empresas, e quem dá suporte entra em várias no mesmo dia —
         saber em qual está é a primeira coisa, não a última. */
      tenantNome: rows[0]?.tenant_nome ?? '',
      ...(principal.studentId !== undefined ? { studentId: principal.studentId } : {}),
    };
  });

  /* ------------------------------------------------------------------
   * POST /api/auth/change-password
   * ---------------------------------------------------------------- */
  app.post(
    '/change-password',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const body = changePasswordSchema.parse(request.body);
      const principal = request.principal!;

      await changePassword(principal, body.currentPassword, body.newPassword, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      // Todas as sessões caíram, inclusive esta.
      void reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      return { ok: true, message: 'Senha alterada. Entre novamente.' };
    },
  );
}
