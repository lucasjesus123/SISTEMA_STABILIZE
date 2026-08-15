import type { Cents } from '@stabilize/shared';
import type { TenantClient } from '../../db/pool.js';
import { type AccessScope, professionalScopeSql } from '../../auth/scope.js';
import type { LancamentoRecebido } from './commission.js';

/**
 * Acesso a dados do financeiro.
 *
 * Duas fronteiras diferentes convivem aqui, e confundi-las seria o erro
 * mais caro do módulo:
 *
 *   FINANCEIRO DA EMPRESA — contas a pagar e a receber, fluxo de caixa,
 *     inadimplência. Só OWNER e ADMIN alcançam, e a permissão da rota já
 *     resolve isso. Não há recorte por profissional porque não faz
 *     sentido: é o caixa da academia.
 *
 *   COMISSÃO DO PROFISSIONAL — o recorte próprio dele. Toda função aqui
 *     exige `scope`, e um profissional nunca enxerga o fechamento do
 *     colega. É a aba que o enunciado pediu que fosse liberada para os
 *     professores.
 */

export type Direcao = 'RECEIVABLE' | 'PAYABLE';

export interface LancamentoRow {
  id: string;
  direction: Direcao;
  description: string;
  category: string | null;
  amount_cents: Cents;
  paid_cents: Cents;
  status: string;
  due_date: string;
  competence_date: string | null;
  student_id: string | null;
  student_name: string | null;
  professional_id: string | null;
  supplier_name: string | null;
  installment_no: number | null;
  installment_total: number | null;
}

export interface FiltroLancamentos {
  readonly direcao?: Direcao | undefined;
  readonly de?: Date | undefined;
  readonly ate?: Date | undefined;
  readonly status?: string | undefined;
  readonly studentId?: string | undefined;
  readonly apenasEmAberto?: boolean | undefined;
  readonly limit: number;
  readonly offset: number;
}

const MAX_PAGINA = 200;

export async function listarLancamentos(
  client: TenantClient,
  filtro: FiltroLancamentos,
): Promise<{ rows: LancamentoRow[]; total: number }> {
  const limit = Math.min(Math.max(filtro.limit, 1), MAX_PAGINA);
  const offset = Math.max(filtro.offset, 0);

  const values: unknown[] = [
    filtro.direcao ?? null,
    filtro.de ?? null,
    filtro.ate ?? null,
    filtro.status ?? null,
    filtro.studentId ?? null,
    filtro.apenasEmAberto ?? false,
  ];

  /* Filtros opcionais como `$n IS NULL OR ...`: o parâmetro ausente
     simplesmente não restringe. Evita montar SQL condicional, que é
     onde se erra a precedência de AND/OR. */
  const where = `
        ($1::entry_direction IS NULL OR e.direction = $1::entry_direction)
    AND ($2::date IS NULL OR e.due_date >= $2::date)
    AND ($3::date IS NULL OR e.due_date <= $3::date)
    AND ($4::entry_status IS NULL OR e.status = $4::entry_status)
    AND ($5::uuid IS NULL OR e.student_id = $5::uuid)
    AND ($6::boolean IS FALSE OR e.status IN ('OPEN','PARTIALLY_PAID','OVERDUE'))
    AND e.cancelled_at IS NULL`;

  const totalRes = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM finance_entries e WHERE ${where}`,
    values,
  );

  values.push(limit, offset);
  const rows = await client.query<LancamentoRow>(
    `SELECT e.id, e.direction, e.description, e.category,
            e.amount_cents, e.paid_cents, e.status::text AS status,
            e.due_date::text AS due_date, e.competence_date::text AS competence_date,
            e.student_id, s.full_name AS student_name,
            e.professional_id, e.supplier_name,
            e.installment_no, e.installment_total
       FROM finance_entries e
       LEFT JOIN students s ON s.id = e.student_id
      WHERE ${where}
      ORDER BY e.due_date DESC, e.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return { rows: rows.rows, total: totalRes.rows[0]?.total ?? 0 };
}

