import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { conflict, notFound } from '../../http/errors.js';
import type { AccessScope } from '../../auth/scope.js';

/**
 * O diário de treino do aluno.
 *
 * A TABELA `workout_logs` EXISTIA DESDE O COMEÇO E NINGUÉM ESCREVIA
 * NELA. O aplicativo mostrava o treino e não deixava dizer que fez — um
 * PDF com login. O aluno abria na terça sem conseguir lembrar se tinha
 * feito o B na segunda, o professor prescrevia doze semanas e descobria
 * na reavaliação que foram seis, e o relatório de progresso contava só
 * as sessões agendadas, que para quem faz musculação é zero.
 *
 * O REGISTRO É DO ALUNO E SÓ DO ALUNO. Nenhuma rota aqui recebe id de
 * aluno: ele sai do token. Um diário que outra pessoa pode escrever não
 * é diário — e o professor que precisar corrigir uma data faz isso pela
 * evolução, que é registro clínico assinado por ele.
 *
 * A DATA VEM DO CLIENTE, dentro de um limite. O celular do aluno sabe
 * que dia é hoje na cidade dele; o servidor sabe o fuso da academia, que
 * não é necessariamente o mesmo (aluno viajando). Aceitar a data do
 * cliente com um teto de ontem-e-hoje resolve os dois casos sem deixar
 * ninguém preencher a semana inteira de uma vez.
 */

function alunoDoToken(scope: AccessScope): string {
  if (scope.kind !== 'SELF') throw notFound('Aluno');
  return scope.studentId;
}

const marcarSchema = z.object({
  /* A letra do dia do treino: "A", "B", "Peito"… é texto livre porque é
     o professor quem escreve, e ele escreve o que quiser. */
  dia: z.string().trim().min(1).max(40),
  /* De 1 a 5 — a escala que o schema original já declarava. Opcional de
     propósito: exigir uma nota de esforço a cada treino é o tipo de campo
     obrigatório que faz a pessoa parar de marcar. */
  esforco: z.coerce.number().int().min(1).max(5).nullish(),
  notas: z.string().trim().max(500).nullish().transform((v) => v || null),
  /* Ontem é o mais longe que se registra. Quem esqueceu de marcar na
     terça marca na quarta; quem quer preencher o mês passado está
     inventando histórico, não registrando. */
  quando: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
    .optional(),
});

