import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, requireScope } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { hashPassword } from '../../auth/password.js';
import { assertStudentInScope } from './students.repository.js';
import type { TenantClient } from '../../db/pool.js';
import { cpfEhValido } from '../../dominio/documentos.js';

/**
 * Liberar o acesso do aluno ao aplicativo.
 *
 * O LOGIN E A SENHA INICIAL SÃO O CPF, como a academia pediu. É a
 * decisão certa para o público: um aluno de musculação muitas vezes não
 * tem e-mail cadastrado, mas todo mundo sabe o próprio CPF de cor — e o
 * que a coluna `users.email` guarda é o LOGIN, não um endereço.
 *
 * A TROCA É OBRIGATÓRIA NO PRIMEIRO ACESSO, e isso não é formalidade: o
 * CPF de alguém não é segredo, então a senha inicial vale exatamente até
 * a primeira entrada. Sem `must_change_password`, qualquer pessoa que
 * conheça o CPF de um aluno entraria no prontuário dele.
 *
 * O REGISTRO DO ALUNO E O USUÁRIO SÃO COISAS DIFERENTES. `students` é a
 * ficha — existe desde o cadastro, tem anamnese, treino e histórico.
 * `users` é a credencial, e só nasce quando alguém decide liberar o
 * aplicativo. Muito aluno nunca vai querer o app, e forçar uma conta
 * para cada ficha encheria a base de credenciais que ninguém usa.
 */

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });

/** Só os dígitos. Quem digita com ponto e quem digita sem é a mesma pessoa. */
const soDigitos = (v: string): string => v.replace(/\D/g, '');

/* A conferência de CPF mudou de casa: agora mora em `documento.ts` e é
   aplicada TAMBÉM no cadastro do aluno, que é onde o erro de digitação
   nasce. Aqui ela continua valendo como última barreira antes de o CPF
   virar login. */

interface LinhaDoAluno {
  full_name: string;
  document: string | null;
  user_id: string | null;
  email: string | null;
  is_active: boolean | null;
  must_change_password: boolean | null;
  last_login_at: Date | null;
}

