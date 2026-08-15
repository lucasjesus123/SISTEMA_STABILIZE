import { describe, expect, it } from 'vitest';
import { formatCents, sumAll } from '@stabilize/shared';
import {
  CommissionError,
  calcularComissao,
  ratearComissao,
  type LancamentoRecebido,
} from './commission.js';

const lanc = (over: Partial<LancamentoRecebido> = {}): LancamentoRecebido => ({
  entryId: 'e1',
  descricao: 'Mensalidade',
  studentId: 's1',
  appointmentId: null,
  valorCentavos: 29990,
  recebidoCentavos: 29990,
  aliquotaBp: 4000,
  ...over,
});

describe('a comissão sai do RECEBIDO, não do cobrado', () => {
  it('lançamento não pago não gera comissão', () => {
    const r = calcularComissao([lanc({ recebidoCentavos: 0 })]);
    expect(r.totalCentavos).toBe(0);
    // Nem vira linha: 30 itens zerados poluiriam a memória de cálculo.
    expect(r.itens).toHaveLength(0);
  });

  it('pagamento parcial comissiona apenas a parte recebida', () => {
    // R$ 299,90 devidos, R$ 100,00 pagos, 40% → comissão sobre 100,00
    const r = calcularComissao([lanc({ recebidoCentavos: 10000 })]);
    expect(r.baseTotalCentavos).toBe(10000);
    expect(r.totalCentavos).toBe(4000);
    expect(formatCents(r.totalCentavos)).toBe('R$ 40,00');
  });

  it('a academia não paga comissão da própria inadimplência', () => {
    // Três alunos, um não pagou. A comissão sai só dos dois que pagaram.
    const r = calcularComissao([
      lanc({ entryId: 'a', recebidoCentavos: 29990 }),
      lanc({ entryId: 'b', recebidoCentavos: 29990 }),
      lanc({ entryId: 'c', recebidoCentavos: 0 }),
    ]);
    expect(r.baseTotalCentavos).toBe(59980);
    expect(r.totalCentavos).toBe(23992); // 40% de 599,80
    expect(r.itens).toHaveLength(2);
  });
});