export async function diarioDoAlunoRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * POST /api/eu/treino/feito
   * ---------------------------------------------------------------- */
  app.post(
    '/treino/feito',
    { preHandler: [app.authorize('self:write')] },
    async (request, reply) => {
      const body = marcarSchema.parse(request.body);
      const alunoId = alunoDoToken(requireScope(request));

      return inTenant(request, async (client, principal) => {
        const criado = await client
          .query<{ id: string; done_on: string }>(
            /* INSERT ... SELECT, e não VALUES: a data depende do fuso da
               ACADEMIA, que mora em `tenants`, e VALUES não tem FROM.
               A primeira versão misturou os dois e o Postgres devolveu
               erro de sintaxe em toda marcação. */
            `INSERT INTO workout_logs (tenant_id, student_id, day_label, done_on, effort, notes)
             SELECT $1, $2, $3,
                    /* A data escolhida, limitada a ontem e hoje NO FUSO DA
                       ACADEMIA. O LEAST corta o futuro; o GREATEST corta o
                       passado distante. Fazer isso no banco e não em
                       JavaScript é o que garante que o limite valha para
                       qualquer cliente, inclusive um com o relógio errado. */
                    GREATEST(
                      LEAST(
                        COALESCE($4::date, (now() AT TIME ZONE t.timezone)::date),
                        (now() AT TIME ZONE t.timezone)::date
                      ),
                      (now() AT TIME ZONE t.timezone)::date - 1
                    ),
                    $5, $6
               FROM tenants t WHERE t.id = $1
             RETURNING id, done_on::text AS done_on`,
            [
              principal.tenantId,
              alunoId,
              body.dia,
              body.quando ?? null,
              body.esforco ?? null,
              body.notas,
            ],
          )
          .catch((e: unknown) => {
            /* 23505 é o índice único (aluno, dia, letra). Dois toques no
               botão num celular com conexão ruim é a regra, não a
               exceção — e sem esta tradução o aluno via "erro" depois de
               ter marcado com sucesso. */
            if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
              throw conflict('Você já marcou este treino neste dia.');
            }
            throw e;
          });

        const l = criado.rows[0]!;
        void reply.status(201);
        return { data: { id: l.id, quando: l.done_on } };
      });
    },
  );

  /* ------------------------------------------------------------------
   * DELETE /api/eu/treino/feito/:id — desmarcar
   *
   * EXISTE PORQUE O TOQUE ERRADO EXISTE. Sem desfazer, quem marcou o B
   * quando fez o A fica com o histórico errado para sempre, e a próxima
   * reação é parar de marcar.
   * ---------------------------------------------------------------- */
  app.delete(
    '/treino/feito/:id',
    { preHandler: [app.authorize('self:write')] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid('Identificador inválido') }).parse(
        request.params,
      );
      const alunoId = alunoDoToken(requireScope(request));

      return inTenant(request, async (client) => {
        /* O `student_id` no WHERE é redundante com a RLS e está aqui de
           propósito: a RLS separa academias, não separa alunos da mesma
           academia. Sem esta linha, um aluno apagaria o registro de
           outro trocando o uuid na chamada. */
        const { rowCount } = await client.query(
          'DELETE FROM workout_logs WHERE id = $1 AND student_id = $2',
          [id, alunoId],
        );
        if ((rowCount ?? 0) === 0) throw notFound('Registro');
        return { ok: true };
      });
    },
  );

  /* ------------------------------------------------------------------
   * GET /api/eu/treino/diario — o histórico e o que já foi feito hoje
   * ---------------------------------------------------------------- */
  app.get('/treino/diario', { preHandler: [app.authorize('self:read')] }, async (request) => {
    const alunoId = alunoDoToken(requireScope(request));

    return inTenant(request, async (client) => {
      const { rows } = await client.query<{
        id: string;
        dia: string;
        quando: string;
        esforco: number | null;
        notas: string | null;
        hoje: boolean;
      }>(
        `SELECT w.id, w.day_label AS dia, w.done_on::text AS quando,
                w.effort AS esforco, w.notes AS notas,
                (w.done_on = (now() AT TIME ZONE t.timezone)::date) AS hoje
           FROM workout_logs w
           JOIN tenants t ON t.id = w.tenant_id
          WHERE w.student_id = $1
            AND w.done_on > (now() AT TIME ZONE t.timezone)::date - 90
          ORDER BY w.done_on DESC, w.created_at DESC`,
        [alunoId],
      );

      /* A SEQUÊNCIA DE SEMANAS é o número que faz alguém voltar amanhã.
         Contada em semanas e não em dias porque ninguém treina sete dias
         por semana — uma sequência de dias corridos quebraria todo
         domingo e não significaria nada. */
      const semanas = new Set(rows.map((r) => semanaDe(r.quando)));
      const { rows: contagem } = await client.query<{ total: string; no_mes: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (
                  WHERE w.done_on >= date_trunc('month', (now() AT TIME ZONE t.timezone)::date)
                )::text AS no_mes
           FROM workout_logs w
           JOIN tenants t ON t.id = w.tenant_id
          WHERE w.student_id = $1`,
        [alunoId],
      );

      return {
        data: {
          registros: rows.map((r) => ({
            id: r.id,
            dia: r.dia,
            quando: r.quando,
            esforco: r.esforco,
            notas: r.notas,
            hoje: r.hoje,
          })),
          feitosHoje: rows.filter((r) => r.hoje).map((r) => r.dia),
          total: Number(contagem[0]?.total ?? 0),
          noMes: Number(contagem[0]?.no_mes ?? 0),
          sequenciaDeSemanas: sequencia([...semanas].sort().reverse()),
        },
      };
    });
  });
}

/** "2026-08-19" → "2026-33" (ano e semana ISO), para agrupar. */
function semanaDe(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-').map(Number);
  const data = new Date(Date.UTC(a!, m! - 1, d!));
  /* Quinta-feira da mesma semana define o ano ISO — é o que evita que a
     semana virada do ano caia em dois anos diferentes e quebre a
     contagem em janeiro. */
  data.setUTCDate(data.getUTCDate() + 4 - (data.getUTCDay() || 7));
  const inicioDoAno = new Date(Date.UTC(data.getUTCFullYear(), 0, 1));
  const n = Math.ceil(((data.getTime() - inicioDoAno.getTime()) / 86_400_000 + 1) / 7);
  return `${data.getUTCFullYear()}-${String(n).padStart(2, '0')}`;
}

/**
 * Quantas semanas seguidas, a partir da mais recente.
 *
 * A SEMANA ATUAL AINDA NÃO CONTA COMO QUEBRA. Quem treinou na semana
 * passada e ainda não treinou nesta não perdeu a sequência — perde na
 * segunda-feira seguinte, se não aparecer. Zerar antes disso é punir
 * alguém por ser terça-feira.
 */
function sequencia(semanasOrdenadas: string[]): number {
  if (semanasOrdenadas.length === 0) return 0;
  let total = 1;
  for (let i = 1; i < semanasOrdenadas.length; i += 1) {
    if (ehAnterior(semanasOrdenadas[i]!, semanasOrdenadas[i - 1]!)) total += 1;
    else break;
  }
  return total;
}

/** `a` é exatamente a semana anterior a `b`? */
function ehAnterior(a: string, b: string): boolean {
  const [anoA, semA] = a.split('-').map(Number);
  const [anoB, semB] = b.split('-').map(Number);
  if (anoA === anoB) return semB! - semA! === 1;
  /* Virada de ano: a semana 1 de 2027 vem depois da 52 ou 53 de 2026, e
     qual das duas depende do calendário daquele ano. Aceitar as duas é
     mais simples do que calcular, e não há como confundir com outra
     coisa. */
  return anoB! - anoA! === 1 && semB === 1 && (semA === 52 || semA === 53);
}
