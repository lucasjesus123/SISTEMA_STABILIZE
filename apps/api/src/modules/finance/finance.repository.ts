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
  /* De qual conta fixa esta linha nasceu, se nasceu de alguma. A lista
     precisa disso para dizer "repete" na própria linha: sem a marca, o
     aluguel de agosto e um aluguel digitado à mão são visualmente a
     mesma coisa, e quem apaga um deles não sabe que o do mês que vem
     volta sozinho. */
  recurrence_id: string | null;
  contract_id: string | null;
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
            e.installment_no, e.installment_total,
            e.recurrence_id, e.contract_id
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
  /** Qual parcela é esta, quando o lançamento foi parcelado. */
  readonly parcelaNumero?: number | undefined;
  readonly parcelaTotal?: number | undefined;
}

export async function criarLancamento(
  client: TenantClient,
  tenantId: string,
  input: CriarLancamentoInput,
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO finance_entries
       (tenant_id, direction, description, category, amount_cents, due_date,
        competence_date, student_id, professional_id, supplier_name, notes, created_by,
        installment_no, installment_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
      input.parcelaNumero ?? null,
      input.parcelaTotal ?? null,
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
    /** Quanto do valor recebido é juros/multa. Entra no caixa e NÃO
     *  abate a dívida original — ver a migração 036. */
    acrescimoCentavos?: Cents | undefined;
    /** Quanto foi perdoado. NÃO entra no caixa e abate a dívida. */
    descontoCentavos?: Cents | undefined;
  },
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO finance_payments
       (tenant_id, entry_id, amount_cents, method, paid_at, reference, recorded_by,
        acrescimo_cents, desconto_cents)
     VALUES ($1,$2,$3,$4::payment_method,COALESCE($5, now()),$6,$7,$8,$9)
     RETURNING id`,
    [
      tenantId,
      input.entryId,
      input.valorCentavos,
      input.metodo,
      input.pagoEm ?? null,
      input.referencia ?? null,
      input.registradoPor,
      input.acrescimoCentavos ?? 0,
      input.descontoCentavos ?? 0,
    ],
  );
  return r.rows[0]!;
}

export interface PagamentoRegistrado {
  id: string;
  valorCentavos: number;
  acrescimoCentavos: number;
  descontoCentavos: number;
  metodo: string;
  pagoEm: Date;
  referencia: string | null;
  registradoPor: string | null;
}

/**
 * As baixas de um lançamento, da mais recente para a mais antiga.
 *
 * ISTO FALTAVA, e a falta não era de uma lista: era do ESTORNO. A rota
 * que apaga um pagamento existe desde sempre e nenhuma tela a alcançava,
 * porque nenhuma tela tinha como saber o `id` da baixa. Quem digitou o
 * valor errado no balcão ficava com o erro no caixa para sempre.
 *
 * QUEM REGISTROU ENTRA NA LISTA porque é a primeira pergunta de quem
 * encontra uma baixa estranha — e a resposta não deveria exigir abrir a
 * auditoria.
 */
export async function listarPagamentos(
  client: TenantClient,
  entryId: string,
): Promise<PagamentoRegistrado[]> {
  const { rows } = await client.query<{
    id: string;
    amount_cents: string;
    acrescimo_cents: string;
    desconto_cents: string;
    method: string;
    paid_at: Date;
    reference: string | null;
    quem: string | null;
  }>(
    `SELECT p.id, p.amount_cents, p.acrescimo_cents, p.desconto_cents,
            p.method::text AS method, p.paid_at, p.reference,
            u.full_name AS quem
       FROM finance_payments p
       LEFT JOIN users u ON u.id = p.recorded_by
      WHERE p.entry_id = $1
      ORDER BY p.paid_at DESC, p.id DESC`,
    [entryId],
  );

  return rows.map((r) => ({
    id: r.id,
    valorCentavos: Number(r.amount_cents),
    acrescimoCentavos: Number(r.acrescimo_cents),
    descontoCentavos: Number(r.desconto_cents),
    metodo: r.method,
    pagoEm: r.paid_at,
    referencia: r.reference,
    registradoPor: r.quem,
  }));
}

/**
 * Estorna uma baixa. O gatilho recalcula o saldo para trás.
 *
 * DEVOLVE O QUE APAGOU, e não um `true`. Depois deste DELETE a linha não
 * existe mais em lugar nenhum: a auditoria é o ÚNICO registro de que
 * aquele dinheiro um dia entrou. Um log que diz apenas "estornou o
 * pagamento tal" não responde a pergunta que se faz seis meses depois —
 * de quanto era e de qual conta saiu.
 */
export async function estornarPagamento(
  client: TenantClient,
  paymentId: string,
): Promise<{ entryId: string; valorCentavos: number; metodo: string } | null> {
  const r = await client.query<{ entry_id: string; amount_cents: string; method: string }>(
    `DELETE FROM finance_payments WHERE id = $1
      RETURNING entry_id, amount_cents, method::text AS method`,
    [paymentId],
  );
  const linha = r.rows[0];
  if (linha === undefined) return null;
  return {
    entryId: linha.entry_id,
    valorCentavos: Number(linha.amount_cents),
    metodo: linha.method,
  };
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
    /* O NOME DO ALUNO ENTRA NA DESCRIÇÃO, e não fica só no `student_id`.
       A memória de cálculo é o que o profissional confere linha a linha,
       e sete linhas escritas "Mensalidade agosto de 2026" não são
       conferíveis: ele não tem como saber se falta alguém. Com o nome,
       ele bate a lista contra os próprios alunos em dez segundos.

       Colado na descrição de propósito: `commission_items` COPIA este
       texto ao fechar, e o fechamento precisa continuar contando a mesma
       história se o aluno for renomeado ou desligado depois. */
    `SELECT e.id                       AS entry_id,
            e.description || coalesce(' · ' || al.full_name, '') AS descricao,
            e.student_id,
            e.appointment_id,
            e.amount_cents             AS valor_centavos,
            /* A COMISSÃO NÃO INCIDE SOBRE JUROS E MULTA.

               amount_cents é o dinheiro que entrou, e desde a
               migração 036 ele pode conter multa por atraso. Multa é
               indenização da academia pelo atraso — não é pagamento do
               atendimento, e o professor não atendeu mais por causa
               dela. Somá-la aqui daria ao profissional uma parte de um
               dinheiro que não é da prestação de serviço.

               O DESCONTO, ao contrário, é subtraído: entrou menos, e a
               comissão acompanha o que entrou. É uma escolha de
               negócio, não uma verdade contábil — a academia pode
               decidir absorver o desconto sozinha, e nesse dia esta é
               a linha que muda. */
            COALESCE(SUM(p.amount_cents - p.acrescimo_cents), 0)::bigint AS recebido_centavos,
            COALESCE(c.commission_bp, 0)            AS aliquota_bp
       FROM finance_entries e
       JOIN finance_payments p ON p.entry_id = e.id
       LEFT JOIN students al ON al.id = e.student_id
       LEFT JOIN student_contracts c
              ON c.id = e.contract_id
      WHERE e.direction = 'RECEIVABLE'
        AND e.professional_id = $1
        AND e.cancelled_at IS NULL
        AND date_trunc('month', p.paid_at) = date_trunc('month', $2::date)
        AND ${escopo.sql}
      GROUP BY e.id, e.description, al.full_name, e.student_id, e.appointment_id,
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

/* --------------------------------------------------------------------
 * Contas fixas — o molde que faz o lançamento nascer sozinho
 *
 * A tabela `finance_recurrences` existe desde o primeiro esquema e
 * nunca teve uma linha: o financeiro só sabia o que alguém tinha
 * digitado à mão naquele mês. As funções abaixo são o CRUD dela; quem
 * materializa os lançamentos é `contas-fixas.ts`.
 * ------------------------------------------------------------------ */

export interface ContaFixa {
  id: string;
  direcao: Direcao;
  descricao: string;
  categoria: string | null;
  valorCentavos: number;
  ciclo: string;
  diaDeCobranca: number;
  aluno: string | null;
  studentId: string | null;
  contraparte: string | null;
  inicio: string;
  fim: string | null;
  ativa: boolean;
  /** Quantos lançamentos já nasceram deste molde. */
  geradas: number;
  /** Deste molde, quantos venceram e continuam abertos. */
  vencidasAbertas: number;
  /** A próxima data em que ela vence, se ainda houver uma. */
  proximoVencimento: string | null;
}

export async function listarContasFixas(
  client: TenantClient,
  direcao?: Direcao,
): Promise<ContaFixa[]> {
  const { rows } = await client.query<{
    id: string;
    direcao: Direcao;
    descricao: string;
    categoria: string | null;
    valor: string;
    ciclo: string;
    dia: number;
    aluno: string | null;
    student_id: string | null;
    contraparte: string | null;
    inicio: string;
    fim: string | null;
    ativa: boolean;
    geradas: number;
    vencidas: number;
    proximo: string | null;
  }>(
    `WITH hoje AS (
       SELECT (now() AT TIME ZONE t.timezone)::date AS d
         FROM tenants t WHERE t.id = current_tenant_id()
     )
     SELECT r.id, r.direction AS direcao, r.description AS descricao,
            r.category AS categoria, r.amount_cents::text AS valor,
            r.cycle::text AS ciclo, r.billing_day AS dia,
            s.full_name AS aluno, r.student_id,
            r.supplier_name AS contraparte,
            r.starts_on::text AS inicio, r.ends_on::text AS fim,
            r.is_active AS ativa,
            (SELECT count(*) FROM finance_entries e
              WHERE e.recurrence_id = r.id AND e.cancelled_at IS NULL)::int AS geradas,
            (SELECT count(*) FROM finance_entries e
              WHERE e.recurrence_id = r.id AND e.cancelled_at IS NULL
                AND e.status <> 'PAID' AND e.due_date < (SELECT d FROM hoje))::int AS vencidas,
            (SELECT min(e.due_date)::text FROM finance_entries e
              WHERE e.recurrence_id = r.id AND e.cancelled_at IS NULL
                AND e.status <> 'PAID') AS proximo
       FROM finance_recurrences r
       LEFT JOIN students s ON s.id = r.student_id
      WHERE ($1::text IS NULL OR r.direction::text = $1)
      ORDER BY r.is_active DESC, r.billing_day, r.description`,
    [direcao ?? null],
  );

  return rows.map((r) => ({
    id: r.id,
    direcao: r.direcao,
    descricao: r.descricao,
    categoria: r.categoria,
    valorCentavos: Number(r.valor),
    ciclo: r.ciclo,
    diaDeCobranca: r.dia,
    aluno: r.aluno,
    studentId: r.student_id,
    contraparte: r.contraparte,
    inicio: r.inicio,
    fim: r.fim,
    ativa: r.ativa,
    geradas: r.geradas,
    vencidasAbertas: r.vencidas,
    proximoVencimento: r.proximo,
  }));
}

export interface CriarContaFixaInput {
  readonly direcao: Direcao;
  readonly descricao: string;
  readonly categoria?: string | undefined;
  readonly valorCentavos: Cents;
  readonly ciclo: string;
  readonly diaDeCobranca: number;
  readonly studentId?: string | undefined;
  readonly contraparte?: string | undefined;
  readonly inicio: Date;
  readonly fim?: Date | undefined;
}

export async function criarContaFixa(
  client: TenantClient,
  tenantId: string,
  input: CriarContaFixaInput,
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO finance_recurrences
       (tenant_id, direction, description, category, amount_cents, cycle,
        billing_day, student_id, supplier_name, starts_on, ends_on)
     VALUES ($1,$2,$3,$4,$5,$6::billing_cycle,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      tenantId,
      input.direcao,
      input.descricao,
      input.categoria ?? null,
      input.valorCentavos,
      input.ciclo,
      input.diaDeCobranca,
      input.studentId ?? null,
      input.contraparte ?? null,
      input.inicio,
      input.fim ?? null,
    ],
  );
  return r.rows[0]!;
}

