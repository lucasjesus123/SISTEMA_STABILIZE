import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { formatCents } from '@stabilize/shared';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';
import { notFound } from '../../http/errors.js';
import { assertStudentInScope, buscarFicha } from '../students/students.repository.js';
import { anamneseVigente, listarEvolucoes } from '../records/records.repository.js';
import { listarTreinos, buscarTreino } from '../workouts/workouts.repository.js';
import {
  abrirDocumento,
  fecharDocumento,
  indicadores,
  linha,
  paragrafo,
  paraBuffer,
  secao,
  tabela,
  type Cabecalho,
} from './documento.js';
import { montarTimbre } from './timbre.js';

/**
 * Relatórios em PDF.
 *
 * CADA RELATÓRIO PASSA PELO MESMO ESCOPO DA TELA CORRESPONDENTE. Um PDF
 * não é uma porta lateral: se o profissional não pode LER o prontuário
 * de um aluno na tela, também não pode baixá-lo em PDF. Parece óbvio, e
 * é justamente o tipo de coisa que se esquece quando o relatório vira um
 * módulo à parte com sua própria consulta.
 *
 * A GERAÇÃO É AUDITADA, e com mais peso que a leitura: um PDF sai do
 * sistema. Depois de baixado, o controle acabou — não há revogação, não
 * há expiração. O log é o que resta para responder "quem tirou o
 * prontuário desta pessoa daqui".
 */

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });

/** Nome do arquivo que o navegador sugere ao salvar. */
function nomeDeArquivo(base: string): string {
  const limpo = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  const hoje = new Date().toISOString().slice(0, 10);
  return `${limpo}-${hoje}.pdf`;
}

function responderPdf(reply: FastifyReply, corpo: Buffer, nome: string): FastifyReply {
  return reply
    .header('Content-Type', 'application/pdf')
    /* `attachment`, como nos anexos e pelo mesmo motivo: PDF servido
       inline executa JavaScript no domínio do sistema em vários leitores.
       Aqui nós geramos o arquivo, mas a regra vale igual — a exceção de
       hoje é o precedente de amanhã. */
    .header('Content-Disposition', `attachment; filename="${nome}"`)
    .header('X-Content-Type-Options', 'nosniff')
    // Prontuário não fica em cache de proxy nem de navegador.
    .header('Cache-Control', 'private, no-store')
    .send(corpo);
}

/**
 * Data em pt-BR.
 *
 * Aceita `Date` e string porque o driver do PostgreSQL devolve as duas
 * coisas conforme a coluna: `date` vem como string, `timestamptz` vem
 * como Date. A primeira versão presumia string ISO e fatiava os dez
 * primeiros caracteres — com um Date, o resultado era "Sun Mar 28", em
 * inglês e sem ano, dentro de um relatório em português.
 */
