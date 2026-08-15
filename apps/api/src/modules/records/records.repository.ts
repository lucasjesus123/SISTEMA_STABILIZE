import type { TenantClient } from '../../db/pool.js';
import { type AccessScope, studentScopeSql } from '../../auth/scope.js';

/**
 * Prontuário: anamnese e evolução.
 *
 * TRÊS REGRAS QUE VALEM PARA TUDO NESTE ARQUIVO
 *
 * 1. NADA É LIDO SEM PASSAR PELO ALUNO. Toda consulta junta com
 *    `students` e aplica o escopo lá, em vez de filtrar por
 *    `professional_id` na própria anamnese ou evolução. A diferença
 *    importa: uma evolução escrita pela Renata num aluno que hoje é do
 *    Marcelo continua sendo do prontuário DAQUELE ALUNO. Quem manda é o
 *    vínculo vigente com o aluno, não a autoria da linha. Filtrar por
 *    autoria daria ao profissional um prontuário furado — ele veria as
 *    próprias anotações de um aluno que já não atende, e não veria as
 *    dos colegas num aluno que hoje é dele.
 *
 * 2. PRONTUÁRIO NÃO SE SOBRESCREVE, SE VERSIONA. Gravar anamnese insere
 *    uma linha nova; a vigente é a mais recente. A anterior fica. Um
 *    registro de saúde onde a versão anterior desaparece não serve para
 *    o que prontuário serve: mostrar a evolução do quadro e responder
 *    "o que se sabia na data em que se decidiu aquilo".
 *
 * 3. LEITURA TAMBÉM É AUDITADA — nas rotas, não aqui. Dado de saúde é
 *    categoria sensível (LGPD art. 5º, II) e o incidente provável não é
 *    alguém alterar um prontuário: é alguém olhar o prontuário de quem
 *    não devia.
 */

/* ====================================================================
 * Anamnese
 * ================================================================== */

export interface Anamnese {
  id: string;
  queixaPrincipal: string | null;
  historicoClinico: string | null;
  medicamentos: string | null;
  cirurgias: string | null;
  lesoes: string | null;
  objetivos: string | null;
  contraindicacoes: string | null;
  alturaCm: number | null;
  pesoG: number | null;
  respostas: Record<string, unknown>;
  realizadaEm: Date;
  criadaEm: Date;
  profissional: { id: string; nome: string } | null;
}

export interface DadosAnamnese {
  queixaPrincipal?: string | undefined;
  historicoClinico?: string | undefined;
  medicamentos?: string | undefined;
  cirurgias?: string | undefined;
  lesoes?: string | undefined;
  objetivos?: string | undefined;
  contraindicacoes?: string | undefined;
  alturaCm?: number | undefined;
  pesoG?: number | undefined;
  respostas?: Record<string, unknown> | undefined;
}

/**
 * A anamnese vigente do aluno — a versão mais recente.
 *
 * Devolve `null` tanto para "aluno fora do escopo" quanto para "aluno
 * sem anamnese". Quem chama não deve distinguir os dois casos na
 * resposta HTTP: a diferença entre 404 e "existe mas está vazio" já é
 * informação sobre um aluno que talvez não seja seu.
 */
export async function anamneseVigente(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
): Promise<Anamnese | null> {
  const escopo = studentScopeSql(scope, 1, 's');

  const { rows } = await client.query<{
    id: string;
    chief_complaint: string | null;
    clinical_history: string | null;
    medications: string | null;
    surgeries: string | null;
    injuries: string | null;
    goals: string | null;
    contraindications: string | null;
    height_cm: number | null;
    weight_g: number | null;
    answers: Record<string, unknown>;
    performed_at: Date;
    created_at: Date;
    prof_id: string | null;
    prof_nome: string | null;
  }>(
    `SELECT a.id, a.chief_complaint, a.clinical_history, a.medications,
            a.surgeries, a.injuries, a.goals, a.contraindications,
            a.height_cm, a.weight_g, a.answers, a.performed_at, a.created_at,
            p.id AS prof_id, p.full_name AS prof_nome
       FROM anamneses a
       JOIN students s ON s.id = a.student_id
       LEFT JOIN users p ON p.id = a.professional_id
      WHERE a.student_id = $1
        AND ${escopo.sql}
      ORDER BY a.performed_at DESC, a.created_at DESC
      LIMIT 1`,
    [alunoId, ...escopo.values],
  );

  const linha = rows[0];
  if (linha === undefined) return null;

  return {
    id: linha.id,
    queixaPrincipal: linha.chief_complaint,
    historicoClinico: linha.clinical_history,
    medicamentos: linha.medications,
    cirurgias: linha.surgeries,
    lesoes: linha.injuries,
    objetivos: linha.goals,
    contraindicacoes: linha.contraindications,
    alturaCm: linha.height_cm,
    pesoG: linha.weight_g,
    respostas: linha.answers,
    realizadaEm: linha.performed_at,
    criadaEm: linha.created_at,
    profissional:
      linha.prof_id === null ? null : { id: linha.prof_id, nome: linha.prof_nome ?? '—' },
  };
}

