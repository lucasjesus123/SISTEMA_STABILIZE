import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatCents } from '@stabilize/shared';
import { inTenant } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { conflict, notFound, unprocessable } from '../../http/errors.js';

/**
 * Check-in na recepção.
 *
 * É A OPERAÇÃO MAIS FREQUENTE DE UMA ACADEMIA e não existia. O que havia
 * era presença em agendamento — o professor marca que o aluno veio à
 * sessão marcada. Serve para personal e pilates; não serve para
 * musculação, que é a maior parte de qualquer academia: o aluno aparece,
 * passa na recepção e treina, sem nada agendado.
 *
 * A CONSULTA E O REGISTRO SÃO DUAS ROTAS. Buscar não pode registrar
 * entrada: a recepcionista digita, erra o nome, digita de novo — e cada
 * tentativa teria virado um check-in. A busca responde "quem é e como
 * está"; o registro acontece quando alguém confirma.
 *
 * A SITUAÇÃO É CONGELADA NO REGISTRO. Guardar só o id do aluno faria a
 * conferência de amanhã mostrar a situação de amanhã — quem estava
 * devendo em março e pagou em abril apareceria como "em dia" no
 * relatório de março. O que se registra é o que a recepção viu na tela.
 */

const idSchema = z.string().uuid('Identificador inválido');

type Situacao = 'EM_DIA' | 'DEVENDO' | 'SEM_CONTRATO' | 'INATIVO';

interface LinhaDaBusca {
  id: string;
  nome: string;
  codigo: string | null;
  status: string;
  tem_foto: boolean;
  devendo: string;
  cobrancas: number;
  dias_de_atraso: number | null;
  tem_contrato: boolean;
  dentro: boolean;
  ultima_entrada: Date | null;
  triagem: SituacaoDaTriagem;
}

type SituacaoDaTriagem = 'NUNCA_ASSINOU' | 'VALIDA' | 'VENCIDA' | 'AGUARDANDO_ATESTADO';

function situacaoDe(l: LinhaDaBusca): Situacao {
  if (l.status !== 'ACTIVE') return 'INATIVO';
  if (Number(l.devendo) > 0) return 'DEVENDO';
  if (!l.tem_contrato) return 'SEM_CONTRATO';
  return 'EM_DIA';
}

