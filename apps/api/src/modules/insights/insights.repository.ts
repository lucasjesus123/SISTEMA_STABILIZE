import type { Cents } from '@stabilize/shared';
import type { TenantClient } from '../../db/pool.js';

/**
 * Indicadores de gestão.
 *
 * Estes são os números pelos quais uma academia é realmente
 * administrada, e não aparecem no extrato: churn, tempo médio de vida,
 * ticket médio, LTV e — o mais acionável de todos — quem está prestes a
 * sair.
 *
 * Duas regras que valem para o arquivo inteiro:
 *
 * 1. TODO indicador devolve o NUMERADOR e o DENOMINADOR, não só o
 *    percentual. "Churn de 8%" com base de 12 alunos é ruído
 *    estatístico; com base de 400 é uma emergência. Um painel que
 *    mostra só a porcentagem esconde essa diferença e leva o dono a
 *    reagir a barulho.
 *
 * 2. Nada de média sobre média. Ticket médio é receita total dividida
 *    por alunos pagantes — não a média dos tickets individuais, que dá
 *    resultado diferente e errado quando os planos têm valores
 *    distintos.
 */

export interface IndicadoresGestao {
  /* --- Base de alunos --- */
  ativos: number;
  inativos: number;
  novosNoMes: number;
  saidasNoMes: number;

  /* --- Evasão ---
     O benchmark brasileiro fica entre 3% e 5% ao mês; abaixo de 3% é
     bom, acima de 7% indica problema sério de experiência. Guardamos a
     base para o número ser interpretável. */
  churnPercentual: number | null;
  churnBase: number;

  /* --- Dinheiro --- */
  receitaMesCentavos: Cents;
  ticketMedioCentavos: Cents | null;
  alunosPagantes: number;
  tempoMedioVidaMeses: number | null;
  ltvCentavos: Cents | null;

  /* --- Inadimplência --- */
  inadimplentes: number;
  inadimplenciaCentavos: Cents;

  /* --- Frequência --- */
  presencasNoMes: number;
  faltasNoMes: number;
  frequenciaMediaPorAluno: number | null;
  taxaComparecimentoPercentual: number | null;
}

