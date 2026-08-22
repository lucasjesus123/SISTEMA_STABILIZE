import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { auditDenied, writeAudit } from '../../audit/audit.js';
import { notFound } from '../../http/errors.js';
import { assertStudentInScope } from '../students/students.repository.js';
import {
  abrirDocumento,
  fecharDocumento,
  graficoDeBarras,
  graficoDeLinha,
  indicadores,
  linha,
  paraBuffer,
  paragrafo,
  secao,
  tabela,
} from './documento.js';
import { montarTimbre } from './timbre.js';

/**
 * O PDF de progresso do aluno.
 *
 * O PEDIDO ERA "TUDO O QUE FOI FEITO, ÓBVIO QUE RESUMIDO, PORQUE VOU TER
 * ALUNOS DE ANOS". As duas metades desse pedido brigam, e o desenho aqui
 * é a resposta a essa briga:
 *
 *   O QUE É SÉRIE vira GRÁFICO. Peso, gordura e as circunferências
 *   principais ao longo do tempo são linhas — trinta avaliações em
 *   tabela são seis páginas que ninguém lê; em três gráficos são três
 *   olhadas. A frequência mensal vira barras.
 *
 *   O QUE É EVENTO vira RESUMO CONTADO. Não listamos as 340 sessões de
 *   um aluno de dois anos: dizemos quantas foram, em quantos meses, e a
 *   média por semana. O detalhe existe na tela; o PDF é o retrato.
 *
 *   O QUE MUDOU vira NÚMERO NO TOPO. A primeira coisa da página é o
 *   delta entre a primeira e a última avaliação — é a pergunta que o
 *   aluno faz ao pegar o papel na mão.
 *
 * A ESCALA DAS LINHAS NÃO COMEÇA EM ZERO. Peso de 74 a 78 kg num eixo
 * que começa em zero vira uma reta e a variação some. A das barras
 * começa, porque barra é comparação de tamanho e cortar a base mente.
 */

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });

const kg = (g: number): string => `${(g / 1000).toFixed(1).replace('.', ',')} kg`;
const cm = (mm: number): string => `${(mm / 10).toFixed(1).replace('.', ',')} cm`;
const pct = (x10: number): string => `${(x10 / 10).toFixed(1).replace('.', ',')}%`;

