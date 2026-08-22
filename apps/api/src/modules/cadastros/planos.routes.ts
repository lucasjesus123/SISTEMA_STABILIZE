import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant } from '../../http/plugins/authenticate.js';
import { conflict, notFound } from '../../http/errors.js';
import { writeAudit } from '../../audit/audit.js';

/**
 * A tabela de valores da academia.
 *
 * A TABELA `price_plans` JÁ EXISTIA no schema desde o primeiro dia, com
 * RLS, restrição de nome único por empresa e a coluna que o contrato do
 * aluno referencia (`student_contracts.price_plan_id`). O que não
 * existia era qualquer código que a lesse ou escrevesse: backend
 * pronto, nunca ligado. Toda mensalidade era digitada aluno a aluno.
 *
 * POR QUE O CONTRATO CONTINUA GUARDANDO O VALOR, e não só o id do
 * plano. O comentário original do schema já dizia, e vale repetir: o
 * valor no contrato é o NEGOCIADO, e pode divergir da tabela. Guardar
 * só a referência faria um reajuste na tabela reescrever
 * retroativamente o que já foi cobrado de quem fechou por outro preço.
 * O plano é a SUGESTÃO — preenche o formulário e some do caminho.
 *
 * PLANO NÃO SE APAGA, SE DESATIVA. Um plano apagado deixaria contratos
 * apontando para o nada (`ON DELETE SET NULL`) e a academia perderia a
 * resposta para "de qual tabela veio este valor?". Desativar tira da
 * lista de escolha e preserva a história.
 */

const CICLOS = [
  'SESSION',
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'ANNUAL',
] as const;

const planoSchema = z.object({
  nome: z.string().trim().min(1, 'O plano precisa de um nome').max(120),
  ciclo: z.enum(CICLOS),
  valorCentavos: z.number().int().min(0, 'O valor não pode ser negativo'),
  sessoesIncluidas: z.number().int().min(0).nullable().optional(),
  comissaoBp: z.number().int().min(0).max(10_000).optional(),
  ativo: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().uuid() });

interface LinhaDoPlano {
  id: string;
  name: string;
  cycle: string;
  amount_cents: string;
  sessions_included: number | null;
  commission_bp: number;
  is_active: boolean;
  em_uso: string;
}

const paraFora = (l: LinhaDoPlano) => ({
  id: l.id,
  nome: l.name,
  ciclo: l.cycle,
  valorCentavos: Number(l.amount_cents),
  sessoesIncluidas: l.sessions_included,
  comissaoBp: l.commission_bp,
  ativo: l.is_active,
  /* Quantos contratos ATIVOS usam este plano. É o que transforma
     "desativar" numa decisão informada em vez de um clique às cegas. */
  emUso: Number(l.em_uso),
});

