import type { TenantClient } from '../../db/pool.js';
import { type AccessScope, studentScopeSql } from '../../auth/scope.js';

/**
 * Acesso a dados de alunos.
 *
 * Toda função aqui exige `scope` como parâmetro OBRIGATÓRIO. Não existe
 * sobrecarga sem escopo, nem valor padrão. Se alguém escrever uma
 * consulta nova esquecendo o recorte, o TypeScript recusa a compilação —
 * que é o momento certo de descobrir, e não em produção.
 *
 * Isso soma-se à RLS, não a substitui. São camadas com propósitos
 * distintos:
 *   RLS   — impede cruzar a fronteira entre EMPRESAS.
 *   scope — recorta DENTRO da mesma empresa (o professor e seus alunos).
 * A RLS não sabe o que é "aluno deste professor"; o escopo não protege
 * contra um WHERE esquecido. Uma não cobre o buraco da outra.
 */

export interface StudentRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  birth_date: string | null;
  status: string;
  photo_path: string | null;
  created_at: Date;
}

export interface ListStudentsParams {
  readonly scope: AccessScope;
  readonly search?: string | undefined;
  readonly status?: string | undefined;
  /** Paginação obrigatória: sem teto, uma lista vira negação de serviço. */
  readonly limit: number;
  readonly offset: number;
}

const MAX_PAGE_SIZE = 100;

export async function listStudents(
  client: TenantClient,
  params: ListStudentsParams,
): Promise<{ rows: StudentRow[]; total: number }> {
  const limit = Math.min(Math.max(params.limit, 1), MAX_PAGE_SIZE);
  const offset = Math.max(params.offset, 0);

  const values: unknown[] = [];
  const conditions: string[] = [];

  const scopeFragment = studentScopeSql(params.scope, values.length, 's');
  conditions.push(scopeFragment.sql);
  values.push(...scopeFragment.values);

  if (params.status !== undefined) {
    values.push(params.status);
    conditions.push(`s.status = $${values.length}::student_status`);
  }

  if (params.search !== undefined && params.search.trim() !== '') {
    /* Busca parametrizada. O termo entra como VALOR, nunca concatenado
       no texto da query — o `%` faz parte do parâmetro, não do SQL. */
    values.push(`%${params.search.trim()}%`);
    conditions.push(`(s.full_name ILIKE $${values.length} OR s.email ILIKE $${values.length})`);
  }

  const where = conditions.join(' AND ');

  const countResult = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM students s WHERE ${where}`,
    values,
  );

  values.push(limit, offset);
  const rowsResult = await client.query<StudentRow>(
    `SELECT s.id, s.full_name, s.email, s.phone, s.whatsapp,
            s.birth_date::text AS birth_date, s.status::text AS status,
            s.photo_path, s.created_at
       FROM students s
      WHERE ${where}
      ORDER BY s.full_name
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return {
    rows: rowsResult.rows,
    total: countResult.rows[0]?.total ?? 0,
  };
}

/**
 * Busca um aluno por id, respeitando o escopo.
 *
 * Devolve `null` — e não lança — quando o aluno não existe OU está fora
 * do escopo. Quem chama traduz isso em 404 nos dois casos, sem
 * distinguir. Ver o comentário de `notFound()` em http/errors.ts: um 403
 * aqui confirmaria a existência do registro e permitiria mapear a base
 * alheia por diferença de resposta.
 */
export async function findStudentById(
  client: TenantClient,
  scope: AccessScope,
  studentId: string,
): Promise<StudentRow | null> {
  const values: unknown[] = [studentId];
  const scopeFragment = studentScopeSql(scope, values.length, 's');
  values.push(...scopeFragment.values);

  const result = await client.query<StudentRow>(
    `SELECT s.id, s.full_name, s.email, s.phone, s.whatsapp,
            s.birth_date::text AS birth_date, s.status::text AS status,
            s.photo_path, s.created_at
       FROM students s
      WHERE s.id = $1 AND ${scopeFragment.sql}`,
    values,
  );

  return result.rows[0] ?? null;
}

/**
 * Confirma que o aluno está no escopo antes de uma escrita.
 *
 * Existe separada porque UPDATE e DELETE também precisam do recorte, e
 * o erro clássico é aplicar o escopo no GET e esquecer no PUT — o que
 * deixa o registro legível só para o dono, mas gravável por qualquer um
 * que saiba o id.
 */
export async function assertStudentInScope(
  client: TenantClient,
  scope: AccessScope,
  studentId: string,
): Promise<boolean> {
  return (await findStudentById(client, scope, studentId)) !== null;
}
