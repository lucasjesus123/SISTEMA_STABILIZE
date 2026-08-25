import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatCents, reaisToCents, MoneyError } from '@stabilize/shared';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { notFound, unprocessable } from '../../http/errors.js';
import { calcularComissao } from './commission.js';
import {
  FechamentoError,
  buscarFechamento,
  fechamentosDoMes,
  fecharMes,
  reabrirMes,
} from './fechamento.js';
import { gerarContasFixasDaEmpresa } from './contas-fixas.js';
import {
  alterarContaFixa,
  baseDeComissao,
  criarContaFixa,
  criarLancamento,
  excluirContaFixa,
  estornarPagamento,
  fluxoPorMes,
  inadimplentes,
  listarContasFixas,
  listarLancamentos,
  listarRecorrencias,
  porCategoria,
  registrarPagamento,
  resumoDoPeriodo,
} from './finance.repository.js';

/**
 * Um campo de CSV, escapado.
 *
 * Aspas em volta de qualquer campo com separador, aspas ou quebra de
 * linha, e aspas internas dobradas. Sem isto, uma descrição como
 * `Mensalidade; 3 sessões` parte a linha em duas colunas e desloca
 * TODAS as seguintes — o arquivo abre e os números aparecem na coluna
 * errada, que é pior do que não abrir.
 */
