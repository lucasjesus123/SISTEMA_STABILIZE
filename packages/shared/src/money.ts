/**
 * Dinheiro na Stabilize.
 *
 * REGRA INEGOCIÁVEL: todo valor monetário é um inteiro de CENTAVOS (`Cents`).
 * Nunca `number` em reais, nunca `float`, nunca `0.1 + 0.2`.
 *
 * O motivo é aritmético, não estilístico. Em ponto flutuante binário:
 *   0.1 + 0.2 === 0.30000000000000004
 *   1.005 * 100 === 100.49999999999999   (arredonda para 100, não 101)
 * Um sistema financeiro que soma milhares de mensalidades com floats acumula
 * erro e o extrato deixa de fechar. Centavos inteiros eliminam a classe inteira
 * de bugs: soma e subtração são exatas até 2^53 centavos (~90 trilhões de reais).
 *
 * Multiplicação (percentual de comissão, juros, desconto) é o único ponto onde
 * arredondamento é inevitável — e está isolado em `applyRate` e `allocate`,
 * que são as ÚNICAS funções autorizadas a arredondar.
 */

/** Valor monetário em centavos. Sempre inteiro, pode ser negativo. */
export type Cents = number;

/** Erro de domínio monetário — nunca deve virar 500 silencioso. */
export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