export async function planosRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/planos
   *
   * `pricing:read` — o mesmo do contrato do aluno. Quem pode ver quanto
   * um aluno paga pode ver a tabela de onde o valor saiu.
   * ---------------------------------------------------------------- */
  app.get('/', { preHandler: [app.authorize('pricing:read')] }, async (request) => {
    const { incluirInativos } = z
      .object({ incluirInativos: z.enum(['true', 'false']).optional() })
      .parse(request.query);

    return inTenant(request, async (client) => {
      const { rows } = await client.query<LinhaDoPlano>(
        `SELECT p.id, p.name, p.cycle::text, p.amount_cents::text,
                p.sessions_included, p.commission_bp, p.is_active,
                (SELECT count(*) FROM student_contracts c
                  WHERE c.price_plan_id = p.id AND c.is_active)::text AS em_uso
           FROM price_plans p
          WHERE ($1 = 'true' OR p.is_active)
          ORDER BY p.is_active DESC, p.amount_cents, p.name`,
        [incluirInativos ?? 'false'],
      );
      return { data: rows.map(paraFora) };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/planos
   * ---------------------------------------------------------------- */
  app.post('/', { preHandler: [app.authorize('pricing:write')] }, async (request, reply) => {
    const corpo = planoSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      let id: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO price_plans
             (tenant_id, name, cycle, amount_cents, sessions_included, commission_bp)
           VALUES ($1,$2,$3::billing_cycle,$4,$5,$6)
           RETURNING id`,
          [
            principal.tenantId,
            corpo.nome,
            corpo.ciclo,
            corpo.valorCentavos,
            corpo.sessoesIncluidas ?? null,
            corpo.comissaoBp ?? 0,
          ],
        );
        id = rows[0]!.id;
      } catch (erro) {
        /* `price_plan_name_per_tenant`. Dois planos "Mensal" na mesma
           academia é o começo de dois preços para a mesma coisa. */
        if ((erro as { code?: string }).code === '23505') {
          throw conflict('Já existe um plano com esse nome.');
        }
        throw erro;
      }

      await writeAudit(client, principal.tenantId, {
        action: 'contract.write',
        resourceType: 'price_plan',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { nome: corpo.nome, ciclo: corpo.ciclo, valorCentavos: corpo.valorCentavos },
      });

      void reply.status(201);
      return { data: { id } };
    });
  });

  /* ------------------------------------------------------------------
   * PUT /api/planos/:id
   * ---------------------------------------------------------------- */
  app.put('/:id', { preHandler: [app.authorize('pricing:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const corpo = planoSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      let afetadas: number;
      try {
        const r = await client.query(
          `UPDATE price_plans
              SET name = $2, cycle = $3::billing_cycle, amount_cents = $4,
                  sessions_included = $5, commission_bp = $6,
                  is_active = COALESCE($7, is_active)
            WHERE id = $1`,
          [
            id,
            corpo.nome,
            corpo.ciclo,
            corpo.valorCentavos,
            corpo.sessoesIncluidas ?? null,
            corpo.comissaoBp ?? 0,
            corpo.ativo ?? null,
          ],
        );
        afetadas = r.rowCount ?? 0;
      } catch (erro) {
        if ((erro as { code?: string }).code === '23505') {
          throw conflict('Já existe um plano com esse nome.');
        }
        throw erro;
      }

      /* Zero linhas é "não existe NESTA empresa": a RLS já reduziu a
         tabela ao tenant do token, então não há como distinguir — nem
         precisa. Um id de outra academia responde 404, que é
         exatamente o que ele deve saber. */
      if (afetadas === 0) throw notFound('Plano');

      await writeAudit(client, principal.tenantId, {
        action: 'contract.write',
        resourceType: 'price_plan',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { nome: corpo.nome, valorCentavos: corpo.valorCentavos },
      });

      return { data: { ok: true } };
    });
  });

  /* ------------------------------------------------------------------
   * DELETE /api/planos/:id — que DESATIVA, e não apaga.
   *
   * O verbo é DELETE porque é o que a tela chama de "remover", e um
   * caminho `/desativar` só empurraria a explicação para o front. O que
   * acontece de fato está aqui e na resposta.
   * ---------------------------------------------------------------- */
  app.delete('/:id', { preHandler: [app.authorize('pricing:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);

    return inTenant(request, async (client, principal) => {
      const r = await client.query<{ em_uso: string }>(
        `UPDATE price_plans SET is_active = false
          WHERE id = $1
        RETURNING (SELECT count(*) FROM student_contracts c
                    WHERE c.price_plan_id = $1 AND c.is_active)::text AS em_uso`,
        [id],
      );
      if (r.rowCount === 0) throw notFound('Plano');

      await writeAudit(client, principal.tenantId, {
        action: 'contract.end',
        resourceType: 'price_plan',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { desativado: true },
      });

      /* Os contratos que já usavam continuam intactos e cobrando. Dizer
         quantos são evita o susto de achar que desativar cancelou
         mensalidade de alguém. */
      return { data: { desativado: true, contratosMantidos: Number(r.rows[0]?.em_uso ?? 0) } };
    });
  });
}
