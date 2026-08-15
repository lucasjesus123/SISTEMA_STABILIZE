import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatCents, reaisToCents, MoneyError } from '@stabilize/shared';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { notFound, unprocessable } from '../../http/errors.js';
import { calcularComissao } from './commission.js';
import {
  baseDeComissao,
  criarLancamento,
  estornarPagamento,
  listarLancamentos,
  registrarPagamento,
  resumoDoPeriodo,
} from './finance.repository.js';

/**
 * Rotas do financeiro.
 *
 * A separação que o enunciado pediu está nas permissões, não em telas:
 *
 *   /api/finance/*        exige finance:*  → só OWNER e ADMIN
 *   /api/finance/comissoes exige commission:read → também PROFESSIONAL,
 *                          com escopo que o prende ao próprio fechamento
 *
 * Um profissional que chamar /api/finance/lancamentos recebe 403 do
 * `authorize()`, antes de qualquer query — e a negativa fica auditada.
 */

const idSchema = z.string().uuid('Identificador inválido');

/**
 * Valor monetário vindo do cliente.
 *
 * Aceita texto ("1.234,56") e converte para centavos inteiros pelo
 * parser do pacote compartilhado, que recusa entrada ambígua. Nunca
 * aceitamos um `number` em reais: seria um float, e float não entra no
 * caminho do dinheiro.
 */
const valorSchema = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return reaisToCents(v);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof MoneyError ? error.message : 'Valor monetário inválido',
      });
      return z.NEVER;
    }
  })
  .refine((c) => c > 0, { message: 'O valor precisa ser maior que zero' });

const criarLancamentoSchema = z.object({
  direcao: z.enum(['RECEIVABLE', 'PAYABLE']),
  descricao: z.string().trim().min(1).max(300),
  categoria: z.string().trim().max(80).optional(),
  valor: valorSchema,
  vencimento: z.coerce.date(),
  competencia: z.coerce.date().optional(),
  studentId: idSchema.optional(),
  professionalId: idSchema.optional(),
  fornecedor: z.string().trim().max(160).optional(),
  observacao: z.string().trim().max(500).optional(),
});

