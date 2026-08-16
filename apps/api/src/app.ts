import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { registerSecurity } from './http/plugins/security.js';
import authPlugin from './http/plugins/authenticate.js';
import { registerErrorHandler } from './http/error-handler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { studentsRoutes } from './modules/students/students.routes.js';
import { recordsRoutes } from './modules/records/records.routes.js';
import { attachmentsRoutes } from './modules/attachments/attachments.routes.js';
import { exercisesRoutes, workoutsRoutes } from './modules/workouts/workouts.routes.js';
import { whatsappRoutes } from './modules/whatsapp/whatsapp.routes.js';
import { reportsRoutes } from './modules/reports/reports.routes.js';
import { registrarAgendador } from './modules/whatsapp/agendador.js';
import multipart from '@fastify/multipart';
import { scheduleRoutes } from './modules/schedule/schedule.routes.js';
import { financeRoutes } from './modules/finance/finance.routes.js';
import { insightsRoutes } from './modules/insights/insights.routes.js';
import { withoutTenantContext } from './db/pool.js';

/**
 * Monta a aplicação.
 *
 * Separado de `server.ts` para que os testes possam levantar a app sem
 * abrir porta de rede — `app.inject()` percorre o mesmo caminho de
 * plugins, hooks e handlers que uma requisição real, o que faz o teste
 * exercitar a autenticação de verdade em vez de contorná-la.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const config = env();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      /* Campos que nunca podem aparecer no log. O log costuma ser o
         ponto cego da proteção de dados: vai para um agregador, é lido
         por quem não tem acesso ao banco e fica guardado por muito
         tempo. */
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.token',
        ],
        censor: '[removido]',
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            // Sem query string: ela costuma carregar termo de busca, que
            // pode conter nome de aluno.
            remoteAddress: request.ip,
          };
        },
      },
    },

    /* Confia no cabeçalho X-Forwarded-For apenas em produção, onde há
       proxy reverso conhecido na frente. Em desenvolvimento, confiar
       nele permitiria a qualquer cliente forjar o próprio IP e escapar
       do rate limit. */
    trustProxy: config.NODE_ENV === 'production',

    /* Teto de corpo da requisição. Sem isto, um POST de 500 MB consome
       memória do processo antes de qualquer validação rodar. Upload de
       anexo tem rota própria, com limite próprio. */
    bodyLimit: 1_048_576, // 1 MB

    genReqId: () => randomUUID(),
    disableRequestLogging: false,
    ignoreTrailingSlash: true,
  });

  registerErrorHandler(app);

  await registerSecurity(app);

  await app.register(cookie, {
    /* Sem `secret`: não usamos cookie assinado. O refresh token já é
       aleatório e verificado por hash no banco — assinar por cima
       adicionaria um segredo a gerenciar sem ganho real. */
    parseOptions: {},
  });

  /* Upload de anexos.
     Os limites são a primeira linha de defesa, e são baratos: sem eles
     um cliente manda um corpo de 4 GB ou 50 mil campos e derruba o
     processo antes de qualquer código nosso rodar. Um arquivo por
     requisição porque o prontuário anexa um documento de cada vez. */
  await app.register(multipart, {
    limits: {
      fileSize: config.UPLOAD_MAX_BYTES,
      files: 1,
      fields: 8,
      fieldSize: 2_000,
      headerPairs: 200,
    },
  });

  await app.register(authPlugin);

  // Devolve o id da requisição para o cliente poder citá-lo no suporte.
  app.addHook('onSend', async (request, reply) => {
    void reply.header('X-Request-Id', request.id);
  });

  /* ------------------------------------------------------------------
   * Healthcheck
   *
   * Sem autenticação, de propósito — é o proxy reverso e o supervisor
   * que consultam. Por isso responde o MÍNIMO: um sistema saudável e um
   * doente devem ser indistinguíveis para quem está sondando. Nada de
   * versão, hostname ou contagem de conexões.
   * ---------------------------------------------------------------- */
  app.get('/health', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => {
    return { status: 'ok' };
  });

  app.get(
    '/health/ready',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      try {
        /* Passa por withoutTenantContext e não por getPool().query direto:
           a convenção do projeto é que nenhum acesso ao banco escape das
           duas funções de contexto, para que a regra de análise estática
           consiga vigiar isso. O healthcheck é uma das exceções
           legítimas, e declará-la aqui é o que a torna auditável. */
        await withoutTenantContext('healthcheck', (client) => client.query('SELECT 1'));
        return { status: 'ready' };
      } catch {
        return reply.status(503).send({ status: 'unavailable' });
      }
    },
  );

  // ------------------------------------------------------------------
  // Rotas de domínio
  // ------------------------------------------------------------------
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(studentsRoutes, { prefix: '/api/students' });
  /* O prontuário vive sob /api/students porque uma anamnese não existe
     solta — existe DE um aluno, e é o aluno que passa pelo escopo. */
  await app.register(recordsRoutes, { prefix: '/api/students' });
  await app.register(attachmentsRoutes, { prefix: '/api/students' });
  await app.register(workoutsRoutes, { prefix: '/api/students' });
  /* A biblioteca tem raiz própria porque é da EMPRESA, não de um aluno.
     A URL diz de quem é a coisa, e isso determina como ela é protegida. */
  await app.register(exercisesRoutes, { prefix: '/api/exercises' });
  await app.register(whatsappRoutes, { prefix: '/api/whatsapp' });
  await app.register(reportsRoutes, { prefix: '/api/relatorios' });

  registrarAgendador(app);
  await app.register(scheduleRoutes, { prefix: '/api/schedule' });
  await app.register(financeRoutes, { prefix: '/api/finance' });
  await app.register(insightsRoutes, { prefix: '/api/insights' });

  return app;
}
