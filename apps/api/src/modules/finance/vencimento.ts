import type { FastifyBaseLogger } from 'fastify';
import { withTenant, withoutTenantContext } from '../../db/pool.js';

/**
 * Envelhecimento das cobranças: o que passou do vencimento vira OVERDUE.
 *
 * POR QUE ISTO PRECISA EXISTIR. O gatilho `recalc_entry_paid` decide o
 * status de um lançamento, e faz isso muito bem — mas só dispara quando
 * um PAGAMENTO é inserido, alterado ou apagado. Uma cobrança que
 * simplesmente atravessa a data de vencimento sem que ninguém pague nada
 * nunca é reavaliada: fica `OPEN` para sempre.
 *
 * O sintoma é uma tela se contradizendo. O cartão do topo conta os
 * vencidos pela DATA e diz "12 cobranças vencidas"; a lista mostra as
 * mesmas 12 linhas escritas "em aberto". E o problema não é da tela:
 * quem consultar a API, gerar um relatório ou disparar uma régua de
 * cobrança recebe o status errado do mesmo jeito.
 *
 * A alternativa seria cada consumidor calcular "vencido" por conta
 * própria — o que garante que um dia dois deles divirjam. O estado mora
 * numa coluna só, e é esta tarefa que a mantém honesta.
 *
 * O DIA É O DA ACADEMIA, NÃO O DO SERVIDOR. `CURRENT_DATE` numa VPS em
 * UTC vira o dia seguinte às 21h de Brasília — e uma conta que vence
 * hoje apareceria vencida três horas antes da meia-noite do cliente.
 */
export async function envelhecerCobrancas(
  log: FastifyBaseLogger,
): Promise<{ empresas: number; vencidas: number }> {
  const { rows } = await withoutTenantContext('cron', (client) =>
    client.query<{ tenant_id: string }>('SELECT tenant_id FROM jobs_tenants_ativos()'),
  );

  let vencidas = 0;

  for (const { tenant_id } of rows) {
    try {
      /* Uma transação POR EMPRESA, com o contexto definido — a partir
         daqui a RLS volta a valer inteira, inclusive contra este job.
         Um UPDATE global com BYPASSRLS seria uma linha mais curta e um
         buraco permanente. */
      const r = await withTenant({ tenantId: tenant_id }, (client) =>
        client.query(
          `UPDATE finance_entries e
              SET status = 'OVERDUE'
             FROM tenants t
            WHERE t.id = e.tenant_id
              AND e.status = 'OPEN'
              AND e.cancelled_at IS NULL
              AND e.due_date < (now() AT TIME ZONE t.timezone)::date`,
        ),
      );
      vencidas += r.rowCount ?? 0;
    } catch (erro) {
      /* Uma empresa com problema não pode parar as outras. */
      log.error({ err: erro, tenantId: tenant_id }, 'falha ao envelhecer cobranças da empresa');
    }
  }

  return { empresas: rows.length, vencidas };
}
