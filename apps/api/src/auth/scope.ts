import { scopeComAreas, type Permission, type Role } from '@stabilize/shared';
import { forbidden } from '../http/errors.js';

/**
 * Escopo de acesso resolvido para um request concreto.
 *
 * A diferença entre isto e o `Scope` do pacote shared é que aqui o
 * escopo já vem PREENCHIDO com a identidade: não é "este papel vê só os
 * próprios alunos", é "este request vê só os alunos do profissional
 * <uuid>". O uuid vem do token, nunca do request.
 *
 * É um tipo de união discriminada de propósito. O repositório recebe
 * este valor e o TypeScript o obriga a tratar os três casos — não dá
 * para "esquecer" o filtro sem que a compilação falhe.
 */
export type AccessScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'OWN_PROFESSIONAL'; readonly professionalId: string }
  | { readonly kind: 'SELF'; readonly studentId: string };

export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: Role;
  /** Preenchido quando o usuário é um aluno com acesso ao app. */
  readonly studentId?: string | undefined;
  /**
   * Áreas marcadas para esta pessoa. Ausente = o papel inteiro.
   *
   * O recorte é aplicado AQUI, no mesmo lugar onde o papel é conferido —
   * e não na tela. Esconder a seção no menu não protege rota nenhuma: uma
   * área que só existisse no front seria enfeite, e quem chamasse a rota
   * direto entraria.
   */
  readonly areas?: readonly string[] | undefined;
}

/**
 * Resolve o escopo de um principal para uma permissão.
 * Lança 403 se o papel não tem a permissão.
 */
export function resolveScope(principal: Principal, permission: Permission): AccessScope {
  const declared = scopeComAreas(principal.role, principal.areas ?? null, permission);

  if (declared === null) {
    throw forbidden('Seu perfil não tem acesso a esta funcionalidade.');
  }

  switch (declared) {
    case 'ALL':
      return { kind: 'ALL' };

    case 'OWN_PROFESSIONAL':
      return { kind: 'OWN_PROFESSIONAL', professionalId: principal.userId };

    case 'SELF': {
      if (principal.studentId === undefined) {
        /* Papel STUDENT sem vínculo com um cadastro de aluno não tem o
           que ler. Falhar aqui é melhor do que devolver escopo vazio e
           deixar a consulta decidir. */
        throw forbidden('Sua conta ainda não está vinculada a um cadastro de aluno.');
      }
      return { kind: 'SELF', studentId: principal.studentId };
    }
  }
}

/**
 * Fragmento SQL que materializa o escopo em cláusula WHERE, para
 * consultas sobre a tabela `students` (ou junções que a alcancem).
 *
 * Devolve texto parametrizado e os valores, nunca SQL concatenado com
 * dado. `paramOffset` permite compor com outros parâmetros da query.
 *
 * O caso ALL devolve `TRUE` — e não string vazia — para que quem chama
 * possa sempre fazer `WHERE ${fragment}` sem montar SQL condicional,
 * que é onde se erra a precedência de AND/OR.
 */
export function studentScopeSql(
  scope: AccessScope,
  paramOffset: number,
  studentAlias = 's',
): { sql: string; values: unknown[] } {
  switch (scope.kind) {
    case 'ALL':
      return { sql: 'TRUE', values: [] };

    case 'SELF':
      return {
        sql: `${studentAlias}.id = $${paramOffset + 1}`,
        values: [scope.studentId],
      };

    case 'OWN_PROFESSIONAL':
      /* O vínculo ativo é a fonte da verdade sobre "aluno deste
         profissional". `unassigned_at IS NULL` importa: um professor que
         deixou de atender um aluno perde o acesso ao prontuário dele. */
      return {
        sql: `EXISTS (
                SELECT 1 FROM student_professionals sp
                 WHERE sp.student_id = ${studentAlias}.id
                   AND sp.professional_id = $${paramOffset + 1}
                   AND sp.unassigned_at IS NULL
              )`,
        values: [scope.professionalId],
      };
  }
}

/** Mesma ideia, para tabelas que têm `professional_id` direto (agenda, comissões). */
export function professionalScopeSql(
  scope: AccessScope,
  paramOffset: number,
  alias: string,
): { sql: string; values: unknown[] } {
  switch (scope.kind) {
    case 'ALL':
      return { sql: 'TRUE', values: [] };

    case 'OWN_PROFESSIONAL':
      return {
        sql: `${alias}.professional_id = $${paramOffset + 1}`,
        values: [scope.professionalId],
      };

    case 'SELF':
      return {
        sql: `${alias}.student_id = $${paramOffset + 1}`,
        values: [scope.studentId],
      };
  }
}
