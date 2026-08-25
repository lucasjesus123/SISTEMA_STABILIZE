import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant } from '../../http/plugins/authenticate.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import { writeAudit } from '../../audit/audit.js';

/**
 * CRM — quem ainda não é aluno.
 *
 * O SISTEMA COMEÇAVA NO ALUNO MATRICULADO. Quem ligou perguntando preço,
 * quem veio conhecer e disse "depois eu te falo", quem fez experimental
 * e sumiu — nada disso existia. Ficava no caderno da recepção ou não
 * ficava, e é o pedaço mais caro de perder: achar um interessado novo
 * custa muito mais que voltar em quem já demonstrou interesse.
 *
 * A ROTA QUE IMPORTA É `/fila`, e não a lista. Uma lista de interessados
 * é um arquivo morto; a fila é "com quem eu falo hoje", ordenada pelo
 * que está mais atrasado. É a diferença entre um CRM usado e um CRM
 * preenchido uma vez.
 *
 * PERMISSÃO: `student:write`. Quem cadastra aluno cuida de interessado —
 * é a mesma pessoa no balcão, na mesma conversa. Criar uma permissão
 * nova daria a chance de a recepção ficar de fora do módulo que existe
 * principalmente para ela.
 */

const ORIGENS = [
  'INDICACAO',
  'INSTAGRAM',
  'GOOGLE',
  'FACHADA',
  'WHATSAPP',
  'EVENTO',
  'OUTRO',
] as const;
const STATUS = ['NOVO', 'CONTATADO', 'VISITOU', 'MATRICULOU', 'PERDIDO'] as const;

/* MATRICULOU não entra aqui: virar aluno é a rota `/converter`, que faz
   as duas coisas numa transação. Deixar o status ser escrito à mão
   permitiria marcar "matriculou" sem aluno nenhum do outro lado — o
   banco recusaria, mas com um erro que não explica nada. */
const STATUS_EDITAVEIS = ['NOVO', 'CONTATADO', 'VISITOU', 'PERDIDO'] as const;

const idParam = z.object({ id: z.string().uuid() });

const leadSchema = z.object({
  nome: z.string().trim().min(2, 'O nome é obrigatório').max(120),
  whatsapp: z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{7,14}$/, 'WhatsApp em formato internacional, com o +')
    .nullable()
    .optional(),
  email: z.string().trim().email('E-mail inválido').nullable().optional(),
  origem: z.enum(ORIGENS).optional(),
  status: z.enum(STATUS_EDITAVEIS).optional(),
  interesse: z.string().trim().max(300).nullable().optional(),
  observacoes: z.string().trim().max(2000).nullable().optional(),
  responsavelId: z.string().uuid().nullable().optional(),
  proximoContato: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD')
    .nullable()
    .optional(),
  perdidoMotivo: z.string().trim().max(300).nullable().optional(),
});

interface LinhaDoLead {
  id: string;
  nome: string;
  whatsapp: string | null;
  email: string | null;
  origem: string;
  status: string;
  interesse: string | null;
  observacoes: string | null;
  responsavel_id: string | null;
  responsavel: string | null;
  proximo_contato: string | null;
  virou_aluno_id: string | null;
  convertido_em: Date | null;
  perdido_motivo: string | null;
  created_at: Date;
  contatos: string;
  atraso: string | null;
}

const paraFora = (l: LinhaDoLead) => ({
  id: l.id,
  nome: l.nome,
  whatsapp: l.whatsapp,
  email: l.email,
  origem: l.origem,
  status: l.status,
  interesse: l.interesse,
  observacoes: l.observacoes,
  responsavelId: l.responsavel_id,
  responsavel: l.responsavel,
  proximoContato: l.proximo_contato,
  virouAlunoId: l.virou_aluno_id,
  convertidoEm: l.convertido_em?.toISOString() ?? null,
  perdidoMotivo: l.perdido_motivo,
  criadoEm: l.created_at.toISOString(),
  contatos: Number(l.contatos),
  /* Dias de atraso do próximo contato. Negativo = ainda vai vencer.
     Vem do banco e não do navegador: a data de "hoje" do celular de
     quem abriu a tela pode estar errada, e uma fila que muda de ordem
     conforme o relógio do usuário é pior que fila nenhuma. */
  atrasoDias: l.atraso === null ? null : Number(l.atraso),
});

