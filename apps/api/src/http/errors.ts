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
 * O que a regra do banco quer dizer, em português de gente.
 *
 * As restrições `CHECK` são as regras que o sistema não abre mão de
 * cumprir — e são justamente as que o usuário esbarra fazendo algo
 * legítimo pela porta errada. Devolver o nome cru seria vazar detalhe
 * interno; devolver só "os dados não atendem às regras" é pior, porque
 * deixa a pessoa sem próximo passo.
 *
 * A lista cobre as restrições que uma tela pode encostar. O que não
 * estiver aqui cai no texto genérico — que continua existindo como
 * último recurso, e não como resposta padrão.
 */
function explicarCheck(constraint: string | undefined): string {
  switch (constraint) {
    case 'entry_counterparty':
      return 'Diga de quem é esta cobrança: escolha o aluno ou informe quem vai pagar.';
    case 'entry_not_overpaid':
      return 'O pagamento é maior que o valor em aberto desta cobrança.';
    case 'entry_installment_coherent':
      return 'Parcelamento incompleto: informe o número da parcela e o total.';
    case 'finance_entries_amount_cents_check':
      return 'O valor precisa ser maior que zero.';
    case 'appt_cancel_coherent':
      return 'Atendimento cancelado precisa da data do cancelamento — e só ele pode tê-la.';
    case 'tenants_logo_completo':
      return 'O logo precisa do arquivo e do tipo juntos.';
    case 'tenants_cep_oito_digitos':
      return 'O CEP precisa ter oito dígitos.';
    case 'tenants_uf_valida':
      return 'UF inválida: use a sigla de duas letras do estado.';
    case 'tenants_telefone_e164':
      return 'Telefone fora do formato esperado.';
    case 'lead_conversao_coerente':
      return 'Interessado marcado como matriculado precisa do aluno que ele virou.';
    default:
      return 'Os dados enviados não atendem às regras do sistema.';
  }
}

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
      /* O TEXTO GENÉRICO É O ÚLTIMO RECURSO, não o primeiro.
         "Os dados enviados não atendem às regras do sistema" descreve o
         que aconteceu e não diz o que fazer: quem lê não sabe qual dado
         nem qual regra. Foi assim que a primeira cobrança de uma
         academia nova virou uma parede — a tela oferecia "sem aluno
         vinculado" e o banco exigia devedor.
         O nome da restrição É a explicação, e o banco já o entrega. */
      return new AppError('UNPROCESSABLE', explicarCheck(e.constraint), {
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
