import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  hasPermission,
  isTenantAdmin,
  permissionScope,
  permissionsOf,
  type Permission,
  type Role,
} from './rbac.js';

describe('invariantes estruturais da matriz de permissões', () => {
  it('nega por padrão: nenhum papel recebe permissão fora do catálogo', () => {
    const catalogo = new Set<string>(PERMISSIONS);
    for (const role of ROLES) {
      for (const p of permissionsOf(role)) {
        expect(catalogo.has(p)).toBe(true);
      }
    }
  });

  it('todo papel devolve escopo definido para o que possui, e null para o resto', () => {
    for (const role of ROLES) {
      const possui = new Set<Permission>(permissionsOf(role));
      for (const p of PERMISSIONS) {
        const scope = permissionScope(role, p);
        if (possui.has(p)) {
          expect(scope).not.toBeNull();
        } else {
          expect(scope).toBeNull();
        }
      }
    }
  });
});

describe('PROFESSIONAL — o recorte que impede um profissional de ver o do outro', () => {
  const role: Role = 'PROFESSIONAL';

  it('lê fichas de aluno APENAS no escopo próprio, nunca no escopo total', () => {
    expect(permissionScope(role, 'student:read')).toBe('OWN_PROFESSIONAL');
    expect(permissionScope(role, 'anamnesis:read')).toBe('OWN_PROFESSIONAL');
    expect(permissionScope(role, 'evolution:read')).toBe('OWN_PROFESSIONAL');
    expect(permissionScope(role, 'attachment:read')).toBe('OWN_PROFESSIONAL');
  });

  it('vê as próprias comissões, e apenas as próprias', () => {
    expect(permissionScope(role, 'commission:read')).toBe('OWN_PROFESSIONAL');
  });

  it('NÃO acessa o financeiro da empresa', () => {
    expect(hasPermission(role, 'finance:receivable:read')).toBe(false);
    expect(hasPermission(role, 'finance:payable:read')).toBe(false);
    expect(hasPermission(role, 'finance:report:read')).toBe(false);
    expect(hasPermission(role, 'finance:recurring:write')).toBe(false);
  });

  it('NÃO administra usuários, preços nem configurações da empresa', () => {
    expect(hasPermission(role, 'user:write')).toBe(false);
    expect(hasPermission(role, 'user:delete')).toBe(false);
    expect(hasPermission(role, 'pricing:write')).toBe(false);
    expect(hasPermission(role, 'tenant:settings')).toBe(false);
    expect(hasPermission(role, 'audit:read')).toBe(false);
  });

  it('NÃO apaga alunos nem redistribui alunos entre profissionais', () => {
    expect(hasPermission(role, 'student:delete')).toBe(false);
    expect(hasPermission(role, 'student:assign_professional')).toBe(false);
  });

  it('enxerga ocupação de sala e disponibilidade geral — necessário para não marcar em cima', () => {
    expect(permissionScope(role, 'availability:read')).toBe('ALL');
    expect(permissionScope(role, 'room:read')).toBe('ALL');
  });
});

describe('STUDENT — o aplicativo do aluno só alcança o próprio cadastro', () => {
  const role: Role = 'STUDENT';

  it('tudo que é pessoal está no escopo SELF', () => {
    expect(permissionScope(role, 'self:read')).toBe('SELF');
    expect(permissionScope(role, 'self:write')).toBe('SELF');
    expect(permissionScope(role, 'self:booking')).toBe('SELF');
  });

  it('não alcança nenhum recurso administrativo, financeiro ou de terceiros', () => {
    const proibidas: Permission[] = [
      'student:read',
      'student:write',
      'anamnesis:read',
      'anamnesis:write',
      'evolution:read',
      'attachment:read',
      'attendance:write',
      'commission:read',
      'finance:receivable:read',
      'finance:payable:read',
      'finance:report:read',
      'user:read',
      'audit:read',
      'schedule:write',
    ];
    for (const p of proibidas) {
      expect(hasPermission(role, p)).toBe(false);
    }
  });

  it('só enxerga disponibilidade, que é o necessário para escolher um horário', () => {
    expect(permissionScope(role, 'availability:read')).toBe('ALL');
    expect(hasPermission(role, 'availability:write')).toBe(false);
  });
});

describe('RECEPTION — opera a recepção sem tocar em dinheiro nem em prontuário', () => {
  const role: Role = 'RECEPTION';

  it('agenda e cadastra', () => {
    expect(hasPermission(role, 'schedule:write')).toBe(true);
    expect(hasPermission(role, 'student:write')).toBe(true);
    expect(hasPermission(role, 'attendance:write')).toBe(true);
  });

  it('não lê prontuário clínico (dado de saúde)', () => {
    expect(hasPermission(role, 'anamnesis:read')).toBe(false);
    expect(hasPermission(role, 'evolution:read')).toBe(false);
    expect(hasPermission(role, 'attachment:read')).toBe(false);
  });

  it('não movimenta financeiro nem comissões', () => {
    expect(hasPermission(role, 'finance:receivable:write')).toBe(false);
    expect(hasPermission(role, 'finance:payment:write')).toBe(false);
    expect(hasPermission(role, 'commission:read')).toBe(false);
  });
});

describe('OWNER e ADMIN', () => {
  it('OWNER alcança todo o catálogo administrativo com escopo total', () => {
    for (const p of PERMISSIONS) {
      if (p.startsWith('self:')) continue;
      expect(permissionScope('OWNER', p)).toBe('ALL');
    }
  });

  it('OWNER não recebe as permissões do app do aluno', () => {
    expect(hasPermission('OWNER', 'self:booking')).toBe(false);
  });

  it('ADMIN gere a operação e o financeiro, mas não apaga usuários nem muda configuração do tenant', () => {
    expect(hasPermission('ADMIN', 'finance:report:read')).toBe(true);
    expect(hasPermission('ADMIN', 'commission:settle')).toBe(true);
    expect(hasPermission('ADMIN', 'user:delete')).toBe(false);
    expect(hasPermission('ADMIN', 'tenant:settings')).toBe(false);
  });

  it('somente OWNER e ADMIN são administradores do tenant', () => {
    expect(isTenantAdmin('OWNER')).toBe(true);
    expect(isTenantAdmin('ADMIN')).toBe(true);
    expect(isTenantAdmin('PROFESSIONAL')).toBe(false);
    expect(isTenantAdmin('RECEPTION')).toBe(false);
    expect(isTenantAdmin('STUDENT')).toBe(false);
  });
});

describe('regressão: permissões sensíveis nunca vazam para papéis não-administrativos', () => {
  const sensiveis: Permission[] = [
    'finance:receivable:read',
    'finance:payable:read',
    'finance:report:read',
    'user:delete',
    'tenant:settings',
    'audit:read',
    'student:delete',
  ];

  it('apenas OWNER/ADMIN aparecem para cada permissão sensível', () => {
    for (const p of sensiveis) {
      const quemTem = ROLES.filter((r) => hasPermission(r, p));
      for (const r of quemTem) {
        expect(isTenantAdmin(r)).toBe(true);
      }
    }
  });
});
