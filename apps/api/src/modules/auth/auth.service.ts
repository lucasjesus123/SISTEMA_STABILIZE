import type { Role } from '@stabilize/shared';
import { withoutTenantContext, withTenant, type TenantClient } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { getDummyHash, hashPassword, needsRehash, verifyPassword } from '../../auth/password.js';
import {
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
  type RefreshTokenMaterial,
} from '../../auth/tokens.js';
import { unauthorized, badRequest } from '../../http/errors.js';
import { writeAudit } from '../../audit/audit.js';

/**
 * Regras de sessão.
 *
 * O tema deste arquivo é **não contar ao atacante o que ele não sabe**.
 * Login errado, e-mail inexistente, conta desativada e empresa suspensa
 * produzem a MESMA resposta e gastam o MESMO tempo. Qualquer diferença
 * entre esses casos vira um oráculo para descobrir quem tem conta.
 */

const MENSAGEM_LOGIN_INVALIDO = 'E-mail ou senha incorretos.';

interface LookupRow {
  user_id: string | null;
  tenant_id: string | null;
  password_hash: string | null;
  role: Role | null;
  full_name: string | null;
  is_active: boolean | null;
  tenant_is_active: boolean | null;
  locked_until: Date | null;
  failed_login_count: number | null;
  must_change_password: boolean | null;
  ambiguous: boolean;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly tenantSlug?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refresh: RefreshTokenMaterial;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly role: Role;
    readonly tenantId: string;
    readonly mustChangePassword: boolean;
  };
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const config = env();

  const lookup = await withoutTenantContext('login', async (client) => {
    const result = await client.query<LookupRow>(
      'SELECT * FROM auth_lookup_user($1::citext, $2::citext)',
      [input.email, input.tenantSlug ?? null],
    );
    return result.rows[0] ?? null;
  });

  if (lookup?.ambiguous === true) {
    /* O mesmo e-mail existe em mais de uma empresa. Pedimos o
       identificador da empresa sem revelar QUAIS empresas — dizer
       "você está na Academia X e na Y" entregaria informação a quem só
       chutou um e-mail. */
    throw badRequest('Informe o identificador da empresa para entrar.', {
      requerEmpresa: true,
    });
  }

  /* Mesmo sem usuário, conferimos a senha contra um hash descartável.
     Sem isso, "e-mail inexistente" responde em 1ms e "senha errada" em
     ~100ms, e essa diferença revela quais e-mails estão cadastrados. */
  if (lookup === null || lookup.user_id === null || lookup.password_hash === null) {
    await verifyPassword(await getDummyHash(), input.password);
    throw unauthorized(MENSAGEM_LOGIN_INVALIDO);
  }

  const userId = lookup.user_id;
  const tenantId = lookup.tenant_id!;
  const role = lookup.role!;

  // Conta bloqueada por tentativas anteriores.
  if (lookup.locked_until !== null && lookup.locked_until > new Date()) {
    await verifyPassword(await getDummyHash(), input.password);
    await auditLoginFailure(tenantId, userId, role, input, 'conta bloqueada');
    /* Mensagem específica de propósito: é informação que o dono legítimo
       precisa (esperar 15 minutos), e o atacante já sabe que bloqueou —
       foi ele quem causou. */
    throw unauthorized(
      `Conta temporariamente bloqueada por excesso de tentativas. Aguarde ${config.LOGIN_LOCKOUT_MINUTES} minutos.`,
    );
  }

  const senhaConfere = await verifyPassword(lookup.password_hash, input.password);

  if (!senhaConfere) {
    await registerAttempt(userId, false);
    await auditLoginFailure(tenantId, userId, role, input, 'senha incorreta');
    throw unauthorized(MENSAGEM_LOGIN_INVALIDO);
  }

  /* Conta ou empresa desativada. A verificação vem DEPOIS de conferir a
     senha, de propósito: antes, responderia diferente para um e-mail
     desativado e um inexistente, o que enumeraria contas. */
  if (lookup.is_active !== true || lookup.tenant_is_active !== true) {
    await auditLoginFailure(tenantId, userId, role, input, 'conta ou empresa inativa');
    throw unauthorized(MENSAGEM_LOGIN_INVALIDO);
  }

  await registerAttempt(userId, true);

  // Endurecimento progressivo: se os parâmetros do Argon2 subiram desde
  // o último login, regrava o hash agora, sem incomodar o usuário.
  if (needsRehash(lookup.password_hash)) {
    const novo = await hashPassword(input.password);
    await withTenant({ tenantId, userId }, async (client) => {
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [novo, userId]);
    });
  }

  const studentId = await resolveStudentId(tenantId, userId, role);

  const { token: accessToken, expiresIn } = await signAccessToken({
    userId,
    tenantId,
    role,
    studentId,
  });

  const refresh = createRefreshToken();

  await withTenant({ tenantId, userId }, async (client) => {
    await persistSession(client, tenantId, userId, refresh, input);
    await writeAudit(client, tenantId, {
      action: 'auth.login',
      resourceType: 'session',
      resourceId: userId,
      actorId: userId,
      actorRole: role,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  });

  return {
    accessToken,
    expiresIn,
    refresh,
    user: {
      id: userId,
      name: lookup.full_name ?? '',
      role,
      tenantId,
      mustChangePassword: lookup.must_change_password === true,
    },
  };
}

/* --------------------------------------------------------------------
 * Rotação do refresh token
 * ------------------------------------------------------------------ */

interface SessionRow {
  id: string;
  user_id: string;
  tenant_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  role: Role;
  is_active: boolean;
}

export interface RefreshResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refresh: RefreshTokenMaterial;
}