/** As versões anteriores, para quem precisa ver como o quadro mudou. */
export async function historicoAnamnese(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
): Promise<{ id: string; realizadaEm: Date; profissional: string | null }[]> {
  const escopo = studentScopeSql(scope, 1, 's');

  const { rows } = await client.query<{
    id: string;
    performed_at: Date;
    prof_nome: string | null;
  }>(
    `SELECT a.id, a.performed_at, p.full_name AS prof_nome
       FROM anamneses a
       JOIN students s ON s.id = a.student_id
       LEFT JOIN users p ON p.id = a.professional_id
      WHERE a.student_id = $1
        AND ${escopo.sql}
      ORDER BY a.performed_at DESC, a.created_at DESC
      LIMIT 50`,
    [alunoId, ...escopo.values],
  );

  return rows.map((l) => ({
    id: l.id,
    realizadaEm: l.performed_at,
    profissional: l.prof_nome,
  }));
}

/**
 * Grava uma versão nova da anamnese.
 *
 * Devolve `null` se o aluno está fora do escopo — a verificação é feita
 * na mesma instrução do INSERT, com `SELECT ... WHERE escopo`, para que
 * não exista janela entre "conferi que posso" e "gravei". Um INSERT
 * precedido de um SELECT separado é uma corrida esperando acontecer:
 * basta o vínculo do profissional ser removido entre os dois.
 */
export async function gravarAnamnese(
  client: TenantClient,
  scope: AccessScope,
  tenantId: string,
  alunoId: string,
  dados: DadosAnamnese,
  autorId: string,
): Promise<{ id: string } | null> {
  const valores: unknown[] = [
    tenantId,
    autorId,
    vazioViraNulo(dados.queixaPrincipal),
    vazioViraNulo(dados.historicoClinico),
    vazioViraNulo(dados.medicamentos),
    vazioViraNulo(dados.cirurgias),
    vazioViraNulo(dados.lesoes),
    vazioViraNulo(dados.objetivos),
    vazioViraNulo(dados.contraindicacoes),
    dados.alturaCm ?? null,
    dados.pesoG ?? null,
    JSON.stringify(dados.respostas ?? {}),
    alunoId,
  ];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO anamneses (
        tenant_id, student_id, professional_id,
        chief_complaint, clinical_history, medications, surgeries,
        injuries, goals, contraindications, height_cm, weight_g, answers,
        created_by)
     SELECT $1, s.id, $2,
            $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
            $2
       FROM students s
      WHERE s.id = $13
        AND ${escopo.sql}
     RETURNING id`,
    valores,
  );

  return rows[0] ?? null;
}

/* ====================================================================
 * Evolução
 * ================================================================== */

export interface Evolucao {
  id: string;
  dataSessao: string;
  conteudo: string;
  escalaDor: number | null;
  medidas: Record<string, unknown>;
  criadaEm: Date;
  atualizadaEm: Date;
  profissional: { id: string; nome: string };
  /** Se este usuário ainda pode editar — ver JANELA_EDICAO_HORAS. */
  editavel: boolean;
}

/**
 * Depois desta janela, a evolução vira imutável mesmo para quem a
 * escreveu.
 *
 * Não é capricho: registro clínico que pode ser reescrito meses depois
 * não vale como registro. A janela existe para corrigir o erro de digitação
 * do mesmo dia, não para reescrever a história do atendimento. Quem
 * precisa retificar depois disso escreve uma evolução nova referenciando
 * a anterior — que é como se faz em papel, e deixa rastro.
 */
const JANELA_EDICAO_HORAS = 24;

export async function listarEvolucoes(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
  usuarioId: string,
  limite = 50,
  deslocamento = 0,
): Promise<{ itens: Evolucao[]; total: number }> {
  /* Os valores são montados em ordem para que o índice de cada
     parâmetro saia da posição real no array, e não de um número escrito
     à mão — contar $1..$14 de cabeça é como se troca o id do aluno pelo
     do profissional numa cláusula de escopo. */
  const valores: unknown[] = [alunoId, usuarioId, String(JANELA_EDICAO_HORAS)];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);
  valores.push(Math.min(Math.max(limite, 1), 100), Math.max(deslocamento, 0));
  const pLimite = `$${valores.length - 1}`;
  const pDeslocamento = `$${valores.length}`;

  const { rows } = await client.query<{
    id: string;
    session_date: string;
    content: string;
    pain_scale: number | null;
    measurements: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
    prof_id: string;
    prof_nome: string;
    editavel: boolean;
    total: string;
  }>(
    `SELECT e.id, e.session_date, e.content, e.pain_scale, e.measurements,
            e.created_at, e.updated_at,
            p.id AS prof_id, p.full_name AS prof_nome,
            (e.professional_id = $2
             AND e.created_at > now() - ($3 || ' hours')::interval) AS editavel,
            count(*) OVER () AS total
       FROM evolutions e
       JOIN students s ON s.id = e.student_id
       JOIN users p ON p.id = e.professional_id
      WHERE e.student_id = $1
        AND ${escopo.sql}
      ORDER BY e.session_date DESC, e.created_at DESC
      LIMIT ${pLimite} OFFSET ${pDeslocamento}`,
    valores,
  );

  return {
    itens: rows.map((l) => ({
      id: l.id,
      dataSessao: l.session_date,
      conteudo: l.content,
      escalaDor: l.pain_scale,
      medidas: l.measurements,
      criadaEm: l.created_at,
      atualizadaEm: l.updated_at,
      profissional: { id: l.prof_id, nome: l.prof_nome },
      editavel: l.editavel,
    })),
    total: rows[0] === undefined ? 0 : Number(rows[0].total),
  };
}

export interface DadosEvolucao {
  dataSessao: string;
  conteudo: string;
  escalaDor?: number | undefined;
  medidas?: Record<string, unknown> | undefined;
}

/**
 * Cria uma evolução.
 *
 * `profissionalId` vem do token de quem está escrevendo, NUNCA do corpo
 * da requisição. Deixar o cliente escolher o autor permitiria assinar
 * atendimento no nome de um colega — e evolução assinada é o que
 * sustenta a comissão e a responsabilidade técnica.
 */
export async function criarEvolucao(
  client: TenantClient,
  scope: AccessScope,
  tenantId: string,
  alunoId: string,
  profissionalId: string,
  dados: DadosEvolucao,
): Promise<{ id: string } | null> {
  const valores: unknown[] = [
    tenantId,
    profissionalId,
    dados.dataSessao,
    dados.conteudo,
    dados.escalaDor ?? null,
    JSON.stringify(dados.medidas ?? {}),
    alunoId,
  ];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO evolutions (
        tenant_id, student_id, professional_id,
        session_date, content, pain_scale, measurements)
     SELECT $1, s.id, $2, $3::date, $4, $5, $6::jsonb
       FROM students s
      WHERE s.id = $7
        AND ${escopo.sql}
     RETURNING id`,
    valores,
  );

  return rows[0] ?? null;
}