const formatarData = (valor: string | Date | null): string | null => {
  if (valor === null) return null;
  const d = valor instanceof Date ? valor : new Date(`${valor.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR');
};

export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * Ficha completa do aluno: cadastro, anamnese, evolução e treino.
   * ---------------------------------------------------------------- */
  app.get(
    '/aluno/:id',
    { preHandler: [app.authorize('student:read')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const scope = requireScope(request);

      const { pdf, nome } = await inTenant(request, async (client, principal) => {
        const ficha = await buscarFicha(client, scope, id);
        if (ficha === null) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'report.generate',
            resourceType: 'student',
            resourceId: id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Aluno');
        }

        /* O que entra no PDF respeita a permissão de quem pediu, não o
           papel de quem vai ler. Uma recepcionista que baixa a ficha
           recebe cadastro e frequência; anamnese e evolução só saem para
           quem pode lê-las na tela. */
        const podeClinico = principal.role !== 'RECEPTION' && principal.role !== 'STUDENT';
        const anamnese = podeClinico ? await anamneseVigente(client, scope, id) : null;
        const evolucoes = podeClinico
          ? (await listarEvolucoes(client, scope, id, principal.userId, 20, 0)).itens
          : [];
        const treinos = await listarTreinos(client, scope, id).catch(() => []);
        const treinoAtivo = treinos.find((t) => t.status === 'ACTIVE');
        const treino =
          treinoAtivo === undefined ? null : await buscarTreino(client, scope, id, treinoAtivo.id);

        const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);

        const info: Cabecalho = {
          titulo: ficha.nome,
          subtitulo: 'Ficha do aluno',
          academia,
          rodape: `${ficha.nome} · ficha do aluno`,
          timbre,
        };

        const doc = abrirDocumento(info);
        const pronto = paraBuffer(doc);

        const totalSessoes = ficha.frequencia.presencas + ficha.frequencia.faltas;
        indicadores(doc, [
          {
            rotulo: 'Frequência',
            valor:
              totalSessoes === 0
                ? '—'
                : `${Math.round((ficha.frequencia.presencas / totalSessoes) * 100)}%`,
          },
          { rotulo: 'Presenças', valor: String(ficha.frequencia.presencas) },
          { rotulo: 'Faltas', valor: String(ficha.frequencia.faltas) },
          { rotulo: 'Em aberto', valor: formatCents(ficha.financeiro.emAbertoCentavos) },
        ]);

        secao(doc, 'Cadastro');
        linha(doc, 'Situação', ficha.status);
        linha(doc, 'E-mail', ficha.email);
        linha(doc, 'Telefone', ficha.telefone);
        linha(doc, 'WhatsApp', ficha.whatsapp);
        linha(doc, 'Nascimento', formatarData(ficha.dataNascimento));
        linha(doc, 'Documento', ficha.documento);
        linha(doc, 'Aluno desde', formatarData(ficha.inicioEm));
        linha(doc, 'Profissional', ficha.profissional?.nome ?? null);

        secao(doc, 'Endereço e emergência');
        linha(
          doc,
          'Endereço',
          ficha.endereco.logradouro === null
            ? null
            : `${ficha.endereco.logradouro}${ficha.endereco.numero !== null ? `, ${ficha.endereco.numero}` : ''} — ${ficha.endereco.bairro ?? ''}`,
        );
        linha(
          doc,
          'Cidade',
          ficha.endereco.cidade === null
            ? null
            : `${ficha.endereco.cidade}${ficha.endereco.uf !== null ? ` / ${ficha.endereco.uf}` : ''}`,
        );
        linha(doc, 'Contato de emergência', ficha.emergencia.contato);
        linha(doc, 'Telefone de emergência', ficha.emergencia.telefone);

        if (anamnese !== null) {
          secao(doc, 'Anamnese');
          linha(doc, 'Atualizada em', formatarData(anamnese.realizadaEm.toISOString()));
          linha(doc, 'Profissional', anamnese.profissional?.nome ?? null);
          if (anamnese.alturaCm !== null) linha(doc, 'Altura', `${anamnese.alturaCm} cm`);
          if (anamnese.pesoG !== null) {
            linha(doc, 'Peso', `${(anamnese.pesoG / 1000).toFixed(1)} kg`);
          }

          /* Contraindicações PRIMEIRO, como na tela. É o campo cuja
             ausência de leitura machuca alguém — não pode ficar no fim
             de sete parágrafos. */
          if (anamnese.contraindicacoes !== null) {
            secao(doc, 'Contraindicações');
            paragrafo(doc, anamnese.contraindicacoes);
          }
          for (const [rotulo, valor] of [
            ['Queixa principal', anamnese.queixaPrincipal],
            ['Histórico clínico', anamnese.historicoClinico],
            ['Lesões', anamnese.lesoes],
            ['Cirurgias', anamnese.cirurgias],
            ['Medicamentos', anamnese.medicamentos],
            ['Objetivos', anamnese.objetivos],
          ] as const) {
            if (valor !== null && valor !== '') {
              secao(doc, rotulo);
              paragrafo(doc, valor);
            }
          }
        }

        if (treino !== null) {
          secao(doc, `Treino vigente — ${treino.nome}`);
          const dias = [...new Set(treino.itens.map((i) => i.dia))];
          for (const dia of dias) {
            secao(doc, dia);
            tabela(
              doc,
              [
                { titulo: 'Exercício', largura: 210 },
                { titulo: 'Séries', largura: 55, direita: true },
                { titulo: 'Reps', largura: 70, direita: true },
                { titulo: 'Carga', largura: 75, direita: true },
                { titulo: 'Descanso', largura: 89, direita: true },
              ],
              treino.itens
                .filter((i) => i.dia === dia)
                .map((i) => [
                  i.exercicio,
                  i.series === null ? '—' : String(i.series),
                  i.repeticoes ?? '—',
                  i.cargaG === null ? '—' : `${(i.cargaG / 1000).toFixed(1)} kg`,
                  i.descansoSegundos === null ? '—' : `${i.descansoSegundos}s`,
                ]),
            );
          }
        }

        if (evolucoes.length > 0) {
          secao(doc, 'Evolução');
          for (const e of evolucoes) {
            linha(
              doc,
              `${formatarData(e.dataSessao)} · ${e.profissional.nome}`,
              e.escalaDor === null ? '' : `dor ${e.escalaDor}/10`,
            );
            paragrafo(doc, e.conteudo);
          }
        }

        fecharDocumento(doc, info);

        await writeAudit(client, principal.tenantId, {
          action: 'report.generate',
          resourceType: 'student',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: {
            relatorio: 'ficha',
            comAnamnese: anamnese !== null,
            evolucoes: evolucoes.length,
          },
        });

        return { pdf: await pronto, nome: nomeDeArquivo(`ficha-${ficha.nome}`) };
      });

      return responderPdf(reply, pdf, nome);
    },
  );

  /* ------------------------------------------------------------------
   * Relação de alunos.
   * ---------------------------------------------------------------- */
  app.get('/alunos', { preHandler: [app.authorize('student:read')] }, async (request, reply) => {
    const scope = requireScope(request);

    const pdf = await inTenant(request, async (client, principal) => {
      const { listStudents } = await import('../students/students.repository.js');
      const { rows, total } = await listStudents(client, { scope, limit: 100, offset: 0 });

      const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);

      const info: Cabecalho = {
        titulo: 'Relação de alunos',
        subtitulo: `${total} aluno(s)`,
        academia,
        rodape: 'Relação de alunos',
        timbre,
      };

      const doc = abrirDocumento(info);
      const pronto = paraBuffer(doc);

      tabela(
        doc,
        [
          { titulo: 'Nome', largura: 200 },
          { titulo: 'Situação', largura: 75 },
          { titulo: 'WhatsApp', largura: 110 },
          { titulo: 'Nascimento', largura: 114, direita: true },
        ],
        rows.map((a) => [
          a.full_name,
          a.status,
          a.whatsapp ?? '—',
          formatarData(a.birth_date) ?? '—',
        ]),
      );

      if (total > rows.length) {
        /* Truncar em silêncio faria alguém tomar decisão sobre "todos os
           alunos" olhando os cem primeiros. */
        paragrafo(
          doc,
          `Mostrando os ${rows.length} primeiros de ${total}. Use os filtros da tela para um recorte menor.`,
        );
      }

      fecharDocumento(doc, info);

      await writeAudit(client, principal.tenantId, {
        action: 'report.generate',
        resourceType: 'student',
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { relatorio: 'alunos', linhas: rows.length },
      });

      return pronto;
    });

    return responderPdf(reply, pdf, nomeDeArquivo('alunos'));
  });

  /* ------------------------------------------------------------------
   * Financeiro do período.
   * ---------------------------------------------------------------- */
  app.get(
    '/financeiro',
    { preHandler: [app.authorize('finance:report:read')] },
    async (request, reply) => {
      const { de, ate } = z
        .object({
          de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .parse(request.query);

      const pdf = await inTenant(request, async (client, principal) => {
        const { rows } = await client.query<{
          descricao: string;
          direcao: string;
          status: string;
          vencimento: string;
          valor: string;
          pago: string;
          aluno: string | null;
        }>(
          `SELECT e.description AS descricao, e.direction::text AS direcao,
                  e.status::text AS status, e.due_date AS vencimento,
                  e.amount_cents::text AS valor, e.paid_cents::text AS pago,
                  s.full_name AS aluno
             FROM finance_entries e
             LEFT JOIN students s ON s.id = e.student_id
            WHERE e.due_date BETWEEN $1::date AND $2::date
            ORDER BY e.due_date, e.description
            LIMIT 400`,
          [de, ate],
        );

        let aReceber = 0;
        let recebido = 0;
        let aPagar = 0;
        let pago = 0;
        for (const l of rows) {
          if (l.direcao === 'IN') {
            aReceber += Number(l.valor);
            recebido += Number(l.pago);
          } else {
            aPagar += Number(l.valor);
            pago += Number(l.pago);
          }
        }

        const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);

        const info: Cabecalho = {
          titulo: 'Financeiro',
          subtitulo: `${formatarData(de)} a ${formatarData(ate)}`,
          academia,
          rodape: `Financeiro ${formatarData(de)}–${formatarData(ate)}`,
          timbre,
        };

        const doc = abrirDocumento(info);
        const pronto = paraBuffer(doc);

        indicadores(doc, [
          { rotulo: 'Recebido', valor: formatCents(recebido) },
          { rotulo: 'A receber', valor: formatCents(aReceber - recebido) },
          { rotulo: 'Pago', valor: formatCents(pago) },
          { rotulo: 'Saldo realizado', valor: formatCents(recebido - pago) },
        ]);

        secao(doc, 'Lançamentos');
        tabela(
          doc,
          [
            { titulo: 'Vencimento', largura: 68 },
            { titulo: 'Descrição', largura: 175 },
            { titulo: 'Aluno', largura: 118 },
            { titulo: 'Valor', largura: 68, direita: true },
            { titulo: 'Pago', largura: 70, direita: true },
          ],
          rows.map((l) => [
            formatarData(l.vencimento) ?? '—',
            l.descricao,
            l.aluno ?? '—',
            formatCents(Number(l.valor)),
            formatCents(Number(l.pago)),
          ]),
        );

        fecharDocumento(doc, info);

        await writeAudit(client, principal.tenantId, {
          action: 'report.generate',
          resourceType: 'finance',
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { relatorio: 'financeiro', de, ate, linhas: rows.length },
        });

        return pronto;
      });

      return responderPdf(reply, pdf, nomeDeArquivo('financeiro'));
    },
  );

  /* ------------------------------------------------------------------
   * Frequência do aluno.
   * ---------------------------------------------------------------- */
  app.get(
    '/frequencia/:id',
    { preHandler: [app.authorize('attendance:read')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const scope = requireScope(request);

      const { pdf, nome } = await inTenant(request, async (client, principal) => {
        if (!(await assertStudentInScope(client, scope, id))) {
          await auditDenied(principal.tenantId, principal.userId, {
            action: 'report.generate',
            resourceType: 'student',
            resourceId: id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
          });
          throw notFound('Aluno');
        }

        const { rows } = await client.query<{
          nome: string;
          inicio: Date;
          status: string;
          profissional: string;
        }>(
          `SELECT s.full_name AS nome, a.starts_at AS inicio, a.status::text AS status,
                  u.full_name AS profissional
             FROM appointments a
             JOIN students s ON s.id = a.student_id
             JOIN users u ON u.id = a.professional_id
            WHERE a.student_id = $1
            ORDER BY a.starts_at DESC
            LIMIT 200`,
          [id],
        );

        const nomeAluno = rows[0]?.nome ?? 'Aluno';
        const presencas = rows.filter((l) => l.status === 'ATTENDED').length;
        const faltas = rows.filter((l) => l.status === 'NO_SHOW').length;
        const realizados = presencas + faltas;

        const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);

        const info: Cabecalho = {
          titulo: 'Frequência',
          subtitulo: nomeAluno,
          academia,
          rodape: `${nomeAluno} · frequência`,
          timbre,
        };

        const doc = abrirDocumento(info);
        const pronto = paraBuffer(doc);

        indicadores(doc, [
          { rotulo: 'Presenças', valor: String(presencas) },
          { rotulo: 'Faltas', valor: String(faltas) },
          {
            rotulo: 'Comparecimento',
            valor: realizados === 0 ? '—' : `${Math.round((presencas / realizados) * 100)}%`,
          },
          { rotulo: 'Agendamentos', valor: String(rows.length) },
        ]);

        secao(doc, 'Histórico');
        tabela(
          doc,
          [
            { titulo: 'Data', largura: 90 },
            { titulo: 'Hora', largura: 60 },
            { titulo: 'Profissional', largura: 180 },
            { titulo: 'Situação', largura: 169, direita: true },
          ],
          rows.map((l) => [
            l.inicio.toLocaleDateString('pt-BR'),
            l.inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
            l.profissional,
            l.status,
          ]),
        );

        fecharDocumento(doc, info);

        await writeAudit(client, principal.tenantId, {
          action: 'report.generate',
          resourceType: 'student',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { relatorio: 'frequencia' },
        });

        return { pdf: await pronto, nome: nomeDeArquivo(`frequencia-${nomeAluno}`) };
      });

      return responderPdf(reply, pdf, nome);
    },
  );
}