export interface CriarLancamentoInput {
  readonly direcao: Direcao;
  readonly descricao: string;
  readonly categoria?: string | undefined;
  readonly valorCentavos: Cents;
  readonly vencimento: Date;
  readonly competencia?: Date | undefined;
  readonly studentId?: string | undefined;
  readonly professionalId?: string | undefined;
  readonly fornecedor?: string | undefined;
  readonly observacao?: string | undefined;
  readonly criadoPor: string;
}

export async function criarLancamento(
  client: TenantClient,
  tenantId: string,
  input: CriarLancamentoInput,
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO finance_entries
       (tenant_id, direction, description, category, amount_cents, due_date,
        competence_date, student_id, professional_id, supplier_name, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      tenantId,
      input.direcao,
      input.descricao,
      input.categoria ?? null,
      input.valorCentavos,
      input.vencimento,
      input.competencia ?? input.vencimento,
      input.studentId ?? null,
      input.professionalId ?? null,
      input.fornecedor ?? null,
      input.observacao ?? null,
      input.criadoPor,
    ],
  );
  return r.rows[0]!;
}

/**
 * Registra uma baixa.
 *
 * NÃO atualiza `paid_cents` nem `status`: quem faz isso é um gatilho no
 * banco, a partir da soma dos pagamentos. Se a aplicação escrevesse
 * esses campos, o extrato poderia divergir dos recibos sob concorrência
 * ou por um caminho de código esquecido — e divergência silenciosa em
 * financeiro é o pior tipo de bug.
 *
 * Superpagamento é recusado por CHECK no banco e vira 422 na resposta.
 */
