import type { FastifyBaseLogger } from 'fastify';
import { withTenant, withoutTenantContext, type TenantClient } from '../../db/pool.js';

/**
 * Contas que se repetem — o aluguel do dia 20, e o que mais nascer todo
 * mês sem ninguém mandar.
 *
 * O QUE ISTO FECHA. A tabela `finance_recurrences` existe no esquema
 * desde o primeiro dia, com índice de idempotência e tudo — e nunca
 * teve uma linha escrita por ninguém. Na prática a academia lançava o
 * aluguel à mão todo mês, e "a pagar" só sabia o que alguém tinha
 * lembrado de digitar. O mês em que a pessoa esquece é o mês em que o
 * saldo previsto mente.
 *
 * A DIFERENÇA PARA A MENSALIDADE DO ALUNO (`cobranca-recorrente.ts`):
 * aquela nasce do CONTRATO, que é do cadastro do aluno e tem regra
 * própria — para de gerar quando o aluno some, respeita o pedido de
 * encerramento, olha a inadimplência. Esta aqui é um molde solto: alguém
 * escreveu "aluguel, R$ 2.500, todo dia 20" e é isso que acontece, até
 * mandarem parar. Juntar as duas numa só faria a regra do aluno valer
 * para o aluguel — e o aluguel não deixa de vencer porque a imobiliária
 * está inadimplente com alguém.
 *
 * RODA QUANTAS VEZES QUISER. A garantia não é do agendador, é do banco:
 * `idx_entries_recurrence_competence` é único por (recorrência,
 * competência), então a segunda passada do mesmo mês esbarra na
 * restrição e não faz nada. Idempotência prometida pelo código é uma
 * promessa; garantida pelo índice, é um fato — e continua valendo se um
 * dia houver duas réplicas da API.
 */

/**
 * De quantos em quantos meses cada ciclo repete.
 *
 * SÓ OS CICLOS ANCORADOS NO MÊS. Semanal e quinzenal não têm "dia do
 * mês" — a data anda pelo calendário — e por sessão nem é uma data. Um
 * ciclo semanal tratado como mensal cobraria um quarto do que devia, em
 * silêncio, e no caminho do dinheiro "quase certo" é errado. Quem
 * precisa deles lança à mão, o que é chato mas é verdade.
 */
const PASSO_EM_MESES: Readonly<Record<string, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
};

export const CICLOS_DE_CONTA_FIXA = Object.keys(PASSO_EM_MESES);

/**
 * Materializa, dentro de UMA empresa, tudo o que já deveria ter nascido.
 *
 * OLHA PARA TRÁS, e não só para o mês corrente. A academia que cadastra
 * o aluguel no dia 3 de agosto dizendo "começou em maio" espera ver maio,
 * junho e julho aparecerem — é o que ela teria lançado à mão. Gerar só o
 * mês de hoje deixaria três buracos que ninguém mais vai preencher,
 * porque a tela não tem como saber que eles existiram.
 *
 * O limite de 24 meses para trás não é medo de laço infinito (a
 * `starts_on` já é o piso): é o que impede um erro de digitação —
 * "começou em 1998" — de encher a conta a pagar com trezentas linhas
 * que ninguém pediu.
 */