export async function indicadoresDoMes(
  client: TenantClient,
  referencia: Date,
): Promise<IndicadoresGestao> {
  const r = await client.query<Record<string, string | number | null>>(
    `
    WITH periodo AS (
      SELECT date_trunc('month', $1::date)::date            AS ini,
             (date_trunc('month', $1::date) + interval '1 month - 1 day')::date AS fim
    ),
    base AS (
      SELECT
        count(*) FILTER (WHERE status = 'ACTIVE')::int   AS ativos,
        count(*) FILTER (WHERE status <> 'ACTIVE')::int  AS inativos,
        count(*) FILTER (
          WHERE started_at BETWEEN (SELECT ini FROM periodo) AND (SELECT fim FROM periodo)
        )::int                                            AS novos,
        count(*) FILTER (
          WHERE ended_at BETWEEN (SELECT ini FROM periodo) AND (SELECT fim FROM periodo)
        )::int                                            AS saidas,
        /* Base do churn é quem estava ativo no INÍCIO do período, não a
           base de hoje. Usar a base final subestima a evasão, porque os
           que saíram já não estão lá para serem contados. */
        count(*) FILTER (
          WHERE started_at < (SELECT ini FROM periodo)
            AND (ended_at IS NULL OR ended_at >= (SELECT ini FROM periodo))
        )::int                                            AS base_inicial
      FROM students
    ),
    vida AS (
      /* Tempo médio de vida em meses, considerando quem já saiu e quem
         continua. Excluir os ativos enviesaria para baixo: os alunos
         mais fiéis são exatamente os que ainda não saíram. */
      /* Subtrair dois valores do tipo date no PostgreSQL devolve
         INTEIRO (dias), não intervalo — EXTRACT(EPOCH FROM ...) sobre
         isso é erro de tipo. Dividir os dias por 30,44 (média de dias
         por mês) é direto e correto.
         (Sem crase neste comentário: ele vive dentro de um template
         literal de TypeScript, e uma crase encerraria a string.) */
      SELECT avg(
               (COALESCE(ended_at, CURRENT_DATE) - started_at) / 30.44
             )::numeric AS meses
        FROM students
       WHERE started_at IS NOT NULL
    ),
    dinheiro AS (
      SELECT
        COALESCE(SUM(p.amount_cents), 0)::bigint AS recebido,
        count(DISTINCT e.student_id)::int        AS pagantes
      FROM finance_payments p
      JOIN finance_entries e ON e.id = p.entry_id
     WHERE e.direction = 'RECEIVABLE'
       AND p.paid_at::date BETWEEN (SELECT ini FROM periodo) AND (SELECT fim FROM periodo)
    ),
    atraso AS (
      SELECT
        count(DISTINCT student_id)::int                       AS qtd,
        COALESCE(SUM(amount_cents - paid_cents), 0)::bigint   AS valor
      FROM finance_entries
     WHERE direction = 'RECEIVABLE'
       AND cancelled_at IS NULL
       AND status <> 'PAID'
       AND due_date < CURRENT_DATE
    ),
    presenca AS (
      SELECT
        count(*) FILTER (WHERE status = 'ATTENDED')::int AS presencas,
        count(*) FILTER (WHERE status = 'NO_SHOW')::int  AS faltas
      FROM appointments
     WHERE lower(period)::date BETWEEN (SELECT ini FROM periodo) AND (SELECT fim FROM periodo)
    )
    SELECT b.ativos, b.inativos, b.novos, b.saidas, b.base_inicial,
           v.meses, d.recebido, d.pagantes,
           a.qtd AS inad_qtd, a.valor AS inad_valor,
           pr.presencas, pr.faltas
      FROM base b, vida v, dinheiro d, atraso a, presenca pr
    `,
    [referencia],
  );

  const l = r.rows[0] ?? {};
  const num = (k: string): number => Number(l[k] ?? 0);

  const baseInicial = num('base_inicial');
  const saidas = num('saidas');
  const recebido = num('recebido');
  const pagantes = num('pagantes');
  const ativos = num('ativos');
  const presencas = num('presencas');
  const faltas = num('faltas');
  const meses = l['meses'] === null ? null : Number(l['meses']);

  const ticketMedio = pagantes > 0 ? Math.round(recebido / pagantes) : null;

  return {
    ativos,
    inativos: num('inativos'),
    novosNoMes: num('novos'),
    saidasNoMes: saidas,

    /* `null` e não `0` quando não há base: zero afirma "não houve
       evasão", e o correto é "não dá para dizer". A tela mostra um
       traço, não um número tranquilizador. */
    churnPercentual:
      baseInicial > 0 ? Math.round((saidas / baseInicial) * 1000) / 10 : null,
    churnBase: baseInicial,

    receitaMesCentavos: recebido,
    ticketMedioCentavos: ticketMedio,
    alunosPagantes: pagantes,
    tempoMedioVidaMeses: meses === null ? null : Math.round(meses * 10) / 10,
    /* LTV = ticket médio x tempo médio de vida. É uma projeção, e a tela
       precisa apresentá-la como tal — não como dinheiro em caixa. */
    ltvCentavos:
      ticketMedio !== null && meses !== null ? Math.round(ticketMedio * meses) : null,

    inadimplentes: num('inad_qtd'),
    inadimplenciaCentavos: num('inad_valor'),

    presencasNoMes: presencas,
    faltasNoMes: faltas,
    frequenciaMediaPorAluno:
      ativos > 0 ? Math.round((presencas / ativos) * 10) / 10 : null,
    taxaComparecimentoPercentual:
      presencas + faltas > 0
        ? Math.round((presencas / (presencas + faltas)) * 1000) / 10
        : null,
  };
}