export async function registrarPagamento(
  client: TenantClient,
  tenantId: string,
  input: {
    entryId: string;
    valorCentavos: Cents;
    metodo: string;
    pagoEm?: Date | undefined;
    referencia?: string | undefined;
    registradoPor: string;
  },
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO finance_payments
       (tenant_id, entry_id, amount_cents, method, paid_at, reference, recorded_by)
     VALUES ($1,$2,$3,$4::payment_method,COALESCE($5, now()),$6,$7)
     RETURNING id`,
    [
      tenantId,
      input.entryId,
      input.valorCentavos,
      input.metodo,
      input.pagoEm ?? null,
      input.referencia ?? null,
      input.registradoPor,
    ],
  );
  return r.rows[0]!;
}

/** Estorna uma baixa. O gatilho recalcula o saldo para trás. */
export async function estornarPagamento(
  client: TenantClient,
  paymentId: string,
): Promise<boolean> {
  const r = await client.query('DELETE FROM finance_payments WHERE id = $1', [paymentId]);
  return (r.rowCount ?? 0) > 0;
}

/* --------------------------------------------------------------------
 * Comissões
 * ------------------------------------------------------------------ */

/**
 * Busca a base de cálculo da comissão de um profissional no mês.
 *
 * O recorte por `scope` é o que impede um profissional de fechar a
 * comissão do colega. Um ADMIN passa com escopo ALL e pode consultar
 * qualquer um; um PROFESSIONAL passa com escopo próprio e o fragmento
 * de SQL o prende ao próprio `professional_id`.
 *
 * A base é o RECEBIDO no período — `paid_cents` filtrado por data de
 * pagamento, não o valor cobrado. Ver o comentário de commission.ts.
 */
export async function baseDeComissao(
  client: TenantClient,
  scope: AccessScope,
  professionalId: string,
  mesReferencia: Date,
): Promise<LancamentoRecebido[]> {
  const values: unknown[] = [professionalId, mesReferencia];
  const escopo = professionalScopeSql(scope, values.length, 'e');
  values.push(...escopo.values);

  /* A comissão é do mês em que o dinheiro ENTROU. Um aluno que paga
     março em abril gera comissão em abril — por isso o filtro é sobre
     finance_payments.paid_at, e não sobre a competência do lançamento. */
  const r = await client.query<{
    entry_id: string;
    descricao: string;
    student_id: string | null;
    appointment_id: string | null;
    valor_centavos: Cents;
    recebido_centavos: Cents;
    aliquota_bp: number;
  }>(
    `SELECT e.id                       AS entry_id,
            e.description              AS descricao,
            e.student_id,
            e.appointment_id,
            e.amount_cents             AS valor_centavos,
            COALESCE(SUM(p.amount_cents), 0)::bigint AS recebido_centavos,
            COALESCE(c.commission_bp, 0)            AS aliquota_bp
       FROM finance_entries e
       JOIN finance_payments p ON p.entry_id = e.id
       LEFT JOIN student_contracts c
              ON c.id = e.contract_id
      WHERE e.direction = 'RECEIVABLE'
        AND e.professional_id = $1
        AND e.cancelled_at IS NULL
        AND date_trunc('month', p.paid_at) = date_trunc('month', $2::date)
        AND ${escopo.sql}
      GROUP BY e.id, e.description, e.student_id, e.appointment_id,
               e.amount_cents, c.commission_bp
      ORDER BY e.due_date`,
    values,
  );

  return r.rows.map((row) => ({
    entryId: row.entry_id,
    descricao: row.descricao,
    studentId: row.student_id,
    appointmentId: row.appointment_id,
    valorCentavos: Number(row.valor_centavos),
    recebidoCentavos: Number(row.recebido_centavos),
    aliquotaBp: Number(row.aliquota_bp),
  }));
}

/* --------------------------------------------------------------------
 * Painel
 * ------------------------------------------------------------------ */

export interface ResumoFinanceiro {
  aReceberCentavos: Cents;
  recebidoCentavos: Cents;
  aPagarCentavos: Cents;
  pagoCentavos: Cents;
  inadimplenteCentavos: Cents;
  inadimplentesQtd: number;
}

export async function resumoDoPeriodo(
  client: TenantClient,
  de: Date,
  ate: Date,
): Promise<ResumoFinanceiro> {
  const r = await client.query<ResumoFinanceiro>(
    `SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE direction='RECEIVABLE'), 0)::bigint AS "aReceberCentavos",
       COALESCE(SUM(paid_cents)   FILTER (WHERE direction='RECEIVABLE'), 0)::bigint AS "recebidoCentavos",
       COALESCE(SUM(amount_cents) FILTER (WHERE direction='PAYABLE'), 0)::bigint    AS "aPagarCentavos",
       COALESCE(SUM(paid_cents)   FILTER (WHERE direction='PAYABLE'), 0)::bigint    AS "pagoCentavos",
       COALESCE(SUM(amount_cents - paid_cents)
                FILTER (WHERE direction='RECEIVABLE' AND due_date < CURRENT_DATE
                          AND status <> 'PAID'), 0)::bigint                          AS "inadimplenteCentavos",
       count(*) FILTER (WHERE direction='RECEIVABLE' AND due_date < CURRENT_DATE
                          AND status <> 'PAID')::int                                 AS "inadimplentesQtd"
     FROM finance_entries
     WHERE due_date BETWEEN $1::date AND $2::date
       AND cancelled_at IS NULL`,
    [de, ate],
  );

  const linha = r.rows[0];
  return {
    aReceberCentavos: Number(linha?.aReceberCentavos ?? 0),
    recebidoCentavos: Number(linha?.recebidoCentavos ?? 0),
    aPagarCentavos: Number(linha?.aPagarCentavos ?? 0),
    pagoCentavos: Number(linha?.pagoCentavos ?? 0),
    inadimplenteCentavos: Number(linha?.inadimplenteCentavos ?? 0),
    inadimplentesQtd: Number(linha?.inadimplentesQtd ?? 0),
  };
}