const SELECT_LEAD = `
  SELECT l.id, l.nome, l.whatsapp, l.email, l.origem::text, l.status::text,
         l.interesse, l.observacoes, l.responsavel_id,
         u.full_name AS responsavel,
         l.proximo_contato::text, l.virou_aluno_id, l.convertido_em,
         l.perdido_motivo, l.created_at,
         (SELECT count(*) FROM lead_contatos c WHERE c.lead_id = l.id)::text AS contatos,
         (CURRENT_DATE - l.proximo_contato)::text AS atraso
    FROM leads l
    LEFT JOIN users u ON u.id = l.responsavel_id`;

export async function crmRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/crm/fila — com quem falar hoje
   *
   * A rota mais usada do módulo. Ordena pelo próximo contato mais
   * atrasado, e coloca quem não tem data marcada no fim: sem data, não
   * há atraso, mas também não há compromisso — e um interessado sem
   * data é justamente o que se perde.
   * ---------------------------------------------------------------- */
  app.get('/fila', { preHandler: [app.authorize('crm:write')] }, async (request) => {
    const { responsavelId } = z
      .object({ responsavelId: z.string().uuid().optional() })
      .parse(request.query);

    return inTenant(request, async (client) => {
      const { rows } = await client.query<LinhaDoLead>(
        `${SELECT_LEAD}
          WHERE l.status NOT IN ('MATRICULOU', 'PERDIDO')
            AND ($1::uuid IS NULL OR l.responsavel_id = $1)
          ORDER BY l.proximo_contato ASC NULLS LAST, l.created_at ASC
          LIMIT 200`,
        [responsavelId ?? null],
      );
      return { data: rows.map(paraFora) };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/crm — a lista completa, com filtro por status
   * ---------------------------------------------------------------- */
  app.get('/', { preHandler: [app.authorize('crm:write')] }, async (request) => {
    const { status, busca } = z
      .object({
        status: z.enum(STATUS).optional(),
        busca: z.string().trim().max(80).optional(),
      })
      .parse(request.query);

    return inTenant(request, async (client) => {
      const { rows } = await client.query<LinhaDoLead>(
        `${SELECT_LEAD}
          WHERE ($1::text IS NULL OR l.status::text = $1)
            AND ($2::text IS NULL OR lower(unaccent_simples(l.nome)) LIKE '%' || lower(unaccent_simples($2)) || '%')
          ORDER BY l.created_at DESC
          LIMIT 300`,
        [status ?? null, busca === undefined || busca === '' ? null : busca],
      );
      return { data: rows.map(paraFora) };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/crm/funil — quantos em cada etapa, e a taxa de conversão
   * ---------------------------------------------------------------- */
  app.get('/funil', { preHandler: [app.authorize('crm:write')] }, async (request) => {
    const { dias } = z
      .object({ dias: z.coerce.number().int().min(1).max(730).optional() })
      .parse(request.query);

    return inTenant(request, async (client) => {
      const { rows } = await client.query<{ status: string; quantos: string }>(
        `SELECT status::text, count(*)::text AS quantos
           FROM leads
          WHERE created_at >= now() - ($1 || ' days')::interval
          GROUP BY status`,
        [String(dias ?? 90)],
      );

      const por = new Map(rows.map((r) => [r.status, Number(r.quantos)]));
      const total = [...por.values()].reduce((a, b) => a + b, 0);
      const matriculou = por.get('MATRICULOU') ?? 0;
      /* A conversão é sobre os DECIDIDOS — matriculou mais perdido —, e
         não sobre o total. Quem ainda está em conversa não decidiu
         nada, e contá-lo como não-convertido faria a taxa piorar
         sozinha só porque entraram interessados novos. */
      const decididos = matriculou + (por.get('PERDIDO') ?? 0);

      return {
        data: {
          dias: dias ?? 90,
          total,
          etapas: STATUS.map((s) => ({ status: s, quantos: por.get(s) ?? 0 })),
          decididos,
          conversao: decididos === 0 ? null : Math.round((matriculou / decididos) * 100),
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * GET /api/crm/:id — com o histórico da conversa
   * ---------------------------------------------------------------- */
  app.get('/:id', { preHandler: [app.authorize('crm:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);

    return inTenant(request, async (client) => {
      const { rows } = await client.query<LinhaDoLead>(`${SELECT_LEAD} WHERE l.id = $1`, [id]);
      const lead = rows[0];
      if (lead === undefined) throw notFound('Interessado');

      const historico = await client.query<{
        id: string;
        texto: string;
        autor: string | null;
        created_at: Date;
      }>(
        `SELECT c.id, c.texto, u.full_name AS autor, c.created_at
           FROM lead_contatos c
           LEFT JOIN users u ON u.id = c.autor_id
          WHERE c.lead_id = $1
          ORDER BY c.created_at DESC`,
        [id],
      );

      return {
        data: {
          ...paraFora(lead),
          historico: historico.rows.map((h) => ({
            id: h.id,
            texto: h.texto,
            autor: h.autor,
            em: h.created_at.toISOString(),
          })),
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/crm
   * ---------------------------------------------------------------- */
  app.post('/', { preHandler: [app.authorize('crm:write')] }, async (request, reply) => {
    const corpo = leadSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO leads
           (tenant_id, nome, whatsapp, email, origem, status, interesse,
            observacoes, responsavel_id, proximo_contato, criado_por)
         VALUES ($1,$2,$3,$4,
                 coalesce($5,'OUTRO')::lead_origem,
                 coalesce($6,'NOVO')::lead_status,
                 $7,$8,$9,$10,$11)
         RETURNING id`,
        [
          principal.tenantId,
          corpo.nome,
          corpo.whatsapp ?? null,
          corpo.email ?? null,
          corpo.origem ?? null,
          corpo.status ?? null,
          corpo.interesse ?? null,
          corpo.observacoes ?? null,
          corpo.responsavelId ?? null,
          corpo.proximoContato ?? null,
          principal.userId,
        ],
      );
      const id = rows[0]!.id;

      await writeAudit(client, principal.tenantId, {
        action: 'student.create',
        resourceType: 'lead',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { origem: corpo.origem ?? 'OUTRO' },
      });

      void reply.status(201);
      return { data: { id } };
    });
  });

  /* ------------------------------------------------------------------
   * PUT /api/crm/:id
   * ---------------------------------------------------------------- */
  app.put('/:id', { preHandler: [app.authorize('crm:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const corpo = leadSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      const r = await client.query(
        `UPDATE leads
            SET nome = $2, whatsapp = $3, email = $4,
                origem = coalesce($5,'OUTRO')::lead_origem,
                status = coalesce($6::lead_status, status),
                interesse = $7, observacoes = $8,
                responsavel_id = $9, proximo_contato = $10,
                perdido_motivo = $11
          WHERE id = $1
            AND status <> 'MATRICULOU'`,
        [
          id,
          corpo.nome,
          corpo.whatsapp ?? null,
          corpo.email ?? null,
          corpo.origem ?? null,
          corpo.status ?? null,
          corpo.interesse ?? null,
          corpo.observacoes ?? null,
          corpo.responsavelId ?? null,
          corpo.proximoContato ?? null,
          corpo.perdidoMotivo ?? null,
        ],
      );

      /* Zero linhas é "não existe" OU "já matriculou". Os dois casos
         param aqui: um lead convertido é história, e reescrever a
         história de uma conversão apagaria o registro de como aquele
         aluno chegou. */
      if (r.rowCount === 0) {
        const existe = await client.query('SELECT 1 FROM leads WHERE id = $1', [id]);
        if (existe.rowCount === 0) throw notFound('Interessado');
        throw conflict('Este interessado já virou aluno. O cadastro dele agora é o do aluno.');
      }

      await writeAudit(client, principal.tenantId, {
        action: 'student.update',
        resourceType: 'lead',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { status: corpo.status ?? 'inalterado' },
      });

      return { data: { ok: true } };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/crm/:id/contato — registra uma conversa
   * ---------------------------------------------------------------- */
  app.post('/:id/contato', { preHandler: [app.authorize('crm:write')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const corpo = z
      .object({
        texto: z.string().trim().min(1, 'Escreva o que foi conversado').max(2000),
        /* Registrar o contato e marcar o próximo na MESMA ação. Separar
           em dois passos é como o CRM para de ser atualizado: a pessoa
           anota a conversa, fecha a tela, e o próximo contato nunca é
           marcado. */
        proximoContato: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        status: z.enum(STATUS_EDITAVEIS).optional(),
      })
      .parse(request.body);

    return inTenant(request, async (client, principal) => {
      const lead = await client.query<{ status: string }>(
        'SELECT status::text FROM leads WHERE id = $1',
        [id],
      );
      if (lead.rowCount === 0) throw notFound('Interessado');
      if (lead.rows[0]!.status === 'MATRICULOU') {
        throw conflict('Este interessado já virou aluno. Registre o atendimento na ficha dele.');
      }

      await client.query(
        `INSERT INTO lead_contatos (tenant_id, lead_id, texto, autor_id)
         VALUES ($1,$2,$3,$4)`,
        [principal.tenantId, id, corpo.texto, principal.userId],
      );

      /* O `coalesce` no status mantém o atual quando não vem nada; o
         `proximo_contato` é escrito SEMPRE que a chave veio no corpo,
         inclusive com null — que é como se diz "não tem próximo". */
      if (corpo.proximoContato !== undefined || corpo.status !== undefined) {
        await client.query(
          `UPDATE leads
              SET proximo_contato = CASE WHEN $2 THEN $3::date ELSE proximo_contato END,
                  status = coalesce($4::lead_status, status)
            WHERE id = $1`,
          [
            id,
            corpo.proximoContato !== undefined,
            corpo.proximoContato ?? null,
            corpo.status ?? null,
          ],
        );
      }

      void reply.status(201);
      return { data: { ok: true } };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/crm/:id/converter — vira aluno
   *
   * O MOMENTO QUE O MÓDULO EXISTE PARA MEDIR. Cria o aluno e fecha o
   * lead na MESMA transação: se o aluno fosse criado e a marcação
   * falhasse, o interessado continuaria na fila para sempre, sendo
   * cobrado por telefone por alguém que já é cliente.
   * ---------------------------------------------------------------- */
  app.post(
    '/:id/converter',
    { preHandler: [app.authorize('crm:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const corpo = z
        .object({
          cpf: z
            .string()
            .trim()
            .regex(/^\d{11}$/, 'CPF com 11 dígitos, só números')
            .optional(),
        })
        .parse(request.body ?? {});

      return inTenant(request, async (client, principal) => {
        const lead = await client.query<{
          nome: string;
          whatsapp: string | null;
          email: string | null;
          status: string;
          virou_aluno_id: string | null;
        }>(
          'SELECT nome, whatsapp, email, status::text, virou_aluno_id FROM leads WHERE id = $1',
          [id],
        );
        if (lead.rowCount === 0) throw notFound('Interessado');
        const l = lead.rows[0]!;

        if (l.status === 'MATRICULOU') {
          throw conflict('Este interessado já foi convertido em aluno.');
        }
        if (l.status === 'PERDIDO') {
          /* Não é bloqueio moral: é que converter um perdido sem
             reabri-lo esconderia que ele voltou, e "voltou depois de
             perdido" é a informação mais útil do funil. */
          throw badRequest(
            'Este interessado está marcado como perdido. Reabra-o antes de converter.',
          );
        }

        const aluno = await client.query<{ id: string }>(
          /* A coluna do CPF em `students` chama `document`, e nao `cpf`.
             O nome generico e proposital no schema — outros documentos
             cabem ali —, mas o CRM so conhece CPF. */
          `INSERT INTO students (tenant_id, full_name, whatsapp, email, document)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id`,
          [principal.tenantId, l.nome, l.whatsapp, l.email, corpo.cpf ?? null],
        );
        const alunoId = aluno.rows[0]!.id;

        await client.query(
          `UPDATE leads
              SET status = 'MATRICULOU', virou_aluno_id = $2, convertido_em = now(),
                  proximo_contato = NULL
            WHERE id = $1`,
          [id, alunoId],
        );

        await writeAudit(client, principal.tenantId, {
          action: 'student.create',
          resourceType: 'student',
          resourceId: alunoId,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { deLead: id },
        });

        void reply.status(201);
        return { data: { alunoId } };
      });
    },
  );
}