export type ResultadoEdicao = 'ok' | 'inexistente' | 'janela-expirada';

/**
 * Edita uma evolução dentro da janela, e só pelo autor.
 *
 * Os dois motivos de recusa são separados de propósito. "Não existe" e
 * "existe, é sua, mas passou da janela" pedem respostas diferentes na
 * tela: a segunda tem uma saída — escrever uma retificação — e o
 * atendente precisa saber disso em vez de achar que perdeu o texto.
 * Note que a distinção só é revelada para quem JÁ passou pelo escopo do
 * aluno; para os demais, tudo é `inexistente`.
 */
export async function editarEvolucao(
  client: TenantClient,
  scope: AccessScope,
  evolucaoId: string,
  autorId: string,
  dados: Pick<DadosEvolucao, 'conteudo'> & { escalaDor?: number | undefined },
): Promise<ResultadoEdicao> {
  const valores: unknown[] = [evolucaoId, autorId, String(JANELA_EDICAO_HORAS)];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows: existentes } = await client.query<{ no_prazo: boolean }>(
    `SELECT (e.created_at > now() - ($3 || ' hours')::interval) AS no_prazo
       FROM evolutions e
       JOIN students s ON s.id = e.student_id
      WHERE e.id = $1
        AND e.professional_id = $2
        AND ${escopo.sql}`,
    valores,
  );

  const atual = existentes[0];
  if (atual === undefined) return 'inexistente';
  if (!atual.no_prazo) return 'janela-expirada';

  /* Campo ausente no PATCH significa "não mexa", não "apague".
     A primeira versão escrevia `pain_scale = $3` sempre, e corrigir um
     erro de digitação no texto zerava a escala de dor do atendimento —
     perda silenciosa de dado clínico.

     O "mexe ou não mexe" vai como PARÂMETRO, num CASE, em vez de montar
     a cláusula SET por concatenação. Assim a instrução continua estática
     e a convenção do projeto segue valendo: nada além do fragmento de
     escopo entra num template de SQL. */
  await client.query(
    `UPDATE evolutions
        SET content = $2,
            pain_scale = CASE WHEN $3 THEN $4::smallint ELSE pain_scale END
      WHERE id = $1
        AND professional_id = $5
        AND created_at > now() - ($6 || ' hours')::interval`,
    [
      evolucaoId,
      dados.conteudo,
      dados.escalaDor !== undefined,
      dados.escalaDor ?? null,
      autorId,
      String(JANELA_EDICAO_HORAS),
    ],
  );

  return 'ok';
}

/**
 * Campo de texto em branco vira NULL.
 *
 * Sem isto, limpar um campo no formulário gravaria string vazia, e o
 * prontuário passaria a ter "sem medicação" e "" como coisas diferentes
 * que a tela mostra igual.
 */
function vazioViraNulo(v: string | undefined): string | null {
  if (v === undefined) return null;
  const limpo = v.trim();
  return limpo === '' ? null : limpo;
}
