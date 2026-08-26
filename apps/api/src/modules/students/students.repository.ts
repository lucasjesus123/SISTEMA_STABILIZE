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
       no texto da query — o `%` faz parte do parâmetro, não do SQL.

       OS CURINGAS DO PRÓPRIO `ILIKE` PRECISAM SER ESCAPADOS, e isso é
       outra coisa: não é injeção — o parâmetro está seguro — é o `%` e
       o `_` digitados pela recepção sendo lidos como "qualquer coisa"
       em vez de como o caractere que ela digitou. Medido antes: buscar
       `%` devolvia a base inteira, e `_` também. Numa lista de duzentos
       alunos isso não parece um bug, parece que a busca não funciona.

       `\\` é o escape padrão do `LIKE`, e a barra também precisa ser
       escapada primeiro — senão ela escaparia o caractere seguinte. */
    const termo = params.search
      .trim()
      .replace(/\\/g, '\\\\')
      .replace(/[%_]/g, (c) => `\\${c}`);
    values.push(`%${termo}%`);
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

/* ====================================================================
 * Ficha do aluno
 *
 * A lição de desenho que veio dos sistemas do mercado: a ficha é o
 * CENTRO DE GRAVIDADE do atendimento, não uma lista de campos. Quem
 * está no balcão abre a ficha e resolve tudo dali — situação, plano,
 * pagamento, frequência, profissional.
 *
 * Por isso uma consulta só devolve o conjunto, em vez de a tela fazer
 * seis chamadas: seis idas ao servidor numa tela que se abre o dia
 * inteiro é lentidão que o atendente sente.
 * ================================================================== */

export interface FichaAluno {
  id: string;
  /** Código interno, o número pelo qual a academia chama o aluno. */
  codigo: string | null;
  nome: string;
  email: string | null;
  telefone: string | null;
  whatsapp: string | null;
  dataNascimento: string | null;
  documento: string | null;
  status: string;
  observacoes: string | null;
  inicioEm: string | null;
  criadoEm: Date;
  endereco: {
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
  };
  emergencia: { contato: string | null; telefone: string | null };
  profissional: { id: string; nome: string } | null;
  contrato: {
    ciclo: string;
    valorCentavos: number;
    comissaoBp: number;
    sessoesIncluidas: number | null;
    diaVencimento: number | null;
    inicioEm: string;
  } | null;
  frequencia: { presencas: number; faltas: number; agendados: number };
  financeiro: { emAbertoCentavos: number; vencidasQtd: number; pagoNoAnoCentavos: number };
  temAnamnese: boolean;
}

/**
 * Coluna `date` do PostgreSQL em ISO "AAAA-MM-DD".
 *
 * O driver devolve `date` como objeto Date, e a versão anterior fazia
 * `String(valor).slice(0, 10)` — que num Date produz "Sun Mar 2":
 * os dez primeiros caracteres da representação em INGLÊS. A API então
 * entregava isso como se fosse ISO, e tanto a tela quanto o PDF exibiam
 * lixo ou traço. Nenhum teste pegou porque o campo continuava sendo uma
 * string não vazia; só apareceu ao abrir um relatório impresso.
 *
 * `toISOString` é seguro aqui: coluna `date` chega como meia-noite UTC,
 * então a parte da data não desloca.
 */
function dataIso(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).slice(0, 10);
}