export interface AlunoEmRisco {
  id: string;
  nome: string;
  diasSemVir: number;
  presencasAnteriores: number;
  profissional: string | null;
  whatsapp: string | null;
}

/**
 * Alunos em risco de abandono.
 *
 * O indicador mais acionável do painel, e o único que aponta para uma
 * PESSOA em vez de um número. Churn é diagnóstico do que já aconteceu;
 * isto aqui ainda dá para reverter com um telefonema.
 *
 * O critério não é "faltou": é **sumiu**. Só entra quem tinha
 * frequência estabelecida (3 presenças ou mais nos últimos 90 dias) e
 * parou. Sem essa condição, a lista encheria de matrícula nova que
 * ainda não criou rotina, e o dono pararia de olhar em uma semana — que
 * é como um alerta morre.
 */
export async function alunosEmRisco(
  client: TenantClient,
  diasSemVir = 14,
): Promise<AlunoEmRisco[]> {
  const r = await client.query<{
    id: string;
    nome: string;
    dias: number;
    anteriores: number;
    profissional: string | null;
    whatsapp: string | null;
  }>(
    `
    WITH historico AS (
      SELECT a.student_id,
             count(*) FILTER (
               WHERE a.status = 'ATTENDED'
                 AND lower(a.period) >= now() - interval '90 days'
             )::int AS presencas_90d,
             max(lower(a.period)) FILTER (WHERE a.status = 'ATTENDED') AS ultima
        FROM appointments a
       GROUP BY a.student_id
    )
    SELECT s.id,
           s.full_name AS nome,
           /* EPOCH e não DAY: EXTRACT(DAY FROM intervalo) devolve só o
              componente de dias, então uma ausência de 45 dias
              apareceria como 15. O erro só aparece depois de um mês
              sumido — justamente quando o alerta mais importa. */
           (EXTRACT(EPOCH FROM (now() - h.ultima)) / 86400)::int AS dias,
           h.presencas_90d AS anteriores,
           u.full_name AS profissional,
           s.whatsapp
      FROM students s
      JOIN historico h ON h.student_id = s.id
      LEFT JOIN student_professionals sp
             ON sp.student_id = s.id AND sp.unassigned_at IS NULL
      LEFT JOIN users u ON u.id = sp.professional_id
     WHERE s.status = 'ACTIVE'
       AND h.ultima IS NOT NULL
       AND h.presencas_90d >= 3
       AND h.ultima < now() - ($1 || ' days')::interval
       /* Quem já tem horário marcado à frente não está sumido: está de
          volta. Alertar sobre ele gastaria a atenção do dono à toa. */
       AND NOT EXISTS (
         SELECT 1 FROM appointments f
          WHERE f.student_id = s.id
            AND f.status IN ('SCHEDULED', 'CONFIRMED')
            AND lower(f.period) > now()
       )
     ORDER BY h.ultima ASC
     LIMIT 50
    `,
    [diasSemVir],
  );

  return r.rows.map((x) => ({
    id: x.id,
    nome: x.nome,
    diasSemVir: Number(x.dias),
    presencasAnteriores: Number(x.anteriores),
    profissional: x.profissional,
    whatsapp: x.whatsapp,
  }));
}

export interface Aniversariante {
  id: string;
  nome: string;
  dia: number;
  mes: number;
  whatsapp: string | null;
}

/** Aniversariantes do mês, usando o índice de (mês, dia). */
export async function aniversariantesDoMes(
  client: TenantClient,
  mes: number,
): Promise<Aniversariante[]> {
  const r = await client.query<Aniversariante>(
    `SELECT id, full_name AS nome,
            (birth_month_day % 100)  AS dia,
            (birth_month_day / 100)  AS mes,
            whatsapp
       FROM students
      WHERE status = 'ACTIVE'
        AND birth_month_day BETWEEN $1 * 100 AND $1 * 100 + 99
      ORDER BY birth_month_day`,
    [mes],
  );
  return r.rows.map((x) => ({ ...x, dia: Number(x.dia), mes: Number(x.mes) }));
}
