import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { formatCents } from '@stabilize/shared';
import { inTenant } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import {
  abrirDocumento,
  fecharDocumento,
  indicadores,
  paragrafo,
  paraBuffer,
  secao,
  tabela,
  type Cabecalho,
} from './documento.js';
import { montarTimbre } from './timbre.js';
import { buscarFechamento } from '../finance/fechamento.js';
import { baseDeComissao } from '../finance/finance.repository.js';
import { calcularComissao } from '../finance/commission.js';
import { requireScope } from '../../http/plugins/authenticate.js';
import { notFound } from '../../http/errors.js';

/**
 * Os relatórios de GESTÃO — os que olham a academia inteira, e não um
 * aluno.
 *
 * OS TRÊS QUE FALTAVAM, e o que cada um responde:
 *
 *   presenca   — "quem veio no mês?", geral ou de um professor só.
 *                Existia apenas por aluno, um de cada vez, o que não
 *                serve para a conversa que a academia realmente tem no
 *                fim do mês.
 *   ocupacao   — "quantas HORAS o professor X trabalhou?". Havia como
 *                saber quanto ele recebeu; não havia como saber quanto
 *                ele ocupou. São perguntas diferentes, e a segunda é a
 *                que decide contratar, remanejar horário e discutir
 *                comissão com números.
 *   inadimplencia — "quem está devendo, e há quanto tempo?". A TELA já
 *                mostrava vencido; o PDF, não — e é o PDF que vai para
 *                a reunião e para o contador.
 *
 * TODOS SÃO RECORTE DE PERÍODO, e o período vem sempre de fora. Um
 * relatório que decide sozinho o mês corrente é um relatório que não
 * serve para fechar o mês anterior, que é quando ele é pedido.
 */

const periodoSchema = z.object({
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inicial no formato AAAA-MM-DD'),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data final no formato AAAA-MM-DD'),
  profissionalId: z.string().uuid().optional(),
});

function nomeDeArquivo(base: string): string {
  const agora = new Date().toISOString().slice(0, 10);
  return `${base}-${agora}.pdf`;
}

function responderPdf(reply: FastifyReply, corpo: Buffer, nome: string): FastifyReply {
  return reply
    .type('application/pdf')
    .header('Content-Disposition', `attachment; filename="${nome}"`)
    .header('Cache-Control', 'no-store')
    .send(corpo);
}

const dataBr = (d: Date | string): string => {
  const v = typeof d === 'string' ? new Date(`${d}T12:00:00Z`) : d;
  return v.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
};

/**
 * O período em `timestamptz`, respeitando o fuso da academia.
 *
 * `(x::date)::timestamp AT TIME ZONE tz` e não `x::date AT TIME ZONE tz`
 * — a segunda forma converte DUAS VEZES. Um `date` é promovido a
 * `timestamptz` antes do operador, então a expressão cai na variante
 * que converte de volta pelo fuso da sessão, e o intervalo sai três
 * horas deslocado. Foi medido: '2026-09-01'::date AT TIME ZONE
 * 'America/Sao_Paulo' devolve 2026-08-31 21:00.
 */
const INICIO = `($1::date)::timestamp AT TIME ZONE t.timezone`;
const FIM = `(($2::date + 1))::timestamp AT TIME ZONE t.timezone`;