export async function buscarFicha(
  client: TenantClient,
  scope: AccessScope,
  studentId: string,
): Promise<FichaAluno | null> {
  const values: unknown[] = [studentId];
  const escopo = studentScopeSql(scope, values.length, 's');
  values.push(...escopo.values);

  const r = await client.query<Record<string, unknown>>(
    `SELECT s.*,
            u.id   AS prof_id,
            u.full_name AS prof_nome,
            c.cycle::text AS c_ciclo, c.amount_cents AS c_valor,
            c.commission_bp AS c_bp, c.sessions_included AS c_sessoes,
            c.billing_day AS c_dia, c.starts_on::text AS c_inicio,
            (SELECT count(*) FROM anamneses an WHERE an.student_id = s.id) AS qtd_anamnese,
            (SELECT count(*) FILTER (WHERE a.status='ATTENDED')
               FROM appointments a WHERE a.student_id = s.id) AS presencas,
            (SELECT count(*) FILTER (WHERE a.status='NO_SHOW')
               FROM appointments a WHERE a.student_id = s.id) AS faltas,
            (SELECT count(*) FILTER (WHERE a.status IN ('SCHEDULED','CONFIRMED'))
               FROM appointments a WHERE a.student_id = s.id) AS agendados,
            (SELECT COALESCE(SUM(e.amount_cents - e.paid_cents),0)
               FROM finance_entries e
              WHERE e.student_id = s.id AND e.direction='RECEIVABLE'
                AND e.cancelled_at IS NULL AND e.status <> 'PAID') AS em_aberto,
            (SELECT count(*) FROM finance_entries e
              WHERE e.student_id = s.id AND e.direction='RECEIVABLE'
                AND e.cancelled_at IS NULL AND e.status <> 'PAID'
                AND e.due_date < CURRENT_DATE) AS vencidas,
            (SELECT COALESCE(SUM(p.amount_cents),0)
               FROM finance_payments p
               JOIN finance_entries e2 ON e2.id = p.entry_id
              WHERE e2.student_id = s.id
                AND p.paid_at >= date_trunc('year', CURRENT_DATE)) AS pago_ano
       FROM students s
       LEFT JOIN student_professionals sp
              ON sp.student_id = s.id AND sp.unassigned_at IS NULL
       LEFT JOIN users u ON u.id = sp.professional_id
       LEFT JOIN student_contracts c
              ON c.student_id = s.id AND c.is_active
             AND c.starts_on <= CURRENT_DATE
             AND (c.ends_on IS NULL OR c.ends_on >= CURRENT_DATE)
      WHERE s.id = $1 AND ${escopo.sql}
      LIMIT 1`,
    values,
  );

  const x = r.rows[0];
  if (x === undefined) return null;

  const txt = (k: string): string | null => (x[k] === null ? null : String(x[k]));
  const n = (k: string): number => Number(x[k] ?? 0);

  return {
    id: String(x['id']),
    /* O CÓDIGO INTERNO DO ALUNO. A coluna já vinha no `s.*` e nunca era
       devolvida — a ficha existia com um número que ninguém via. */
    codigo: txt('codigo'),
    nome: String(x['full_name']),
    email: txt('email'),
    telefone: txt('phone'),
    whatsapp: txt('whatsapp'),
    dataNascimento: dataIso(x['birth_date']),
    documento: txt('document'),
    status: String(x['status']),
    observacoes: txt('notes'),
    inicioEm: dataIso(x['started_at']),
    criadoEm: x['created_at'] as Date,
    endereco: {
      cep: txt('address_zip'),
      logradouro: txt('address_street'),
      numero: txt('address_number'),
      complemento: txt('address_complement'),
      bairro: txt('address_district'),
      cidade: txt('address_city'),
      uf: txt('address_state'),
    },
    emergencia: { contato: txt('emergency_contact'), telefone: txt('emergency_phone') },
    profissional:
      x['prof_id'] === null
        ? null
        : { id: String(x['prof_id']), nome: String(x['prof_nome']) },
    contrato:
      x['c_ciclo'] === null
        ? null
        : {
            ciclo: String(x['c_ciclo']),
            valorCentavos: n('c_valor'),
            comissaoBp: n('c_bp'),
            sessoesIncluidas: x['c_sessoes'] === null ? null : n('c_sessoes'),
            diaVencimento: x['c_dia'] === null ? null : n('c_dia'),
            inicioEm: String(x['c_inicio']),
          },
    frequencia: { presencas: n('presencas'), faltas: n('faltas'), agendados: n('agendados') },
    financeiro: {
      emAbertoCentavos: n('em_aberto'),
      vencidasQtd: n('vencidas'),
      pagoNoAnoCentavos: n('pago_ano'),
    },
    temAnamnese: n('qtd_anamnese') > 0,
  };
}

export interface DadosAluno {
  nome: string;
  email?: string | undefined;
  telefone?: string | undefined;
  whatsapp?: string | undefined;
  dataNascimento?: string | undefined;
  documento?: string | undefined;
  status?: string | undefined;
  observacoes?: string | undefined;
  cep?: string | undefined;
  logradouro?: string | undefined;
  numero?: string | undefined;
  complemento?: string | undefined;
  bairro?: string | undefined;
  cidade?: string | undefined;
  uf?: string | undefined;
  contatoEmergencia?: string | undefined;
  telefoneEmergencia?: string | undefined;
  profissionalId?: string | undefined;
}

/** Colunas gravadas pelo formulário. Lista fechada, e é isso que importa:
 *  sem ela, um corpo de requisição com campos extras poderia alterar
 *  coluna que o formulário nunca deveria tocar (mass assignment). */