function paraCampoCsv(valor: string): string {
  if (!/[;"\r\n]/.test(valor)) return valor;
  return `"${valor.replace(/"/g, '""')}"`;
}

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

  /* ------------------------------------------------------------------
   * Baixa com MAIS DE UMA FORMA DE PAGAMENTO
   *
   * Metade no PIX e metade no cartão é rotina de balcão, e até aqui não
   * tinha como registrar: a tela mandava um pagamento por vez, então a
   * pessoa dava duas baixas seguidas. Funcionava e era errado por dois
   * motivos — se a segunda falhasse, a conta ficava meio paga sem que
   * ninguém soubesse; e o relatório por forma de pagamento contava dois
   * recebimentos onde houve um.
   *
   * O LOTE INTEIRO CABE NUMA TRANSAÇÃO. `inTenant` já abre BEGIN e
   * COMMIT, então ou entram todos os pagamentos ou não entra nenhum —
   * que é a única semântica aceitável para dinheiro.
   * ---------------------------------------------------------------- */
  app.post(
    '/lancamentos/:id/pagamentos/lote',
    { preHandler: [app.authorize('finance:payment:write')] },
    async (request, reply) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);
      const body = z
        .object({
          /* O teto de seis não é técnico: é o número acima do qual uma
             baixa deixou de ser "dividiu a conta" e virou outra coisa,
             que merece lançamentos separados. */
          pagamentos: z.array(pagamentoSchema).min(1, 'Informe ao menos um pagamento.').max(6),
        })
        .parse(request.body);

      return inTenant(request, async (client, principal) => {
        const criados: string[] = [];
        for (const p of body.pagamentos) {
          const pago = await registrarPagamento(client, principal.tenantId, {
            entryId: id,
            valorCentavos: p.valor,
            metodo: p.metodo,
            pagoEm: p.pagoEm,
            referencia: p.referencia,
            registradoPor: principal.userId,
          });
          criados.push(pago.id);
        }

        await writeAudit(client, principal.tenantId, {
          action: 'finance.payment.create',
          resourceType: 'finance_entry',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: {
            formas: body.pagamentos.length,
            totalCentavos: body.pagamentos.reduce((s, p) => s + p.valor, 0),
            metodos: body.pagamentos.map((p) => p.metodo),
          },
        });

        void reply.status(201);
        return { data: { ids: criados } };
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
   * RELATÓRIOS
   *
   * Três blocos, na ordem em que o dono do negócio pensa: "estou
   * melhorando?", "para onde vai o dinheiro?", "quem eu cobro hoje?".
   * ================================================================ */

  app.get('/relatorios', { preHandler: [app.authorize('finance:report:read')] }, async (request) => {
    const query = z
      .object({
        de: z.coerce.date(),
        ate: z.coerce.date(),
        meses: z.coerce.number().int().min(3).max(24).default(12),
      })
      .parse(request.query);
    if (query.ate < query.de) throw unprocessable('O fim do período precisa ser depois do início.');

    return inTenant(request, async (client, principal) => {
      const [fluxo, categorias, devendo] = await Promise.all([
        fluxoPorMes(client, query.meses),
        porCategoria(client, query.de, query.ate),
        inadimplentes(client),
      ]);

      await writeAudit(client, principal.tenantId, {
        action: 'finance.report.read',
        resourceType: 'report',
        resourceId: 'relatorios',
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
      });

      return {
        data: {
          fluxo: fluxo.map((m) => ({
            ...m,
            saldoCentavos: m.recebidoCentavos - m.pagoCentavos,
          })),
          categorias: categorias.map((c) => ({ ...c, totalFormatado: formatCents(c.totalCentavos) })),
          inadimplentes: devendo.map((i) => ({
            ...i,
            devendoFormatado: formatCents(i.devendoCentavos),
          })),
          totalDevendoCentavos: devendo.reduce((a, i) => a + i.devendoCentavos, 0),
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * Recorrências: os contratos que geram cobrança sozinhos
   * ---------------------------------------------------------------- */
  app.get('/recorrencias', { preHandler: [app.authorize('finance:report:read')] }, async (request) =>
    inTenant(request, async (client) => {
      const linhas = await listarRecorrencias(client);
      return {
        data: linhas.map((r) => ({ ...r, valorFormatado: formatCents(r.valorCentavos) })),
      };
    }),
  );

  /* ------------------------------------------------------------------
   * CONTAS FIXAS — o aluguel do dia 20
   *
   * SÃO AS DUAS DIREÇÕES no mesmo cadastro, e não uma tela para
   * despesa e outra para receita. O molde é o mesmo objeto — descrição,
   * valor, dia, ciclo, de quem ou para quem —, e a direção é um campo
   * dele. Duplicar a tela duplicaria a regra de geração junto, que é a
   * parte que não pode divergir.
   *
   * A PERMISSÃO JÁ EXISTIA: `finance:recurring:write` está declarada no
   * RBAC desde o começo, concedida a OWNER, a ADMIN e à área do
   * financeiro — e nenhuma rota a exigia, porque não havia o que
   * recorrer. Ela é separada de `receivable:write` de propósito:
   * cadastrar uma conta fixa é lançar as próximas doze de uma vez, e
   * quem pode digitar uma despesa não necessariamente pode agendar um
   * ano delas.
   * ---------------------------------------------------------------- */

  const contaFixaSchema = z.object({
    direcao: z.enum(['RECEIVABLE', 'PAYABLE']),
    descricao: z.string().trim().min(1).max(300),
    categoria: z.string().trim().max(80).optional(),
    valor: valorSchema,
    ciclo: z.enum(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']),
    /* O TETO É 28, e é o mesmo da coluna. Não é preguiça de tratar o
       dia 31: é que "todo dia 31" não existe em fevereiro, e qualquer
       resposta que o sistema desse — dia 28, dia 1º do mês seguinte,
       pular o mês — seria uma decisão dele sobre o contrato de outra
       pessoa. Recusar na entrada faz quem cadastra escolher. */
    diaDeCobranca: z.coerce.number().int().min(1).max(28),
    studentId: idSchema.optional(),
    contraparte: z.string().trim().max(160).optional(),
    inicio: z.coerce.date(),
    fim: z.coerce.date().optional(),
  });

  app.get(
    '/contas-fixas',
    { preHandler: [app.authorize('finance:report:read')] },
    async (request) => {
      const { direcao } = z
        .object({ direcao: z.enum(['RECEIVABLE', 'PAYABLE']).optional() })
        .parse(request.query);

      return inTenant(request, async (client) => {
        const linhas = await listarContasFixas(client, direcao);
        return {
          data: linhas.map((c) => ({ ...c, valorFormatado: formatCents(c.valorCentavos) })),
        };
      });
    },
  );

  app.post(
    '/contas-fixas',
    { preHandler: [app.authorize('finance:recurring:write')] },
    async (request, reply) => {
      const body = contaFixaSchema.parse(request.body);

      if (body.fim !== undefined && body.fim < body.inicio) {
        throw unprocessable('A data de término precisa ser depois do início.');
      }
      /* A receber PRECISA dizer de quem — é um CHECK do banco sobre o
         lançamento gerado, e descobrir isso só quando o agendador roda
         seria uma conta que nunca nasce, sem ninguém saber por quê. */
      if (
        body.direcao === 'RECEIVABLE' &&
        body.studentId === undefined &&
        (body.contraparte ?? '') === ''
      ) {
        throw unprocessable('Diga de quem você vai receber: um aluno ou um nome.');
      }

      return inTenant(request, async (client, principal) => {
        const criada = await criarContaFixa(client, principal.tenantId, {
          direcao: body.direcao,
          descricao: body.descricao,
          categoria: body.categoria,
          valorCentavos: body.valor,
          ciclo: body.ciclo,
          diaDeCobranca: body.diaDeCobranca,
          studentId: body.studentId,
          contraparte: body.contraparte,
          inicio: body.inicio,
          fim: body.fim,
        });

        /* GERA NA HORA, e não só no próximo tique do agendador. Quem
           acabou de cadastrar "aluguel, dia 20, começou em maio" espera
           ver maio, junho e julho na lista — e se não vir, cadastra de
           novo achando que não salvou. */
        const geradas = await gerarContasFixasDaEmpresa(client);

        await writeAudit(client, principal.tenantId, {
          action: 'finance.recurrence.create',
          resourceType: 'finance_recurrence',
          resourceId: criada.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: {
            direcao: body.direcao,
            valorCentavos: body.valor,
            ciclo: body.ciclo,
            dia: body.diaDeCobranca,
            geradas,
          },
        });

        void reply.status(201);
        return { data: { id: criada.id, geradas } };
      });
    },
  );

  app.patch(
    '/contas-fixas/:id',
    { preHandler: [app.authorize('finance:recurring:write')] },
    async (request) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);
      const body = z
        .object({
          descricao: z.string().trim().min(1).max(300).optional(),
          categoria: z.string().trim().max(80).nullable().optional(),
          valor: valorSchema.optional(),
          ciclo: z.enum(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']).optional(),
          diaDeCobranca: z.coerce.number().int().min(1).max(28).optional(),
          contraparte: z.string().trim().max(160).nullable().optional(),
          fim: z.coerce.date().nullable().optional(),
          ativa: z.boolean().optional(),
        })
        .parse(request.body);

      return inTenant(request, async (client, principal) => {
        const ok = await alterarContaFixa(client, id, {
          ...(body.descricao !== undefined && { descricao: body.descricao }),
          ...(body.categoria !== undefined && { categoria: body.categoria }),
          ...(body.valor !== undefined && { valorCentavos: body.valor }),
          ...(body.ciclo !== undefined && { ciclo: body.ciclo }),
          ...(body.diaDeCobranca !== undefined && { diaDeCobranca: body.diaDeCobranca }),
          ...(body.contraparte !== undefined && { contraparte: body.contraparte }),
          ...(body.fim !== undefined && { fim: body.fim }),
          ...(body.ativa !== undefined && { ativa: body.ativa }),
        });
        if (!ok) throw notFound('Conta fixa');

        /* Reativar precisa correr atrás do que não nasceu enquanto ela
           estava parada; alterar valor ou dia não gera nada de novo
           (a idempotência é por competência), então chamar sempre é
           barato e fecha o buraco sem um caso especial. */
        if (body.ativa === true) await gerarContasFixasDaEmpresa(client);

        await writeAudit(client, principal.tenantId, {
          action: 'finance.recurrence.update',
          resourceType: 'finance_recurrence',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { campos: Object.keys(body) },
        });

        return { ok: true };
      });
    },
  );

  app.delete(
    '/contas-fixas/:id',
    { preHandler: [app.authorize('finance:recurring:write')] },
    async (request) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);

      return inTenant(request, async (client, principal) => {
        const ok = await excluirContaFixa(client, id);
        if (!ok) throw notFound('Conta fixa');

        await writeAudit(client, principal.tenantId, {
          action: 'finance.recurrence.delete',
          resourceType: 'finance_recurrence',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
        });

        return { ok: true };
      });
    },
  );

  /* Materializar sob demanda. O agendador já faz de hora em hora; este
     botão existe para quem acabou de cadastrar e quer ver agora, e para
     quando a academia ficou dias sem o serviço no ar. */
  app.post(
    '/contas-fixas/gerar',
    { preHandler: [app.authorize('finance:recurring:write')] },
    async (request) =>
      inTenant(request, async (client, principal) => {
        const geradas = await gerarContasFixasDaEmpresa(client);
        return { data: { geradas } };
      }),
  );

  /* ------------------------------------------------------------------
   * CSV — o contador do cliente sempre pede.
   *
   * PONTO E VÍRGULA como separador, e não vírgula. O Excel em português
   * lê CSV com vírgula como uma coluna só, porque a vírgula já é o
   * separador decimal daqui — o arquivo "abre", fica ilegível, e o
   * cliente conclui que o sistema exportou errado.
   * ---------------------------------------------------------------- */
  app.get('/lancamentos.csv', { preHandler: [app.authorize('finance:report:read')] }, async (request, reply) => {
    const query = z
      .object({
        de: z.coerce.date(),
        ate: z.coerce.date(),
        direcao: z.enum(['RECEIVABLE', 'PAYABLE']).optional(),
      })
      .parse(request.query);

    return inTenant(request, async (client, principal) => {
      const { rows } = await listarLancamentos(client, {
        direcao: query.direcao,
        de: query.de,
        ate: query.ate,
        limit: 200,
        offset: 0,
      });

      await writeAudit(client, principal.tenantId, {
        action: 'finance.report.read',
        resourceType: 'report',
        resourceId: 'csv',
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { linhas: rows.length },
      });

      const cabecalho = [
        'Vencimento',
        'Competência',
        'Direção',
        'Descrição',
        'Categoria',
        'Aluno ou fornecedor',
        'Valor',
        'Pago',
        'Situação',
      ];
      const linhas = rows.map((e) => [
        e.due_date,
        e.competence_date ?? '',
        e.direction === 'RECEIVABLE' ? 'Receita' : 'Despesa',
        e.description,
        e.category ?? '',
        e.student_name ?? e.supplier_name ?? '',
        /* Vírgula decimal: é assim que a planilha em português espera o
           número, e é assim que o contador soma sem reformatar nada. */
        (e.amount_cents / 100).toFixed(2).replace('.', ','),
        (e.paid_cents / 100).toFixed(2).replace('.', ','),
        e.status,
      ]);

      const csv = [cabecalho, ...linhas]
        .map((l) => l.map(paraCampoCsv).join(';'))
        .join('\r\n');

      void reply.header('Content-Type', 'text/csv; charset=utf-8');
      void reply.header(
        'Content-Disposition',
        `attachment; filename="lancamentos-${query.de.toISOString().slice(0, 10)}.csv"`,
      );
      /* BOM no começo: sem ele o Excel abre o arquivo em Latin-1 e todo
         "ã" vira "Ã£". O arquivo está certo; o Excel é que adivinha
         errado sem a marca. */
      return `\uFEFF${csv}`;
    });
  });

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

  /* ------------------------------------------------------------------
   * FECHAR O MÊS
   *
   * O cálculo acima é VOLÁTIL: ele lê `finance_payments` agora, e uma
   * baixa retroativa muda o número de um mês que o profissional já
   * recebeu. Fechar transforma o cálculo em documento — grava o total,
   * a alíquota e a memória linha a linha — e cria a DESPESA que a
   * academia vai pagar.
   *
   * FECHAR NÃO PAGA. A baixa acontece em "A pagar", como qualquer
   * despesa. Um botão que fizesse as duas coisas afirmaria que o
   * dinheiro saiu no dia em que alguém conferiu a conta.
   * ---------------------------------------------------------------- */

  app.get(
    '/comissoes/:professionalId/fechamento',
    { preHandler: [app.authorize('commission:read')] },
    async (request) => {
      const { professionalId } = z.object({ professionalId: idSchema }).parse(request.params);
      const { mes } = z.object({ mes: z.coerce.date() }).parse(request.query);
      const scope = requireScope(request);

      if (scope.kind === 'OWN_PROFESSIONAL' && scope.professionalId !== professionalId) {
        throw notFound('Fechamento de comissão');
      }

      return inTenant(request, async (client) => {
        const f = await buscarFechamento(client, professionalId, mes);
        return {
          data:
            f === null
              ? null
              : {
                  ...f,
                  baseFormatada: formatCents(f.baseCentavos),
                  totalFormatado: formatCents(f.totalCentavos),
                  pagoFormatado: formatCents(f.lancamentoPagoCentavos),
                  quitado: f.lancamentoPagoCentavos >= f.totalCentavos,
                },
        };
      });
    },
  );

  app.post(
    '/comissoes/:professionalId/fechar',
    { preHandler: [app.authorize('commission:settle')] },
    async (request, reply) => {
      const { professionalId } = z.object({ professionalId: idSchema }).parse(request.params);
      const body = z
        .object({
          mes: z.coerce.date(),
          /* O VENCIMENTO É ESCOLHÍVEL e tem padrão. Cada academia paga
             num dia — dia 5, dia 10, no mesmo dia do fechamento — e
             fixar um deles no código faria metade delas corrigir o
             lançamento à mão toda vez. */
          vencimento: z.coerce.date().optional(),
          observacao: z.string().trim().max(500).optional(),
        })
        .parse(request.body);

      return inTenant(request, async (client, principal) => {
        const lancamentos = await baseDeComissao(
          client,
          { kind: 'ALL' },
          professionalId,
          body.mes,
        );
        const calculo = calcularComissao(lancamentos);

        const { rows: quem } = await client.query<{ nome: string }>(
          'SELECT full_name AS nome FROM users WHERE id = $1',
          [professionalId],
        );
        const profissional = quem[0]?.nome;
        if (profissional === undefined) throw notFound('Profissional');

        /* Dia 5 do mês SEGUINTE ao de referência: é quando quase toda
           academia paga, e é depois de o mês ter acabado — vencer no
           dia 30 do próprio mês colocaria a conta a pagar em atraso
           antes de o fechamento poder ser feito. */
        const padrao = new Date(body.mes.getFullYear(), body.mes.getMonth() + 1, 5);

        try {
          const feito = await fecharMes(client, principal.tenantId, {
            professionalId,
            profissional,
            mes: body.mes,
            fechamento: calculo,
            vencimento: body.vencimento ?? padrao,
            criadoPor: principal.userId,
            observacao: body.observacao,
          });

          await writeAudit(client, principal.tenantId, {
            action: 'commission.settle',
            resourceType: 'commission',
            resourceId: feito.id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
            metadata: {
              mes: body.mes.toISOString().slice(0, 7),
              profissionalId: professionalId,
              totalCentavos: calculo.totalCentavos,
              itens: calculo.itens.length,
              lancamentoId: feito.lancamentoId,
            },
          });

          void reply.status(201);
          return {
            data: {
              id: feito.id,
              lancamentoId: feito.lancamentoId,
              totalCentavos: calculo.totalCentavos,
              totalFormatado: formatCents(calculo.totalCentavos),
            },
          };
        } catch (erro) {
          if (erro instanceof FechamentoError) throw unprocessable(erro.message);
          throw erro;
        }
      });
    },
  );

  app.delete(
    '/comissoes/:professionalId/fechamento',
    { preHandler: [app.authorize('commission:settle')] },
    async (request) => {
      const { professionalId } = z.object({ professionalId: idSchema }).parse(request.params);
      const { mes } = z.object({ mes: z.coerce.date() }).parse(request.query);

      return inTenant(request, async (client, principal) => {
        try {
          const ok = await reabrirMes(client, professionalId, mes);
          if (!ok) throw notFound('Fechamento de comissão');
        } catch (erro) {
          if (erro instanceof FechamentoError) throw unprocessable(erro.message);
          throw erro;
        }

        await writeAudit(client, principal.tenantId, {
          action: 'commission.reopen',
          resourceType: 'commission',
          resourceId: professionalId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { mes: mes.toISOString().slice(0, 7) },
        });

        return { ok: true };
      });
    },
  );

  /* A visão da ACADEMIA sobre o mês: quem já fechou e quanto. Sem ela,
     saber se falta fechar alguém exige abrir os profissionais um a um. */
  app.get(
    '/comissoes/fechados',
    { preHandler: [app.authorize('commission:settle')] },
    async (request) => {
      const { mes } = z.object({ mes: z.coerce.date() }).parse(request.query);
      return inTenant(request, async (client) => {
        const linhas = await fechamentosDoMes(client, mes);
        return {
          data: linhas.map((l) => ({
            ...l,
            totalFormatado: formatCents(l.totalCentavos),
            quitado: l.pagoCentavos >= l.totalCentavos,
          })),
        };
      });
    },
  );
}