/**
 * Troca um refresh token por um par novo.
 *
 * O ponto central é a **detecção de reuso**. Cada refresh é de uso
 * único: ao ser usado, é revogado e substituído. Se um token JÁ USADO
 * aparecer de novo, a leitura mais provável é roubo — o dono legítimo já
 * rotacionou, então quem apresenta o antigo é outra pessoa.
 *
 * Nesse caso derrubamos a FAMÍLIA inteira, não só aquele token: o
 * atacante pode ter obtido o token atual também, e não há como saber
 * qual das duas partes é a legítima. Ambas são deslogadas, e o dono
 * refaz o login.
 */
export async function refresh(
  presentedToken: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<RefreshResult> {
  const tokenHash = hashRefreshToken(presentedToken);

  /* Consulta pela função SECURITY DEFINER, e não por SELECT direto:
     `user_sessions` tem RLS por tenant, e aqui ainda não sabemos qual é
     o tenant — é justamente o que estamos descobrindo. Um SELECT direto
     devolveria zero linhas e TODO refresh viraria 401, deslogando o
     usuário a cada 15 minutos. */
  const sessao = await withoutTenantContext('login', async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT session_id AS id, user_id, tenant_id, family_id,
              expires_at, revoked_at, role, is_active
         FROM auth_lookup_session($1)`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  });

  if (sessao === null) {
    throw unauthorized('Sessão inválida. Entre novamente.');
  }

  // ---- Reuso detectado ----------------------------------------------
  if (sessao.revoked_at !== null) {
    await withTenant({ tenantId: sessao.tenant_id, userId: sessao.user_id }, async (client) => {
      await client.query('SELECT auth_revoke_token_family($1, $2)', [
        sessao.family_id,
        'reuso de refresh token detectado',
      ]);
      await writeAudit(client, sessao.tenant_id, {
        action: 'auth.refresh_reuse_detected',
        resourceType: 'session',
        resourceId: sessao.id,
        outcome: 'DENIED',
        actorId: sessao.user_id,
        actorRole: sessao.role,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: { familyId: sessao.family_id },
      });
    });
    throw unauthorized('Sessão encerrada por segurança. Entre novamente.');
  }

  if (sessao.expires_at <= new Date()) {
    throw unauthorized('Sessão expirada. Entre novamente.');
  }

  if (!sessao.is_active) {
    throw unauthorized('Sessão inválida. Entre novamente.');
  }

  const studentId = await resolveStudentId(sessao.tenant_id, sessao.user_id, sessao.role);

  const { token: accessToken, expiresIn } = await signAccessToken({
    userId: sessao.user_id,
    tenantId: sessao.tenant_id,
    role: sessao.role,
    studentId,
  });

  // Mantém a família: é ela que amarra a cadeia de rotações.
  const novo = createRefreshToken(sessao.family_id);

  await withTenant({ tenantId: sessao.tenant_id, userId: sessao.user_id }, async (client) => {
    await client.query(
      `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'rotacionado' WHERE id = $1`,
      [sessao.id],
    );
    await persistSession(client, sessao.tenant_id, sessao.user_id, novo, meta);
    await writeAudit(client, sessao.tenant_id, {
      action: 'auth.refresh',
      resourceType: 'session',
      resourceId: sessao.id,
      actorId: sessao.user_id,
      actorRole: sessao.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return { accessToken, expiresIn, refresh: novo };
}

/** Encerra a sessão apresentada. */
export async function logout(
  presentedToken: string | undefined,
  principal: { tenantId: string; userId: string; role: Role },
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<void> {
  await withTenant({ tenantId: principal.tenantId, userId: principal.userId }, async (client) => {
    if (presentedToken !== undefined) {
      await client.query(
        `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'logout'
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hashRefreshToken(presentedToken)],
      );
    }
    await writeAudit(client, principal.tenantId, {
      action: 'auth.logout',
      resourceType: 'session',
      actorId: principal.userId,
      actorRole: principal.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
}

/**
 * Troca de senha.
 *
 * Exige a senha atual mesmo com sessão válida: uma sessão sequestrada
 * não pode trocar a senha e expulsar o dono. E derruba todas as outras
 * sessões — trocar a senha é justamente o que se faz ao desconfiar de
 * acesso indevido, e não adiantaria se o intruso continuasse logado.
 */
export async function changePassword(
  principal: { tenantId: string; userId: string; role: Role },
  currentPassword: string,
  newPassword: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<void> {
  await withTenant({ tenantId: principal.tenantId, userId: principal.userId }, async (client) => {
    const result = await client.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [principal.userId],
    );
    const atual = result.rows[0];
    if (atual === undefined) throw unauthorized();

    if (!(await verifyPassword(atual.password_hash, currentPassword))) {
      throw unauthorized('Senha atual incorreta.');
    }
    if (currentPassword === newPassword) {
      throw badRequest('A nova senha precisa ser diferente da atual.');
    }

    const novoHash = await hashPassword(newPassword);
    await client.query(
      `UPDATE users
          SET password_hash = $1, password_changed_at = now(), must_change_password = false
        WHERE id = $2`,
      [novoHash, principal.userId],
    );

    await client.query(
      `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'senha alterada'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [principal.userId],
    );

    await writeAudit(client, principal.tenantId, {
      action: 'auth.password_changed',
      resourceType: 'user',
      resourceId: principal.userId,
      actorId: principal.userId,
      actorRole: principal.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
}

/* --------------------------------------------------------------------
 * Auxiliares
 * ------------------------------------------------------------------ */

async function persistSession(
  client: TenantClient,
  tenantId: string,
  userId: string,
  material: RefreshTokenMaterial,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<void> {
  await client.query(
    `INSERT INTO user_sessions
       (tenant_id, user_id, token_hash, family_id, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      tenantId,
      userId,
      material.tokenHash,
      material.familyId,
      material.expiresAt,
      meta.ip ?? null,
      meta.userAgent ?? null,
    ],
  );
}

/** Descobre o cadastro de aluno vinculado, quando o papel é STUDENT. */
async function resolveStudentId(
  tenantId: string,
  userId: string,
  role: Role,
): Promise<string | undefined> {
  if (role !== 'STUDENT') return undefined;
  return withTenant({ tenantId, userId }, async (client) => {
    const result = await client.query<{ id: string }>(
      'SELECT id FROM students WHERE user_id = $1',
      [userId],
    );
    return result.rows[0]?.id;
  });
}

async function registerAttempt(userId: string, success: boolean): Promise<void> {
  const config = env();
  await withoutTenantContext('login', async (client) => {
    await client.query('SELECT auth_register_login_attempt($1,$2,$3,$4)', [
      userId,
      success,
      config.LOGIN_MAX_FAILED_ATTEMPTS,
      config.LOGIN_LOCKOUT_MINUTES,
    ]);
  });
}

async function auditLoginFailure(
  tenantId: string,
  userId: string,
  role: Role,
  input: LoginInput,
  motivo: string,
): Promise<void> {
  await withTenant({ tenantId, userId }, (client) =>
    writeAudit(client, tenantId, {
      action: 'auth.login_failed',
      resourceType: 'session',
      resourceId: userId,
      outcome: 'DENIED',
      actorId: userId,
      actorRole: role,
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: { motivo },
    }),
  ).catch(() => {
    /* Falha ao auditar não pode virar 500 e revelar que o usuário
       existe — o login continua recusado, que é o essencial. */
  });
}
