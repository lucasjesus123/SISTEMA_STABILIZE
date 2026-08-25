import type { Cents } from '@stabilize/shared';
import type { TenantClient } from '../../db/pool.js';
import type { FechamentoComissao } from './commission.js';

/**
 * Fechar o mês de um profissional.
 *
 * O QUE MUDA EM RELAÇÃO A SÓ CALCULAR. A aba de comissões sempre soube
 * calcular: ela lê os recebimentos do mês e mostra a memória de cálculo.
 * O que ela não fazia era FECHAR — e a diferença não é de tela, é de
 * natureza:
 *
 *   · O CÁLCULO É VOLÁTIL. Ele olha `finance_payments` agora. Uma baixa
 *     lançada com data retroativa, um estorno, um contrato com a
 *     alíquota corrigida — qualquer uma dessas coisas muda o número de
 *     um mês que o profissional já recebeu. A conversa vira "mas não era
 *     esse o valor", e ninguém tem como provar o que era.
 *   · O FECHAMENTO É UM FATO. Grava o total, a alíquota e a memória de
 *     cálculo linha a linha, na data em que foi fechado, e gera a
 *     DESPESA correspondente. A partir daí o que a academia deve ao
 *     profissional é um lançamento em "a pagar" como qualquer outro, com
 *     vencimento e baixa.
 *
 * AS TABELAS JÁ EXISTIAM — `commissions` e `commission_items`, com
 * unicidade por (empresa, profissional, mês) e uma coluna
 * `settled_entry_id` esperando o lançamento. Nunca receberam uma linha.
 *
 * FECHAR NÃO PAGA. Fechar cria a conta a pagar; pagar é dar baixa nela,
 * pelo mesmo caminho de qualquer despesa. Juntar as duas coisas num
 * botão só faria o sistema afirmar que o dinheiro saiu no dia em que
 * alguém conferiu a planilha.
 */

export interface FechamentoGravado {
  id: string;
  mes: string;
  profissionalId: string;
  profissional: string;
  baseCentavos: number;
  totalCentavos: number;
  aliquotaMediaBp: number;
  status: string;
  fechadoEm: string;
  /** A despesa gerada — é por onde o pagamento acontece. */
  lancamentoId: string | null;
  lancamentoPagoCentavos: number;
  lancamentoVencimento: string | null;
  itens: {
    descricao: string;
    baseCentavos: number;
    aliquotaBp: number;
    valorCentavos: number;
  }[];
}

/** O fechamento já gravado deste profissional neste mês, se houver. */
export async function buscarFechamento(
  client: TenantClient,
  professionalId: string,
  mes: Date,
): Promise<FechamentoGravado | null> {
  const { rows } = await client.query<{
    id: string;
    mes: string;
    professional_id: string;
    profissional: string;
    base: string;
    total: string;
    rate: number;
    status: string;
    fechado_em: string;
    entry_id: string | null;
    pago: string | null;
    vence: string | null;
  }>(
    `SELECT c.id, to_char(c.reference_month, 'YYYY-MM') AS mes,
            c.professional_id, u.full_name AS profissional,
            c.base_cents::text AS base, c.amount_cents::text AS total,
            c.rate_bp AS rate, c.status::text AS status,
            /* O padrão OF devolve "+00" — sem os minutos —, e o Date do
               navegador recusa esse formato: o relatório saía com "Mês
               FECHADO em Invalid Date". Convertido para UTC e carimbado
               com Z, é ISO 8601 válido em qualquer lugar. */
            to_char(coalesce(c.settled_at, c.created_at) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS fechado_em,
            c.settled_entry_id AS entry_id,
            e.paid_cents::text AS pago, e.due_date::text AS vence
       FROM commissions c
       JOIN users u ON u.id = c.professional_id
       LEFT JOIN finance_entries e ON e.id = c.settled_entry_id AND e.cancelled_at IS NULL
      WHERE c.professional_id = $1
        AND c.reference_month = date_trunc('month', $2::date)::date`,
    [professionalId, mes],
  );

  const f = rows[0];
  if (f === undefined) return null;

  const { rows: itens } = await client.query<{
    descricao: string;
    base: string;
    rate: number;
    valor: string;
  }>(
    `SELECT description AS descricao, base_cents::text AS base,
            rate_bp AS rate, amount_cents::text AS valor
       FROM commission_items
      WHERE commission_id = $1
      ORDER BY created_at, description`,
    [f.id],
  );

  return {
    id: f.id,
    mes: f.mes,
    profissionalId: f.professional_id,
    profissional: f.profissional,
    baseCentavos: Number(f.base),
    totalCentavos: Number(f.total),
    aliquotaMediaBp: f.rate,
    status: f.status,
    fechadoEm: f.fechado_em,
    lancamentoId: f.entry_id,
    lancamentoPagoCentavos: Number(f.pago ?? 0),
    lancamentoVencimento: f.vence,
    itens: itens.map((i) => ({
      descricao: i.descricao,
      baseCentavos: Number(i.base),
      aliquotaBp: i.rate,
      valorCentavos: Number(i.valor),
    })),
  };
}

