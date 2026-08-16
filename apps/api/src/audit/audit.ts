import { withTenant, type TenantClient } from '../db/pool.js';
import type { Role } from '@stabilize/shared';

/**
 * Trilha de auditoria.
 *
 * Registra LEITURA além de escrita, o que é incomum e aqui é
 * necessário: anamnese e evolução são dado de saúde — categoria
 * sensível na LGPD (art. 5º, II). Saber quem *alterou* um prontuário não
 * ajuda a investigar o caso mais provável, que é alguém tendo olhado o
 * prontuário de quem não devia.
 *
 * A tabela é append-only por construção (sem policy de UPDATE/DELETE e
 * com o privilégio revogado). Log que pode ser reescrito não é log.
 */

export type AuditAction =
  // sessão
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.refresh'
  | 'auth.refresh_reuse_detected'
  | 'auth.password_changed'
  | 'auth.account_locked'
  // dado clínico — leitura registrada de propósito
  | 'student.read'
  | 'student.list'
  | 'student.create'
  | 'student.update'
  | 'student.delete'
  | 'anamnesis.read'
  | 'anamnesis.write'
  | 'evolution.read'
  | 'evolution.write'
  | 'attachment.read'
  | 'attachment.upload'
  | 'attachment.delete'
  // treino
  | 'exercise.write'
  | 'workout.write'
  // integração
  | 'whatsapp.connect'
  | 'report.generate'
  // agenda
  | 'appointment.create'
  | 'appointment.update'
  | 'appointment.cancel'
  | 'attendance.mark'
  // financeiro
  | 'finance.entry.create'
  | 'finance.entry.update'
  | 'finance.payment.create'
  | 'finance.payment.delete'
  | 'finance.report.read'
  | 'commission.read'
  | 'commission.settle'
  // administração
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'pricing.update'
  | 'tenant.settings'
  // negativas — as mais interessantes numa investigação
  | 'access.denied';

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'ERROR';

export interface AuditEntry {
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId?: string | undefined;
  readonly outcome?: AuditOutcome;
  readonly actorId?: string | undefined;
  readonly actorRole?: Role | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Campos que nunca podem entrar no metadata do log.
 *
 * O log costuma ser o ponto cego da proteção de dados: ele vai para um
 * agregador, é lido por gente que não teria acesso ao banco, e fica
 * guardado por muito tempo. Um prontuário copiado para dentro de um
 * campo `metadata` sai do controle de acesso do sistema sem ninguém
 * perceber.
 */
const CAMPOS_PROIBIDOS = new Set([
  'password',
  'senha',
  'password_hash',
  'passwordHash',
  'token',
  'tokenHash',
  'token_hash',
  'refreshToken',
  'accessToken',
  'secret',
  'authorization',
  'cookie',
  'content',
  'answers',
  'clinical_history',
  'clinicalHistory',
  'medications',
  'chief_complaint',
  'chiefComplaint',
  'document',
  'cpf',
]);

/** Remove campos sensíveis e limita o tamanho antes de gravar. */
export function sanitizeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (CAMPOS_PROIBIDOS.has(key) || CAMPOS_PROIBIDOS.has(key.toLowerCase())) {
      out[key] = '[removido]';
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.length > 500 ? `${value.slice(0, 500)}…[truncado]` : value;
      continue;
    }
    if (value === null || ['number', 'boolean'].includes(typeof value)) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.length > 50 ? `[${value.length} itens]` : value.map(String).slice(0, 50);
      continue;
    }
    if (typeof value === 'object') {
      // Não descemos recursivamente: objeto aninhado em log de auditoria
      // quase sempre é payload inteiro copiado sem pensar.
      out[key] = '[objeto omitido]';
      continue;
    }
    out[key] = String(value);
  }

  return out;
}

/**
 * Grava uma entrada de auditoria.
 *
 * Recebe o mesmo `client` da transação da operação auditada, de
 * propósito: se a operação for revertida, o log da operação bem-sucedida
 * é revertido junto — não queremos registrar como feito o que não foi.
 * Tentativas NEGADAS são gravadas em transação própria (ver
 * `logDeniedAccess`), porque essas precisam sobreviver ao rollback.
 */
export async function writeAudit(
  client: TenantClient,
  tenantId: string,
  entry: AuditEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (tenant_id, actor_id, actor_role, action, resource_type, resource_id,
        outcome, ip, user_agent, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      tenantId,
      entry.actorId ?? null,
      entry.actorRole ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.outcome ?? 'SUCCESS',
      entry.ip ?? null,
      entry.userAgent ?? null,
      JSON.stringify(sanitizeMetadata(entry.metadata ?? {})),
    ],
  );
}

/**
 * Grava uma NEGATIVA de acesso em transação própria.
 *
 * Esta função existe por causa de um bug real, encontrado por teste: a
 * negativa era gravada com o mesmo cliente da requisição e a requisição
 * terminava lançando 404 — o que dava rollback na transação e levava o
 * registro de auditoria junto. O resultado era o pior possível: toda
 * tentativa BEM-SUCEDIDA ficava registrada, e toda tentativa NEGADA
 * desaparecia. Justamente o inverso do que uma investigação precisa.
 *
 * Abrir transação separada custa uma conexão a mais no caminho de erro,
 * e vale: uma sequência de negativas do mesmo usuário em ids diferentes
 * é o padrão de quem está varrendo a base, e sem esse rastro não há como
 * perceber depois.
 *
 * Nunca propaga erro: falhar ao auditar não pode transformar um 404
 * correto num 500, o que por si só já seria um oráculo.
 */
export async function auditDenied(
  tenantId: string,
  userId: string,
  entry: Omit<AuditEntry, 'outcome'>,
): Promise<void> {
  try {
    await withTenant({ tenantId, userId }, (client) =>
      writeAudit(client, tenantId, { ...entry, outcome: 'DENIED' }),
    );
  } catch {
    /* Silencioso de propósito — ver acima. O erro de gravação aparece
       no log do processo pelo handler de erro do pool. */
  }
}
