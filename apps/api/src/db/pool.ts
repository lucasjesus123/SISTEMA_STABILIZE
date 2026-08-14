import pg from 'pg';
import { env } from '../config/env.js';

/**
 * Acesso ao banco.
 *
 * Esta é a peça mais sensível da API. A Row-Level Security do PostgreSQL
 * protege os dados a partir de `current_setting('app.tenant_id')`, e é
 * AQUI que esse valor é definido. Um erro neste arquivo desliga o
 * isolamento do sistema inteiro, silenciosamente.
 *
 * Duas decisões merecem explicação, porque a alternativa "óbvia" está
 * errada dos dois lados:
 *
 * 1. SET LOCAL, NÃO SET.
 *    `SET LOCAL` vale só até o fim da transação. `SET` vale pela SESSÃO —
 *    e como as conexões são reaproveitadas de um pool, o tenant do
 *    usuário anterior continuaria valendo para o próximo request que
 *    pegasse a mesma conexão. Seria um vazamento entre empresas
 *    intermitente e praticamente impossível de reproduzir.
 *
 * 2. set_config($1, $2, true) COM PARÂMETRO, não interpolação.
 *    `SET LOCAL` não aceita parâmetro no protocolo estendido, o que
 *    empurra para montar a string na mão — e aí um tenant_id vindo de
 *    fora vira injeção de SQL no exato ponto que decide a autorização.
 *    set_config() é uma função comum e aceita parâmetro. O valor ainda é
 *    validado como UUID antes de chegar aqui: duas trancas.
 */

const { Pool } = pg;

/* O driver devolve BIGINT como string para não perder precisão acima de
   2^53. Nossos valores monetários são BIGINT de centavos e cabem com
   folga em Number.MAX_SAFE_INTEGER (~90 trilhões de reais), então
   convertemos para number — que é o tipo `Cents` do pacote shared. */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`valor BIGINT fora do intervalo seguro do JavaScript: ${value}`);
  }
  return n;
});

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;

  const config = env();
  pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: config.DATABASE_POOL_IDLE_MS,
    connectionTimeoutMillis: 5_000,
    /* Query travada segura uma conexão do pool. Com o pool esgotado, a
       API para de responder inteira — um relatório mal indexado vira
       indisponibilidade geral. O timeout transforma isso em um erro
       localizado num request só. */
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: 'stabilize-api',
  });

  pool.on('error', (err) => {
    // Erro em conexão ociosa não deve derrubar o processo.
    // eslint-disable-next-line no-console
    console.error('[db] erro em conexão ociosa do pool:', err.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Identidade que a transação assume no banco. */
export interface TenantContext {
  readonly tenantId: string;
  readonly userId?: string | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  override readonly name = 'TenantContextError';
}

/** Cliente restrito ao que a camada de dados deve poder fazer. */
export interface TenantClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Executa `fn` dentro de uma transação com o contexto de tenant definido.
 *
 * TODO acesso a dado de empresa passa por aqui. Não existe caminho
 * alternativo que use `pool.query()` direto — fora desta função, o
 * contexto não está definido e a RLS devolve zero linhas.
 *
 * O `tenantId` vem SEMPRE do token verificado, nunca de parâmetro de
 * rota, corpo, query string ou cabeçalho.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (client: TenantClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(ctx.tenantId)) {
    throw new TenantContextError('tenantId inválido: precisa ser um UUID');
  }
  if (ctx.userId !== undefined && !UUID_RE.test(ctx.userId)) {
    throw new TenantContextError('userId inválido: precisa ser um UUID');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Escopo de transação (terceiro argumento `true`) — ver comentário do topo.
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ctx.tenantId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', ctx.userId ?? '']);

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* A conexão pode já estar inutilizável; o release abaixo a descarta. */
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transação SEM contexto de tenant.
 *
 * Existe para as poucas operações que legitimamente antecedem a
 * identificação da empresa — resolver o e-mail de login para descobrir o
 * tenant, e o healthcheck. Está isolada e nomeada de forma incômoda de
 * propósito: cada chamada nova deve chamar atenção em revisão de código.
 *
 * Sob este cliente a RLS devolve zero linhas em qualquer tabela com
 * policy. As queries que rodam aqui precisam ser as que não dependem
 * dela — ver `login.ts`, que consulta `users` por uma função
 * SECURITY DEFINER restrita ao mínimo necessário.
 */
export async function withoutTenantContext<T>(
  reason: 'login' | 'healthcheck' | 'cron',
  fn: (client: TenantClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.context_reason', reason]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ver acima */
    }
    throw error;
  } finally {
    client.release();
  }
}