describe('o total é a soma dos itens arredondados, nunca o arredondamento da soma', () => {
  it('bate com a lista que o profissional está olhando', () => {
    /* Com 30 itens, arredondar só no fim produz um total que não fecha
       com a soma das linhas na tela — e a conversa vira "o sistema está
       errado", com razão. */
    const lancamentos = Array.from({ length: 30 }, (_, i) =>
      lanc({ entryId: `e${i}`, recebidoCentavos: 3333, aliquotaBp: 3333 }),
    );
    const r = calcularComissao(lancamentos);

    const somaDasLinhas = sumAll(r.itens.map((i) => i.valorCentavos));
    expect(r.totalCentavos).toBe(somaDasLinhas);

    // 3333 * 0,3333 = 1110,89 → 1111 por item; 30 itens = 33330
    expect(r.itens[0]!.valorCentavos).toBe(1111);
    expect(r.totalCentavos).toBe(33_330);
  });

  it('base e comissão fecham com o líquido da academia, sem centavo órfão', () => {
    const lancamentos = [
      lanc({ entryId: 'a', recebidoCentavos: 12345, aliquotaBp: 3333 }),
      lanc({ entryId: 'b', recebidoCentavos: 777, aliquotaBp: 1234 }),
      lanc({ entryId: 'c', recebidoCentavos: 99, aliquotaBp: 5000 }),
    ];
    const r = calcularComissao(lancamentos);
    expect(r.totalCentavos + r.liquidoAcademiaCentavos).toBe(r.baseTotalCentavos);
  });

  it('mantém a invariante numa varredura ampla de valores e alíquotas', () => {
    for (let recebido = 1; recebido <= 2000; recebido += 37) {
      for (const bp of [0, 1, 1250, 3000, 3333, 5000, 10_000]) {
        const r = calcularComissao([lanc({ recebidoCentavos: recebido, valorCentavos: recebido, aliquotaBp: bp })]);
        expect(r.totalCentavos + r.liquidoAcademiaCentavos).toBe(r.baseTotalCentavos);
        expect(r.totalCentavos).toBeLessThanOrEqual(r.baseTotalCentavos);
        expect(r.totalCentavos).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('alíquotas diferentes no mesmo mês', () => {
  it('cada item usa a alíquota do próprio contrato', () => {
    const r = calcularComissao([
      lanc({ entryId: 'a', valorCentavos: 100000, recebidoCentavos: 100000, aliquotaBp: 3000 }), // 30% → 30000
      lanc({ entryId: 'b', valorCentavos: 100000, recebidoCentavos: 100000, aliquotaBp: 5000 }), // 50% → 50000
    ]);
    expect(r.itens[0]!.valorCentavos).toBe(30000);
    expect(r.itens[1]!.valorCentavos).toBe(50000);
    expect(r.totalCentavos).toBe(80000);
  });

  it('a alíquota média é informativa e não descreve nenhum contrato sozinha', () => {
    const r = calcularComissao([
      lanc({ entryId: 'a', valorCentavos: 100000, recebidoCentavos: 100000, aliquotaBp: 3000 }),
      lanc({ entryId: 'b', valorCentavos: 100000, recebidoCentavos: 100000, aliquotaBp: 5000 }),
    ]);
    // 80000 / 200000 = 40%
    expect(r.aliquotaMediaBp).toBe(4000);
  });

  it('alíquota zero é válida — profissional sem comissão sobre aquele item', () => {
    const r = calcularComissao([lanc({ aliquotaBp: 0 })]);
    expect(r.totalCentavos).toBe(0);
    expect(r.itens).toHaveLength(1); // o item existe, só não rende
    expect(r.liquidoAcademiaCentavos).toBe(29990);
  });

  it('alíquota de 100% entrega tudo ao profissional', () => {
    const r = calcularComissao([lanc({ aliquotaBp: 10_000 })]);
    expect(r.totalCentavos).toBe(29990);
    expect(r.liquidoAcademiaCentavos).toBe(0);
  });
});

describe('recusa dado inconsistente em vez de calcular por cima', () => {
  it('recebido maior que o devido', () => {
    // O banco impede por CHECK; se chegou aqui, o dado está corrompido e
    // calcular geraria comissão maior que a devida.
    expect(() =>
      calcularComissao([lanc({ valorCentavos: 10000, recebidoCentavos: 20000 })]),
    ).toThrow(CommissionError);
  });

  it('recebido negativo', () => {
    expect(() => calcularComissao([lanc({ recebidoCentavos: -100 })])).toThrow(CommissionError);
  });

  it('alíquota fora do intervalo ou fracionária', () => {
    expect(() => calcularComissao([lanc({ aliquotaBp: -1 })])).toThrow(CommissionError);
    expect(() => calcularComissao([lanc({ aliquotaBp: 10_001 })])).toThrow(CommissionError);
    expect(() => calcularComissao([lanc({ aliquotaBp: 12.5 })])).toThrow(CommissionError);
  });

  it('valor em centavos fracionário (float vazando para o domínio)', () => {
    expect(() => calcularComissao([lanc({ recebidoCentavos: 100.5 })])).toThrow();
  });
});

describe('mês sem movimento', () => {
  it('devolve fechamento zerado, não erro', () => {
    const r = calcularComissao([]);
    expect(r.totalCentavos).toBe(0);
    expect(r.baseTotalCentavos).toBe(0);
    expect(r.liquidoAcademiaCentavos).toBe(0);
    expect(r.aliquotaMediaBp).toBe(0);
    expect(r.itens).toEqual([]);
  });
});

describe('rateio entre profissionais que dividiram o atendimento', () => {
  it('divide por peso sem perder centavo', () => {
    const partes = ratearComissao(10000, [1, 1, 1]);
    expect(sumAll(partes)).toBe(10000);
    expect(partes).toEqual([3334, 3333, 3333]);
  });

  it('proporcional ao número de sessões atendidas', () => {
    const partes = ratearComissao(100000, [5, 3, 2]);
    expect(partes).toEqual([50000, 30000, 20000]);
    expect(sumAll(partes)).toBe(100000);
  });
});

describe('cenário real: fechamento do mês de um professor', () => {
  it('reproduz a memória de cálculo que ele confere', () => {
    const fechamento = calcularComissao([
      // 3 mensalistas de R$ 299,90 a 40%
      lanc({ entryId: 'm1', descricao: 'Mensalidade março — Ana', recebidoCentavos: 29990 }),
      lanc({ entryId: 'm2', descricao: 'Mensalidade março — Bruno', recebidoCentavos: 29990 }),
      lanc({ entryId: 'm3', descricao: 'Mensalidade março — Carla', recebidoCentavos: 29990 }),
      // 1 mensalista que pagou metade
      lanc({ entryId: 'm4', descricao: 'Mensalidade março — Diego', recebidoCentavos: 15000 }),
      // 1 mensalista inadimplente
      lanc({ entryId: 'm5', descricao: 'Mensalidade março — Elisa', recebidoCentavos: 0 }),
      // 12 sessões avulsas de R$ 120,00 a 50%
      ...Array.from({ length: 12 }, (_, i) =>
        lanc({
          entryId: `s${i}`,
          descricao: 'Sessão avulsa',
          valorCentavos: 12000,
          recebidoCentavos: 12000,
          aliquotaBp: 5000,
          appointmentId: `ap${i}`,
        }),
      ),
    ]);

    // 4 linhas de mensalidade com recebimento + 12 sessões = 16 itens
    expect(fechamento.itens).toHaveLength(16);

    // Base: 3 x 29990 + 15000 + 12 x 12000 = 89970 + 15000 + 144000
    expect(fechamento.baseTotalCentavos).toBe(248_970);

    // Comissão: 40% de 104970 = 41988 ; 50% de 144000 = 72000
    expect(fechamento.totalCentavos).toBe(113_988);
    expect(formatCents(fechamento.totalCentavos)).toBe('R$ 1.139,88');

    // Fecha com o que sobra para a academia.
    expect(fechamento.liquidoAcademiaCentavos).toBe(248_970 - 113_988);
    expect(
      fechamento.totalCentavos + fechamento.liquidoAcademiaCentavos,
    ).toBe(fechamento.baseTotalCentavos);

    // E a soma das linhas bate com o total apresentado.
    expect(sumAll(fechamento.itens.map((i) => i.valorCentavos))).toBe(
      fechamento.totalCentavos,
    );
  });
});
