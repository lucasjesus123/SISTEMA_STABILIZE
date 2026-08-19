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
  venceHojeCentavos: Cents;
  venceHojeQtd: number;
}

export async function resumoDoPeriodo(
  client: TenantClient,
  de: Date,
  ate: Date,
): Promise<ResumoFinanceiro> {
  const r = await client.query<ResumoFinanceiro>(
    /* O "HOJE" É O DA ACADEMIA, NÃO O DO SERVIDOR.
       `CURRENT_DATE` numa VPS em UTC vira o dia seguinte às 21h de
       Brasília: às nove da noite o dono via as contas de hoje saltarem
       para "vencidas" sozinhas, na frente dele. */
    `WITH hoje AS (
       SELECT (now() AT TIME ZONE t.timezone)::date AS d
         FROM tenants t WHERE t.id = current_tenant_id()
     )
     SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE direction='RECEIVABLE'), 0)::bigint AS "aReceberCentavos",
       COALESCE(SUM(paid_cents)   FILTER (WHERE direction='RECEIVABLE'), 0)::bigint AS "recebidoCentavos",
       COALESCE(SUM(amount_cents) FILTER (WHERE direction='PAYABLE'), 0)::bigint    AS "aPagarCentavos",
       COALESCE(SUM(paid_cents)   FILTER (WHERE direction='PAYABLE'), 0)::bigint    AS "pagoCentavos",
       COALESCE(SUM(amount_cents - paid_cents)
                FILTER (WHERE direction='RECEIVABLE' AND due_date < (SELECT d FROM hoje)
                          AND status <> 'PAID'), 0)::bigint                          AS "inadimplenteCentavos",
       count(*) FILTER (WHERE direction='RECEIVABLE' AND due_date < (SELECT d FROM hoje)
                          AND status <> 'PAID')::int                                 AS "inadimplentesQtd",
       /* Vence HOJE e ainda não foi pago: é o número que a recepção
          precisa antes de abrir a porta. */
       COALESCE(SUM(amount_cents - paid_cents)
                FILTER (WHERE direction='RECEIVABLE' AND due_date = (SELECT d FROM hoje)
                          AND status <> 'PAID'), 0)::bigint                          AS "venceHojeCentavos",
       count(*) FILTER (WHERE direction='RECEIVABLE' AND due_date = (SELECT d FROM hoje)
                          AND status <> 'PAID')::int                                 AS "venceHojeQtd"
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
    venceHojeCentavos: Number(linha?.venceHojeCentavos ?? 0),
    venceHojeQtd: Number(linha?.venceHojeQtd ?? 0),
  };
}

/* --------------------------------------------------------------------
 * Relatórios
 *
 * Três perguntas, nesta ordem de importância — a mesma ordem que
 * qualquer ERP maduro usa, porque é a ordem em que o dono do negócio
 * pensa: "estou melhorando?", "para onde vai o dinheiro?", "quem eu
 * cobro hoje?".
 * ------------------------------------------------------------------ */

export interface MesDoFluxo {
  mes: string;
  recebidoCentavos: number;
  pagoCentavos: number;
}

/**
 * Entrou × saiu, mês a mês.
 *
 * PELA DATA DO PAGAMENTO, e não pela do lançamento. A pergunta é sobre
 * CAIXA: uma mensalidade de janeiro paga em março entrou em março, e é
 * em março que ela aparece no gráfico. Agrupar pela competência
 * responderia outra pergunta — legítima, mas não esta.
 */
export async function fluxoPorMes(client: TenantClient, meses: number): Promise<MesDoFluxo[]> {
  const { rows } = await client.query<{
    mes: string;
    recebido: string;
    pago: string;
  }>(
    `WITH janela AS (
       SELECT date_trunc('month', (now() AT TIME ZONE t.timezone))::date AS fim
         FROM tenants t WHERE t.id = current_tenant_id()
     ),
     meses AS (
       SELECT (SELECT fim FROM janela) - (n * INTERVAL '1 month') AS inicio
         FROM generate_series(0, $1::int - 1) AS n
     )
     SELECT to_char(m.inicio, 'YYYY-MM') AS mes,
            COALESCE(SUM(p.amount_cents) FILTER (WHERE e.direction = 'RECEIVABLE'), 0)::text AS recebido,
            COALESCE(SUM(p.amount_cents) FILTER (WHERE e.direction = 'PAYABLE'), 0)::text AS pago
       FROM meses m
       LEFT JOIN finance_payments p
              ON date_trunc('month', p.paid_at) = date_trunc('month', m.inicio)
       LEFT JOIN finance_entries e ON e.id = p.entry_id
      GROUP BY m.inicio
      ORDER BY m.inicio`,
    [meses],
  );

  return rows.map((r) => ({
    mes: r.mes,
    recebidoCentavos: Number(r.recebido),
    pagoCentavos: Number(r.pago),
  }));
}

export interface LinhaDeCategoria {
  categoria: string;
  direcao: Direcao;
  totalCentavos: number;
  quantidade: number;
}

/** Para onde vai o dinheiro. Sem categoria vira "sem categoria", e não
    some: a fatia sem nome costuma ser a maior, e escondê-la faz o
    gráfico mentir por omissão. */
export async function porCategoria(
  client: TenantClient,
  de: Date,
  ate: Date,
): Promise<LinhaDeCategoria[]> {
  const { rows } = await client.query<{
    categoria: string;
    direction: Direcao;
    total: string;
    quantidade: number;
  }>(
    `SELECT COALESCE(NULLIF(btrim(e.category), ''), 'Sem categoria') AS categoria,
            e.direction,
            COALESCE(SUM(p.amount_cents), 0)::text AS total,
            count(DISTINCT e.id)::int AS quantidade
       FROM finance_entries e
       JOIN finance_payments p ON p.entry_id = e.id
      WHERE p.paid_at::date BETWEEN $1::date AND $2::date
        AND e.cancelled_at IS NULL
      GROUP BY 1, 2
     HAVING SUM(p.amount_cents) > 0
      ORDER BY SUM(p.amount_cents) DESC`,
    [de, ate],
  );

  return rows.map((r) => ({
    categoria: r.categoria,
    direcao: r.direction,
    totalCentavos: Number(r.total),
    quantidade: r.quantidade,
  }));
}

export interface Inadimplente {
  studentId: string;
  nome: string;
  telefone: string | null;
  devendoCentavos: number;
  cobrancas: number;
  diasDeAtraso: number;
}

/**
 * Quem eu cobro hoje.
 *
 * ORDENADO POR DIAS DE ATRASO, não por valor. Quem deve R$ 200 há seis
 * meses é um problema diferente de quem deve R$ 800 desde ontem — e a
 * lista existe para virar ligação, não para somar.
 */
export async function inadimplentes(client: TenantClient): Promise<Inadimplente[]> {
  const { rows } = await client.query<{
    student_id: string;
    nome: string;
    telefone: string | null;
    devendo: string;
    cobrancas: number;
    dias: number;
  }>(
    `WITH hoje AS (
       SELECT (now() AT TIME ZONE t.timezone)::date AS d
         FROM tenants t WHERE t.id = current_tenant_id()
     )
     SELECT e.student_id, s.full_name AS nome,
            COALESCE(s.whatsapp, s.phone) AS telefone,
            SUM(e.amount_cents - e.paid_cents)::text AS devendo,
            count(*)::int AS cobrancas,
            ((SELECT d FROM hoje) - MIN(e.due_date))::int AS dias
       FROM finance_entries e
       JOIN students s ON s.id = e.student_id
      WHERE e.direction = 'RECEIVABLE'
        AND e.cancelled_at IS NULL
        AND e.status <> 'PAID'
        AND e.due_date < (SELECT d FROM hoje)
      GROUP BY e.student_id, s.full_name, s.whatsapp, s.phone
      ORDER BY dias DESC
      LIMIT 200`,
  );

  return rows.map((r) => ({
    studentId: r.student_id,
    nome: r.nome,
    telefone: r.telefone,
    devendoCentavos: Number(r.devendo),
    cobrancas: r.cobrancas,
    diasDeAtraso: r.dias,
  }));
}

/** Os contratos que geram cobrança sozinhos — a aba "Recorrências". */
export interface Recorrencia {
  contratoId: string;
  studentId: string;
  aluno: string;
  ciclo: string;
  valorCentavos: number;
  diaDeCobranca: number | null;
  profissional: string | null;
  desde: string;
  encerrandoNoFim: boolean;
  vencidasAbertas: number;
}

export async function listarRecorrencias(client: TenantClient): Promise<Recorrencia[]> {
  const { rows } = await client.query<{
    contrato: string;
    student_id: string;
    aluno: string;
    ciclo: string;
    valor: string;
    dia: number | null;
    profissional: string | null;
    desde: string;
    encerrando: boolean;
    vencidas: number;
  }>(
    `WITH hoje AS (
       SELECT (now() AT TIME ZONE t.timezone)::date AS d
         FROM tenants t WHERE t.id = current_tenant_id()
     )
     SELECT c.id AS contrato, c.student_id, s.full_name AS aluno,
            c.cycle::text AS ciclo, c.amount_cents::text AS valor,
            c.billing_day AS dia, u.full_name AS profissional,
            c.starts_on::text AS desde,
            c.encerrar_no_fim_do_periodo AS encerrando,
            (SELECT count(*) FROM finance_entries v
              WHERE v.contract_id = c.id AND v.cancelled_at IS NULL
                AND v.status <> 'PAID' AND v.due_date < (SELECT d FROM hoje))::int AS vencidas
       FROM student_contracts c
       JOIN students s ON s.id = c.student_id
       LEFT JOIN users u ON u.id = c.professional_id
      WHERE c.is_active
      ORDER BY s.full_name`,
  );

  return rows.map((r) => ({
    contratoId: r.contrato,
    studentId: r.student_id,
    aluno: r.aluno,
    ciclo: r.ciclo,
    valorCentavos: Number(r.valor),
    diaDeCobranca: r.dia,
    profissional: r.profissional,
    desde: r.desde,
    encerrandoNoFim: r.encerrando,
    vencidasAbertas: r.vencidas,
  }));
}