const COLUNAS: readonly (readonly [keyof DadosAluno, string])[] = [
  ['nome', 'full_name'],
  ['email', 'email'],
  ['telefone', 'phone'],
  ['whatsapp', 'whatsapp'],
  ['dataNascimento', 'birth_date'],
  ['documento', 'document'],
  ['observacoes', 'notes'],
  ['cep', 'address_zip'],
  ['logradouro', 'address_street'],
  ['numero', 'address_number'],
  ['complemento', 'address_complement'],
  ['bairro', 'address_district'],
  ['cidade', 'address_city'],
  ['uf', 'address_state'],
  ['contatoEmergencia', 'emergency_contact'],
  ['telefoneEmergencia', 'emergency_phone'],
];

export async function criarAluno(
  client: TenantClient,
  tenantId: string,
  dados: DadosAluno,
  criadoPor: string,
): Promise<{ id: string }> {
  const colunas = ['tenant_id', 'status', 'started_at', 'created_by'];
  const valores: unknown[] = [tenantId, dados.status ?? 'ACTIVE', new Date(), criadoPor];

  for (const [campo, coluna] of COLUNAS) {
    const v = dados[campo];
    if (v === undefined) continue;
    colunas.push(coluna);
    valores.push(v === '' ? null : v);
  }

  const marcadores = valores.map((_, i) => `$${i + 1}`);
  // `status` é o 2º valor e precisa do cast para o tipo enum.
  marcadores[1] = '$2::student_status';

  const r = await client.query<{ id: string }>(
    `INSERT INTO students (${colunas.join(', ')}) VALUES (${marcadores.join(', ')}) RETURNING id`,
    valores,
  );

  const id = r.rows[0]!.id;

  if (dados.profissionalId !== undefined && dados.profissionalId !== '') {
    await client.query(
      `INSERT INTO student_professionals (tenant_id, student_id, professional_id)
       VALUES ($1,$2,$3)`,
      [tenantId, id, dados.profissionalId],
    );
  }

  return { id };
}

/** Atualiza respeitando o escopo. Devolve `false` se o aluno não está
 *  ao alcance de quem edita — que a rota traduz em 404, nunca 403. */
/* `nome` também opcional na edição, e cada campo aceita `undefined`
   explicitamente: com exactOptionalPropertyTypes, `Partial<T>` de um
   campo obrigatório vira `nome?: string` SEM `| undefined`, e um objeto
   que traz a chave com valor undefined deixa de encaixar. */
export type EdicaoAluno = { [K in keyof DadosAluno]?: DadosAluno[K] | undefined };

export async function atualizarAluno(
  client: TenantClient,
  scope: AccessScope,
  tenantId: string,
  studentId: string,
  dados: EdicaoAluno,
): Promise<boolean> {
  const sets: string[] = [];
  const valores: unknown[] = [];

  for (const [campo, coluna] of COLUNAS) {
    const v = dados[campo];
    if (v === undefined) continue;
    valores.push(v === '' ? null : v);
    sets.push(`${coluna} = $${valores.length}`);
  }

  if (dados.status !== undefined) {
    valores.push(dados.status);
    sets.push(`status = $${valores.length}::student_status`);
  }

  if (sets.length === 0) return true; // nada a mudar não é erro

  valores.push(studentId);
  const idPos = valores.length;
  const escopo = studentScopeSql(scope, valores.length, 'students');
  valores.push(...escopo.values);

  const r = await client.query(
    `UPDATE students SET ${sets.join(', ')}
      WHERE id = $${idPos} AND ${escopo.sql}`,
    valores,
  );

  if ((r.rowCount ?? 0) === 0) return false;

  if (dados.profissionalId !== undefined) {
    /* Trocar de profissional encerra o vínculo anterior em vez de
       apagá-lo: o histórico de quem atendeu quem é o que sustenta o
       cálculo de comissão dos meses passados. */
    await client.query(
      `UPDATE student_professionals SET unassigned_at = now()
        WHERE student_id = $1 AND unassigned_at IS NULL
          AND professional_id <> $2`,
      [studentId, dados.profissionalId],
    );
    if (dados.profissionalId !== '') {
      await client.query(
        `INSERT INTO student_professionals (tenant_id, student_id, professional_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, student_id, professional_id)
         DO UPDATE SET unassigned_at = NULL`,
        [tenantId, studentId, dados.profissionalId],
      );
    }
  }

  return true;
}
