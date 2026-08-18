import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatCents, reaisToCents, MoneyError } from '@stabilize/shared';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { hashPassword } from '../../auth/password.js';
import { randomBytes } from 'node:crypto';
import { assertStudentInScope } from '../students/students.repository.js';
import * as repo from './cadastros.repository.js';

/**
 * Equipe, espaços e contrato do aluno.
 *
 * São três cadastros pequenos que não mereciam três módulos, e que têm
 * em comum o fato de a AGENDA e o FINANCEIRO não funcionarem sem eles:
 * sem a lista de profissionais o calendário não tem legenda nem cor, sem
 * salas não há como dividir o espaço, e sem contrato o sistema não sabe
 * quanto cobrar de ninguém.
 *
 * A LISTA DE PROFISSIONAIS É LIBERADA POR `schedule:read`, e não por
 * `user:read`. O profissional precisa dela para ler o calendário
 * compartilhado — que a academia pediu que fosse de todos —, e não tem
 * (nem deve ter) acesso ao cadastro de usuários. Por isso ela devolve
 * apenas nome, papel e cor: o suficiente para pintar a agenda, longe de
 * um diretório de contatos.
 */

const idSchema = z.string().uuid('Identificador inválido');

/**
 * Senha provisória, ditável por telefone.
 *
 * O alfabeto não tem 0/O nem 1/l/I: esta senha costuma ser lida em voz
 * alta para o funcionário novo ou copiada de uma tela, e o par
 * confundido custa uma ligação.
 */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const senhaProvisoria = (): string =>
  [...randomBytes(12)].map((b) => ALFABETO[b % ALFABETO.length]).join('');
const idParam = z.object({ id: idSchema });

const corSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Use uma cor no formato #RRGGBB.')
  .nullish()
  .transform((v) => v ?? null);

const salaSchema = z.object({
  nome: z.string().trim().min(1, 'Informe o nome do espaço.').max(80),
  descricao: z.string().trim().max(300).nullish().transform((v) => v || null),
  capacidade: z.coerce
    .number()
    .int()
    .min(1, 'A capacidade precisa ser pelo menos 1.')
    .max(500)
    .default(1),
  cor: corSchema,
});

/** Valor monetário, sempre em centavos inteiros. Nunca float. */
const valorSchema = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return reaisToCents(v);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof MoneyError ? error.message : 'Valor monetário inválido',
    });
    return z.NEVER;
  }
});

/**
 * A porcentagem do professor, digitada como número (30, 42,5) e guardada
 * em BASIS POINTS inteiros.
 *
 * 42,5% vira 4250, e não 0.425: percentual em ponto flutuante multiplica
 * valor em centavos e produz meio centavo, que alguém arredonda de um
 * jeito na tela e de outro no fechamento. O sistema inteiro já é inteiro;
 * a conversão acontece aqui, uma vez.
 */
const comissaoSchema = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const texto = String(v).trim().replace('%', '').replace(',', '.');
    const numero = Number(texto);
    if (texto === '' || !Number.isFinite(numero)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Porcentagem inválida.' });
      return z.NEVER;
    }
    if (numero < 0 || numero > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A porcentagem vai de 0 a 100.' });
      return z.NEVER;
    }
    return Math.round(numero * 100);
  })
  .default(0);

