import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from '../../config/env.js';
import { AppError } from '../errors.js';

/**
 * Cabeçalhos, CORS e limites de requisição.
 *
 * Esta é a camada que responde ao navegador "o que este site pode fazer
 * com esta resposta". Cada cabeçalho abaixo desliga uma classe de ataque.
 */
export async function registerSecurity(app: FastifyInstance): Promise<void> {
  const config = env();

  await app.register(helmet, {
    /* A API devolve JSON, não HTML. Uma CSP que proíbe absolutamente
       tudo é a correta aqui: se um endpoint algum dia devolver HTML por
       engano — mensagem de erro, upload refletido — nada dentro dele
       executa. */
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'none'"],
        imgSrc: ["'none'"],
        connectSrc: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
      },
    },

    /* HSTS: o navegador passa a recusar HTTP para este domínio, o que
       fecha a janela do primeiro request em texto claro numa rede
       hostil. Dois anos e includeSubDomains são os valores exigidos
       para entrar na lista de pré-carregamento dos navegadores. */
    hsts: config.NODE_ENV === 'production'
      ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
      : false,

    // Impede que a API seja embutida em iframe (clickjacking).
    frameguard: { action: 'deny' },

    // Impede o navegador de "adivinhar" o tipo do conteúdo. Sem isto,
    // um anexo enviado por um aluno pode ser interpretado como HTML e
    // executar script no domínio da aplicação.
    noSniff: true,

    // Não vazar a URL da aplicação (que contém ids) para sites externos.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

    // Esconde o cabeçalho X-Powered-By.
    hidePoweredBy: true,

    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
  });

  /* Permissions-Policy não é coberto pelo helmet. A API não precisa de
     câmera, microfone nem geolocalização; desligar é higiene. */
  app.addHook('onSend', async (_req, reply) => {
    void reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    );
  });

  /* ------------------------------------------------------------------
   * CORS
   *
   * Lista explícita. Nunca `origin: true`, que reflete a origem de quem
   * pediu — combinado com credenciais, isso permite que qualquer site
   * leia respostas autenticadas da API em nome do usuário logado.
   * A validação de configuração já recusa "*" em produção.
   * ---------------------------------------------------------------- */
  const permitidas = new Set(config.CORS_ORIGINS);

  await app.register(cors, {
    origin(origin, callback) {
      // Requisição sem Origin (curl, app nativo, mesma origem) passa —
      // CORS protege o navegador, e sem Origin não há navegador
      // aplicando a política.
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      if (permitidas.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new AppError('FORBIDDEN', 'Origem não autorizada.'), false);
    },
    credentials: true, // necessário para o cookie do refresh token
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  /* ------------------------------------------------------------------
   * Limite de requisições
   *
   * O limite global protege contra abuso genérico. O limite do login é
   * muito mais apertado e está declarado na própria rota — força bruta
   * de senha é o ataque que mais importa aqui.
   *
   * A chave inclui o tenant quando há sessão: senão, um tenant
   * barulhento consumiria a cota de todos que compartilham o IP de saída.
   * ---------------------------------------------------------------- */
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_PER_MIN,
    timeWindow: '1 minute',
    keyGenerator(request) {
      const principal = request.principal;
      if (principal !== undefined) {
        return `u:${principal.tenantId}:${principal.userId}`;
      }
      return `ip:${request.ip}`;
    },
    /* O plugin LANÇA o que este builder devolver (index.js:333), e não o
       envia como corpo. Devolver um objeto simples faz o handler de erro
       tratá-lo como falha desconhecida e responder 500 — o cliente não
       distingue "diminua o ritmo" de "servidor quebrado", e o
       monitoramento passa a contar excesso de requisições como erro
       interno. Devolvendo AppError, o statusCode 429 e a mensagem
       atravessam o handler corretamente. */
    errorResponseBuilder(_request, context) {
      const segundos = Math.ceil(context.ttl / 1000);
      return new AppError(
        'RATE_LIMITED',
        `Muitas requisições. Tente novamente em ${segundos} segundo${segundos === 1 ? '' : 's'}.`,
        { logContext: { limite: context.max, janelaMs: context.ttl } },
      );
    },
  });
}
