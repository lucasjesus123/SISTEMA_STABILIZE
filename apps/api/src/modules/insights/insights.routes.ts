import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatCents } from '@stabilize/shared';
import { inTenant } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import {
  alunosEmRisco,
  aniversariantesDoMes,
  indicadoresDoMes,
} from './insights.repository.js';

/**
 * Indicadores de gestão.
 *
 * Exigem `finance:report:read` — são números estratégicos da empresa
 * (evasão, LTV, ticket médio) e o mesmo raciocínio do caixa se aplica:
 * não são do profissional, são do dono.
 *
 * A exceção é a lista de aniversariantes, que a recepção precisa e não
 * revela nada sensível além do que ela já vê no cadastro.
 */
export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/gestao',
    { preHandler: [app.authorize('finance:report:read')] },
    async (request) => {
      const { mes } = z
        .object({ mes: z.coerce.date().optional() })
        .parse(request.query);
      const referencia = mes ?? new Date();

      return inTenant(request, async (client, principal) => {
        /* SEQUENCIAL, e não Promise.all.
           As três consultas compartilham o MESMO cliente da transação, e
           um cliente pg executa uma query por vez — dispará-las em
           paralelo faz uma atropelar a outra. O driver avisa
           ("client is already executing a query") e promete transformar
           isso em erro no pg@9. Paralelizar exigiria três conexões, três
           transações e três contextos de tenant; para três consultas
           rápidas, não compensa. */
        const indicadores = await indicadoresDoMes(client, referencia);
        const risco = await alunosEmRisco(client);
        const aniversariantes = await aniversariantesDoMes(client, referencia.getMonth() + 1);

        await writeAudit(client, principal.tenantId, {
          action: 'finance.report.read',
          resourceType: 'report',
          resourceId: 'indicadores-gestao',
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });

        /* O churn ganha uma leitura em texto junto do número. O
           benchmark brasileiro é 3% a 5% ao mês; sem essa referência,
           "4,2%" não diz a ninguém se está bom ou ruim, e um painel que
           não informa é só um painel bonito. */
        const churn = indicadores.churnPercentual;
        const leituraChurn =
          churn === null
            ? 'Base insuficiente para calcular'
            : churn < 3
              ? 'Abaixo da média do mercado — retenção saudável'
              : churn <= 5
                ? 'Dentro da média do mercado (3% a 5%)'
                : churn <= 7
                  ? 'Acima da média — vale investigar'
                  : 'Bem acima da média — atenção urgente';

        return {
          data: {
            ...indicadores,
            receitaMesFormatada: formatCents(indicadores.receitaMesCentavos),
            ticketMedioFormatado:
              indicadores.ticketMedioCentavos === null
                ? null
                : formatCents(indicadores.ticketMedioCentavos),
            ltvFormatado:
              indicadores.ltvCentavos === null ? null : formatCents(indicadores.ltvCentavos),
            inadimplenciaFormatada: formatCents(indicadores.inadimplenciaCentavos),
            leituraChurn,
            emRisco: risco,
            aniversariantes,
          },
        };
      });
    },
  );
}
