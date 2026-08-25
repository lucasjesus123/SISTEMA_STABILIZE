import { describe, expect, it } from 'vitest';
import {
  AREAS,
  PERMISSIONS,
  ROLES,
  hasPermission,
  isTenantAdmin,
  permissionScope,
  permissionsOf,
  scopeComAreas,
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

  it('ADMIN tem exatamente o mesmo que OWNER dentro da academia', () => {
    /* A distinção que importa neste sistema NÃO é "dono contra gerente":
       os dois tocam a operação inteira e um cobre o outro quando falta.
       É "quem administra a ACADEMIA" contra "quem administra o SERVIÇO",
       e o segundo mora em `platform_admins`, fora desta matriz.

       Este teste existe para que a igualdade seja uma DECISÃO e não um
       acidente: se alguém acrescentar permissão a um dos dois e esquecer
       o outro, ele falha. */
    const doDono = permissionsOf('OWNER').filter(
      (p) => p !== 'self:read' && p !== 'self:write' && p !== 'self:booking',
    );
    for (const p of doDono) {
      expect(hasPermission('ADMIN', p), `ADMIN deveria ter ${p}`).toBe(true);
    }
    for (const p of permissionsOf('ADMIN')) {
      expect(hasPermission('OWNER', p), `OWNER deveria ter ${p}`).toBe(true);
    }
  });

  it('nem OWNER nem ADMIN recebem as permissões do app do aluno', () => {
    /* `self:*` é do aluno olhando o próprio cadastro. Um administrador
       que as tivesse passaria pelo escopo SELF sem ter `studentId`, e o
       recorte cairia em cima de uma conta que não é de aluno. */
    for (const papel of ['OWNER', 'ADMIN'] as const) {
      expect(hasPermission(papel, 'self:read')).toBe(false);
      expect(hasPermission(papel, 'self:booking')).toBe(false);
    }
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

/* =====================================================================
 * Áreas — o recorte por pessoa
 *
 * A propriedade que estes testes guardam é uma só, e é a que torna o
 * recurso seguro: ÁREA ESTREITA, NUNCA ALARGA. No dia em que marcar uma
 * área puder acrescentar permissão fora do papel, a matriz de papéis
 * deixa de responder "o que este papel enxerga?" e a resposta vira
 * "depende de quem foi marcado".
 * =================================================================== */

describe('áreas do usuário', () => {
  it('sem áreas, a pessoa tem o papel inteiro', () => {
    for (const role of ROLES) {
      expect(permissionsOf(role, null)).toEqual(permissionsOf(role));
      expect(permissionsOf(role, [])).toEqual(permissionsOf(role));
    }
  });

  it('marcar só o financeiro tira o resto do administrador', () => {
    const so = permissionsOf('ADMIN', ['financeiro']);
    expect(so).toContain('finance:report:read');
    expect(so).toContain('commission:read');
    /* O que o pedido dizia com todas as letras: quem cuida do dinheiro
       não abre prontuário de aluno. */
    expect(so).not.toContain('anamnesis:read');
    expect(so).not.toContain('evolution:read');
    expect(so).not.toContain('user:write');
    expect(so).not.toContain('schedule:read');
  });

  it('NÃO ALARGA: marcar financeiro numa recepção não inventa financeiro', () => {
    const recepcao = permissionsOf('RECEPTION', ['financeiro']);
    expect(recepcao).not.toContain('finance:report:read');
    expect(recepcao).not.toContain('finance:receivable:read');
    /* O que sobra é a interseção: `student:read` e `pricing:read` a
       recepção já tinha, e a área financeira também os pede. */
    expect(recepcao.every((p) => permissionsOf('RECEPTION').includes(p))).toBe(true);
  });

  it('o recorte vale na autorização, e não só na montagem do menu', () => {
    expect(scopeComAreas('ADMIN', null, 'student:read')).toBe('ALL');
    expect(scopeComAreas('ADMIN', ['financeiro'], 'student:read')).toBe('ALL');
    /* `student:read` está na área financeira porque o financeiro precisa
       saber de quem é a cobrança. O que some é o resto do prontuário: */
    expect(scopeComAreas('ADMIN', ['financeiro'], 'anamnesis:read')).toBeNull();
    expect(scopeComAreas('ADMIN', ['financeiro'], 'user:write')).toBeNull();
  });

  it('área desconhecida é ignorada, e sozinha não dá nada', () => {
    /* Um valor escrito errado não pode virar "tudo": o CHECK do banco
       recusa a gravação, e se algum caminho escapar, aqui ele resulta em
       conjunto vazio — que é falha fechada, não aberta. */
    expect(permissionsOf('ADMIN', ['financiero'])).toEqual([]);
    expect(scopeComAreas('ADMIN', ['financiero'], 'student:read')).toBeNull();
  });

  it('cada área é recortável sozinha — nenhuma arrasta a vizinha', () => {
    /* Foi por isto que CRM e WhatsApp ganharam permissão própria: os dois
       andavam emprestados de `student:write` e `user:write`, e marcar só
       "Interessados" entregava o cadastro de alunos inteiro junto. */
    const crm = permissionsOf('ADMIN', ['interessados']);
    expect(crm).toContain('crm:write');
    expect(crm).not.toContain('student:write');
    expect(crm).not.toContain('student:delete');

    const zap = permissionsOf('ADMIN', ['whatsapp']);
    expect(zap).toContain('whatsapp:manage');
    expect(zap).not.toContain('user:write');
    expect(zap).not.toContain('tenant:settings');
  });

  it('toda área serve para alguma coisa em pelo menos um papel', () => {
    /* Uma área cujo conjunto é vazio para todo mundo é uma caixa que
       aparece na tela e não faz nada. */
    for (const area of AREAS) {
      const alguem = ROLES.some((r) => permissionsOf(r, [area]).length > 0);
      expect(alguem, `área sem efeito: ${area}`).toBe(true);
    }
  });
});