/**
 * Altera o molde. O que já nasceu dele NÃO muda.
 *
 * É a decisão que evita reescrever história: subir o aluguel de 2.500
 * para 2.700 vale do mês que vem em diante, e não faz o mês passado —
 * que já foi pago — virar outro número no extrato.
 */
export async function alterarContaFixa(
  client: TenantClient,
  id: string,
  campos: Partial<{
    descricao: string;
    categoria: string | null;
    valorCentavos: Cents;
    ciclo: string;
    diaDeCobranca: number;
    contraparte: string | null;
    fim: Date | null;
    ativa: boolean;
  }>,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const põe = (coluna: string, valor: unknown, molde = ''): void => {
    values.push(valor);
    sets.push(`${coluna} = $${values.length}${molde}`);
  };

  if (campos.descricao !== undefined) põe('description', campos.descricao);
  if (campos.categoria !== undefined) põe('category', campos.categoria);
  if (campos.valorCentavos !== undefined) põe('amount_cents', campos.valorCentavos);
  if (campos.ciclo !== undefined) põe('cycle', campos.ciclo, '::billing_cycle');
  if (campos.diaDeCobranca !== undefined) põe('billing_day', campos.diaDeCobranca);
  if (campos.contraparte !== undefined) põe('supplier_name', campos.contraparte);
  if (campos.fim !== undefined) põe('ends_on', campos.fim);
  if (campos.ativa !== undefined) põe('is_active', campos.ativa);

  if (sets.length === 0) return true;

  const r = await client.query(
    `UPDATE finance_recurrences SET ${sets.join(', ')} WHERE id = $1`,
    values,
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Apaga o molde.
 *
 * Os lançamentos já gerados FICAM — a FK é `ON DELETE SET NULL`, então
 * eles perdem o vínculo e continuam sendo contas normais. Apagar o
 * aluguel do cadastro não pode fazer sumir do caixa os seis meses que já
 * foram pagos.
 */
export async function excluirContaFixa(client: TenantClient, id: string): Promise<boolean> {
  const r = await client.query('DELETE FROM finance_recurrences WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}


/**
 * Corrige um lançamento já emitido.
 *
 * O QUE NÃO SE PODE MEXER: a direção e o vínculo. Uma despesa não vira
 * cobrança por edição — os dois lados do caixa já contaram esse valor no
 * saldo, e trocar o sinal de uma linha antiga reescreve o fechamento de
 * um mês que alguém já leu. Quem errou o lado exclui e lança de novo.
 *
 * O VALOR NÃO PODE CAIR ABAIXO DO QUE JÁ FOI PAGO. O banco recusa por
 * CHECK (`entry_not_overpaid`), e é bom que recuse — mas a mensagem dele
 * fala de restrição, não do que fazer. Quem baixou R$ 300 e quer
 * corrigir o total para R$ 200 precisa estornar a baixa primeiro.
 *
 * EDITAR UM LANÇAMENTO QUE NASCEU DE UMA CONTA FIXA vale só para ELE. O
 * molde continua o que era, e o mês que vem nasce igual — é a mesma
 * regra de "mudar o molde não reescreve o passado", vista do outro lado.
 */
export async function alterarLancamento(
  client: TenantClient,
  id: string,
  campos: Partial<{
    descricao: string;
    categoria: string | null;
    valorCentavos: Cents;
    vencimento: Date;
    competencia: Date | null;
    contraparte: string | null;
    observacao: string | null;
  }>,
): Promise<{ ok: boolean; motivo?: string }> {
  const atual = await client.query<{ paid_cents: string; cancelled_at: string | null }>(
    'SELECT paid_cents::text, cancelled_at FROM finance_entries WHERE id = $1',
    [id],
  );
  const linha = atual.rows[0];
  if (linha === undefined) return { ok: false };

  if (linha.cancelled_at !== null) {
    return { ok: false, motivo: 'Este lançamento foi cancelado e não pode mais ser alterado.' };
  }

  const pago = Number(linha.paid_cents);
  if (campos.valorCentavos !== undefined && campos.valorCentavos < pago) {
    return {
      ok: false,
      motivo:
        `Já foram baixados ${(pago / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} ` +
        'neste lançamento. Estorne o pagamento antes de reduzir o valor.',
    };
  }

  const sets: string[] = [];
  const values: unknown[] = [id];
  const põe = (coluna: string, valor: unknown): void => {
    values.push(valor);
    sets.push(`${coluna} = $${values.length}`);
  };

  if (campos.descricao !== undefined) põe('description', campos.descricao);
  if (campos.categoria !== undefined) põe('category', campos.categoria);
  if (campos.valorCentavos !== undefined) põe('amount_cents', campos.valorCentavos);
  if (campos.vencimento !== undefined) põe('due_date', campos.vencimento);
  if (campos.competencia !== undefined) põe('competence_date', campos.competencia);
  if (campos.contraparte !== undefined) põe('supplier_name', campos.contraparte);
  if (campos.observacao !== undefined) põe('notes', campos.observacao);

  if (sets.length === 0) return { ok: true };

  const r = await client.query(
    `UPDATE finance_entries SET ${sets.join(', ')} WHERE id = $1 AND cancelled_at IS NULL`,
    values,
  );
  if ((r.rowCount ?? 0) === 0) return { ok: false };

  /* O STATUS É DERIVADO do valor e do vencimento, e quem o mantinha era
     o gatilho sobre `finance_payments`. Mudar o valor ou a data por aqui
     não passa por lá: uma conta que vencia amanhã e passou a vencer
     ontem continuaria "em aberto" na tela até alguém dar uma baixa nela.
     Recalculado pelo MESMO critério, para os dois nunca discordarem. */
  await client.query(
    `UPDATE finance_entries
        SET status = CASE
              WHEN cancelled_at IS NOT NULL      THEN 'CANCELLED'::entry_status
              WHEN paid_cents >= amount_cents    THEN 'PAID'::entry_status
              WHEN paid_cents > 0                THEN 'PARTIALLY_PAID'::entry_status
              WHEN due_date < CURRENT_DATE       THEN 'OVERDUE'::entry_status
              ELSE 'OPEN'::entry_status
            END
      WHERE id = $1`,
    [id],
  );

  return { ok: true };
}

/**
 * Cancela um lançamento.
 *
 * CANCELA, NÃO APAGA. A linha sai das listas e das somas — o gatilho de
 * 034 põe o status em CANCELLED — e continua existindo para quem for
 * auditar o mês. Apagar de verdade deixaria um buraco na sequência do
 * extrato que ninguém consegue explicar depois.
 *
 * COM BAIXA, NÃO CANCELA. O dinheiro já entrou ou saiu; cancelar deixaria
 * no caixa um pagamento sem conta que o justifique. Estorna-se a baixa
 * primeiro — uma etapa a mais, e a que deixa rastro.
 */
export async function cancelarLancamento(
  client: TenantClient,
  id: string,
): Promise<{ ok: boolean; motivo?: string }> {
  const atual = await client.query<{ paid_cents: string; cancelled_at: string | null }>(
    'SELECT paid_cents::text, cancelled_at FROM finance_entries WHERE id = $1',
    [id],
  );
  const linha = atual.rows[0];
  if (linha === undefined) return { ok: false };
  if (linha.cancelled_at !== null) return { ok: true };

  if (Number(linha.paid_cents) > 0) {
    return {
      ok: false,
      motivo:
        'Este lançamento já teve baixa. Estorne o pagamento antes de excluí-lo — senão o caixa fica com um pagamento sem conta que o explique.',
    };
  }

  await client.query('UPDATE finance_entries SET cancelled_at = now() WHERE id = $1', [id]);
  return { ok: true };
}

/* --------------------------------------------------------------------
 * PREVISÃO — o que ainda não existe, e vai existir
 *
 * O BURACO QUE ISTO FECHA. Os lançamentos recorrentes são
 * materializados até o mês corrente, e não além: uma conta a pagar
 * criada com um ano de antecedência ficaria congelada no valor de hoje,
 * e subir o aluguel em março não mudaria os onze meses já emitidos —
 * exatamente o contrário do que se espera do futuro.
 *
 * Só que a consequência disso era a tela dizer "Nada neste mês" em
 * setembro para uma academia com R$ 4.567 de conta fixa por mês. O
 * número estava certo e a resposta estava errada: quem olha o mês que
 * vem quer saber o que vai ter de pagar, e "nada" é a única resposta
 * que aquela tela não podia dar.
 *
 * A SAÍDA NÃO É MATERIALIZAR O FUTURO, é CALCULÁ-LO na hora. O que vem
 * daqui não é um lançamento: é a projeção dele. Não tem id, não recebe
 * baixa e sai da tela no instante em que o molde muda — que é
 * precisamente o comportamento certo para uma conta que ainda não
 * venceu.
 * ------------------------------------------------------------------ */

export interface LinhaPrevista {
  /** Sempre `null`: previsão não é lançamento e não tem identidade. */
  readonly id: null;
  readonly direcao: Direcao;
  readonly descricao: string;
  readonly categoria: string | null;
  readonly valorCentavos: number;
  readonly vencimento: string;
  readonly contraparte: string | null;
  /** De onde a projeção veio — para a tela saber onde mandar quem quer mexer. */
  readonly origem: 'CONTA_FIXA' | 'CONTRATO';
  readonly origemId: string;
}

/**
 * O que ainda vai nascer no mês, e ainda não nasceu.
 *
 * EXCLUI O QUE JÁ EXISTE. Uma conta fixa cujo lançamento do mês já foi
 * gerado não aparece aqui — senão o total do mês contaria o aluguel duas
 * vezes, uma como lançamento e outra como previsão. É a mesma chave da
 * idempotência da geração: (molde, competência).
 */
export async function previsaoDoMes(
  client: TenantClient,
  mes: Date,
  direcao?: Direcao,
): Promise<LinhaPrevista[]> {
  const { rows: fixas } = await client.query<{
    origem_id: string;
    direcao: Direcao;
    descricao: string;
    categoria: string | null;
    valor: string;
    vence: string;
    contraparte: string | null;
  }>(
    `WITH alvo AS (SELECT date_trunc('month', $1::date)::date AS m)
     SELECT r.id AS origem_id, r.direction AS direcao,
            r.description || ' ' || to_char(a.m, 'MM/YYYY') AS descricao,
            r.category AS categoria, r.amount_cents::text AS valor,
            GREATEST(
              (a.m + (r.billing_day - 1) * INTERVAL '1 day')::date,
              r.starts_on
            )::text AS vence,
            COALESCE(s.full_name, r.supplier_name) AS contraparte
       FROM finance_recurrences r
       CROSS JOIN alvo a
       LEFT JOIN students s ON s.id = r.student_id
      WHERE r.is_active
        AND r.amount_cents > 0
        AND ($2::text IS NULL OR r.direction::text = $2)
        AND a.m >= date_trunc('month', r.starts_on)
        /* O passo do ciclo, contado em MESES a partir do início — a
           mesma conta da geração, para a previsão e o que nasce nunca
           discordarem sobre em qual mês a conta cai. */
        AND MOD(
              (EXTRACT(YEAR FROM a.m)::int * 12 + EXTRACT(MONTH FROM a.m)::int)
              - (EXTRACT(YEAR FROM r.starts_on)::int * 12 + EXTRACT(MONTH FROM r.starts_on)::int),
              CASE r.cycle::text
                WHEN 'MONTHLY' THEN 1 WHEN 'QUARTERLY' THEN 3
                WHEN 'SEMIANNUAL' THEN 6 WHEN 'ANNUAL' THEN 12 ELSE 1
              END
            ) = 0
        AND r.cycle::text IN ('MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL')
        AND (r.ends_on IS NULL OR a.m <= date_trunc('month', r.ends_on)::date)
        AND NOT EXISTS (
          SELECT 1 FROM finance_entries e
           WHERE e.recurrence_id = r.id
             AND e.competence_date = a.m
             AND e.cancelled_at IS NULL
        )`,
    [mes, direcao ?? null],
  );

  /* A MENSALIDADE DO ALUNO É A OUTRA METADE DA PERGUNTA. "Quanto eu tenho
     para receber no mês que vem" só tem resposta com ela — as contas
     fixas a receber são a exceção numa academia, e o contrato é a regra. */
  const { rows: contratos } =
    direcao === 'PAYABLE'
      ? { rows: [] as typeof fixas }
      : await client.query<{
          origem_id: string;
          direcao: Direcao;
          descricao: string;
          categoria: string | null;
          valor: string;
          vence: string;
          contraparte: string | null;
        }>(
          `WITH alvo AS (SELECT date_trunc('month', $1::date)::date AS m)
           SELECT c.id AS origem_id, 'RECEIVABLE'::entry_direction AS direcao,
                  'Mensalidade ' || to_char(a.m, 'MM/YYYY') AS descricao,
                  'Mensalidade' AS categoria, c.amount_cents::text AS valor,
                  GREATEST(
                    (a.m + (COALESCE(c.billing_day, 10) - 1) * INTERVAL '1 day')::date,
                    c.starts_on
                  )::text AS vence,
                  s.full_name AS contraparte
             FROM student_contracts c
             JOIN students s ON s.id = c.student_id
             CROSS JOIN alvo a
            WHERE c.is_active
              AND c.cycle = 'MONTHLY'
              AND c.amount_cents > 0
              AND a.m >= date_trunc('month', c.starts_on)
              /* PEDIU PARA SAIR não entra na previsão: o contrato vale
                 até o fim do período pago e não gera cobrança nova. */
              AND NOT c.encerrar_no_fim_do_periodo
              AND (c.ends_on IS NULL OR a.m <= date_trunc('month', c.ends_on)::date)
              AND s.status IN ('ACTIVE', 'LEAD')
              AND NOT EXISTS (
                SELECT 1 FROM finance_entries e
                 WHERE e.contract_id = c.id
                   AND e.competence_date = a.m
                   AND e.cancelled_at IS NULL
              )`,
          [mes],
        );

  const converter = (
    r: (typeof fixas)[number],
    origem: 'CONTA_FIXA' | 'CONTRATO',
  ): LinhaPrevista => ({
    id: null,
    direcao: r.direcao,
    descricao: r.descricao,
    categoria: r.categoria,
    valorCentavos: Number(r.valor),
    vencimento: r.vence,
    contraparte: r.contraparte,
    origem,
    origemId: r.origem_id,
  });

  return [
    ...fixas.map((r) => converter(r, 'CONTA_FIXA')),
    ...contratos.map((r) => converter(r, 'CONTRATO')),
  ].sort((a, b) => a.vencimento.localeCompare(b.vencimento));
}
