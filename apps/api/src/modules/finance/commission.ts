import {
  type Cents,
  applyRate,
  assertCents,
  subtract,
  sumAll,
} from '@stabilize/shared';

/**
 * Cálculo de comissão.
 *
 * Função PURA: recebe os lançamentos do mês e devolve a memória de
 * cálculo. Sem banco, sem relógio. O fechamento de comissão é o número
 * que o profissional confere no fim do mês e o que a academia paga —
 * precisa ser conferível linha a linha, e reproduzível.
 *
 * A decisão que define este arquivo: **a comissão sai do que foi
 * RECEBIDO, não do que foi cobrado.**
 *
 * Se saísse do cobrado, o professor receberia sobre mensalidade que o
 * aluno nunca pagou, e a academia pagaria a comissão da inadimplência do
 * próprio bolso. Num mês com 10% de inadimplência isso não é detalhe: é
 * prejuízo direto, e cresce com o faturamento.
 *
 * O outro lado dessa escolha, que precisa estar claro para o
 * profissional: um aluno que paga atrasado gera comissão no mês do
 * PAGAMENTO, não no mês do atendimento. Por isso cada item carrega a
 * data de competência e a data de recebimento.
 */

export interface LancamentoRecebido {
  readonly entryId: string;
  readonly descricao: string;
  readonly studentId: string | null;
  readonly appointmentId: string | null;
  /** Valor do lançamento (o total devido). */
  readonly valorCentavos: Cents;
  /** Quanto foi efetivamente recebido até a data de corte. */
  readonly recebidoCentavos: Cents;
  /** Alíquota do contrato, em basis points (3000 = 30%). */
  readonly aliquotaBp: number;
}

export interface ItemComissao {
  readonly entryId: string;
  readonly descricao: string;
  readonly studentId: string | null;
  readonly appointmentId: string | null;
  readonly baseCentavos: Cents;
  readonly aliquotaBp: number;
  readonly valorCentavos: Cents;
}

export interface FechamentoComissao {
  readonly itens: readonly ItemComissao[];
  /** Soma das bases (o que o profissional gerou e foi recebido). */
  readonly baseTotalCentavos: Cents;
  /** Soma das comissões. */
  readonly totalCentavos: Cents;
  /** O que fica para a academia. */
  readonly liquidoAcademiaCentavos: Cents;
  /**
   * Alíquota média efetiva, em basis points. Só informativa: quando há
   * alíquotas diferentes no mesmo mês, nenhuma delas sozinha descreve o
   * fechamento, e mostrar "30%" seria enganoso.
   */
  readonly aliquotaMediaBp: number;
}

export class CommissionError extends Error {
  override readonly name = 'CommissionError';
}

/**
 * Calcula o fechamento do mês.
 *
 * Cada item é arredondado individualmente, e o total é a SOMA DOS ITENS
 * arredondados — nunca o arredondamento da soma. A diferença aparece
 * rápido: com 30 itens, arredondar no fim produz um total que não bate
 * com a lista que o profissional está olhando, e a conversa vira
 * "o sistema está errado".
 */
export function calcularComissao(
  lancamentos: readonly LancamentoRecebido[],
): FechamentoComissao {
  const itens: ItemComissao[] = [];

  for (const l of lancamentos) {
    assertCents(l.recebidoCentavos, `recebido do lançamento ${l.entryId}`);
    assertCents(l.valorCentavos, `valor do lançamento ${l.entryId}`);

    if (l.recebidoCentavos < 0) {
      throw new CommissionError(`lançamento ${l.entryId} tem recebimento negativo`);
    }
    if (l.recebidoCentavos > l.valorCentavos) {
      /* O banco já impede superpagamento por CHECK. Se chegou aqui, o
         dado está inconsistente e calcular por cima produziria uma
         comissão maior que o devido — melhor falhar alto. */
      throw new CommissionError(
        `lançamento ${l.entryId} tem recebido maior que o valor devido`,
      );
    }
    if (!Number.isInteger(l.aliquotaBp) || l.aliquotaBp < 0 || l.aliquotaBp > 10_000) {
      throw new CommissionError(
        `alíquota inválida no lançamento ${l.entryId}: ${l.aliquotaBp}`,
      );
    }

    // Nada recebido, nada a comissionar. Não vira item para não poluir
    // a memória de cálculo com dezenas de linhas de valor zero.
    if (l.recebidoCentavos === 0) continue;

    itens.push({
      entryId: l.entryId,
      descricao: l.descricao,
      studentId: l.studentId,
      appointmentId: l.appointmentId,
      baseCentavos: l.recebidoCentavos,
      aliquotaBp: l.aliquotaBp,
      valorCentavos: applyRate(l.recebidoCentavos, l.aliquotaBp),
    });
  }

  const baseTotal = sumAll(itens.map((i) => i.baseCentavos));
  const total = sumAll(itens.map((i) => i.valorCentavos));

  return {
    itens,
    baseTotalCentavos: baseTotal,
    totalCentavos: total,
    // O que fica para a academia é exatamente o resto: sem centavo órfão.
    liquidoAcademiaCentavos: subtract(baseTotal, total),
    aliquotaMediaBp: baseTotal === 0 ? 0 : Math.round((total / baseTotal) * 10_000),
  };
}

/**
 * Divide uma comissão entre profissionais que dividiram o atendimento.
 *
 * Reexporta o rateio por pesos do pacote compartilhado, com o nome do
 * domínio. A invariante que importa: a soma das partes é exatamente
 * igual ao total, mesmo quando a divisão não fecha.
 */
export { allocateByWeights as ratearComissao } from '@stabilize/shared';