const contratoSchema = z.object({
  ciclo: z
    .enum(['SESSION', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'])
    .default('MONTHLY'),
  valor: valorSchema,
  comissaoPercentual: comissaoSchema,
  sessoesIncluidas: z.coerce.number().int().min(0).max(500).nullish().transform((v) => v ?? null),
  diaDeCobranca: z.coerce.number().int().min(1).max(28).nullish().transform((v) => v ?? null),
  inicioEm: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
    .optional(),
  profissionalId: idSchema.nullish().transform((v) => v ?? null),
});

export async function cadastrosRoutes(app: FastifyInstance): Promise<void> {
  /* ==================================================================
   * Equipe
   * ================================================================ */

  app.get('/profissionais', { preHandler: [app.authorize('schedule:read')] }, async (request) =>
    inTenant(request, async (client) => {
      const linhas = await repo.listarProfissionais(client);
      return {
        data: linhas.map((p) => ({
          id: p.id,
          nome: p.full_name,
          papel: p.role,
          cor: p.color,
          ativo: p.is_active,
        })),
      };
    }),
  );

  app.put(
    '/profissionais/:id/cor',
    { preHandler: [app.authorize('user:write')] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { cor } = z
        .object({ cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use uma cor no formato #RRGGBB.') })
        .parse(request.body);

      return inTenant(request, async (client, principal) => {
        if (!(await repo.definirCor(client, id, cor))) throw notFound('Profissional');
        await writeAudit(client, principal.tenantId, {
          action: 'user.color.update',
          resourceType: 'user',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { cor },
        });
        return { ok: true };
      });
    },
  );

  /* ==================================================================
   * Equipe: cadastrar, editar, desligar
   *
   * QUEM MEXE EM QUEM. Duas regras, e as duas são impostas aqui, no
   * servidor:
   *
   *   1. SÓ O DONO CRIA OU EDITA OUTRO DONO. Um administrador que
   *      pudesse criar um OWNER se promoveria em dois passos — cria um
   *      dono novo com um e-mail que ele controla e entra por ele.
   *   2. NINGUÉM SE DESLIGA NEM SE REBAIXA. Não é gentileza: é o que
   *      impede a academia de ficar sem nenhum administrador ativo, um
   *      estado do qual só se sai por fora do sistema.
   * ================================================================ */

  const PAPEIS = ['OWNER', 'ADMIN', 'PROFESSIONAL', 'RECEPTION'] as const;

  const usuarioSchema = z.object({
    nome: z.string().trim().min(2, 'Informe o nome completo.').max(160),
    papel: z.enum(PAPEIS),
    telefone: z.string().trim().max(40).nullish().transform((v) => v || null),
    cor: corSchema,
  });

  app.get('/usuarios', { preHandler: [app.authorize('user:read')] }, async (request) =>
    inTenant(request, async (client) => {
      const linhas = await repo.listarUsuarios(client);
      return {
        data: linhas.map((u) => ({
          id: u.id,
          nome: u.full_name,
          email: u.email,
          papel: u.role,
          telefone: u.phone,
          cor: u.cor,
          ativo: u.is_active,
          ultimoAcesso: u.last_login_at?.toISOString() ?? null,
          precisaTrocarSenha: u.must_change_password,
        })),
      };
    }),
  );

  app.post('/usuarios', { preHandler: [app.authorize('user:write')] }, async (request, reply) => {
    const body = usuarioSchema
      .extend({ email: z.string().trim().toLowerCase().email('E-mail inválido.').max(160) })
      .parse(request.body);

    return inTenant(request, async (client, principal) => {
      if (body.papel === 'OWNER' && principal.role !== 'OWNER') {
        throw forbidden('Só o dono da academia cria outro dono.');
      }

      const senha = senhaProvisoria();
      const criado = await repo
        .criarUsuario(client, principal.tenantId, {
          nome: body.nome,
          email: body.email,
          papel: body.papel,
          telefone: body.telefone,
          cor: body.cor,
          hash: await hashPassword(senha),
        })
        .catch((e: unknown) => {
          if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
            throw conflict('Já existe alguém com esse e-mail nesta academia.');
          }
          throw e;
        });

      await writeAudit(client, principal.tenantId, {
        action: 'user.create',
        resourceType: 'user',
        resourceId: criado.id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { papel: body.papel },
      });

      void reply.status(201);
      /* A senha aparece UMA VEZ, na resposta desta chamada. Não é
         guardada em claro em lugar nenhum e a troca é obrigatória no
         primeiro acesso — quem cadastrou nunca sabe a senha definitiva
         de ninguém. */
      return { data: { id: criado.id, senhaProvisoria: senha } };
    });
  });

  app.put('/usuarios/:id', { preHandler: [app.authorize('user:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = usuarioSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      const papelAtual = await repo.papelDe(client, id);
      if (papelAtual === null || papelAtual === 'STUDENT') throw notFound('Usuário');

      if ((papelAtual === 'OWNER' || body.papel === 'OWNER') && principal.role !== 'OWNER') {
        throw forbidden('Só o dono da academia mexe no cadastro de um dono.');
      }
      if (id === principal.userId && body.papel !== principal.role) {
        throw forbidden('Você não pode trocar o próprio papel. Peça a outro administrador.');
      }

      if (!(await repo.atualizarUsuario(client, id, body))) throw notFound('Usuário');

      await writeAudit(client, principal.tenantId, {
        action: 'user.update',
        resourceType: 'user',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { papel: body.papel },
      });
      return { ok: true };
    });
  });

  app.post(
    '/usuarios/:id/situacao',
    { preHandler: [app.authorize('user:write')] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { ativo } = z.object({ ativo: z.boolean() }).parse(request.body);

      return inTenant(request, async (client, principal) => {
        if (id === principal.userId) {
          throw forbidden('Você não pode desligar a própria conta.');
        }
        const papelAtual = await repo.papelDe(client, id);
        if (papelAtual === null || papelAtual === 'STUDENT') throw notFound('Usuário');
        if (papelAtual === 'OWNER' && principal.role !== 'OWNER') {
          throw forbidden('Só o dono da academia desliga outro dono.');
        }

        if (!(await repo.definirUsuarioAtivo(client, id, ativo))) throw notFound('Usuário');

        await writeAudit(client, principal.tenantId, {
          action: ativo ? 'user.update' : 'user.delete',
          resourceType: 'user',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { ativo },
        });
        return { ok: true };
      });
    },
  );

  app.post('/usuarios/:id/senha', { preHandler: [app.authorize('user:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);

    return inTenant(request, async (client, principal) => {
      const papelAtual = await repo.papelDe(client, id);
      if (papelAtual === null || papelAtual === 'STUDENT') throw notFound('Usuário');
      if (papelAtual === 'OWNER' && principal.role !== 'OWNER') {
        throw forbidden('Só o dono da academia redefine a senha de outro dono.');
      }

      const senha = senhaProvisoria();
      if (!(await repo.redefinirSenha(client, id, await hashPassword(senha)))) {
        throw notFound('Usuário');
      }

      await writeAudit(client, principal.tenantId, {
        action: 'user.update',
        resourceType: 'user',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { senhaRedefinida: true },
      });
      return { data: { senhaProvisoria: senha } };
    });
  });

  /* ------------------------------------------------------------------
   * Horários de atendimento
   *
   * O ESCOPO É QUEM DECIDE DE QUEM SÃO. `availability:write` chega ao
   * profissional com escopo OWN_PROFESSIONAL e ao administrador com
   * escopo ALL — é a mesma regra do calendário: cada um mexe no seu, e
   * quem administra mexe no de todos. A recusa acontece aqui, no
   * servidor; a tela apenas evita oferecer o que seria recusado.
   * ---------------------------------------------------------------- */
  app.get(
    '/profissionais/:id/horarios',
    { preHandler: [app.authorize('availability:read')] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return inTenant(request, async (client) => {
        const linhas = await repo.listarHorarios(client, id);
        return {
          data: linhas.map((h) => ({
            id: h.id,
            diaDaSemana: h.weekday,
            /* `time` do PostgreSQL volta "09:00:00"; a tela usa
               <input type="time">, que só aceita "09:00". */
            inicio: h.start_time.slice(0, 5),
            fim: h.end_time.slice(0, 5),
            duracaoMinutos: h.slot_minutes,
            salaId: h.room_id,
          })),
        };
      });
    },
  );

  app.put(
    '/profissionais/:id/horarios',
    { preHandler: [app.authorize('availability:write')] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { faixas } = z
        .object({
          faixas: z
            .array(
              z
                .object({
                  diaDaSemana: z.coerce.number().int().min(0).max(6),
                  inicio: z.string().regex(/^\d{2}:\d{2}$/, 'Horário inválido.'),
                  fim: z.string().regex(/^\d{2}:\d{2}$/, 'Horário inválido.'),
                  duracaoMinutos: z.coerce.number().int().min(10).max(240).default(60),
                  salaId: idSchema.nullish().transform((v) => v ?? null),
                })
                .refine((f) => f.fim > f.inicio, {
                  message: 'O fim precisa ser depois do início.',
                }),
            )
            .max(60, 'São muitas faixas para uma semana.'),
        })
        .parse(request.body);

      const escopo = requireScope(request);
      if (escopo.kind === 'OWN_PROFESSIONAL' && escopo.professionalId !== id) {
        /* 404, e não 403: dizer "existe, mas não é seu" confirma a
           existência de quem perguntou. Aqui não muda muito — a equipe
           se conhece —, mas a resposta é a mesma do resto do sistema, e
           uniformidade é o que impede o vazamento pela exceção. */
        throw notFound('Profissional');
      }

      return inTenant(request, async (client, principal) => {
        const quantas = await repo.gravarHorarios(client, principal.tenantId, id, faixas);
        await writeAudit(client, principal.tenantId, {
          action: 'availability.write',
          resourceType: 'availability_rule',
          resourceId: id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { faixas: quantas },
        });
        return { ok: true, data: { faixas: quantas } };
      });
    },
  );

  /* ==================================================================
   * Espaços
   * ================================================================ */

  app.get('/salas', { preHandler: [app.authorize('room:read')] }, async (request) =>
    inTenant(request, async (client) => {
      const linhas = await repo.listarSalas(client);
      return {
        data: linhas.map((s) => ({
          id: s.id,
          nome: s.name,
          descricao: s.description,
          capacidade: s.capacity,
          cor: s.color,
          ativa: s.is_active,
        })),
      };
    }),
  );

  app.post('/salas', { preHandler: [app.authorize('room:write')] }, async (request, reply) => {
    const body = salaSchema.parse(request.body);

    return inTenant(request, async (client, principal) => {
      const criada = await repo
        .criarSala(client, principal.tenantId, {
          nome: body.nome,
          descricao: body.descricao,
          capacidade: body.capacidade,
          cor: body.cor,
        })
        .catch((e: unknown) => {
          /* 23505 é a unicidade do nome dentro da academia. Deixar o erro
             cru subir viraria 500, e o operador leria "erro interno" para
             o que é apenas um nome repetido. */
          if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
            throw conflict('Já existe um espaço com esse nome.');
          }
          throw e;
        });

      await writeAudit(client, principal.tenantId, {
        action: 'room.create',
        resourceType: 'room',
        resourceId: criada.id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
      });

      void reply.status(201);
      return { data: { id: criada.id } };
    });
  });

  app.put('/salas/:id', { preHandler: [app.authorize('room:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = salaSchema.extend({ ativa: z.boolean().default(true) }).parse(request.body);

    return inTenant(request, async (client, principal) => {
      const ok = await repo
        .atualizarSala(client, id, {
          nome: body.nome,
          descricao: body.descricao,
          capacidade: body.capacidade,
          cor: body.cor,
          ativa: body.ativa,
        })
        .catch((e: unknown) => {
          if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
            throw conflict('Já existe um espaço com esse nome.');
          }
          throw e;
        });
      if (!ok) throw notFound('Espaço');

      await writeAudit(client, principal.tenantId, {
        action: 'room.update',
        resourceType: 'room',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
      });
      return { ok: true };
    });
  });
}

/* ====================================================================
 * Contrato do aluno — registrado sob /api/students/:id
 * ================================================================== */

export async function contratoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/contrato', { preHandler: [app.authorize('pricing:read')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    return inTenant(request, async (client) => {
      /* O escopo do ALUNO manda, e não o da tabela de preços: um
         profissional com `pricing:read` continua sem enxergar o contrato
         de um aluno que não é dele. */
      if (!(await assertStudentInScope(client, scope, id))) throw notFound('Aluno');

      const c = await repo.buscarContratoAtivo(client, id);
      if (c === null) return { data: null };

      const centavos = Number(c.amount_cents);
      return {
        data: {
          id: c.id,
          ciclo: c.cycle,
          valorCentavos: centavos,
          valorFormatado: formatCents(centavos),
          comissaoBp: c.commission_bp,
          comissaoPercentual: c.commission_bp / 100,
          sessoesIncluidas: c.sessions_included,
          diaDeCobranca: c.billing_day,
          inicioEm: dataSimples(c.starts_on),
          fimEm: c.ends_on === null ? null : dataSimples(c.ends_on),
          profissional:
            c.professional_id === null
              ? null
              : { id: c.professional_id, nome: c.professional_name },
        },
      };
    });
  });

  app.put('/:id/contrato', { preHandler: [app.authorize('pricing:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = contratoSchema.parse(request.body);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      if (!(await assertStudentInScope(client, scope, id))) throw notFound('Aluno');

      const criado = await repo
        .gravarContrato(client, principal.tenantId, id, {
          ciclo: body.ciclo,
          valorCentavos: body.valor,
          comissaoBp: body.comissaoPercentual,
          sessoesIncluidas: body.sessoesIncluidas,
          diaDeCobranca: body.diaDeCobranca,
          inicioEm: body.inicioEm ?? dataSimples(new Date()),
          profissionalId: body.profissionalId,
        })
        .catch((e: unknown) => {
          /* 422 com a data no texto. Sem isto o CHECK do banco estourava
             e a tela dizia "erro interno" para uma data mal escolhida. */
          if (e instanceof repo.ContratoAnteriorError) throw unprocessable(e.message);
          throw e;
        });

      await writeAudit(client, principal.tenantId, {
        action: 'contract.write',
        resourceType: 'student_contract',
        resourceId: criado.id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: {
          alunoId: id,
          valorCentavos: body.valor,
          comissaoBp: body.comissaoPercentual,
          ciclo: body.ciclo,
        },
      });

      return { data: { id: criado.id } };
    });
  });

  app.delete('/:id/contrato', { preHandler: [app.authorize('pricing:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      if (!(await assertStudentInScope(client, scope, id))) throw notFound('Aluno');
      if (!(await repo.encerrarContrato(client, id))) throw notFound('Contrato');

      await writeAudit(client, principal.tenantId, {
        action: 'contract.end',
        resourceType: 'student_contract',
        resourceId: id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
      });
      return { ok: true };
    });
  });
}

/**
 * `date` do PostgreSQL chega como Date em hora LOCAL. `toISOString()`
 * converte para UTC e, a oeste de Greenwich, devolve o dia anterior — o
 * contrato que começa dia 1 apareceria começando dia 31.
 */
function dataSimples(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}
