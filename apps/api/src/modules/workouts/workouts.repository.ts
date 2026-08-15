import type { TenantClient } from '../../db/pool.js';
import { type AccessScope, studentScopeSql } from '../../auth/scope.js';

/**
 * Treino: biblioteca de exercícios e prescrição.
 *
 * DUAS COISAS COM REGRAS DIFERENTES, no mesmo arquivo porque uma não
 * existe sem a outra:
 *
 *   BIBLIOTECA — é da EMPRESA. Não tem dono nem aluno, então não passa
 *   pelo escopo: a RLS já garante que ninguém vê o catálogo de outra
 *   academia, e dentro da academia todo profissional lê a mesma lista.
 *   Quem escreve é controlado por permissão, não por escopo.
 *
 *   PRESCRIÇÃO — é do ALUNO. Passa pelo escopo como todo o resto do
 *   prontuário, e pela mesma razão: um treino diz o que a pessoa pode e
 *   não pode fazer com o corpo dela.
 *
 * A distinção importa na hora de escrever consulta nova. Se a tabela
 * tem `student_id`, o escopo é obrigatório. Se não tem, é catálogo.
 */

/* ====================================================================
 * Biblioteca
 * ================================================================== */

export interface Exercicio {
  id: string;
  nome: string;
  grupo: string;
  equipamento: string | null;
  instrucoes: string | null;
  video: string | null;
  ativo: boolean;
}

export const GRUPOS_MUSCULARES = [
  'PEITO', 'COSTAS', 'OMBRO', 'BICEPS', 'TRICEPS', 'ANTEBRACO',
  'ABDOMEN', 'LOMBAR', 'GLUTEO', 'QUADRICEPS', 'POSTERIOR',
  'PANTURRILHA', 'CORPO_INTEIRO', 'MOBILIDADE', 'CARDIO',
] as const;

export type GrupoMuscular = (typeof GRUPOS_MUSCULARES)[number];

export async function listarExercicios(
  client: TenantClient,
  filtros: { busca?: string | undefined; grupo?: string | undefined; incluirInativos?: boolean },
): Promise<Exercicio[]> {
  const valores: unknown[] = [];
  const condicoes: string[] = [];

  if (filtros.incluirInativos !== true) condicoes.push('e.is_active');

  if (filtros.grupo !== undefined) {
    valores.push(filtros.grupo);
    condicoes.push(`e.muscle_group = $${valores.length}::muscle_group`);
  }

  if (filtros.busca !== undefined && filtros.busca !== '') {
    /* Acento não pode atrapalhar: quem digita "triceps" precisa achar
       "Tríceps". `unaccent` exigiria extensão; `translate` resolve para
       o alfabeto que importa aqui e roda em qualquer instalação. */
    valores.push(`%${filtros.busca}%`);
    condicoes.push(
      `translate(lower(e.name), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')
         LIKE translate(lower($${valores.length}), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')`,
    );
  }

  const where = condicoes.length === 0 ? 'TRUE' : condicoes.join(' AND ');

  const { rows } = await client.query<{
    id: string;
    name: string;
    muscle_group: string;
    equipment: string | null;
    instructions: string | null;
    video_url: string | null;
    is_active: boolean;
  }>(
    `SELECT e.id, e.name, e.muscle_group, e.equipment, e.instructions,
            e.video_url, e.is_active
       FROM exercises e
      WHERE ${where}
      ORDER BY e.muscle_group, e.name
      LIMIT 500`,
    valores,
  );

  return rows.map(paraExercicio);
}

function paraExercicio(l: {
  id: string;
  name: string;
  muscle_group: string;
  equipment: string | null;
  instructions: string | null;
  video_url: string | null;
  is_active: boolean;
}): Exercicio {
  return {
    id: l.id,
    nome: l.name,
    grupo: l.muscle_group,
    equipamento: l.equipment,
    instrucoes: l.instructions,
    video: l.video_url,
    ativo: l.is_active,
  };
}

export interface DadosExercicio {
  nome: string;
  grupo: GrupoMuscular;
  equipamento?: string | undefined;
  instrucoes?: string | undefined;
  video?: string | undefined;
}

export async function criarExercicio(
  client: TenantClient,
  tenantId: string,
  dados: DadosExercicio,
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO exercises (tenant_id, name, muscle_group, equipment, instructions, video_url)
     VALUES ($1, $2, $3::muscle_group, $4, $5, $6)
     RETURNING id`,
    [
      tenantId,
      dados.nome,
      dados.grupo,
      dados.equipamento ?? null,
      dados.instrucoes ?? null,
      dados.video ?? null,
    ],
  );
  return rows[0]!;
}

/**
 * Desativa em vez de apagar.
 *
 * Um exercício removido continua referenciado por prescrições antigas —
 * a FK é RESTRICT justamente para o banco recusar o apagamento. E
 * prontuário não se reescreve: o treino de março tem que continuar
 * dizendo o que dizia em março.
 */
export async function alternarExercicio(
  client: TenantClient,
  exercicioId: string,
  ativo: boolean,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE exercises SET is_active = $2 WHERE id = $1`,
    [exercicioId, ativo],
  );
  return (rowCount ?? 0) > 0;
}