async function lerAluno(client: TenantClient, id: string): Promise<LinhaDoAluno | null> {
  const { rows } = await client.query<LinhaDoAluno>(
    `SELECT s.full_name, s.document, s.user_id,
            u.email::text AS email, u.is_active, u.must_change_password, u.last_login_at
       FROM students s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function acessoDoAlunoRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------
   * GET /api/students/:id/acesso — como está o acesso deste aluno
   * ---------------------------------------------------------------- */
  app.get('/:id/acesso', { preHandler: [app.authorize('student:read')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    return inTenant(request, async (client) => {
      if (!(await assertStudentInScope(client, scope, id))) throw notFound('Aluno');
      const aluno = await lerAluno(client, id);
      if (aluno === null) throw notFound('Aluno');

      return {
        data: {
          liberado: aluno.user_id !== null && aluno.is_active === true,
          login: aluno.email,
          /* Se já entrou uma vez, a senha não é mais o CPF — e dizer
             isso evita a recepção prometer "é o seu CPF" a quem já
             trocou. */
          usouSenhaInicial: aluno.must_change_password === true,
          jaEntrou: aluno.last_login_at !== null,
          temCpf: aluno.document !== null && cpfEhValido(soDigitos(aluno.document)),
        },
      };
    });
  });

  /* ------------------------------------------------------------------
   * POST /api/students/:id/acesso — libera (ou redefine para o CPF)
   * ---------------------------------------------------------------- */
  app.post(
    '/:id/acesso',
    { preHandler: [app.authorize('student:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const scope = requireScope(request);

      return inTenant(request, async (client, principal) => {
        if (!(await assertStudentInScope(client, scope, id))) throw notFound('Aluno');
        const aluno = await lerAluno(client, id);
        if (aluno === null) throw notFound('Aluno');

        const cpf = soDigitos(aluno.document ?? '');
        if (cpf === '') {
          throw unprocessable(
            'Este aluno não tem CPF no cadastro, e o CPF é o login do aplicativo. Preencha o CPF na ficha e libere o acesso depois.',
          );
        }
        if (!cpfEhValido(cpf)) {
          /* Recusar aqui é o que impede uma conta que o aluno nunca
             consegue acessar: ele digitaria o CPF certo e o sistema
             responderia "não existe". */
          throw unprocessable(
            'O CPF do cadastro não é válido. Corrija na ficha antes de liberar o acesso.',
          );
        }

        const hash = await hashPassword(cpf);

        /* JÁ TEM CONTA: isto é uma redefinição, não uma criação. A senha
           volta a ser o CPF, a troca volta a ser obrigatória e as
           sessões abertas caem — é o caminho de "o aluno esqueceu a
           senha", que é o motivo real de alguém apertar este botão pela
           segunda vez. */
        if (aluno.user_id !== null) {
          await client.query(
            `UPDATE users
                SET password_hash = $2, password_changed_at = now(),
                    must_change_password = true, is_active = true,
                    failed_login_count = 0, locked_until = NULL
              WHERE id = $1`,
            [aluno.user_id, hash],
          );
          await client.query(
            `UPDATE user_sessions SET revoked_at = now()
              WHERE user_id = $1 AND revoked_at IS NULL`,
            [aluno.user_id],
          );

          await writeAudit(client, principal.tenantId, {
            action: 'user.update',
            resourceType: 'user',
            resourceId: aluno.user_id,
            actorId: principal.userId,
            actorRole: principal.role,
            ip: request.ip,
            metadata: { alunoId: id, senhaVoltouAoCpf: true },
          });

          return { data: { login: cpf, senhaInicial: cpf, criado: false } };
        }

        const criado = await client
          .query<{ id: string }>(
            `INSERT INTO users (tenant_id, email, password_hash, full_name, role, must_change_password)
             VALUES ($1, $2, $3, $4, 'STUDENT', true)
             RETURNING id`,
            [principal.tenantId, cpf, hash, aluno.full_name],
          )
          .catch((e: unknown) => {
            if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
              throw conflict(
                'Já existe um acesso com este CPF nesta academia. Confira se o aluno não está cadastrado duas vezes.',
              );
            }
            throw e;
          });

        await client.query('UPDATE students SET user_id = $2 WHERE id = $1', [
          id,
          criado.rows[0]!.id,
        ]);

        await writeAudit(client, principal.tenantId, {
          action: 'user.create',
          resourceType: 'user',
          resourceId: criado.rows[0]!.id,
          actorId: principal.userId,
          actorRole: principal.role,
          ip: request.ip,
          metadata: { alunoId: id, papel: 'STUDENT' },
        });

        void reply.status(201);
        return { data: { login: cpf, senhaInicial: cpf, criado: true } };
      });
    },
  );

  /* ------------------------------------------------------------------
   * DELETE /api/students/:id/acesso — bloqueia
   *
   * DESATIVA, NÃO APAGA. Apagar o usuário levaria junto o vínculo com
   * tudo o que ele registrou pelo aplicativo — check-in de treino,
   * exame que ele mesmo enviou. Bloquear devolve o acesso a zero e
   * preserva o histórico.
   * ---------------------------------------------------------------- */
  app.delete('/:id/acesso', { preHandler: [app.authorize('student:write')] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = requireScope(request);

    return inTenant(request, async (client, principal) => {
      if (!(await assertStudentInScope(client, scope, id))) throw notFound('Aluno');
      const aluno = await lerAluno(client, id);
      if (aluno?.user_id == null) throw notFound('Acesso');

      await client.query('UPDATE users SET is_active = false WHERE id = $1', [aluno.user_id]);
      await client.query(
        `UPDATE user_sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [aluno.user_id],
      );

      await writeAudit(client, principal.tenantId, {
        action: 'user.delete',
        resourceType: 'user',
        resourceId: aluno.user_id,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { alunoId: id },
      });

      return { ok: true };
    });
  });
}
