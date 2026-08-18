/**
 * Papéis e permissões da Stabilize.
 *
 * Três princípios que valem para o sistema inteiro:
 *
 * 1. NEGAR POR PADRÃO. Uma rota sem permissão declarada é uma rota fechada,
 *    não uma rota aberta. Esquecer de proteger não pode virar buraco.
 *
 * 2. PERMISSÃO ≠ ESCOPO. Ter `student:read` não significa ler QUALQUER aluno.
 *    A permissão diz "esta pessoa pode ler fichas de aluno"; o escopo diz
 *    "quais fichas". Um professor tem `student:read` com escopo OWN — só os
 *    alunos vinculados a ele. Confundir os dois é a origem clássica de IDOR.
 *
 * 3. O ESCOPO É DECIDIDO NO SERVIDOR, a partir do token, nunca a partir de um
 *    parâmetro enviado pelo cliente.
 */

/** Papéis do sistema. A ordem não implica hierarquia automática. */
export const ROLES = ['OWNER', 'ADMIN', 'PROFESSIONAL', 'RECEPTION', 'STUDENT'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Catálogo fechado de permissões. Formato `recurso:ação`.
 * Adicionar permissão aqui é uma decisão consciente e revisável em diff.
 */
export const PERMISSIONS = [
  // Alunos e prontuário clínico
  'student:read',
  'student:write',
  'student:delete',
  'student:assign_professional',
  'anamnesis:read',
  'anamnesis:write',
  'evolution:read',
  'evolution:write',
  'attachment:read',
  'attachment:write',
  'attachment:delete',

  /* Treino. A BIBLIOTECA e a PRESCRIÇÃO são permissões separadas de
     propósito: escrever um treino para o próprio aluno é rotina do
     professor; mexer no catálogo da academia muda o vocabulário de
     todo mundo, e é decisão de quem administra. */
  'exercise:read',
  'exercise:write',
  'workout:read',
  'workout:write',

  // Agenda, salas e presença
  'schedule:read',
  'schedule:write',
  'schedule:cancel',
  'availability:read',
  'availability:write',
  'room:read',
  'room:write',
  'attendance:read',
  'attendance:write',

  // Financeiro da empresa — dado sensível de negócio
  'finance:receivable:read',
  'finance:receivable:write',
  'finance:payable:read',
  'finance:payable:write',
  'finance:recurring:write',
  'finance:payment:write',
  'finance:report:read',

  // Financeiro do profissional (comissões) — recorte próprio
  'commission:read',
  'commission:settle',

  // Administração da empresa
  'user:read',
  'user:write',
  'user:delete',
  'pricing:read',
  'pricing:write',
  'tenant:settings',
  'audit:read',

  // Aplicativo do aluno — sempre sobre o próprio cadastro
  'self:read',
  'self:write',
  'self:booking',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Escopo de acesso a dados dentro do tenant.
 * O tenant já é isolado numa camada abaixo (RLS no banco); isto recorta
 * *dentro* da mesma empresa.
 */
export type Scope =
  /** Todos os registros do tenant. */
  | 'ALL'
  /** Apenas registros vinculados ao profissional autenticado. */
  | 'OWN_PROFESSIONAL'
  /** Apenas o registro do próprio aluno autenticado. */
  | 'SELF';

export interface Grant {
  readonly permission: Permission;
  readonly scope: Scope;
}

function grants(scope: Scope, ...permissions: Permission[]): Grant[] {
  return permissions.map((permission) => ({ permission, scope }));
}

/**
 * Matriz de papéis. Esta é a fonte única da verdade sobre quem pode o quê.
 *
 * Nota sobre PROFESSIONAL: ele tem acesso amplo ao prontuário *dos seus
 * alunos* — porque é ele quem preenche anamnese e evolução — mas o escopo
 * OWN_PROFESSIONAL faz o servidor filtrar por vínculo. Ele nunca recebe
 * `finance:receivable:read`: o financeiro da empresa não é dele. O que ele vê
 * é `commission:read` com escopo próprio.
 */
const ROLE_GRANTS: Readonly<Record<Role, readonly Grant[]>> = {
  OWNER: [
    ...grants(
      'ALL',
      ...(PERMISSIONS.filter(
        (p) => p !== 'self:read' && p !== 'self:write' && p !== 'self:booking',
      ) as Permission[]),
    ),
  ],

  /* O ADMIN É O GERENTE DA ACADEMIA e tem tudo o que o dono tem, menos o
     que é da PLATAFORMA. A distinção que importa neste sistema não é
     "dono contra gerente" — os dois tocam a operação inteira e um
     precisa cobrir o outro quando falta. É "quem administra a academia"
     contra "quem administra o serviço", e essa segunda fica em
     `platform_admins`, fora desta matriz.

     A versão anterior negava ao admin escrever anamnese, evolução e
     treino, com o argumento de que a conduta técnica é do profissional.
     O argumento é bom para uma clínica com equipe grande e ruim para uma
     academia onde o gerente também atende — e quem decide isso é quem
     opera, não quem escreve o software. */
  ADMIN: [
    ...grants(
      'ALL',
      'student:read',
      'student:write',
      'student:delete',
      'student:assign_professional',
      'anamnesis:read',
      'anamnesis:write',
      'evolution:read',
      'evolution:write',
      'attachment:read',
      'attachment:write',
      'attachment:delete',
      'exercise:read',
      'exercise:write',
      'workout:read',
      'workout:write',
      'schedule:read',
      'schedule:write',
      'schedule:cancel',
      'availability:read',
      'availability:write',
      'room:read',
      'room:write',
      'attendance:read',
      'attendance:write',
      'finance:receivable:read',
      'finance:receivable:write',
      'finance:payable:read',
      'finance:payable:write',
      'finance:recurring:write',
      'finance:payment:write',
      'finance:report:read',
      'commission:read',
      'commission:settle',
      'user:read',
      'user:write',
      'pricing:read',
      'pricing:write',
      'audit:read',
      'user:delete',
      'tenant:settings',
    ),
  ],

  PROFESSIONAL: [
    ...grants(
      'OWN_PROFESSIONAL',
      'student:read',
      'student:write',
      'anamnesis:read',
      'anamnesis:write',
      'evolution:read',
      'evolution:write',
      'attachment:read',
      'attachment:write',
      'schedule:write',
      'schedule:cancel',
      'availability:write',
      'attendance:read',
      'attendance:write',
      'commission:read',
      'finance:payment:write',
      'workout:read',
      'workout:write',
    ),
    /* A AGENDA DA ACADEMIA INTEIRA é lida por todo profissional, e a
       escrita continua sendo só da própria. É a regra que a academia
       pediu: o calendário é compartilhado, mas ninguém mexe no horário
       do colega — para isso existe a administração.

       A consequência precisa estar dita: o profissional passa a ver o
       NOME do aluno atendido pelo colega, e não mais um bloco anônimo de
       ocupação. Quem atende no mesmo espaço já cruza com essas pessoas
       na sala; o que muda é que agora está na tela, e cada leitura passa
       pelo audit_log.

       `schedule:write` e `schedule:cancel` ficaram no escopo próprio,
       logo acima — é ali que "não mexo no calendário do outro" é
       imposto, e é o servidor que impõe, não a tela. */
    ...grants('ALL', 'schedule:read', 'availability:read', 'room:read', 'exercise:read'),
  ],

  RECEPTION: [
    ...grants(
      'ALL',
      'student:read',
      'student:write',
      'schedule:read',
      'schedule:write',
      'schedule:cancel',
      'availability:read',
      'room:read',
      'attendance:read',
      'attendance:write',
      'pricing:read',
    ),
  ],

  STUDENT: [
    ...grants('SELF', 'self:read', 'self:write', 'self:booking', 'workout:read'),
    ...grants('ALL', 'availability:read'),
  ],
};

/** Índice pré-computado para consulta O(1) no caminho quente das requisições. */
const GRANT_INDEX: Readonly<Record<Role, ReadonlyMap<Permission, Scope>>> = buildGrantIndex();

function buildGrantIndex(): Record<Role, ReadonlyMap<Permission, Scope>> {
  const index = {} as Record<Role, ReadonlyMap<Permission, Scope>>;
  for (const role of ROLES) {
    const map = new Map<Permission, Scope>();
    for (const g of ROLE_GRANTS[role]) {
      const existing = map.get(g.permission);
      // Se um papel recebe a mesma permissão em dois escopos, vale o mais amplo.
      if (existing === undefined || scopeRank(g.scope) > scopeRank(existing)) {
        map.set(g.permission, g.scope);
      }
    }
    index[role] = map;
  }
  return index;
}

function scopeRank(scope: Scope): number {
  switch (scope) {
    case 'ALL':
      return 3;
    case 'OWN_PROFESSIONAL':
      return 2;
    case 'SELF':
      return 1;
  }
}

/**
 * O papel tem a permissão? Retorna o escopo, ou `null` se não tem.
 *
 * Retornar o escopo (e não um booleano) é deliberado: obriga quem chama a
 * lidar com o recorte. Um `boolean` convida a esquecer o filtro e é
 * exatamente assim que nasce um IDOR.
 */
export function permissionScope(role: Role, permission: Permission): Scope | null {
  return GRANT_INDEX[role].get(permission) ?? null;
}

/** Checagem simples de posse da permissão, sem considerar escopo. */
export function hasPermission(role: Role, permission: Permission): boolean {
  return GRANT_INDEX[role].has(permission);
}

/** Todas as permissões de um papel — usado para montar o menu do front. */
export function permissionsOf(role: Role): Permission[] {
  return [...GRANT_INDEX[role].keys()].sort();
}

/** `true` se o papel administra a empresa (dono ou admin). */
export function isTenantAdmin(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Rótulos em português para exibição na interface. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  PROFESSIONAL: 'Profissional',
  RECEPTION: 'Recepção',
  STUDENT: 'Aluno',
};