/* ====================================================================
 * Prescrição
 * ================================================================== */

export interface ItemTreino {
  id: string;
  exercicioId: string;
  exercicio: string;
  grupo: string;
  equipamento: string | null;
  video: string | null;
  dia: string;
  posicao: number;
  series: number | null;
  repeticoes: string | null;
  cargaG: number | null;
  descansoSegundos: number | null;
  observacoes: string | null;
}

export interface Treino {
  id: string;
  nome: string;
  objetivo: string | null;
  status: string;
  inicioEm: string;
  fimEm: string | null;
  observacoes: string | null;
  criadoEm: Date;
  profissional: { id: string; nome: string };
  itens: ItemTreino[];
}

/** Resumo dos treinos do aluno, sem os itens. */
export async function listarTreinos(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
): Promise<Omit<Treino, 'itens'>[]> {
  const valores: unknown[] = [alunoId];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<LinhaTreino>(
    `SELECT w.id, w.name, w.goal, w.status, w.starts_on, w.ends_on,
            w.notes, w.created_at, u.id AS prof_id, u.full_name AS prof_nome
       FROM workout_plans w
       JOIN students s ON s.id = w.student_id
       JOIN users u ON u.id = w.professional_id
      WHERE w.student_id = $1
        AND ${escopo.sql}
      ORDER BY (w.status = 'ACTIVE') DESC, w.created_at DESC
      LIMIT 50`,
    valores,
  );

  return rows.map(paraTreino);
}

interface LinhaTreino {
  id: string;
  name: string;
  goal: string | null;
  status: string;
  starts_on: string;
  ends_on: string | null;
  notes: string | null;
  created_at: Date;
  prof_id: string;
  prof_nome: string;
}

function paraTreino(l: LinhaTreino): Omit<Treino, 'itens'> {
  return {
    id: l.id,
    nome: l.name,
    objetivo: l.goal,
    status: l.status,
    inicioEm: l.starts_on,
    fimEm: l.ends_on,
    observacoes: l.notes,
    criadoEm: l.created_at,
    profissional: { id: l.prof_id, nome: l.prof_nome },
  };
}

/** Um treino com os itens. Devolve null se está fora do escopo. */
export async function buscarTreino(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
  treinoId: string,
): Promise<Treino | null> {
  const valores: unknown[] = [treinoId, alunoId];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<LinhaTreino>(
    `SELECT w.id, w.name, w.goal, w.status, w.starts_on, w.ends_on,
            w.notes, w.created_at, u.id AS prof_id, u.full_name AS prof_nome
       FROM workout_plans w
       JOIN students s ON s.id = w.student_id
       JOIN users u ON u.id = w.professional_id
      WHERE w.id = $1
        AND w.student_id = $2
        AND ${escopo.sql}`,
    valores,
  );

  const cabecalho = rows[0];
  if (cabecalho === undefined) return null;

  /* Os itens só são buscados DEPOIS de o cabeçalho passar pelo escopo.
     Consultar itens por plan_id sem essa confirmação seria confiar no id
     que veio da URL. */
  const { rows: itens } = await client.query<{
    id: string;
    exercise_id: string;
    nome: string;
    muscle_group: string;
    equipment: string | null;
    video_url: string | null;
    day_label: string;
    position: number;
    sets: number | null;
    reps: string | null;
    load_g: number | null;
    rest_seconds: number | null;
    notes: string | null;
  }>(
    `SELECT i.id, i.exercise_id, e.name AS nome, e.muscle_group,
            e.equipment, e.video_url,
            i.day_label, i.position, i.sets, i.reps, i.load_g,
            i.rest_seconds, i.notes
       FROM workout_items i
       JOIN exercises e ON e.id = i.exercise_id
      WHERE i.plan_id = $1
      ORDER BY i.day_label, i.position, i.created_at`,
    [treinoId],
  );

  return {
    ...paraTreino(cabecalho),
    itens: itens.map((l) => ({
      id: l.id,
      exercicioId: l.exercise_id,
      exercicio: l.nome,
      grupo: l.muscle_group,
      equipamento: l.equipment,
      video: l.video_url,
      dia: l.day_label,
      posicao: l.position,
      series: l.sets,
      repeticoes: l.reps,
      cargaG: l.load_g,
      descansoSegundos: l.rest_seconds,
      observacoes: l.notes,
    })),
  };
}

export interface DadosTreino {
  nome: string;
  objetivo?: string | undefined;
  inicioEm?: string | undefined;
  fimEm?: string | undefined;
  observacoes?: string | undefined;
}