/** "2026-08-18" → "18/08/26", sem passar por `Date` e sem deslocar fuso. */
function curta(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a!.slice(2)}`;
}

export async function progressoRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/progresso/:id',
    { preHandler: [app.authorize('evolution:read')] },
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

        const aluno = await client.query<{
          nome: string;
          codigo: string | null;
          desde: string | null;
          academia: string;
        }>(
          `SELECT s.full_name AS nome, s.codigo, s.started_at::text AS desde, t.name AS academia
             FROM students s JOIN tenants t ON t.id = s.tenant_id
            WHERE s.id = $1`,
          [id],
        );
        const a = aluno.rows[0];
        if (a === undefined) throw notFound('Aluno');

        const medidas = await client.query<{
          data: string;
          peso_g: number | null;
          gordura: number | null;
          cintura: number | null;
          quadril: number | null;
          braco: number | null;
        }>(
          `SELECT measured_on::text AS data, weight_g AS peso_g,
                  gordura_pct_x10 AS gordura,
                  cintura_mm AS cintura, quadril_mm AS quadril, braco_dir_mm AS braco
             FROM body_measurements
            WHERE student_id = $1
            ORDER BY measured_on`,
          [id],
        );

        const frequencia = await client.query<{ mes: string; presencas: string; faltas: string }>(
          `SELECT to_char(date_trunc('month', lower(period)), 'MM/YY') AS mes,
                  count(*) FILTER (WHERE status = 'ATTENDED')::text AS presencas,
                  count(*) FILTER (WHERE status = 'NO_SHOW')::text AS faltas
             FROM appointments
            WHERE student_id = $1
              AND lower(period) > now() - INTERVAL '12 months'
            GROUP BY 1, date_trunc('month', lower(period))
            ORDER BY date_trunc('month', lower(period))`,
          [id],
        );

        const totais = await client.query<{
          presencas: string;
          faltas: string;
          meses: string;
          treinos: string;
        }>(
          `SELECT
             (SELECT count(*) FROM appointments WHERE student_id = $1 AND status = 'ATTENDED')::text AS presencas,
             (SELECT count(*) FROM appointments WHERE student_id = $1 AND status = 'NO_SHOW')::text AS faltas,
             (SELECT count(DISTINCT date_trunc('month', lower(period)))
                FROM appointments WHERE student_id = $1 AND status = 'ATTENDED')::text AS meses,
             (SELECT count(*) FROM workout_plans WHERE student_id = $1)::text AS treinos`,
          [id],
        );
        const t = totais.rows[0]!;

        /* Este relatório já lia o nome do banco — era o único dos cinco
           que não tinha "Stabilize" escrito à mão. O timbre entra pelo
           mesmo caminho dos outros, e o nome passa a vir da mesma fonte
           para que não existam duas maneiras de descobrir a mesma
           coisa. */
        const { academia, timbre } = await montarTimbre(client, principal.tenantId, request.log);

        const cabecalho = {
          academia,
          titulo: 'Relatório de progresso',
          subtitulo: a.codigo === null ? a.nome : `${a.nome} · aluno nº ${a.codigo}`,
          /* O rodapé repete a identificação em toda página: uma folha
             solta de um relatório de dez páginas precisa dizer de quem
             é sem depender da primeira. */
          rodape: a.codigo === null ? a.nome : `${a.nome} — nº ${a.codigo}`,
          timbre,
        };
        const doc = abrirDocumento(cabecalho);

        /* ---- o que mudou, em números ---- */
        const primeira = medidas.rows[0];
        const ultima = medidas.rows[medidas.rows.length - 1];
        const delta = (
          pega: (m: (typeof medidas.rows)[number]) => number | null,
          formata: (v: number) => string,
        ): string => {
          if (primeira === undefined || ultima === undefined || primeira === ultima) return '—';
          const i = pega(primeira);
          const f = pega(ultima);
          if (i === null || f === null) return '—';
          const d = f - i;
          /* HÍFEN ASCII, e não o sinal de menos tipográfico (U+2212).
             As fontes padrão do PDF usam codificação WinAnsi, que não
             tem esse caractere — ele sai como aspas na página. É o tipo
             de defeito que só aparece no papel impresso, nunca na tela
             de quem escreveu o código. */
          return `${d > 0 ? '+' : d < 0 ? '-' : ''}${formata(Math.abs(d))}`;
        };

        const presencas = Number(t.presencas);
        const meses = Math.max(1, Number(t.meses));

        indicadores(doc, [
          { rotulo: 'Peso', valor: delta((m) => m.peso_g, kg) },
          { rotulo: 'Cintura', valor: delta((m) => m.cintura, cm) },
          { rotulo: 'Gordura', valor: delta((m) => m.gordura, pct) },
          { rotulo: 'Presenças', valor: String(presencas) },
          /* MÉDIA POR SEMANA e não total: é o número que diz se a
             rotina existe. 340 presenças em dois anos e 340 em oito
             meses são histórias diferentes. */
          {
            rotulo: 'Por semana',
            valor: (presencas / (meses * 4.33)).toFixed(1).replace('.', ','),
          },
        ]);

        if (a.desde !== null) {
          paragrafo(
            doc,
            [
              `Acompanhamento desde ${curta(a.desde)}.`,
              /* "avaliações", não "avaliaçãoões": o plural de palavra
                 terminada em -ão troca a terminação inteira. Concatenar
                 sufixo cegamente erra em toda uma classe de palavras do
                 português, e o erro só aparece com n diferente de 1. */
              medidas.rows.length === 1
                ? '1 avaliação física registrada,'
                : `${medidas.rows.length} avaliações físicas registradas,`,
              t.treinos === '1' ? '1 treino prescrito' : `${t.treinos} treinos prescritos`,
              t.faltas === '1' ? 'e 1 falta.' : `e ${t.faltas} faltas.`,
            ].join(' '),
          );
        }

        /* ---- as séries viram gráfico ---- */
        if (medidas.rows.length >= 2) {
          secao(doc, 'Evolução das medidas');

          const serie = (
            pega: (m: (typeof medidas.rows)[number]) => number | null,
          ): { rotulo: string; valor: number }[] =>
            medidas.rows
              .filter((m) => pega(m) !== null)
              .map((m) => ({ rotulo: curta(m.data), valor: pega(m)! }));

          graficoDeLinha(doc, 'Peso', serie((m) => m.peso_g), kg);
          graficoDeLinha(doc, 'Cintura', serie((m) => m.cintura), cm);
          graficoDeLinha(doc, 'Gordura corporal', serie((m) => m.gordura), pct);
          graficoDeLinha(doc, 'Quadril', serie((m) => m.quadril), cm);
          graficoDeLinha(doc, 'Braço direito', serie((m) => m.braco), cm);
        }

        if (frequencia.rows.length > 0) {
          secao(doc, 'Frequência');
          graficoDeBarras(
            doc,
            'Presenças por mês',
            frequencia.rows.map((f) => ({ rotulo: f.mes, valor: Number(f.presencas) })),
            (v) => String(v),
          );
        }

        /* ---- a primeira e a última, lado a lado ----
           Não as trinta: o comparativo responde "mudou quanto", e o
           meio do caminho já está nos gráficos. */
        if (primeira !== undefined && ultima !== undefined && primeira !== ultima) {
          secao(doc, `Comparativo — ${curta(primeira.data)} e ${curta(ultima.data)}`);
          tabela(
            doc,
            [
              { titulo: 'Medida', largura: 0.4 },
              { titulo: curta(primeira.data), largura: 0.2, direita: true },
              { titulo: curta(ultima.data), largura: 0.2, direita: true },
              { titulo: 'Variação', largura: 0.2, direita: true },
            ],
            (
              [
                ['Peso', (m) => m.peso_g, kg],
                ['Gordura', (m) => m.gordura, pct],
                ['Cintura', (m) => m.cintura, cm],
                ['Quadril', (m) => m.quadril, cm],
                ['Braço direito', (m) => m.braco, cm],
              ] as [string, (m: (typeof medidas.rows)[number]) => number | null, (v: number) => string][]
            )
              .filter(([, pega]) => pega(primeira) !== null || pega(ultima) !== null)
              .map(([nomeDaMedida, pega, formata]) => [
                nomeDaMedida,
                pega(primeira) === null ? '—' : formata(pega(primeira)!),
                pega(ultima) === null ? '—' : formata(pega(ultima)!),
                delta(pega, formata),
              ]),
          );
        }

        if (medidas.rows.length === 0) {
          paragrafo(
            doc,
            'Ainda não há avaliação física registrada. A primeira é o ponto de partida: sem ela não há do que comparar daqui a três meses.',
          );
        }

        linha(doc, 'Emitido para', a.nome);
        fecharDocumento(doc, cabecalho);

        await writeAudit(client, principal.tenantId, {
          action: 'report.generate',
          resourceType: 'student',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { relatorio: 'progresso', avaliacoes: medidas.rows.length },
        });

        return { pdf: await paraBuffer(doc), nome: a.nome };
      });

      void reply.header('Content-Type', 'application/pdf');
      void reply.header(
        'Content-Disposition',
        `attachment; filename="progresso-${nome.replace(/[^\w]+/g, '-').toLowerCase()}.pdf"`,
      );
      return reply.send(pdf);
    },
  );
}
