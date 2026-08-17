import { z } from 'zod';

/**
 * Configuração da API.
 *
 * O processo NÃO SOBE com configuração inválida. Isso é deliberado.
 * A alternativa — cair para um valor padrão — é como sistemas vão para
 * produção com `JWT_SECRET=changeme`: ninguém percebe, porque funciona.
 * Falhar no boot é barulhento e acontece no deploy, não no vazamento.
 *
 * Nenhum segredo tem valor padrão. Nenhum.
 */

const secret = (min: number, label: string) =>
  z
    .string()
    .min(min, `${label} precisa de pelo menos ${min} caracteres`)
    .refine((v) => !/^(changeme|secret|password|test|dev|123)/i.test(v), {
      message: `${label} parece ser um valor de exemplo — gere um segredo real`,
    });

/**
 * Campo opcional que aceita VAZIO como "não configurado".
 *
 * `.optional()` sozinho não basta, e a diferença derrubou a API na
 * primeira instalação real. Para o Zod, `.optional()` quer dizer "pode
 * ser undefined" — e uma variável de ambiente vazia NÃO é undefined, é
 * uma string de zero caractere. O `.env` traz
 *
 *   UAZAPI_BASE_URL=
 *   UAZAPI_ADMIN_TOKEN=
 *
 * porque a integração de WhatsApp é opcional; o compose repassa isso
 * como string vazia, e a validação reprovava com "Invalid url" e
 * "String must contain at least 8 character(s)". A API se recusava a
 * subir por causa de uma funcionalidade que a instalação nem usa.
 *
 * Este `preprocess` normaliza vazio para ausente ANTES de validar, que é
 * o que "opcional" significa para quem escreve um arquivo de
 * configuração. Note que ele NÃO afronxa nada: se a variável vier
 * preenchida, as regras valem inteiras.
 *
 * Foi a terceira vez nesta instalação que "vazio" e "ausente" foram
 * confundidos — antes disso derrubaram o proxy (`email` do Caddy) e
 * passaram batido no meu próprio teste, que usava a variável ausente.
 */
const opcional = <T extends z.ZodTypeAny>(esquema: T) =>
  z.preprocess((valor) => (valor === '' ? undefined : valor), esquema.optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3333),
    HOST: z.string().default('127.0.0.1'),

    /** Credencial de runtime: papel stabilize_app, sem BYPASSRLS. */
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    DATABASE_POOL_IDLE_MS: z.coerce.number().int().min(1000).default(30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),

    /* Segredos de assinatura. Access e refresh usam segredos DIFERENTES:
       se um vazar, o outro não permite forjar o par. */
    JWT_ACCESS_SECRET: secret(32, 'JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: secret(32, 'JWT_REFRESH_SECRET'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).default(60 * 60 * 24 * 14),

    /** Chave de cifra dos tokens de terceiros (uazapi). 32 bytes em base64. */
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, {
        message: 'ENCRYPTION_KEY precisa ser 32 bytes em base64 (openssl rand -base64 32)',
      }),

    /** Origens permitidas no CORS. Lista explícita, nunca curinga. */
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    /** Diretório de anexos. Fora da raiz pública do servidor web. */
    STORAGE_DIR: z.string().default('./storage'),
    UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(20 * 1024 * 1024),

    RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(10).default(300),

    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).default(8),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

    /* Integração WhatsApp (uazapi). Opcional: o sistema opera sem ela. */
    UAZAPI_BASE_URL: opcional(z.string().url()),
    UAZAPI_ADMIN_TOKEN: opcional(z.string().min(8)),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // Em produção, exigências que em desenvolvimento seriam atrito inútil.
    if (env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'em produção é obrigatório declarar as origens permitidas',
      });
    }
    if (env.CORS_ORIGINS.some((o) => o === '*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'curinga "*" não é aceito em produção',
      });
    }
    if (env.CORS_ORIGINS.some((o) => o.startsWith('http://') && !o.includes('localhost'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'origem sem HTTPS em produção',
      });
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'access e refresh precisam de segredos distintos',
      });
    }
    if (env.HOST === '0.0.0.0') {
      // Não é erro fatal — atrás de proxy reverso em container é o normal —
      // mas precisa ser uma escolha consciente, então avisamos alto.
      // eslint-disable-next-line no-console
      console.warn(
        '[config] HOST=0.0.0.0: a API escuta em todas as interfaces. ' +
          'Confirme que só o proxy reverso alcança esta porta.',
      );
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    /* Imprimimos NOMES de variáveis e mensagens — nunca os valores.
       Um log de erro de boot que ecoa o valor recebido é uma forma
       clássica de vazar segredo para o agregador de logs. */
    const problemas = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração inválida. A API não vai subir.\n${problemas}`);
  }

  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Apenas para testes: descarta o cache entre casos. */
export function resetEnvCache(): void {
  cached = null;
}