export class FechamentoError extends Error {
  override readonly name = 'FechamentoError';
}

/**
 * Grava o fechamento e cria a despesa.
 *
 * TUDO OU NADA. Três escritas — a comissão, os itens e o lançamento —
 * e as três precisam existir juntas: um fechamento sem despesa é um
 * número que ninguém vai pagar, e uma despesa sem fechamento é um valor
 * que ninguém sabe de onde veio. O `withTenant` já abre a transação;
 * aqui basta não engolir exceção.
 */
export async function fecharMes(
  client: TenantClient,
  tenantId: string,
  entrada: {
    professionalId: string;
    profissional: string;
    mes: Date;
    fechamento: FechamentoComissao;
    vencimento: Date;
    criadoPor: string;
    observacao?: string | undefined;
  },
): Promise<{ id: string; lancamentoId: string }> {
  const mesIso = entrada.mes.toISOString().slice(0, 7);

  if (entrada.fechamento.totalCentavos <= 0) {
    /* Fechar zero criaria uma conta a pagar de R$ 0,00 que nunca sai da
       lista de pendências — o `amount_cents > 0` do banco recusaria de
       qualquer forma, e a mensagem dele não diria o que fazer. */
    throw new FechamentoError('Não há comissão a fechar neste mês: nada foi recebido.');
  }

  const jaExiste = await buscarFechamento(client, entrada.professionalId, entrada.mes);
  if (jaExiste !== null) {
    throw new FechamentoError(
      `O mês ${mesIso} já foi fechado para ${entrada.profissional}. Reabra antes de fechar de novo.`,
    );
  }

  const { rows: criada } = await client.query<{ id: string }>(
    `INSERT INTO commissions
       (tenant_id, professional_id, reference_month, base_cents, rate_bp,
        amount_cents, status, notes)
     VALUES ($1, $2, date_trunc('month', $3::date)::date, $4, $5, $6, 'APPROVED', $7)
     RETURNING id`,
    [
      tenantId,
      entrada.professionalId,
      entrada.mes,
      entrada.fechamento.baseTotalCentavos,
      entrada.fechamento.aliquotaMediaBp,
      entrada.fechamento.totalCentavos,
      entrada.observacao ?? null,
    ],
  );
  const comissao = criada[0]!;

  /* A MEMÓRIA DE CÁLCULO É COPIADA, não referenciada. Os itens guardam
     a descrição e a base do dia em que se fechou; se o lançamento de
     origem for editado depois, o fechamento continua contando a mesma
     história. É a diferença entre um documento e uma consulta. */
  for (const i of entrada.fechamento.itens) {
    await client.query(
      `INSERT INTO commission_items
         (tenant_id, commission_id, entry_id, student_id, description,
          base_cents, rate_bp, amount_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tenantId,
        comissao.id,
        i.entryId,
        i.studentId,
        i.descricao,
        i.baseCentavos,
        i.aliquotaBp,
        i.valorCentavos,
      ],
    );
  }

  const [ano, mesNum] = mesIso.split('-');
  const { rows: lanc } = await client.query<{ id: string }>(
    `INSERT INTO finance_entries
       (tenant_id, direction, description, category, amount_cents,
        due_date, competence_date, professional_id, supplier_name, created_by)
     VALUES ($1, 'PAYABLE', $2, 'Comissão', $3, $4,
             date_trunc('month', $5::date)::date, $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      `Comissão ${mesNum}/${ano} — ${entrada.profissional}`,
      entrada.fechamento.totalCentavos as Cents,
      entrada.vencimento,
      entrada.mes,
      entrada.professionalId,
      entrada.profissional,
      entrada.criadoPor,
    ],
  );
  const lancamento = lanc[0]!;

  await client.query(
    `UPDATE commissions
        SET status = 'SETTLED', settled_entry_id = $2, settled_at = now()
      WHERE id = $1`,
    [comissao.id, lancamento.id],
  );

  return { id: comissao.id, lancamentoId: lancamento.id };
}

/**
 * Reabre o mês.
 *
 * SÓ ENQUANTO NINGUÉM PAGOU. Depois da primeira baixa, apagar o
 * fechamento deixaria no caixa uma saída de dinheiro sem documento que a
 * explique — e o extrato do mês passaria a mostrar um pagamento a um
 * profissional que, segundo o sistema, não tinha nada a receber. Quem
 * pagou errado estorna a baixa primeiro; é uma etapa a mais, e é a que
 * deixa rastro.
 */
export async function reabrirMes(
  client: TenantClient,
  professionalId: string,
  mes: Date,
): Promise<boolean> {
  const atual = await buscarFechamento(client, professionalId, mes);
  if (atual === null) return false;

  if (atual.lancamentoPagoCentavos > 0) {
    throw new FechamentoError(
      'Este fechamento já teve baixa. Estorne o pagamento em "A pagar" antes de reabrir o mês.',
    );
  }

  if (atual.lancamentoId !== null) {
    /* CANCELA, não apaga. O lançamento sai das listas e das somas — o
       `status` vira CANCELLED por gatilho — e continua existindo para
       quem for auditar o que aconteceu naquele mês. */
    await client.query(
      `UPDATE finance_entries SET cancelled_at = now()
        WHERE id = $1 AND cancelled_at IS NULL`,
      [atual.lancamentoId],
    );
  }

  /* Os itens caem junto por ON DELETE CASCADE. */
  await client.query('DELETE FROM commissions WHERE id = $1', [atual.id]);
  return true;
}

/** Todos os fechamentos de um mês — a visão da academia, não a do professor. */
export async function fechamentosDoMes(
  client: TenantClient,
  mes: Date,
): Promise<
  {
    profissionalId: string;
    profissional: string;
    totalCentavos: number;
    baseCentavos: number;
    fechado: boolean;
    pagoCentavos: number;
  }[]
> {
  const { rows } = await client.query<{
    professional_id: string;
    profissional: string;
    total: string;
    base: string;
    pago: string | null;
  }>(
    `SELECT c.professional_id, u.full_name AS profissional,
            c.amount_cents::text AS total, c.base_cents::text AS base,
            e.paid_cents::text AS pago
       FROM commissions c
       JOIN users u ON u.id = c.professional_id
       LEFT JOIN finance_entries e ON e.id = c.settled_entry_id AND e.cancelled_at IS NULL
      WHERE c.reference_month = date_trunc('month', $1::date)::date
      ORDER BY u.full_name`,
    [mes],
  );

  return rows.map((r) => ({
    profissionalId: r.professional_id,
    profissional: r.profissional,
    totalCentavos: Number(r.total),
    baseCentavos: Number(r.base),
    fechado: true,
    pagoCentavos: Number(r.pago ?? 0),
  }));
}
