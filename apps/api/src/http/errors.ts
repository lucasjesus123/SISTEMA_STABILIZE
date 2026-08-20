/**
 * Erros da API.
 *
 * Princípio: a mensagem que vai para o cliente é escrita por nós; a
 * mensagem que vai para o log é a real. Nunca serializamos o erro
 * original na resposta — stack trace, texto de query e caminho interno
 * são mapa para quem está sondando o sistema.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'UNAVAILABLE';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  /* Dependência externa fora do ar. NÃO é 500: o sistema está de pé, e
     quem recebe isto sabe que pode tentar de novo daqui a pouco. */
  UNAVAILABLE: 503,
};

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly statusCode: number;
  /** Detalhe seguro para exibir ao usuário (ex.: campos inválidos). */
  readonly details: unknown;
  /** Contexto para o log. NUNCA vai na resposta. */
  readonly logContext: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; logContext?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = options.details;
    this.logContext = options.logContext ?? {};
  }
}

export const badRequest = (m: string, details?: unknown) =>
  new AppError('BAD_REQUEST', m, { details });
export const unauthorized = (m = 'Não autenticado') => new AppError('UNAUTHORIZED', m);
export const forbidden = (m = 'Acesso negado') => new AppError('FORBIDDEN', m);
export const conflict = (m: string) => new AppError('CONFLICT', m);
export const unprocessable = (m: string, details?: unknown) =>
  new AppError('UNPROCESSABLE', m, { details });
/** Serviço de terceiro indisponível. Diferente de "não encontrei". */
export const unavailable = (m: string) => new AppError('UNAVAILABLE', m);

/**
 * Recurso não encontrado.
 *
 * Este é o erro mais importante do arquivo, e o motivo é sutil.
 *
 * Quando um usuário da Empresa A pede `/alunos/<id-da-empresa-B>`, a
 * resposta correta é 404 — a MESMA de um id que não existe em lugar
 * nenhum. Responder 403 ("existe, mas você não pode ver") confirmaria
 * ao atacante que aquele id é real, permitindo mapear a base alheia por
 * diferença de resposta, sem nunca ler um registro.
 *
 * É o mesmo raciocínio do login, que não distingue "e-mail não existe"
 * de "senha errada".
 */
export const notFound = (recurso = 'Recurso') =>
  new AppError('NOT_FOUND', `${recurso} não encontrado`);

/**
 * Traduz erro do PostgreSQL para erro de API, sem vazar detalhe interno.
 * O texto original do driver vai só para o log.
 */
export function fromDatabaseError(error: unknown): AppError {
  const e = error as { code?: string; constraint?: string; message?: string };

  switch (e.code) {
    case '23505': // unique_violation
      return new AppError('CONFLICT', 'Já existe um registro com esses dados.', {
        logContext: { pgCode: e.code, constraint: e.constraint },
      });

    case '23P01': {
      // exclusion_violation — na prática, sempre choque de agenda.
      const alvo = e.constraint?.includes('room')
        ? 'A sala já está ocupada nesse horário.'
        : e.constraint?.includes('student')
          ? 'O aluno já tem outro atendimento nesse horário.'
          : 'O profissional já tem outro atendimento nesse horário.';
      return new AppError('CONFLICT', alvo, {
        logContext: { pgCode: e.code, constraint: e.constraint },
      });
    }

    case '23503': // foreign_key_violation
      return new AppError('UNPROCESSABLE', 'Registro relacionado não encontrado.', {
        logContext: { pgCode: e.code, constraint: e.constraint },
      });

    case '23514': // check_violation
      return new AppError('UNPROCESSABLE', 'Os dados enviados não atendem às regras do sistema.', {
        logContext: { pgCode: e.code, constraint: e.constraint },
      });

    case '42501': // insufficient_privilege — quase sempre RLS barrando
      return new AppError('NOT_FOUND', 'Recurso não encontrado', {
        logContext: { pgCode: e.code, hint: 'possível tentativa de acesso cross-tenant' },
      });

    case '57014': // query_canceled — statement_timeout
      return new AppError('INTERNAL', 'A operação demorou demais e foi cancelada.', {
        logContext: { pgCode: e.code },
      });

    default:
      return new AppError('INTERNAL', 'Erro interno.', {
        logContext: { pgCode: e.code, pgMessage: e.message },
        cause: error,
      });
  }
}