/** Garante que o valor é um inteiro de centavos utilizável. */
export function assertCents(value: number, label = 'valor'): asserts value is Cents {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} deve ser um inteiro de centavos, recebido: ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} excede o limite seguro de centavos: ${value}`);
  }
}

/**
 * Converte reais (string ou number) para centavos, sem passar por float.
 *
 * Aceita as formas que aparecem de verdade num formulário brasileiro:
 *   "1.234,56"  "1234.56"  "1234,56"  "R$ 1.234,56"  1234.56
 *
 * A conversão é feita em cima da REPRESENTAÇÃO TEXTUAL (dígitos), não
 * multiplicando por 100, justamente para não herdar o erro do float.
 */
export function reaisToCents(input: string | number): Cents {
  const raw = typeof input === 'number' ? decimalToString(input) : input;

  let s = raw.trim().replace(/\s/g, '').replace(/^R\$/i, '').trim();
  if (s === '') throw new MoneyError('valor monetário vazio');

  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  // Formato contábil: (1.234,56) significa negativo.
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    /* Os dois separadores presentes: o decimal é o que aparece por ÚLTIMO.
       "1.234,56" (pt-BR) vs "1,234.56" (en-US). Aqui não há ambiguidade. */
    const decimalSep = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    const [intGroups, ...decParts] = s.split(decimalSep);
    if (decParts.length > 1) {
      throw new MoneyError(`valor monetário inválido: "${raw}" (separador decimal repetido)`);
    }
    assertThousandGroups(intGroups!.split(thousandSep), raw);
    s = `${intGroups!.split(thousandSep).join('')}.${decParts[0] ?? ''}`;
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    const parts = s.split(sep);

    if (parts.length > 2) {
      // "1.234.567" ou "1,234,567" — só faz sentido como separador de milhar.
      assertThousandGroups(parts, raw);
      s = parts.join('');
    } else if (isAmbiguousSingleSeparator(parts[0]!, parts[1]!)) {
      /* AMBIGUIDADE REAL, e num sistema financeiro ela não pode ser adivinhada.
         "1,234" pode ser R$ 1.234,00 (separador de milhar) ou R$ 1,23
         (decimal com 3ª casa a arredondar). Errar aqui é um erro de 1000x no
         extrato de um aluno. A única resposta correta é recusar a entrada e
         exigir uma forma inequívoca. Vale igual para "1.234". */
      throw new MoneyError(
        `valor monetário ambíguo: "${raw}". ` +
          `Use 2 casas decimais ("1,23") ou separador de milhar explícito ("1.234,00").`,
      );
    } else {
      s = parts.join('.');
    }
  }
  // Nenhum separador: já está em formato "1234".

  const match = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!match) throw new MoneyError(`valor monetário inválido: "${raw}"`);

  const intPart = match[1] === '' || match[1] === undefined ? '0' : match[1];
  const fracRaw = match[2] ?? '';
  if (fracRaw.length > 2) {
    // Mais de 2 casas: arredonda meio-para-cima na 3ª casa (half-up),
    // que é a convenção contábil brasileira.
    const keep = fracRaw.slice(0, 2);
    const nextDigit = Number(fracRaw[2]);
    const base = Number(intPart) * 100 + Number(keep.padEnd(2, '0'));
    const rounded = nextDigit >= 5 ? base + 1 : base;
    assertCents(rounded);
    return negative ? -rounded : rounded;
  }

  const frac = fracRaw.padEnd(2, '0');
  const cents = Number(intPart) * 100 + Number(frac);
  assertCents(cents, `valor "${raw}"`);
  return negative ? -cents : cents;
}

/**
 * Um separador único seguido de exatamente 3 dígitos é ambíguo ("1,234"):
 * pode ser milhar ou decimal. A exceção é a parte inteira começar com "0"
 * ("0,999"), onde a leitura de milhar é impossível — ninguém escreve "0,999"
 * para novecentos e noventa e nove.
 */
function isAmbiguousSingleSeparator(intPart: string, fracPart: string): boolean {
  if (fracPart.length !== 3) return false;
  if (intPart === '') return false;
  if (intPart.startsWith('0')) return false;
  if (intPart.length > 3) return false; // "1234,567" não é agrupamento válido
  return true;
}

/**
 * Valida que os grupos separados por milhar têm a forma correta:
 * o primeiro com 1 a 3 dígitos, os demais com exatamente 3.
 * Sem isso, "12,34,56" seria silenciosamente lido como 123456.
 */
function assertThousandGroups(groups: string[], raw: string): void {
  if (groups.length === 0) throw new MoneyError(`valor monetário inválido: "${raw}"`);
  const [first, ...rest] = groups;
  if (first === undefined || first.length === 0 || first.length > 3 || !/^\d+$/.test(first)) {
    throw new MoneyError(`valor monetário inválido: "${raw}" (agrupamento de milhar incorreto)`);
  }
  for (const g of rest) {
    if (g.length !== 3 || !/^\d{3}$/.test(g)) {
      throw new MoneyError(`valor monetário inválido: "${raw}" (agrupamento de milhar incorreto)`);
    }
  }
}

/** Representa um number decimal como string sem notação científica. */
function decimalToString(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError(`valor monetário não finito: ${n}`);
  // toFixed(4) preserva casas suficientes para o arredondamento half-up acima
  // decidir corretamente, sem arrastar o ruído binário de longe.
  return n.toFixed(4);
}

/** Formata centavos como texto pt-BR. `withSymbol` inclui "R$". */
export function formatCents(cents: Cents, withSymbol = true): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const intPart = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const intStr = intPart.toLocaleString('pt-BR');
  const body = `${intStr},${frac}`;
  const prefix = withSymbol ? 'R$ ' : '';
  return negative ? `-${prefix}${body}` : `${prefix}${body}`;
}

/** Soma exata. Aceita qualquer quantidade de parcelas. */
export function sum(...values: Cents[]): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
    if (Math.abs(total) > MAX_SAFE_CENTS) {
      throw new MoneyError('overflow na soma monetária');
    }
  }
  return total;
}

/** Soma exata de uma lista (atalho para agregações). */
export function sumAll(values: readonly Cents[]): Cents {
  return sum(...values);
}

/** Subtração exata: `a - b`. */
export function subtract(a: Cents, b: Cents): Cents {
  assertCents(a);
  assertCents(b);
  return a - b;
}

/** Multiplica por uma quantidade inteira (ex.: 8 sessões x R$ 120,00). */
export function multiplyByQuantity(unit: Cents, quantity: number): Cents {
  assertCents(unit, 'valor unitário');
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new MoneyError(`quantidade deve ser inteiro não-negativo, recebido: ${quantity}`);
  }
  const total = unit * quantity;
  assertCents(total, 'total');
  return total;
}

/**
 * Modo de arredondamento. `HALF_UP` é o padrão contábil brasileiro
 * (0,5 sempre sobe em valor absoluto) e o default do sistema.
 */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

function roundWith(value: number, mode: RoundingMode): number {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const floor = Math.floor(abs);
  const diff = abs - floor;

  switch (mode) {
    case 'DOWN':
      return sign * floor;
    case 'UP':
      return sign * (diff > 0 ? floor + 1 : floor);
    case 'HALF_EVEN': {
      if (diff > 0.5) return sign * (floor + 1);
      if (diff < 0.5) return sign * floor;
      return sign * (floor % 2 === 0 ? floor : floor + 1);
    }
    case 'HALF_UP':
    default:
      return sign * (diff >= 0.5 ? floor + 1 : floor);
  }
}

/**
 * Aplica um percentual a um valor — comissão, desconto, juros, multa.
 *
 * `rateBasisPoints` está em BASIS POINTS (1 bp = 0,01%), inteiro, para que a
 * própria taxa não seja um float. Exemplos:
 *   30%    → 3000 bp
 *   12,5%  → 1250 bp
 *   0,033% →    3,3 → NÃO permitido (use inteiro; arredonde a política antes)
 *
 * Isso torna as taxas auditáveis: "3000" no banco é inequivocamente 30%.
 */
export function applyRate(
  amount: Cents,
  rateBasisPoints: number,
  mode: RoundingMode = 'HALF_UP',
): Cents {
  assertCents(amount);
  if (!Number.isInteger(rateBasisPoints)) {
    throw new MoneyError(`taxa deve ser inteiro em basis points, recebido: ${rateBasisPoints}`);
  }
  if (rateBasisPoints < 0) {
    throw new MoneyError(`taxa não pode ser negativa: ${rateBasisPoints}`);
  }
  const exact = (amount * rateBasisPoints) / 10_000;
  const rounded = roundWith(exact, mode);
  assertCents(rounded, 'resultado da taxa');
  return rounded;
}

/** Converte percentual humano ("30", "12,5") para basis points inteiros. */
export function percentToBasisPoints(percent: string | number): number {
  const asCents = reaisToCents(percent); // reaproveita o parser: 12,5 → 1250
  return asCents;
}

/** Converte basis points para texto percentual pt-BR ("3000" → "30%"). */
export function formatBasisPoints(bp: number): string {
  if (!Number.isInteger(bp)) throw new MoneyError(`basis points deve ser inteiro: ${bp}`);
  const whole = Math.trunc(bp / 100);
  const frac = Math.abs(bp % 100);
  if (frac === 0) return `${whole}%`;
  const fracStr = String(frac).padStart(2, '0').replace(/0$/, '');
  return `${whole},${fracStr}%`;
}

/**
 * Divide um total em N partes SEM PERDER NEM CRIAR UM CENTAVO.
 *
 * Este é o problema clássico: R$ 100,00 em 3 parcelas não é 33,33 x 3
 * (= 99,99, some 1 centavo). O método do maior resto distribui os centavos
 * remanescentes nas primeiras parcelas, garantindo que
 * `sumAll(allocate(total, n)) === total` SEMPRE.
 *
 * Usado em: parcelamento de planos, rateio de comissão entre profissionais,
 * divisão de pacote de sessões.
 */
export function allocate(total: Cents, parts: number): Cents[] {
  assertCents(total);
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new MoneyError(`número de partes deve ser inteiro positivo, recebido: ${parts}`);
  }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / parts);
  const remainder = abs - base * parts;

  const result: Cents[] = [];
  for (let i = 0; i < parts; i += 1) {
    result.push(sign * (base + (i < remainder ? 1 : 0)));
  }
  return result;
}

/**
 * Divide um total segundo PESOS arbitrários, sem perder centavos.
 * Usado para rateio proporcional (ex.: comissão dividida por nº de sessões
 * que cada profissional atendeu).
 */
export function allocateByWeights(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total);
  if (weights.length === 0) throw new MoneyError('lista de pesos vazia');
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new MoneyError(`peso inválido: ${w}`);
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new MoneyError('soma dos pesos deve ser positiva');

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);

  // Piso de cada fatia + guarda o resto fracionário para ordenar depois.
  const floors: number[] = [];
  const remainders: { index: number; frac: number }[] = [];
  let allocated = 0;

  weights.forEach((w, index) => {
    const exact = (abs * w) / totalWeight;
    const floor = Math.floor(exact);
    floors.push(floor);
    allocated += floor;
    remainders.push({ index, frac: exact - floor });
  });

  // Distribui os centavos que sobraram para os maiores restos.
  let leftover = abs - allocated;
  remainders.sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const { index } of remainders) {
    if (leftover <= 0) break;
    floors[index] = floors[index]! + 1;
    leftover -= 1;
  }

  return floors.map((c) => sign * c);
}

/** `true` se o valor é zero. Evita `=== 0` espalhado com sinal negativo. */
export function isZero(cents: Cents): boolean {
  assertCents(cents);
  return cents === 0;
}

/** Valor absoluto. */
export function abs(cents: Cents): Cents {
  assertCents(cents);
  return Math.abs(cents);
}

/** Compara dois valores. Retorna -1, 0 ou 1. */
export function compare(a: Cents, b: Cents): -1 | 0 | 1 {
  assertCents(a);
  assertCents(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Maior valor de uma lista. Lança se a lista for vazia. */
export function max(values: readonly Cents[]): Cents {
  if (values.length === 0) throw new MoneyError('lista vazia em max()');
  return values.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
}

/** Menor valor de uma lista. Lança se a lista for vazia. */
export function min(values: readonly Cents[]): Cents {
  if (values.length === 0) throw new MoneyError('lista vazia em min()');
  return values.reduce((a, b) => (compare(a, b) <= 0 ? a : b));
}