export async function checkinRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/checkin/buscar?termo=
   *
   * Aceita CÓDIGO, CPF ou parte do nome — porque é assim que a pessoa
   * se identifica no balcão. Quem tem a carteirinha diz o número; quem
   * esqueceu diz o nome; quem não sabe nenhum dos dois dá o CPF.
   * ---------------------------------------------------------------- */
  app.get('/buscar', { preHandler: [app.authorize('attendance:write')] }, async (request) => {
    const { termo } = z
      .object({ termo: z.string().trim().min(1, 'Digite algo para buscar.').max(80) })
      .parse(request.query);

    return inTenant(request, async (client) => {
      const digitos = termo.replace(/\D/g, '');

      const { rows } = await client.query<LinhaDaBusca>(
        `WITH hoje AS (
           SELECT (now() AT TIME ZONE t.timezone)::date AS d
             FROM tenants t WHERE t.id = current_tenant_id()
         )
         SELECT s.id, s.full_name AS nome, s.codigo::text AS codigo, s.status::text AS status,
                (s.photo_path IS NOT NULL) AS tem_foto,
                COALESCE((SELECT SUM(e.amount_cents - e.paid_cents)
                            FROM finance_entries e
                           WHERE e.student_id = s.id AND e.direction = 'RECEIVABLE'
                             AND e.cancelled_at IS NULL AND e.status <> 'PAID'
                             AND e.due_date < (SELECT d FROM hoje)), 0)::text AS devendo,
                (SELECT count(*) FROM finance_entries e
                  WHERE e.student_id = s.id AND e.direction = 'RECEIVABLE'
                    AND e.cancelled_at IS NULL AND e.status <> 'PAID'
                    AND e.due_date < (SELECT d FROM hoje))::int AS cobrancas,
                (SELECT ((SELECT d FROM hoje) - MIN(e.due_date))::int
                   FROM finance_entries e
                  WHERE e.student_id = s.id AND e.direction = 'RECEIVABLE'
                    AND e.cancelled_at IS NULL AND e.status <> 'PAID'
                    AND e.due_date < (SELECT d FROM hoje)) AS dias_de_atraso,
                EXISTS (SELECT 1 FROM student_contracts c
                         WHERE c.student_id = s.id AND c.is_active) AS tem_contrato,
                EXISTS (SELECT 1 FROM checkins k
                         WHERE k.student_id = s.id AND k.saiu_em IS NULL) AS dentro,
                (SELECT MAX(k.entrou_em) FROM checkins k WHERE k.student_id = s.id) AS ultima_entrada,
                /* A TRIAGEM DE SAÚDE, resumida a uma palavra.
                   A recepção precisa saber que falta; NÃO precisa — e
                   não pode — ver as respostas do PAR-Q, que são dado de
                   saúde. Por isso aqui sai só a situação. */
                (SELECT CASE
                          WHEN h.student_id IS NULL THEN 'NUNCA_ASSINOU'
                          WHEN h.valido_ate < (SELECT d FROM hoje) THEN 'VENCIDA'
                          WHEN h.precisa_liberacao_medica AND h.liberado_em IS NULL
                            THEN 'AGUARDANDO_ATESTADO'
                          ELSE 'VALIDA'
                        END
                   FROM (SELECT 1) AS _
                   LEFT JOIN LATERAL (
                     SELECT student_id, valido_ate, precisa_liberacao_medica, liberado_em
                       FROM health_screenings
                      WHERE student_id = s.id
                      ORDER BY assinado_em DESC LIMIT 1) h ON true) AS triagem
           FROM students s
          WHERE
            /* CÓDIGO EXATO PRIMEIRO. Quem digita "42" quer o aluno 42, e
               não os dezessete cujo telefone contém 42.

               A COMPARAÇÃO É EM TEXTO porque a coluna é integer no banco
               e o parâmetro chega do campo de busca. Comparar direto
               fazia o Postgres tentar converter o parâmetro vazio para
               inteiro e derrubar a busca inteira com "invalid input
               syntax for type integer" — inclusive quando ninguém
               digitou número nenhum. */
            ($1 <> '' AND s.codigo::text = $1)
            OR ($2 <> '' AND regexp_replace(COALESCE(s.document, ''), '\\D', '', 'g') = $2)
            /* ESCAPE explícito porque o % e o _ que a recepção
               digitar precisam valer como caractere, e não como
               curinga. Sem isto, buscar "%" devolvia a base inteira — o
               que numa lista de duzentos alunos não parece um bug,
               parece que a busca não funciona. O termo já chega
               escapado do lado do Node. */
            OR translate(lower(s.full_name), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')
               LIKE '%' || translate(lower($3), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn') || '%'
               ESCAPE '\\'
          ORDER BY
            ($1 <> '' AND s.codigo::text = $1) DESC,
            (s.status = 'ACTIVE') DESC,
            s.full_name
          LIMIT 12`,
        [
          digitos.length > 0 && digitos.length < 11 ? digitos : '',
          digitos.length === 11 ? digitos : '',
          /* A barra sai primeiro: escapá-la depois faria ela escapar o
             caractere seguinte. */
          termo.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => `\\${c}`),
        ],
      );

      const { rows: config } = await client.query<{ bloquear: number; exigir_triagem: boolean }>(
        `SELECT bloquear_entrada_apos_dias AS bloquear, exigir_triagem_na_porta AS exigir_triagem
           FROM tenants WHERE id = current_tenant_id()`,
      );
      const bloquearApos = config[0]?.bloquear ?? 0;
      const exigirTriagem = config[0]?.exigir_triagem ?? false;

      return {
        data: rows.map((l) => {
          const situacao = situacaoDe(l);
          const devendo = Number(l.devendo);
          const atraso = l.dias_de_atraso ?? 0;
          return {
            id: l.id,
            nome: l.nome,
            codigo: l.codigo,
            temFoto: l.tem_foto,
            situacao,
            devendoCentavos: devendo,
            devendoFormatado: formatCents(devendo),
            cobrancasVencidas: l.cobrancas,
            diasDeAtraso: atraso,
            dentro: l.dentro,
            ultimaEntrada: l.ultima_entrada?.toISOString() ?? null,
            triagem: l.triagem,
            /* PRECISA DE LIBERAÇÃO, e não "está bloqueado": barrar aluno
               na porta é decisão de negócio. O sistema avisa e pede uma
               confirmação consciente; quem decide é quem está no balcão
               olhando na cara da pessoa. */
            precisaLiberar:
              situacao === 'INATIVO' ||
              (bloquearApos > 0 && situacao === 'DEVENDO' && atraso >= bloquearApos) ||
              /* A PENDÊNCIA DE TRIAGEM PESA DIFERENTE DA FINANCEIRA. A
                 dívida é problema de caixa; treinar sem ter declarado a
                 saúde é problema de corpo, e é a academia que responde.
                 Ainda assim a decisão continua sendo da empresa — o
                 padrão de `exigir_triagem_na_porta` é false, e quem
                 liga assume o atrito no balcão. */
              (exigirTriagem && l.triagem !== 'VALIDA'),
          };
        }),
      };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/checkin — registra a entrada
   * ---------------------------------------------------------------- */
  app.post('/', { preHandler: [app.authorize('attendance:write')] }, async (request, reply) => {
    const body = z
      .object({
        studentId: idSchema,
        /* Marcado pela recepção quando o aviso aparece e ela decide
           deixar entrar mesmo assim. Fica no registro. */
        liberadoComAviso: z.boolean().default(false),
        observacao: z.string().trim().max(300).nullish().transform((v) => v || null),
      })
      .parse(request.body);

    return inTenant(request, async (client, principal) => {
      const { rows } = await client.query<LinhaDaBusca>(
        `WITH hoje AS (
           SELECT (now() AT TIME ZONE t.timezone)::date AS d
             FROM tenants t WHERE t.id = current_tenant_id()
         )
         SELECT s.id, s.full_name AS nome, s.codigo::text AS codigo, s.status::text AS status,
                false AS tem_foto,
                COALESCE((SELECT SUM(e.amount_cents - e.paid_cents)
                            FROM finance_entries e
                           WHERE e.student_id = s.id AND e.direction = 'RECEIVABLE'
                             AND e.cancelled_at IS NULL AND e.status <> 'PAID'
                             AND e.due_date < (SELECT d FROM hoje)), 0)::text AS devendo,
                0 AS cobrancas, NULL::int AS dias_de_atraso,
                EXISTS (SELECT 1 FROM student_contracts c
                         WHERE c.student_id = s.id AND c.is_active) AS tem_contrato,
                false AS dentro, NULL::timestamptz AS ultima_entrada
           FROM students s WHERE s.id = $1`,
        [body.studentId],
      );
      const aluno = rows[0];
      if (aluno === undefined) throw notFound('Aluno');

      const situacao = situacaoDe(aluno);
      const devendo = Number(aluno.devendo);

      const criado = await client
        .query<{ id: string }>(
          `INSERT INTO checkins
             (tenant_id, student_id, situacao, devendo_centavos, liberado_por,
              observacao, registrado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id`,
          [
            principal.tenantId,
            body.studentId,
            situacao,
            devendo,
            body.liberadoComAviso ? principal.userId : null,
            body.observacao,
            principal.userId,
          ],
        )
        .catch((e: unknown) => {
          /* 23505 é o índice parcial que impede duas entradas abertas.
             Um duplo toque no botão criaria duas, e a contagem de quem
             está na academia agora ficaria errada para sempre. */
          if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
            throw conflict(`${aluno.nome} já está na academia. Registre a saída antes.`);
          }
          throw e;
        });

      await writeAudit(client, principal.tenantId, {
        action: 'attendance.mark',
        resourceType: 'student',
        resourceId: body.studentId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { checkin: true, situacao, liberadoComAviso: body.liberadoComAviso },
      });

      void reply.status(201);
      return { data: { id: criado.rows[0]!.id, situacao, nome: aluno.nome } };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/checkin/:id/saida
   * ---------------------------------------------------------------- */
  app.post('/:id/saida', { preHandler: [app.authorize('attendance:write')] }, async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);

    return inTenant(request, async (client) => {
      const { rowCount } = await client.query(
        'UPDATE checkins SET saiu_em = now() WHERE id = $1 AND saiu_em IS NULL',
        [id],
      );
      if ((rowCount ?? 0) === 0) throw notFound('Entrada em aberto');
      return { ok: true };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/checkin/agora — quem está na academia
   *
   * É o número que o dono olha quando quer saber se a academia está
   * cheia, e o que a recepção usa para fechar as entradas esquecidas no
   * fim do dia.
   * ---------------------------------------------------------------- */
  app.get('/agora', { preHandler: [app.authorize('attendance:read')] }, async (request) =>
    inTenant(request, async (client) => {
      const { rows } = await client.query<{
        id: string;
        nome: string;
        codigo: string | null;
        entrou_em: Date;
        situacao: string;
      }>(
        `SELECT k.id, s.full_name AS nome, s.codigo::text AS codigo, k.entrou_em, k.situacao
           FROM checkins k JOIN students s ON s.id = k.student_id
          WHERE k.saiu_em IS NULL
          ORDER BY k.entrou_em`,
      );

      return {
        data: rows.map((r) => ({
          id: r.id,
          nome: r.nome,
          codigo: r.codigo,
          entrouEm: r.entrou_em.toISOString(),
          situacao: r.situacao,
        })),
      };
    }),
  );

  /* ------------------------------------------------------------------
   * GET /api/checkin/hoje — o movimento do dia
   * ---------------------------------------------------------------- */
  app.get('/hoje', { preHandler: [app.authorize('attendance:read')] }, async (request) => {
    const { de } = z
      .object({ de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(request.query);

    return inTenant(request, async (client) => {
      const { rows } = await client.query<{
        total: string;
        dentro: string;
        devendo: string;
        por_hora: { hora: number; n: number }[] | null;
      }>(
        `WITH dia AS (
           SELECT COALESCE($1::date, (now() AT TIME ZONE t.timezone)::date) AS d, t.timezone AS tz
             FROM tenants t WHERE t.id = current_tenant_id()
         ),
         doDia AS (
           SELECT k.*, (k.entrou_em AT TIME ZONE (SELECT tz FROM dia)) AS local
             FROM checkins k
            WHERE (k.entrou_em AT TIME ZONE (SELECT tz FROM dia))::date = (SELECT d FROM dia)
         )
         SELECT count(*)::text AS total,
                count(*) FILTER (WHERE saiu_em IS NULL)::text AS dentro,
                count(*) FILTER (WHERE situacao = 'DEVENDO')::text AS devendo,
                (SELECT json_agg(json_build_object('hora', h, 'n', n) ORDER BY h)
                   FROM (SELECT extract(hour FROM local)::int AS h, count(*)::int AS n
                           FROM doDia GROUP BY 1) AS x) AS por_hora
           FROM doDia`,
        [de ?? null],
      );
      const l = rows[0];

      return {
        data: {
          total: Number(l?.total ?? 0),
          dentro: Number(l?.dentro ?? 0),
          devendo: Number(l?.devendo ?? 0),
          porHora: l?.por_hora ?? [],
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * PUT /api/checkin/config — quantos dias de atraso pedem liberação
   * ---------------------------------------------------------------- */
  app.put('/config', { preHandler: [app.authorize('tenant:settings')] }, async (request) => {
    const { bloquearApos } = z
      .object({ bloquearApos: z.coerce.number().int().min(0).max(365) })
      .parse(request.body);

    return inTenant(request, async (client, principal) => {
      const { rowCount } = await client.query(
        'UPDATE tenants SET bloquear_entrada_apos_dias = $1 WHERE id = current_tenant_id()',
        [bloquearApos],
      );
      if ((rowCount ?? 0) === 0) throw unprocessable('Não foi possível salvar.');

      await writeAudit(client, principal.tenantId, {
        action: 'tenant.settings',
        resourceType: 'tenant',
        resourceId: principal.tenantId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { bloquearEntradaAposDias: bloquearApos },
      });
      return { ok: true };
    });
  });
}