export async function gerarContasFixasDaEmpresa(client: TenantClient): Promise<number> {
  const r = await client.query(
    `WITH hoje AS (
       SELECT (now() AT TIME ZONE t.timezone)::date AS d
         FROM tenants t
        WHERE t.id = current_tenant_id()
     ),
     /* Uma linha por ocorrência que já deveria existir: a recorrência
        cruzada com cada mês entre o começo dela e o mês de hoje. */
     ocorrencia AS (
       SELECT
         r.id                AS recorrencia,
         r.tenant_id,
         r.direction,
         r.description,
         r.category,
         r.amount_cents,
         r.student_id,
         r.professional_id,
         r.supplier_name,
         m::date             AS competencia,
         /* O dia da cobrança é limitado a 28 na coluna, então somar
            (dia - 1) ao primeiro do mês nunca escorrega para o mês
            seguinte — nem em fevereiro.

            GREATEST com o início: quem cadastra "aluguel dia 20" com
            início no dia 25 não gera uma conta vencida cinco dias antes
            de o contrato existir. */
         GREATEST(
           (m + (r.billing_day - 1) * INTERVAL '1 day')::date,
           r.starts_on
         ) AS vence
       FROM finance_recurrences r
       CROSS JOIN hoje h
       CROSS JOIN LATERAL generate_series(
         GREATEST(
           date_trunc('month', r.starts_on),
           date_trunc('month', h.d) - INTERVAL '24 months'
         ),
         date_trunc('month', h.d),
         INTERVAL '1 month'
       ) AS m
      WHERE r.is_active
        AND r.amount_cents > 0
        AND r.cycle::text = ANY($1::text[])
        /* O PASSO DO CICLO, contado a partir do mês de início. Um
           trimestral que começou em janeiro nasce em janeiro, abril,
           julho — e não todo mês. A conta em meses evita a armadilha do
           "a cada 90 dias", que anda pelo calendário. */
        AND MOD(
              (EXTRACT(YEAR FROM m)::int * 12 + EXTRACT(MONTH FROM m)::int)
              - (EXTRACT(YEAR FROM r.starts_on)::int * 12 + EXTRACT(MONTH FROM r.starts_on)::int),
              CASE r.cycle::text
                WHEN 'MONTHLY' THEN 1
                WHEN 'QUARTERLY' THEN 3
                WHEN 'SEMIANNUAL' THEN 6
                ELSE 12
              END
            ) = 0
     )
     INSERT INTO finance_entries
       (tenant_id, direction, description, category, amount_cents,
        due_date, competence_date, student_id, professional_id,
        supplier_name, recurrence_id)
     SELECT
       o.tenant_id, o.direction,
       o.description || ' ' || to_char(o.competencia, 'MM/YYYY'),
       o.category, o.amount_cents,
       o.vence, o.competencia, o.student_id, o.professional_id,
       o.supplier_name, o.recorrencia
     FROM ocorrencia o
     /* ENCERRADA: a conta para de nascer depois da data de fim, mas o
        que já nasceu continua valendo — encerrar um aluguel não apaga o
        mês que ainda não foi pago. */
     WHERE (SELECT ends_on FROM finance_recurrences WHERE id = o.recorrencia) IS NULL
        OR o.vence <= (SELECT ends_on FROM finance_recurrences WHERE id = o.recorrencia)
     ON CONFLICT DO NOTHING`,
    [CICLOS_DE_CONTA_FIXA],
  );

  const geradas = r.rowCount ?? 0;

  if (geradas > 0) {
    /* Só para a tela poder dizer "última vez em...". A verdade sobre o
       que existe continua sendo `finance_entries`; esta coluna é um
       carimbo, e o sistema não decide nada a partir dela — se ela
       estiver errada, nada duplica. */
    await client.query(
      `UPDATE finance_recurrences r
          SET last_generated_on = (SELECT (now() AT TIME ZONE t.timezone)::date
                                     FROM tenants t WHERE t.id = current_tenant_id())
        WHERE r.is_active`,
    );
  }

  return geradas;
}

/** A passada do agendador: todas as empresas, uma por vez. */
export async function gerarContasFixasDoMes(
  log: FastifyBaseLogger,
): Promise<{ empresas: number; geradas: number }> {
  const { rows } = await withoutTenantContext('cron', (client) =>
    client.query<{ tenant_id: string }>('SELECT tenant_id FROM jobs_tenants_ativos()'),
  );

  let geradas = 0;

  for (const { tenant_id } of rows) {
    try {
      geradas += await withTenant({ tenantId: tenant_id }, (client) =>
        gerarContasFixasDaEmpresa(client),
      );
    } catch (erro) {
      /* Uma empresa com dado estranho não pode derrubar a passada das
         outras — o laço segue e o erro fica no log com o tenant. */
      log.error({ err: erro, tenantId: tenant_id }, 'falha ao gerar contas fixas da empresa');
    }
  }

  return { empresas: rows.length, geradas };
}
