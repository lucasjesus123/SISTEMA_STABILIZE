import { buildApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';

/**
 * Ponto de entrada.
 *
 * Duas responsabilidades além de subir: falhar cedo se a configuração
 * estiver errada, e desligar sem cortar requisição no meio.
 */
async function main(): Promise<void> {
  /* Valida a configuração ANTES de abrir a porta. Se um segredo estiver
     faltando, o processo morre no boot — barulhento, no deploy — em vez
     de subir e falhar no primeiro login. */
  const config = env();

  const app = await buildApp();

  /* Desligamento gracioso.
   *
   * Sem isto, um deploy corta as requisições em andamento no meio: uma
   * baixa de pagamento que já gravou o recibo mas não recalculou o
   * saldo deixa o extrato inconsistente. `app.close()` para de aceitar
   * conexões novas e espera as em curso terminarem.
   */
  let desligando = false;
  const desligar = async (sinal: string): Promise<void> => {
    if (desligando) return;
    desligando = true;
    app.log.info({ sinal }, 'desligando');

    /* Prazo máximo. Se algo travar, o processo morre de qualquer forma —
       um processo pendurado é pior do que um reiniciado, porque o
       supervisor acha que ainda está vivo. */
    const prazo = setTimeout(() => {
      app.log.error('desligamento excedeu o prazo; encerrando à força');
      process.exit(1);
    }, 15_000);
    prazo.unref();

    try {
      await app.close();
      await closePool();
      app.log.info('desligado');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'erro no desligamento');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void desligar('SIGTERM'));
  process.on('SIGINT', () => void desligar('SIGINT'));

  process.on('unhandledRejection', (motivo) => {
    app.log.error({ err: motivo }, 'promise rejeitada sem tratamento');
  });
  process.on('uncaughtException', (erro) => {
    /* Estado do processo é desconhecido após exceção não capturada.
       Continuar rodando arrisca corromper dado; o supervisor reinicia. */
    app.log.fatal({ err: erro }, 'exceção não capturada; encerrando');
    process.exit(1);
  });

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('falha ao iniciar a API:', error instanceof Error ? error.message : error);
  process.exit(1);
});
