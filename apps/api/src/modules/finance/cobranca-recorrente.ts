import type { FastifyBaseLogger } from 'fastify';
import { withTenant, withoutTenantContext } from '../../db/pool.js';

/**
 * Gera a cobrança do mês a partir do contrato do aluno.
 *
 * O QUE ISTO FECHA. O cadastro do aluno grava quanto ele paga e desde
 * quando; sem esta tarefa, isso ficava sendo uma anotação bonita e o
 * financeiro só mostrava o que alguém tinha lançado à mão. A academia
 * cadastra trinta alunos mensalistas e a aba "A receber" continua vazia.
 *
 * RODA QUANTAS VEZES QUISER. A segurança não está aqui, está no banco:
 * `idx_entries_contract_competence` é único por (contrato, competência),
 * então a segunda tentativa do mesmo mês esbarra na restrição e não faz
 * nada. Idempotência no agendador seria uma promessa; no índice, é um
 * fato — e continua valendo se um dia houver duas réplicas da API.
 *
 * SÓ CONTRATOS MENSAIS, de propósito. Um contrato trimestral gerado todo
 * mês cobraria o cliente três vezes pelo mesmo trimestre, e "quase
 * certo" no caminho do dinheiro é errado. Semanal e quinzenal precisam
 * de uma regra de datas própria; enquanto ela não existe, esses
 * contratos ficam de fora e a academia lança à mão — o que é chato, mas
 * é verdade, e não vira cobrança indevida.
 */
export async function gerarCobrancasDoMes(
  log: FastifyBaseLogger,
): Promise<{ empresas: number; geradas: number }> {
  const { rows } = await withoutTenantContext('cron', (client) =>
    client.query<{ tenant_id: string }>('SELECT tenant_id FROM jobs_tenants_ativos()'),
  );

  let geradas = 0;

  for (const { tenant_id } of rows) {
    try {
      const r = await withTenant({ tenantId: tenant_id }, (client) =>
        client.query(
          /* Tudo numa instrução só, e dentro do contexto da empresa: a
             RLS vale contra este job como vale contra qualquer um. */
          `WITH hoje AS (
             SELECT (now() AT TIME ZONE t.timezone)::date AS d
               FROM tenants t
              WHERE t.id = current_tenant_id()
           ),
           alvo AS (
             SELECT
               c.id                AS contrato,
               c.tenant_id,
               c.student_id,
               c.professional_id,
               c.amount_cents,
               date_trunc('month', h.d)::date AS competencia,
               /* O dia da cobrança é limitado a 28 na coluna, então
                  somar (dia - 1) ao primeiro do mês nunca escorrega para
                  o mês seguinte — nem em fevereiro. */
               /* GREATEST com a data de início: o aluno que entra dia
                  18 numa academia que cobra dia 10 paga a primeira
                  mensalidade no dia em que entrou, e só a partir do mês
                  seguinte no dia 10. Sem isto, a cobrança venceria antes
                  de o contrato existir — e a alternativa que eu tinha
                  escrito antes era pior: pular o mês em silêncio, e a
                  academia cadastrava um mensalista sem nada a receber. */
               GREATEST(
                 (date_trunc('month', h.d)::date
                   + (COALESCE(c.billing_day, 10) - 1) * INTERVAL '1 day')::date,
                 c.starts_on
               ) AS vence,
               s.full_name
             FROM student_contracts c
             JOIN students s ON s.id = c.student_id
             CROSS JOIN hoje h
            WHERE c.is_active
              AND c.cycle = 'MONTHLY'
              AND c.amount_cents > 0
              AND c.starts_on <= h.d
              /* PEDIU PARA SAIR: o contrato continua valendo até o fim
                 do período que ele já pagou, mas não gera cobrança nova.
                 Encerrar na hora tiraria o acesso de quem pagou o mês
                 inteiro; encerrar em silêncio no dia 30 exigiria alguém
                 lembrar de voltar lá. */
              AND NOT c.encerrar_no_fim_do_periodo
              /* JÁ NÃO PAGA HÁ N MESES: para de gerar.
                 Sem isto, um aluno que sumiu em março acumula uma
                 mensalidade nova todo mês, para sempre — em dezembro
                 "deve" dez meses de um serviço que não usou, e o
                 relatório de inadimplência vira ficção. O limite é da
                 EMPRESA: academia de bairro segura três meses, estúdio
                 de pilates corta no primeiro. */
              AND (
                SELECT count(*)
                  FROM finance_entries v
                 WHERE v.contract_id = c.id
                   AND v.cancelled_at IS NULL
                   AND v.status <> 'PAID'
                   AND v.due_date < h.d
              ) < (SELECT parar_cobranca_apos_vencidas FROM tenants WHERE id = current_tenant_id())
              AND (c.ends_on IS NULL OR c.ends_on >= h.d)
              /* Aluno desligado não recebe cobrança nova. */
              AND s.status IN ('ACTIVE', 'LEAD')
           )
           INSERT INTO finance_entries
             (tenant_id, direction, description, category, amount_cents,
              due_date, competence_date, student_id, professional_id, contract_id)
           SELECT
             a.tenant_id, 'RECEIVABLE',
             'Mensalidade ' || to_char(a.competencia, 'MM/YYYY'),
             'Mensalidade', a.amount_cents,
             a.vence, a.competencia, a.student_id, a.professional_id, a.contrato
           FROM alvo a
          ON CONFLICT DO NOTHING`,
        ),
      );
      geradas += r.rowCount ?? 0;
    } catch (erro) {
      log.error({ err: erro, tenantId: tenant_id }, 'falha ao gerar cobranças da empresa');
    }
  }

  return { empresas: rows.length, geradas };
}