const pagamentoSchema = z.object({
  valor: valorSchema,
  metodo: z.enum(['PIX', 'CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'BANK_TRANSFER', 'BOLETO', 'OTHER']),
  pagoEm: z.coerce.date().optional(),
  referencia: z.string().trim().max(120).optional(),
});

const periodoSchema = z.object({
  de: z.coerce.date(),
  ate: z.coerce.date(),
});

export async function financeRoutes(app: FastifyInstance): Promise<void> {
  /* ==================================================================
   * FINANCEIRO DA EMPRESA — só OWNER e ADMIN
   * ================================================================ */

  app.get(
    '/lancamentos',
    { preHandler: [app.authorize('finance:receivable:read')] },
    async (request) => {
      const query = z
        .object({
          direcao: z.enum(['RECEIVABLE', 'PAYABLE']).optional(),
          de: z.coerce.date().optional(),
          ate: z.coerce.date().optional(),
          status: z.enum(['OPEN', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']).optional(),
          studentId: idSchema.optional(),
          apenasEmAberto: z.coerce.boolean().optional(),
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      return inTenant(request, async (client) => {
        const { rows, total } = await listarLancamentos(client, {
          direcao: query.direcao,
          de: query.de,
          ate: query.ate,
          status: query.status,
          studentId: query.studentId,
          apenasEmAberto: query.apenasEmAberto,
          limit: query.pageSize,
          offset: (query.page - 1) * query.pageSize,
        });

        return {
          data: rows.map((e) => ({
            id: e.id,
            direcao: e.direction,
            descricao: e.description,
            categoria: e.category,
            valorCentavos: e.amount_cents,
            valorFormatado: formatCents(e.amount_cents),
            pagoCentavos: e.paid_cents,
            saldoCentavos: e.amount_cents - e.paid_cents,
            status: e.status,
            vencimento: e.due_date,
            competencia: e.competence_date,
            aluno: e.student_id === null ? null : { id: e.student_id, nome: e.student_name },
            fornecedor: e.supplier_name,
            parcela:
              e.installment_no === null ? null : `${e.installment_no}/${e.installment_total}`,
          })),
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total,
            totalPages: Math.ceil(total / query.pageSize),
          },
        };
      });
    },
  );

  app.post(
    '/lancamentos',
    { preHandler: [app.authorize('finance:receivable:write')] },
    async (request, reply) => {
      const body = criarLancamentoSchema.parse(request.body);

      return inTenant(request, async (client, principal) => {
        const criado = await criarLancamento(client, principal.tenantId, {
          direcao: body.direcao,
          descricao: body.descricao,
          categoria: body.categoria,
          valorCentavos: body.valor,
          vencimento: body.vencimento,
          competencia: body.competencia,
          studentId: body.studentId,
          professionalId: body.professionalId,
          fornecedor: body.fornecedor,
          observacao: body.observacao,
          criadoPor: principal.userId,
        });

        await writeAudit(client, principal.tenantId, {
          action: 'finance.entry.create',
          resourceType: 'finance_entry',
          resourceId: criado.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          // Valor entra no log: é registro contábil, e quem lê a
          // auditoria precisa saber a ordem de grandeza do lançamento.
          metadata: { direcao: body.direcao, valorCentavos: body.valor },
        });

        void reply.status(201);
        return { data: { id: criado.id } };
      });
    },
  );

  /* ------------------------------------------------------------------
   * Baixa de pagamento
   *
   * Liberada também para o PROFISSIONAL (finance:payment:write), como o
   * enunciado pediu: ele lança o recebimento dos próprios alunos. O que
   * ele NÃO tem é finance:receivable:read — não enxerga o caixa da
   * empresa, só movimenta o que é dele.
   * ---------------------------------------------------------------- */
  app.post(
    '/lancamentos/:id/pagamentos',
    { preHandler: [app.authorize('finance:payment:write')] },
    async (request, reply) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);
      const body = pagamentoSchema.parse(request.body);

      return inTenant(request, async (client, principal) => {
        const pago = await registrarPagamento(client, principal.tenantId, {
          entryId: id,
          valorCentavos: body.valor,
          metodo: body.metodo,
          pagoEm: body.pagoEm,
          referencia: body.referencia,
          registradoPor: principal.userId,
        });

        await writeAudit(client, principal.tenantId, {
          action: 'finance.payment.create',
          resourceType: 'finance_payment',
          resourceId: pago.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { entryId: id, valorCentavos: body.valor, metodo: body.metodo },
        });

        void reply.status(201);
        return { data: { id: pago.id } };
      });
    },
  );

  app.delete(
    '/pagamentos/:id',
    { preHandler: [app.authorize('finance:payment:write')] },
    async (request) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);

      return inTenant(request, async (client, principal) => {
        const ok = await estornarPagamento(client, id);
        if (!ok) throw notFound('Pagamento');

        await writeAudit(client, principal.tenantId, {
          action: 'finance.payment.delete',
          resourceType: 'finance_payment',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });

        return { ok: true };
      });
    },
  );

  app.get(
    '/resumo',
    { preHandler: [app.authorize('finance:report:read')] },
    async (request) => {
      const query = periodoSchema.parse(request.query);
      if (query.ate < query.de) throw unprocessable('O fim do período precisa ser depois do início.');

      return inTenant(request, async (client, principal) => {
        const resumo = await resumoDoPeriodo(client, query.de, query.ate);

        await writeAudit(client, principal.tenantId, {
          action: 'finance.report.read',
          resourceType: 'report',
          resourceId: 'resumo',
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });

        return {
          data: {
            ...resumo,
            aReceberFormatado: formatCents(resumo.aReceberCentavos),
            recebidoFormatado: formatCents(resumo.recebidoCentavos),
            aPagarFormatado: formatCents(resumo.aPagarCentavos),
            inadimplenteFormatado: formatCents(resumo.inadimplenteCentavos),
            // Saldo é receita menos despesa REALIZADAS, não previstas:
            // o previsto vira caixa apenas quando entra.
            saldoRealizadoCentavos: resumo.recebidoCentavos - resumo.pagoCentavos,
            saldoRealizadoFormatado: formatCents(
              resumo.recebidoCentavos - resumo.pagoCentavos,
            ),
          },
        };
      });
    },
  );

  /* ==================================================================
   * COMISSÕES — a aba do profissional
   * ================================================================ */

  app.get(
    '/comissoes/:professionalId',
    { preHandler: [app.authorize('commission:read')] },
    async (request) => {
      const { professionalId } = z.object({ professionalId: idSchema }).parse(request.params);
      const { mes } = z
        .object({ mes: z.coerce.date() })
        .parse(request.query);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        /* Defesa em profundidade. O fragmento de escopo já prende a
           consulta ao próprio profissional, mas checar aqui torna a
           intenção explícita e devolve 404 — e não uma lista vazia, que
           seria ambígua entre "não tenho acesso" e "não houve
           movimento no mês". */
        if (scope.kind === 'OWN_PROFESSIONAL' && scope.professionalId !== professionalId) {
          throw notFound('Fechamento de comissão');
        }

        const lancamentos = await baseDeComissao(client, scope, professionalId, mes);
        const fechamento = calcularComissao(lancamentos);

        await writeAudit(client, principal.tenantId, {
          action: 'commission.read',
          resourceType: 'commission',
          resourceId: professionalId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { mes: mes.toISOString().slice(0, 7), itens: fechamento.itens.length },
        });

        return {
          data: {
            mes: mes.toISOString().slice(0, 7),
            profissionalId: professionalId,
            baseTotalCentavos: fechamento.baseTotalCentavos,
            baseTotalFormatado: formatCents(fechamento.baseTotalCentavos),
            totalCentavos: fechamento.totalCentavos,
            totalFormatado: formatCents(fechamento.totalCentavos),
            aliquotaMediaBp: fechamento.aliquotaMediaBp,
            // A memória de cálculo, linha a linha: é isso que permite
            // ao profissional conferir de onde veio cada centavo.
            itens: fechamento.itens.map((i) => ({
              lancamentoId: i.entryId,
              descricao: i.descricao,
              alunoId: i.studentId,
              baseCentavos: i.baseCentavos,
              baseFormatada: formatCents(i.baseCentavos),
              aliquotaBp: i.aliquotaBp,
              valorCentavos: i.valorCentavos,
              valorFormatado: formatCents(i.valorCentavos),
            })),
          },
        };
      });
    },
  );
}
