import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  allocate,
  allocateByWeights,
  applyRate,
  formatBasisPoints,
  formatCents,
  multiplyByQuantity,
  percentToBasisPoints,
  reaisToCents,
  subtract,
  sum,
  sumAll,
} from './money.js';

describe('reaisToCents — o parser é a fronteira entre o usuário e o extrato', () => {
  it('lê os formatos que um brasileiro realmente digita', () => {
    expect(reaisToCents('1.234,56')).toBe(123456);
    expect(reaisToCents('R$ 1.234,56')).toBe(123456);
    expect(reaisToCents('1234,56')).toBe(123456);
    expect(reaisToCents('1234.56')).toBe(123456);
    expect(reaisToCents('1,234.56')).toBe(123456); // en-US
    expect(reaisToCents('120')).toBe(12000);
    expect(reaisToCents('0,01')).toBe(1);
    expect(reaisToCents(',5')).toBe(50);
  });

  it('aceita negativos, inclusive em notação contábil', () => {
    expect(reaisToCents('-50,00')).toBe(-5000);
    expect(reaisToCents('(50,00)')).toBe(-5000);
  });

  it('arredonda meio-para-cima na terceira casa (convenção contábil BR)', () => {
    expect(reaisToCents('0,999')).toBe(100);
    expect(reaisToCents('0,005')).toBe(1);
    expect(reaisToCents('0,004')).toBe(0);
    expect(reaisToCents('1,0050')).toBe(101);
    expect(reaisToCents('1,0045')).toBe(100);
  });

  it('NÃO herda o erro do ponto flutuante ao receber number', () => {
    // 1.005 * 100 === 100.49999999999999 em float → arredondaria para 100.
    expect(reaisToCents(1.005)).toBe(101);
    expect(reaisToCents(0.1 + 0.2)).toBe(30);
    expect(reaisToCents(29.99)).toBe(2999);
  });

  it('recusa entrada ambígua em vez de adivinhar', () => {
    // "1,234" pode ser 1234,00 ou 1,23 — errar aqui é um erro de 1000x.
    expect(() => reaisToCents('1,234')).toThrow(MoneyError);
    expect(() => reaisToCents('1.234')).toThrow(MoneyError);
    expect(() => reaisToCents('12,345')).toThrow(MoneyError);
  });

  it('recusa agrupamento de milhar malformado', () => {
    expect(() => reaisToCents('12,34,56')).toThrow(MoneyError);
    expect(() => reaisToCents('1.23.456')).toThrow(MoneyError);
    expect(() => reaisToCents('1234.567.890')).toThrow(MoneyError);
  });

  it('recusa lixo', () => {
    expect(() => reaisToCents('')).toThrow(MoneyError);
    expect(() => reaisToCents('abc')).toThrow(MoneyError);
    expect(() => reaisToCents('12abc,34')).toThrow(MoneyError);
    expect(() => reaisToCents(Number.NaN)).toThrow(MoneyError);
    expect(() => reaisToCents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe('formatCents', () => {
  it('formata em pt-BR', () => {
    expect(formatCents(123456)).toBe('R$ 1.234,56');
    expect(formatCents(1)).toBe('R$ 0,01');
    expect(formatCents(0)).toBe('R$ 0,00');
    expect(formatCents(-5000)).toBe('-R$ 50,00');
    expect(formatCents(123456, false)).toBe('1.234,56');
  });

  it('faz o round-trip com o parser sem perder valor', () => {
    for (const cents of [0, 1, 99, 100, 12345, 999999, 100000000]) {
      expect(reaisToCents(formatCents(cents, false))).toBe(cents);
    }
  });
});

describe('soma e subtração são exatas', () => {
  it('soma mil parcelas de 0,01 e dá exatamente 10,00', () => {
    const parcelas = Array.from({ length: 1000 }, () => 1);
    expect(sumAll(parcelas)).toBe(1000);
    // Em float: 0.01 somado 1000x === 9.999999999999831
  });

  it('fecha um mês de mensalidades sem deriva', () => {
    const mensalidades = Array.from({ length: 100 }, () => 29990); // R$ 299,90
    expect(sumAll(mensalidades)).toBe(2999000);
    expect(formatCents(sumAll(mensalidades))).toBe('R$ 29.990,00');
  });

  it('subtrai', () => {
    expect(subtract(10000, 3350)).toBe(6650);
    expect(subtract(0, 100)).toBe(-100);
  });

  it('recusa valores não-inteiros (guarda contra float vazando pro domínio)', () => {
    expect(() => sum(10.5)).toThrow(MoneyError);
  });
});

describe('multiplyByQuantity — pacotes de sessão', () => {
  it('8 sessões de R$ 120,00', () => {
    expect(multiplyByQuantity(12000, 8)).toBe(96000);
  });

  it('quantidade zero é válida', () => {
    expect(multiplyByQuantity(12000, 0)).toBe(0);
  });

  it('recusa quantidade fracionária ou negativa', () => {
    expect(() => multiplyByQuantity(12000, 1.5)).toThrow(MoneyError);
    expect(() => multiplyByQuantity(12000, -1)).toThrow(MoneyError);
  });
});

describe('applyRate — comissões, descontos, juros', () => {
  it('30% de R$ 1.000,00', () => {
    expect(applyRate(100000, 3000)).toBe(30000);
  });

  it('12,5% de R$ 299,90 arredonda meio-para-cima', () => {
    // 29990 * 0,125 = 3748,75 → 3749
    expect(applyRate(29990, 1250)).toBe(3749);
  });

  it('respeita o modo de arredondamento no empate exato (.5)', () => {
    // 100 * 12,5% = 12,5 — empate perfeito, onde os modos divergem.
    expect(applyRate(100, 1250, 'HALF_UP')).toBe(13);
    expect(applyRate(100, 1250, 'HALF_EVEN')).toBe(12); // 12 é par
    expect(applyRate(100, 1250, 'DOWN')).toBe(12);
    expect(applyRate(100, 1250, 'UP')).toBe(13);
    // 300 * 12,5% = 37,5 — HALF_EVEN sobe, porque 38 é o par.
    expect(applyRate(300, 1250, 'HALF_EVEN')).toBe(38);
  });

  it('exige taxa inteira em basis points', () => {
    expect(() => applyRate(10000, 12.5)).toThrow(MoneyError);
    expect(() => applyRate(10000, -100)).toThrow(MoneyError);
  });

  it('converte percentual humano para basis points', () => {
    expect(percentToBasisPoints('30')).toBe(3000);
    expect(percentToBasisPoints('12,5')).toBe(1250);
    expect(percentToBasisPoints(40)).toBe(4000);
    expect(formatBasisPoints(3000)).toBe('30%');
    expect(formatBasisPoints(1250)).toBe('12,5%');
    expect(formatBasisPoints(1205)).toBe('12,05%');
  });
});

describe('allocate — parcelar sem perder centavo', () => {
  it('R$ 100,00 em 3 parcelas soma exatamente R$ 100,00', () => {
    const parcelas = allocate(10000, 3);
    expect(parcelas).toEqual([3334, 3333, 3333]);
    expect(sumAll(parcelas)).toBe(10000);
    // A armadilha clássica: 33,33 x 3 = 99,99 — some 1 centavo.
  });

  it('mantém a invariante para uma varredura ampla de valores e parcelas', () => {
    for (let total = 0; total <= 5000; total += 7) {
      for (let n = 1; n <= 13; n += 1) {
        const parts = allocate(total, n);
        expect(parts).toHaveLength(n);
        expect(sumAll(parts)).toBe(total);
        // Nenhuma parcela difere de outra em mais de 1 centavo.
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('funciona com valores negativos (estornos)', () => {
    const parcelas = allocate(-10000, 3);
    expect(sumAll(parcelas)).toBe(-10000);
  });

  it('recusa número de partes inválido', () => {
    expect(() => allocate(10000, 0)).toThrow(MoneyError);
    expect(() => allocate(10000, -1)).toThrow(MoneyError);
    expect(() => allocate(10000, 2.5)).toThrow(MoneyError);
  });
});

describe('allocateByWeights — rateio proporcional de comissão', () => {
  it('divide R$ 1.000,00 entre 3 profissionais por nº de sessões', () => {
    const partes = allocateByWeights(100000, [5, 3, 2]);
    expect(partes).toEqual([50000, 30000, 20000]);
    expect(sumAll(partes)).toBe(100000);
  });

  it('não perde centavo em divisão que não fecha', () => {
    const partes = allocateByWeights(10000, [1, 1, 1]);
    expect(sumAll(partes)).toBe(10000);
    expect(partes).toEqual([3334, 3333, 3333]);
  });

  it('mantém a invariante numa varredura ampla', () => {
    const pesosCasos = [
      [1, 2, 3],
      [7, 11, 13, 17],
      [1],
      [1, 0, 1],
      [99, 1],
    ];
    for (const pesos of pesosCasos) {
      for (let total = 0; total <= 3000; total += 13) {
        const partes = allocateByWeights(total, pesos);
        expect(sumAll(partes)).toBe(total);
        expect(partes).toHaveLength(pesos.length);
      }
    }
  });

  it('peso zero recebe zero', () => {
    const partes = allocateByWeights(10000, [1, 0]);
    expect(partes[1]).toBe(0);
    expect(sumAll(partes)).toBe(10000);
  });

  it('recusa pesos inválidos', () => {
    expect(() => allocateByWeights(10000, [])).toThrow(MoneyError);
    expect(() => allocateByWeights(10000, [0, 0])).toThrow(MoneyError);
    expect(() => allocateByWeights(10000, [-1, 2])).toThrow(MoneyError);
  });
});

describe('cenário real: fechamento de comissão de um professor', () => {
  it('calcula o repasse do mês fechando com o faturamento', () => {
    // 12 sessões avulsas de R$ 120,00 + 3 mensalistas de R$ 299,90
    const avulsas = multiplyByQuantity(12000, 12);
    const mensalistas = multiplyByQuantity(29990, 3);
    const faturamento = sum(avulsas, mensalistas);
    expect(faturamento).toBe(233970); // R$ 2.339,70

    // Comissão de 40% sobre o faturamento gerado pelo professor.
    const comissao = applyRate(faturamento, percentToBasisPoints('40'));
    expect(comissao).toBe(93588); // R$ 935,88
    expect(formatCents(comissao)).toBe('R$ 935,88');

    // O que fica para a academia é exatamente o resto — sem centavo órfão.
    const liquidoAcademia = subtract(faturamento, comissao);
    expect(sum(comissao, liquidoAcademia)).toBe(faturamento);
  });
});
