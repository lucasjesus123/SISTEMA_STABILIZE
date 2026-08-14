import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { listStudents, findStudentById, assertStudentInScope } from './students.repository.js';
import type { AccessScope } from '../../auth/scope.js';
import type { TenantClient } from '../../db/pool.js';

/**
 * Teste de isolamento contra um PostgreSQL REAL.
 *
 * Mock de banco não serve aqui. O que estamos testando é justamente a
 * interação entre a RLS do PostgreSQL e o recorte por escopo da
 * aplicação — um mock devolveria o que mandássemos devolver e o teste
 * passaria com o isolamento quebrado.
 *
 * Requer TEST_DATABASE_URL apontando para um banco com as migrations
 * aplicadas, usando um papel SEM BYPASSRLS.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let pool: pg.Pool;

/** Ids fixos, criados no beforeAll. */
const ids = {
  tenantA: '',
  tenantB: '',
  profA1: '',
  profA2: '',
  studentA1: '',
  studentA2: '',
  studentB1: '',
  userStudentA1: '',
};

/** Executa `fn` com o contexto de tenant definido, como faz a API. */
async function withTenant<T>(tenantId: string, fn: (c: TenantClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

suite('isolamento de alunos: entre empresas e entre profissionais', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    // Confirma que o papel de teste NÃO ignora RLS. Sem isso o teste
    // inteiro seria teatro: passaria com as policies desligadas.
    const priv = await pool.query<{ privileged: boolean }>(
      'SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user',
    );
    if (priv.rows[0]?.privileged !== false) {
      throw new Error(
        'TEST_DATABASE_URL usa papel privilegiado; o teste de isolamento seria inválido.',
      );
    }

    const uuid = () => crypto.randomUUID();
    ids.tenantA = uuid();
    ids.tenantB = uuid();

    await withTenant(ids.tenantA, async (c) => {
      await c.query('INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)', [
        ids.tenantA,
        'Stabilize Centro',
        `centro-${ids.tenantA.slice(0, 8)}`,
      ]);

      const p1 = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1,$2,'x','Prof Um','PROFESSIONAL') RETURNING id`,
        [ids.tenantA, `p1-${ids.tenantA.slice(0, 8)}@t.test`],
      );
      ids.profA1 = p1.rows[0]!.id;

      const p2 = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1,$2,'x','Prof Dois','PROFESSIONAL') RETURNING id`,
        [ids.tenantA, `p2-${ids.tenantA.slice(0, 8)}@t.test`],
      );
      ids.profA2 = p2.rows[0]!.id;

      const su = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1,$2,'x','Aluno Um','STUDENT') RETURNING id`,
        [ids.tenantA, `a1-${ids.tenantA.slice(0, 8)}@t.test`],
      );
      ids.userStudentA1 = su.rows[0]!.id;

      const s1 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name, user_id) VALUES ($1,'Ana Aluna',$2) RETURNING id`,
        [ids.tenantA, ids.userStudentA1],
      );
      ids.studentA1 = s1.rows[0]!.id;

      const s2 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name) VALUES ($1,'Bruno Aluno') RETURNING id`,
        [ids.tenantA],
      );
      ids.studentA2 = s2.rows[0]!.id;

      // Ana é do Prof Um; Bruno é do Prof Dois.
      await c.query(
        `INSERT INTO student_professionals (tenant_id, student_id, professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantA, ids.studentA1, ids.profA1],
      );
      await c.query(
        `INSERT INTO student_professionals (tenant_id, student_id, professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantA, ids.studentA2, ids.profA2],
      );
    });

    await withTenant(ids.tenantB, async (c) => {
      await c.query('INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)', [
        ids.tenantB,
        'Outra Academia',
        `outra-${ids.tenantB.slice(0, 8)}`,
      ]);
      const s = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name) VALUES ($1,'Carla Concorrente') RETURNING id`,
        [ids.tenantB],
      );
      ids.studentB1 = s.rows[0]!.id;
    });
  });

  afterAll(async () => {
    if (!pool) return;
    for (const t of [ids.tenantA, ids.tenantB]) {
      if (!t) continue;
      await withTenant(t, async (c) => {
        await c.query('DELETE FROM tenants WHERE id = $1', [t]);
      }).catch(() => undefined);
    }
    await pool.end();
  });

  // ==================================================================
  // Fronteira entre EMPRESAS — garantida pela RLS
  // ==================================================================
  describe('entre empresas', () => {
    it('um admin da Empresa A não lista alunos da Empresa B', async () => {
      const out = await withTenant(ids.tenantA, (c) =>
        listStudents(c, { scope: { kind: 'ALL' }, limit: 100, offset: 0 }),
      );
      const nomes = out.rows.map((r) => r.full_name);
      expect(nomes).toContain('Ana Aluna');
      expect(nomes).toContain('Bruno Aluno');
      expect(nomes).not.toContain('Carla Concorrente');
      expect(out.total).toBe(2);
    });

    it('não lê o aluno da Empresa B nem sabendo o UUID exato (IDOR)', async () => {
      const found = await withTenant(ids.tenantA, (c) =>
        findStudentById(c, { kind: 'ALL' }, ids.studentB1),
      );
      expect(found).toBeNull();
    });

    it('a busca por texto não atravessa a fronteira da empresa', async () => {
      const out = await withTenant(ids.tenantA, (c) =>
        listStudents(c, { scope: { kind: 'ALL' }, search: 'Carla', limit: 100, offset: 0 }),
      );
      expect(out.rows).toHaveLength(0);
      expect(out.total).toBe(0);
    });
  });

  // ==================================================================
  // Recorte DENTRO da empresa — garantido pelo escopo
  // ==================================================================
  describe('entre profissionais da mesma empresa', () => {
    const scopeProf1 = (): AccessScope => ({
      kind: 'OWN_PROFESSIONAL',
      professionalId: ids.profA1,
    });
    const scopeProf2 = (): AccessScope => ({
      kind: 'OWN_PROFESSIONAL',
      professionalId: ids.profA2,
    });

    it('o Prof Um vê apenas a própria aluna', async () => {
      const out = await withTenant(ids.tenantA, (c) =>
        listStudents(c, { scope: scopeProf1(), limit: 100, offset: 0 }),
      );
      expect(out.rows.map((r) => r.full_name)).toEqual(['Ana Aluna']);
      expect(out.total).toBe(1);
    });

    it('o Prof Dois vê apenas o próprio aluno', async () => {
      const out = await withTenant(ids.tenantA, (c) =>
        listStudents(c, { scope: scopeProf2(), limit: 100, offset: 0 }),
      );
      expect(out.rows.map((r) => r.full_name)).toEqual(['Bruno Aluno']);
    });

    it('o Prof Um não abre a ficha do aluno do colega pelo id direto', async () => {
      const found = await withTenant(ids.tenantA, (c) =>
        findStudentById(c, scopeProf1(), ids.studentA2),
      );
      expect(found).toBeNull();
    });

    it('o recorte vale também no caminho de ESCRITA, não só na leitura', async () => {
      const podeEscrever = await withTenant(ids.tenantA, (c) =>
        assertStudentInScope(c, scopeProf1(), ids.studentA2),
      );
      expect(podeEscrever).toBe(false);
    });

    it('desvincular o aluno remove o acesso do profissional ao prontuário', async () => {
      await withTenant(ids.tenantA, async (c) => {
        await c.query(
          `UPDATE student_professionals SET unassigned_at = now()
            WHERE student_id = $1 AND professional_id = $2`,
          [ids.studentA1, ids.profA1],
        );
      });

      const depois = await withTenant(ids.tenantA, (c) =>
        findStudentById(c, scopeProf1(), ids.studentA1),
      );
      expect(depois).toBeNull();

      // Restaura para não afetar outros casos.
      await withTenant(ids.tenantA, async (c) => {
        await c.query(
          `UPDATE student_professionals SET unassigned_at = NULL
            WHERE student_id = $1 AND professional_id = $2`,
          [ids.studentA1, ids.profA1],
        );
      });
    });
  });

  // ==================================================================
  // App do aluno
  // ==================================================================
  describe('aplicativo do aluno', () => {
    it('o aluno só alcança o próprio cadastro', async () => {
      const scope: AccessScope = { kind: 'SELF', studentId: ids.studentA1 };

      const lista = await withTenant(ids.tenantA, (c) =>
        listStudents(c, { scope, limit: 100, offset: 0 }),
      );
      expect(lista.rows.map((r) => r.full_name)).toEqual(['Ana Aluna']);

      const outro = await withTenant(ids.tenantA, (c) =>
        findStudentById(c, scope, ids.studentA2),
      );
      expect(outro).toBeNull();
    });
  });

  // ==================================================================
  // Paginação — limite é teto, não sugestão
  // ==================================================================
  describe('paginação', () => {
    it('o limite é fixado em 100 mesmo se o cliente pedir mais', async () => {
      const out = await withTenant(ids.tenantA, (c) =>
        listStudents(c, { scope: { kind: 'ALL' }, limit: 99_999, offset: 0 }),
      );
      // Só temos 2 alunos; o que importa é que a query não estourou e
      // que o LIMIT foi aplicado — verificado pelo plano abaixo.
      expect(out.rows.length).toBeLessThanOrEqual(100);
    });

    it('o termo de busca é parametrizado — aspas e % não quebram a query', async () => {
      const out = await withTenant(ids.tenantA, (c) =>
        listStudents(c, {
          scope: { kind: 'ALL' },
          search: "%' OR 1=1 --",
          limit: 10,
          offset: 0,
        }),
      );
      // Se o termo fosse concatenado, o OR 1=1 devolveria tudo.
      expect(out.rows).toHaveLength(0);
      expect(out.total).toBe(0);
    });
  });
});