export async function criarTreino(
  client: TenantClient,
  scope: AccessScope,
  tenantId: string,
  alunoId: string,
  profissionalId: string,
  dados: DadosTreino,
): Promise<{ id: string } | null> {
  const valores: unknown[] = [
    tenantId,
    profissionalId,
    dados.nome,
    dados.objetivo ?? null,
    dados.inicioEm ?? null,
    dados.fimEm ?? null,
    dados.observacoes ?? null,
    alunoId,
  ];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO workout_plans (
        tenant_id, student_id, professional_id, name, goal,
        starts_on, ends_on, notes)
     SELECT $1, s.id, $2, $3, $4,
            COALESCE($5::date, CURRENT_DATE), $6::date, $7
       FROM students s
      WHERE s.id = $8
        AND ${escopo.sql}
     RETURNING id`,
    valores,
  );

  return rows[0] ?? null;
}

export interface DadosItem {
  exercicioId: string;
  dia?: string | undefined;
  posicao?: number | undefined;
  series?: number | undefined;
  repeticoes?: string | undefined;
  cargaG?: number | undefined;
  descansoSegundos?: number | undefined;
  observacoes?: string | undefined;
}

/**
 * Acrescenta um exercício ao treino.
 *
 * O INSERT confere DUAS coisas na mesma instrução: que o treino é de um
 * aluno no escopo, e que o exercício existe nesta empresa. A segunda
 * parece redundante — a RLS já filtra — mas sem ela um exercise_id de
 * outra empresa viraria erro de chave estrangeira, e um 500 distinguível
 * de um 404 conta ao atacante que o id existe em algum lugar.
 */
export async function adicionarItem(
  client: TenantClient,
  scope: AccessScope,
  tenantId: string,
  alunoId: string,
  treinoId: string,
  dados: DadosItem,
): Promise<{ id: string } | null> {
  const valores: unknown[] = [
    tenantId,
    treinoId,
    dados.exercicioId,
    dados.dia ?? 'A',
    dados.posicao ?? 0,
    dados.series ?? null,
    dados.repeticoes ?? null,
    dados.cargaG ?? null,
    dados.descansoSegundos ?? null,
    dados.observacoes ?? null,
    alunoId,
  ];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO workout_items (
        tenant_id, plan_id, exercise_id, day_label, position,
        sets, reps, load_g, rest_seconds, notes)
     SELECT $1, w.id, e.id, $4, $5, $6, $7, $8, $9, $10
       FROM workout_plans w
       JOIN students s ON s.id = w.student_id
       JOIN exercises e ON e.id = $3
      WHERE w.id = $2
        AND w.student_id = $11
        AND ${escopo.sql}
     RETURNING id`,
    valores,
  );

  return rows[0] ?? null;
}

export async function removerItem(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
  treinoId: string,
  itemId: string,
): Promise<boolean> {
  const valores: unknown[] = [itemId, treinoId, alunoId];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rowCount } = await client.query(
    `DELETE FROM workout_items i
      USING workout_plans w, students s
      WHERE i.id = $1
        AND i.plan_id = $2
        AND w.id = i.plan_id
        AND s.id = w.student_id
        AND w.student_id = $3
        AND ${escopo.sql}`,
    valores,
  );

  return (rowCount ?? 0) > 0;
}

export type ResultadoAtivacao = 'ok' | 'inexistente' | 'sem-itens';

/**
 * Publica o treino para o aluno.
 *
 * Dois cuidados que a tela sozinha não garante:
 *
 * 1. TREINO VAZIO NÃO É ATIVADO. O aluno abriria o app e veria um plano
 *    sem exercício nenhum, que é pior do que não ter treino: parece
 *    defeito do sistema, e ele liga para a recepção.
 *
 * 2. O ANTERIOR É ARQUIVADO NA MESMA TRANSAÇÃO. O índice parcial
 *    `idx_workout_um_ativo` recusaria dois ativos, então sem arquivar
 *    antes a ativação simplesmente falharia — e a mensagem seria uma
 *    violação de unicidade, que não diz nada a quem está no balcão.
 */
export async function ativarTreino(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
  treinoId: string,
): Promise<ResultadoAtivacao> {
  const valores: unknown[] = [treinoId, alunoId];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{ itens: string }>(
    `SELECT (SELECT count(*) FROM workout_items i WHERE i.plan_id = w.id) AS itens
       FROM workout_plans w
       JOIN students s ON s.id = w.student_id
      WHERE w.id = $1
        AND w.student_id = $2
        AND ${escopo.sql}`,
    valores,
  );

  const encontrado = rows[0];
  if (encontrado === undefined) return 'inexistente';
  if (Number(encontrado.itens) === 0) return 'sem-itens';

  await client.query(
    `UPDATE workout_plans
        SET status = 'ARCHIVED'
      WHERE student_id = $1
        AND status = 'ACTIVE'
        AND id <> $2`,
    [alunoId, treinoId],
  );

  await client.query(`UPDATE workout_plans SET status = 'ACTIVE' WHERE id = $1`, [treinoId]);

  return 'ok';
}