export async function gestaoRoutes(app: FastifyInstance): Promise<void> {
  /* ==================================================================
   * Presença do mês — geral ou por professor
   * ================================================================ */
  app.get(
    '/presenca',
    { preHandler: [app.authorize('attendance:read')] },
    async (request, reply) => {
      const { de, ate, profissionalId } = periodoSchema.parse(request.query);

      const pdf = await inTenant(request, async (client, principal) => {
        const { rows } = await client.query<{
          aluno: string;
          codigo: number | null;
          profissional: string;
          presencas: string;
          faltas: string;
          agendados: string;
        }>(
          `SELECT s.full_name AS aluno, s.codigo,
                  coalesce(u.full_name, '—') AS profissional,
                  count(*) FILTER (WHERE a.status = 'ATTENDED')::text AS presencas,
                  count(*) FILTER (WHERE a.status = 'NO_SHOW')::text  AS faltas,
                  count(*)::text AS agendados
             FROM appointments a
             JOIN students s ON s.id = a.student_id
             LEFT JOIN users u ON u.id = a.professional_id
             CROSS JOIN tenants t
            WHERE lower(a.period) >= ${INICIO}
              AND lower(a.period) <  ${FIM}
              AND ($3::uuid IS NULL OR a.professional_id = $3)
            GROUP BY s.full_name, s.codigo, u.full_name
            ORDER BY count(*) FILTER (WHERE a.status = 'ATTENDED') DESC, s.full_name`,
          [de, ate, profissionalId ?? null],
        );

        const soma = (c: 'presencas' | 'faltas' | 'agendados'): number =>
          rows.reduce((t, l) => t + Number(l[c]), 0);
        const presencas = soma('presencas');
        const faltas = soma('faltas');
        const realizados = presencas + faltas;

        const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);
        const doQuem =
          profissionalId === undefined ? 'Toda a academia' : (rows[0]?.profissional ?? 'Professor');

        const info: Cabecalho = {
          titulo: 'Presença no período',
          subtitulo: `${dataBr(de)} a ${dataBr(ate)} · ${doQuem}`,
          academia,
          rodape: `Presença ${dataBr(de)}–${dataBr(ate)}`,
          timbre,
        };

        const doc = abrirDocumento(info);
        const pronto = paraBuffer(doc);

        indicadores(doc, [
          { rotulo: 'Alunos', valor: String(rows.length) },
          { rotulo: 'Presenças', valor: String(presencas) },
          { rotulo: 'Faltas', valor: String(faltas) },
          {
            /* A taxa é sobre o REALIZADO — presenças mais faltas —, e não
               sobre o agendado. Aula cancelada com antecedência não é
               falta de ninguém, e contá-la puniria o aluno que avisou. */
            rotulo: 'Comparecimento',
            valor: realizados === 0 ? '—' : `${Math.round((presencas / realizados) * 100)}%`,
          },
        ]);

        if (rows.length === 0) {
          paragrafo(doc, 'Nenhum atendimento agendado neste período.');
        } else {
          secao(doc, 'Por aluno');
          tabela(
            doc,
            [
              { titulo: 'Código', largura: 48 },
              { titulo: 'Aluno', largura: 168 },
              { titulo: 'Professor', largura: 130 },
              { titulo: 'Presenças', largura: 52, direita: true },
              { titulo: 'Faltas', largura: 44, direita: true },
              { titulo: '%', largura: 40, direita: true },
            ],
            rows.map((l) => {
              const feitos = Number(l.presencas) + Number(l.faltas);
              return [
                l.codigo === null ? '—' : String(l.codigo),
                l.aluno,
                l.profissional,
                l.presencas,
                l.faltas,
                feitos === 0 ? '—' : `${Math.round((Number(l.presencas) / feitos) * 100)}%`,
              ];
            }),
          );
        }

        fecharDocumento(doc, info);

        await writeAudit(client, principal.tenantId, {
          action: 'report.generate',
          resourceType: 'report',
          resourceId: 'presenca',
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { de, ate, porProfissional: profissionalId !== undefined },
        });

        return pronto;
      });

      return responderPdf(reply, pdf, nomeDeArquivo('presenca'));
    },
  );

  /* ==================================================================
   * Ocupação — quantas horas cada professor trabalhou
   * ================================================================ */
  app.get(
    '/ocupacao',
    { preHandler: [app.authorize('commission:read')] },
    async (request, reply) => {
      const { de, ate } = periodoSchema.parse(request.query);

      const pdf = await inTenant(request, async (client, principal) => {
        const { rows } = await client.query<{
          profissional: string;
          atendimentos: string;
          realizados: string;
          minutos: string;
          alunos: string;
          recebido: string;
        }>(
          /* OS MINUTOS SAEM DA DURAÇÃO REAL de cada atendimento, e não de
             uma média multiplicada pela contagem: a academia tem sessão
             de 30, de 50 e de 60 minutos, e a média esconderia
             exatamente a diferença que interessa. */
          `SELECT u.full_name AS profissional,
                  count(*)::text AS atendimentos,
                  count(*) FILTER (WHERE a.status = 'ATTENDED')::text AS realizados,
                  coalesce(sum(
                    EXTRACT(EPOCH FROM (upper(a.period) - lower(a.period))) / 60
                  ) FILTER (WHERE a.status = 'ATTENDED'), 0)::bigint::text AS minutos,
                  count(DISTINCT a.student_id)::text AS alunos,
                  /* O RECEBIDO VEM DA COLUNA paid_cents, que o
                     financeiro já mantém somada, e não de um subselect
                     em finance_payments.

                     A primeira versão fazia o subselect e usava
                     t.timezone lá dentro — o PostgreSQL recusa:
                     "subquery uses ungrouped column t.timezone from
                     outer query". Daria para contornar repetindo o
                     fuso, mas o contorno esconderia que a soma já
                     existe pronta um nível acima.

                     O recorte aqui é por VENCIMENTO e não por data de
                     pagamento. É a escolha certa para este relatório:
                     ele responde "quanto o professor gerou no período
                     que trabalhou", e não "quanto entrou no caixa em
                     março" — que é pergunta do relatório financeiro. */
                  (SELECT coalesce(sum(e.paid_cents), 0)::text
                     FROM finance_entries e
                    WHERE e.professional_id = u.id
                      AND e.direction = 'RECEIVABLE'
                      AND e.due_date BETWEEN $1::date AND $2::date) AS recebido
             FROM appointments a
             JOIN users u ON u.id = a.professional_id
             CROSS JOIN tenants t
            WHERE lower(a.period) >= ${INICIO}
              AND lower(a.period) <  ${FIM}
            GROUP BY u.id, u.full_name
            ORDER BY sum(
                       EXTRACT(EPOCH FROM (upper(a.period) - lower(a.period))) / 60
                     ) FILTER (WHERE a.status = 'ATTENDED') DESC NULLS LAST`,
          [de, ate],
        );

        const totalMinutos = rows.reduce((t, l) => t + Number(l.minutos), 0);
        const totalAtend = rows.reduce((t, l) => t + Number(l.realizados), 0);

        const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);

        const info: Cabecalho = {
          titulo: 'Ocupação por professor',
          subtitulo: `${dataBr(de)} a ${dataBr(ate)}`,
          academia,
          rodape: `Ocupação ${dataBr(de)}–${dataBr(ate)}`,
          timbre,
        };

        const doc = abrirDocumento(info);
        const pronto = paraBuffer(doc);

        indicadores(doc, [
          { rotulo: 'Professores', valor: String(rows.length) },
          { rotulo: 'Horas atendidas', valor: horas(totalMinutos) },
          { rotulo: 'Atendimentos', valor: String(totalAtend) },
        ]);

        if (rows.length === 0) {
          paragrafo(doc, 'Nenhum atendimento no período.');
        } else {
          secao(doc, 'Por professor');
          tabela(
            doc,
            [
              { titulo: 'Professor', largura: 150 },
              { titulo: 'Alunos', largura: 48, direita: true },
              { titulo: 'Agendados', largura: 58, direita: true },
              { titulo: 'Realizados', largura: 60, direita: true },
              { titulo: 'Horas', largura: 50, direita: true },
              { titulo: 'Recebido', largura: 76, direita: true },
            ],
            rows.map((l) => [
              l.profissional,
              l.alunos,
              l.atendimentos,
              l.realizados,
              horas(Number(l.minutos)),
              formatCents(Number(l.recebido)),
            ]),
          );

          paragrafo(
            doc,
            'As horas contam apenas atendimentos marcados como realizados, pela duração de cada um. Cancelados e faltas não entram — quem não veio não ocupou a sala.',
          );
        }

        fecharDocumento(doc, info);

        await writeAudit(client, principal.tenantId, {
          action: 'report.generate',
          resourceType: 'report',
          resourceId: 'ocupacao',
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { de, ate },
        });

        return pronto;
      });

      return responderPdf(reply, pdf, nomeDeArquivo('ocupacao'));
    },
  );

  /* ==================================================================
   * Inadimplência
   * ================================================================ */
  app.get(
    '/inadimplencia',
    { preHandler: [app.authorize('finance:receivable:read')] },
    async (request, reply) => {
      const pdf = await inTenant(request, async (client, principal) => {
        const { rows } = await client.query<{
          aluno: string;
          codigo: number | null;
          descricao: string;
          vencimento: Date;
          dias: string;
          aberto: string;
          whatsapp: string | null;
        }>(
          /* DUAS DECISÕES NESTA CONSULTA, e as duas nasceram de errar
             antes.

             1. O ABERTO É O SALDO, não o valor da cobrança. Baixa
                parcial existe, e listar o valor cheio de uma conta já
                paga pela metade inflaria a inadimplência da academia —
                no caso do teste, em 50%.

             2. NÃO FILTRA POR `status = 'OVERDUE'`. Uma cobrança
                vencida que recebeu baixa parcial passa a
                'PARTIALLY_PAID' e sumiria do relatório — justamente a
                que mais interessa, porque é a que a pessoa começou a
                pagar e parou. Além disso, a régua que marca OVERDUE
                roda de hora em hora: filtrar pelo status faria o
                relatório depender de um job ter passado. O critério é
                o fato: venceu e ainda tem saldo. */
          `SELECT coalesce(s.full_name, e.description) AS aluno, s.codigo,
                  e.description AS descricao, e.due_date AS vencimento,
                  (CURRENT_DATE - e.due_date)::text AS dias,
                  (e.amount_cents - coalesce((
                     SELECT sum(p.amount_cents) FROM finance_payments p WHERE p.entry_id = e.id
                  ), 0))::text AS aberto,
                  s.whatsapp
             FROM finance_entries e
             LEFT JOIN students s ON s.id = e.student_id
            WHERE e.direction = 'RECEIVABLE'
              AND e.status <> 'CANCELLED'
              AND e.due_date < CURRENT_DATE
              AND e.amount_cents > coalesce((
                    SELECT sum(p.amount_cents) FROM finance_payments p WHERE p.entry_id = e.id
                  ), 0)
            ORDER BY e.due_date`,
          [],
        );

        const total = rows.reduce((t, l) => t + Number(l.aberto), 0);
        const alunos = new Set(rows.map((l) => l.aluno)).size;
        const maisVelha = rows[0];

        const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);

        const info: Cabecalho = {
          titulo: 'Inadimplência',
          subtitulo: `Posição de ${dataBr(new Date())}`,
          academia,
          rodape: 'Inadimplência',
          timbre,
        };

        const doc = abrirDocumento(info);
        const pronto = paraBuffer(doc);

        indicadores(doc, [
          { rotulo: 'Em aberto', valor: formatCents(total) },
          { rotulo: 'Cobranças', valor: String(rows.length) },
          { rotulo: 'Alunos', valor: String(alunos) },
          {
            rotulo: 'Atraso máximo',
            valor: maisVelha === undefined ? '—' : `${maisVelha.dias} dias`,
          },
        ]);

        if (rows.length === 0) {
          paragrafo(doc, 'Nenhuma cobrança vencida. Nada a receber em atraso nesta data.');
        } else {
          secao(doc, 'Cobranças vencidas');
          tabela(
            doc,
            [
              { titulo: 'Venceu', largura: 56 },
              { titulo: 'Dias', largura: 34, direita: true },
              { titulo: 'Aluno', largura: 150 },
              { titulo: 'Cobrança', largura: 140 },
              { titulo: 'Em aberto', largura: 72, direita: true },
            ],
            rows.map((l) => [
              dataBr(l.vencimento),
              l.dias,
              l.codigo === null ? l.aluno : `${l.aluno} (nº ${l.codigo})`,
              l.descricao,
              formatCents(Number(l.aberto)),
            ]),
          );

          paragrafo(
            doc,
            'A coluna "em aberto" já desconta pagamentos parciais. A régua que marca uma cobrança como vencida roda de hora em hora, então esta posição é a do momento da emissão.',
          );
        }

        fecharDocumento(doc, info);

        await writeAudit(client, principal.tenantId, {
          action: 'finance.report.read',
          resourceType: 'report',
          resourceId: 'inadimplencia',
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { cobrancas: rows.length },
        });

        return pronto;
      });

      return responderPdf(reply, pdf, nomeDeArquivo('inadimplencia'));
    },
  );

  /* ==================================================================
   * FECHAMENTO DO PROFISSIONAL — o papel que vai junto com o pagamento
   *
   * É O RELATÓRIO MAIS PEDIDO E O QUE NÃO EXISTIA. A academia fecha o
   * mês, paga o professor e precisa entregar a ele o que sustenta o
   * número: quanto entrou pelos alunos dele, qual o percentual, quanto
   * fica para a academia e quanto ele recebe. Sem esse papel, a
   * conversa do dia 5 é a palavra de um contra a do outro.
   *
   * SAI FECHADO OU PRÉVIA, e o documento DIZ QUAL DOS DOIS É. Se o mês
   * já foi fechado, os números vêm da tabela — congelados no dia em que
   * se fechou. Se não foi, vêm do cálculo de agora, e o relatório traz
   * "prévia" no subtítulo: entregar uma prévia com cara de documento
   * final é como o valor muda entre o papel e o pagamento.
   * ================================================================ */
  app.get(
    '/comissao',
    { preHandler: [app.authorize('commission:read')] },
    async (request, reply) => {
      const { profissionalId, mes } = z
        .object({
          profissionalId: z.string().uuid(),
          mes: z.string().regex(/^\d{4}-\d{2}$/, 'Mês no formato AAAA-MM'),
        })
        .parse(request.query);

      const scope = requireScope(request);
      if (scope.kind === 'OWN_PROFESSIONAL' && scope.professionalId !== profissionalId) {
        throw notFound('Fechamento de comissão');
      }

      const referencia = new Date(`${mes}-01T12:00:00Z`);

      const pdf = await inTenant(request, async (client, principal) => {
        const gravado = await buscarFechamento(client, profissionalId, referencia);

        const { rows: quem } = await client.query<{ nome: string; email: string }>(
          'SELECT full_name AS nome, email::text AS email FROM users WHERE id = $1',
          [profissionalId],
        );
        const pessoa = quem[0];
        if (pessoa === undefined) throw notFound('Profissional');

        /* Vindo da tabela quando fechado, do cálculo quando não. As duas
           formas produzem a mesma estrutura de linhas de propósito: o
           documento é o mesmo, muda só a origem e o carimbo. */
        const itens =
          gravado !== null
            ? gravado.itens
            : calcularComissao(
                await baseDeComissao(client, { kind: 'ALL' }, profissionalId, referencia),
              ).itens.map((i) => ({
                descricao: i.descricao,
                baseCentavos: i.baseCentavos,
                aliquotaBp: i.aliquotaBp,
                valorCentavos: i.valorCentavos,
              }));

        const base = gravado?.baseCentavos ?? itens.reduce((a, i) => a + i.baseCentavos, 0);
        const total = gravado?.totalCentavos ?? itens.reduce((a, i) => a + i.valorCentavos, 0);
        const aliquota =
          gravado?.aliquotaMediaBp ?? (base === 0 ? 0 : Math.round((total / base) * 10_000));

        /* QUANTOS ATENDIMENTOS o profissional fez no mês. Não entra na
           conta da comissão — que sai do recebido — e entra no papel,
           porque é a pergunta seguinte de quem lê: "o valor caiu, eu
           trabalhei menos?". Ter os dois números lado a lado responde
           sozinho. */
        const { rows: atend } = await client.query<{
          realizados: string;
          faltas: string;
          minutos: string;
          alunos: string;
        }>(
          `SELECT count(*) FILTER (WHERE a.status = 'ATTENDED')::text AS realizados,
                  count(*) FILTER (WHERE a.status = 'NO_SHOW')::text  AS faltas,
                  coalesce(sum(
                    EXTRACT(EPOCH FROM (upper(a.period) - lower(a.period))) / 60
                  ) FILTER (WHERE a.status = 'ATTENDED'), 0)::bigint::text AS minutos,
                  count(DISTINCT a.student_id)::text AS alunos
             FROM appointments a
             CROSS JOIN tenants t
            WHERE t.id = current_tenant_id()
              AND a.professional_id = $1
              AND lower(a.period) >= (date_trunc('month', $2::date))::timestamp AT TIME ZONE t.timezone
              AND lower(a.period) <  (date_trunc('month', $2::date) + INTERVAL '1 month')::timestamp AT TIME ZONE t.timezone`,
          [profissionalId, referencia],
        );
        const a = atend[0] ?? { realizados: '0', faltas: '0', minutos: '0', alunos: '0' };

        const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);
        const [ano, mesNum] = mes.split('-');
        const nomeDoMes = referencia.toLocaleDateString('pt-BR', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        });

        const info: Cabecalho = {
          titulo: 'Fechamento do profissional',
          subtitulo: `${pessoa.nome} · ${nomeDoMes}${gravado === null ? ' · PRÉVIA' : ''}`,
          academia,
          rodape: `Fechamento ${mesNum}/${ano} — ${pessoa.nome}`,
          timbre,
        };

        const doc = abrirDocumento(info);
        const pronto = paraBuffer(doc);

        /* O NÚMERO QUE IMPORTA PRIMEIRO. Quem recebe este papel tem uma
           pergunta só, e ela não é "qual foi a base". */
        indicadores(doc, [
          { rotulo: 'A receber', valor: formatCents(total) },
          { rotulo: 'Base (recebido)', valor: formatCents(base) },
          {
            rotulo: 'Percentual',
            valor: `${(aliquota / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`,
          },
          { rotulo: 'Fica na academia', valor: formatCents(base - total) },
        ]);

        secao(doc, 'O mês em números');
        indicadores(doc, [
          { rotulo: 'Atendimentos', valor: a.realizados },
          { rotulo: 'Faltas', valor: a.faltas },
          { rotulo: 'Horas atendidas', valor: horas(Number(a.minutos)) },
          { rotulo: 'Alunos distintos', valor: a.alunos },
        ]);

        if (itens.length === 0) {
          paragrafo(
            doc,
            'Nenhum recebimento neste mês. A comissão sai do que foi efetivamente PAGO pelo aluno — não do que foi cobrado —, então uma mensalidade em aberto ainda não gera repasse. Ela entra no fechamento do mês em que for paga.',
          );
        } else {
          secao(doc, 'De onde veio cada centavo');
          tabela(
            doc,
            [
              { titulo: 'Recebimento', largura: 250 },
              { titulo: 'Base', largura: 90, direita: true },
              { titulo: '%', largura: 50, direita: true },
              { titulo: 'Comissão', largura: 92, direita: true },
            ],
            itens.map((i) => [
              i.descricao,
              formatCents(i.baseCentavos),
              `${(i.aliquotaBp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`,
              formatCents(i.valorCentavos),
            ]),
          );

          /* A LINHA DE TOTAL DEPOIS DA TABELA, e não como última linha
             dela: uma linha de soma com a mesma forma das outras é lida
             como mais um item, e some no meio de trinta. */
          secao(doc, 'Total a repassar');
          indicadores(doc, [
            { rotulo: 'Recebimentos', valor: String(itens.length) },
            { rotulo: 'Base somada', valor: formatCents(base) },
            { rotulo: 'A pagar ao profissional', valor: formatCents(total) },
          ]);
        }

        if (gravado !== null) {
          paragrafo(
            doc,
            `Mês FECHADO em ${new Date(gravado.fechadoEm).toLocaleDateString('pt-BR')}. ` +
              `Os valores acima estão congelados nesta data e não mudam com lançamentos posteriores. ` +
              (gravado.lancamentoVencimento === null
                ? ''
                : `O repasse foi lançado em contas a pagar com vencimento em ${new Date(`${gravado.lancamentoVencimento}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}. `) +
              (gravado.lancamentoPagoCentavos >= gravado.totalCentavos
                ? 'Já quitado.'
                : gravado.lancamentoPagoCentavos > 0
                  ? `Pago até aqui: ${formatCents(gravado.lancamentoPagoCentavos)}.`
                  : 'Ainda não pago.'),
          );
        } else {
          paragrafo(
            doc,
            'PRÉVIA — este mês ainda não foi fechado. Os valores são os de agora e podem mudar até o fechamento: uma baixa lançada hoje com data do mês passado entra nesta conta. Ao fechar o mês, os números são congelados e o repasse vira uma conta a pagar.',
          );
        }

        paragrafo(
          doc,
          'A comissão é calculada sobre o valor RECEBIDO de cada aluno, não sobre o cobrado. Um aluno que paga com atraso gera comissão no mês do pagamento.',
        );

        fecharDocumento(doc, info);

        await writeAudit(client, principal.tenantId, {
          action: 'report.generate',
          resourceType: 'report',
          resourceId: 'comissao',
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { mes, profissionalId, fechado: gravado !== null, itens: itens.length },
        });

        return pronto;
      });

      return responderPdf(reply, pdf, nomeDeArquivo(`fechamento-${mes}`));
    },
  );
}

/** 95 minutos vira "1h35". Decimal ("1,58h") ninguém consegue conferir. */
function horas(minutos: number): string {
  if (minutos <= 0) return '—';
  const h = Math.floor(minutos / 60);
  const m = Math.round(minutos % 60);
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}
