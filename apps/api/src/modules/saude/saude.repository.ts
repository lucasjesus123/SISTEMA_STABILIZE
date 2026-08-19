import type { TenantClient } from '../../db/pool.js';
import { CHAVES_PARQ, montarTermo } from './termo.js';

/**
 * A triagem de saúde no banco.
 *
 * A CONSULTA DE "SITUAÇÃO" É A QUE MAIS IMPORTA, e é a mais simples: a
 * recepção precisa de uma palavra — válida, vencida, faltando atestado,
 * nunca assinada — e não do questionário. O questionário é dado de
 * saúde; a palavra é o que dá para mostrar no balcão sem expor nada.
 */

export type SituacaoDaTriagem =
  | 'NUNCA_ASSINOU'
  | 'VALIDA'
  | 'VENCIDA'
  | 'AGUARDANDO_ATESTADO';

export interface TriagemResumo {
  situacao: SituacaoDaTriagem;
  assinadaEm: string | null;
  validoAte: string | null;
  precisaLiberacaoMedica: boolean;
  temAtestado: boolean;
  liberadoEm: string | null;
}

interface LinhaDaTriagem {
  id: string;
  assinado_em: Date;
  valido_ate: string;
  precisa_liberacao_medica: boolean;
  atestado_id: string | null;
  liberado_em: Date | null;
  vencida: boolean;
}

function situacaoDe(l: LinhaDaTriagem | undefined): SituacaoDaTriagem {
  if (l === undefined) return 'NUNCA_ASSINOU';
  if (l.vencida) return 'VENCIDA';
  /* PAR-Q com "sim" e sem liberação médica não é triagem válida — é
     triagem que pediu uma coisa e não recebeu. Tratar como válida
     esvaziaria a única pergunta que o questionário faz de verdade. */
  if (l.precisa_liberacao_medica && l.liberado_em === null) return 'AGUARDANDO_ATESTADO';
  return 'VALIDA';
}

/** A triagem mais recente do aluno, resumida. */
export async function situacaoDoAluno(
  client: TenantClient,
  studentId: string,
): Promise<TriagemResumo> {
  const { rows } = await client.query<LinhaDaTriagem>(
    `SELECT h.id, h.assinado_em, h.valido_ate::text AS valido_ate,
            h.precisa_liberacao_medica, h.atestado_id, h.liberado_em,
            (h.valido_ate < (now() AT TIME ZONE t.timezone)::date) AS vencida
       FROM health_screenings h
       JOIN tenants t ON t.id = h.tenant_id
      WHERE h.student_id = $1
      ORDER BY h.assinado_em DESC
      LIMIT 1`,
    [studentId],
  );
  const l = rows[0];

  return {
    situacao: situacaoDe(l),
    assinadaEm: l?.assinado_em.toISOString() ?? null,
    validoAte: l?.valido_ate ?? null,
    precisaLiberacaoMedica: l?.precisa_liberacao_medica ?? false,
    temAtestado: l?.atestado_id !== null && l?.atestado_id !== undefined,
    liberadoEm: l?.liberado_em?.toISOString() ?? null,
  };
}

export interface TriagemCompleta extends TriagemResumo {
  id: string;
  respostas: Record<string, boolean>;
  observacoes: string | null;
  termoVersao: string;
  termoTexto: string;
  assinadoNome: string;
  assinadoPeloAluno: boolean;
}

/** O histórico inteiro — para a ficha do aluno. */
export async function historico(
  client: TenantClient,
  studentId: string,
): Promise<TriagemCompleta[]> {
  const { rows } = await client.query<
    LinhaDaTriagem & {
      respostas: Record<string, boolean>;
      observacoes: string | null;
      termo_versao: string;
      termo_texto: string;
      assinado_nome: string;
      assinado_pelo_aluno: boolean;
    }
  >(
    `SELECT h.id, h.assinado_em, h.valido_ate::text AS valido_ate,
            h.precisa_liberacao_medica, h.atestado_id, h.liberado_em,
            (h.valido_ate < (now() AT TIME ZONE t.timezone)::date) AS vencida,
            h.respostas, h.observacoes, h.termo_versao, h.termo_texto,
            h.assinado_nome, h.assinado_pelo_aluno
       FROM health_screenings h
       JOIN tenants t ON t.id = h.tenant_id
      WHERE h.student_id = $1
      ORDER BY h.assinado_em DESC`,
    [studentId],
  );

  return rows.map((l) => ({
    id: l.id,
    situacao: situacaoDe(l),
    assinadaEm: l.assinado_em.toISOString(),
    validoAte: l.valido_ate,
    precisaLiberacaoMedica: l.precisa_liberacao_medica,
    temAtestado: l.atestado_id !== null,
    liberadoEm: l.liberado_em?.toISOString() ?? null,
    respostas: l.respostas,
    observacoes: l.observacoes,
    termoVersao: l.termo_versao,
    termoTexto: l.termo_texto,
    assinadoNome: l.assinado_nome,
    assinadoPeloAluno: l.assinado_pelo_aluno,
  }));
}

/** O termo que a academia usa hoje, com o nome dela já dentro. */
export async function termoVigente(
  client: TenantClient,
): Promise<{ versao: string; texto: string; academia: string; validadeDias: number }> {
  const { rows } = await client.query<{
    versao: string;
    modelo: string | null;
    academia: string;
    dias: number;
  }>(
    `SELECT termo_versao AS versao, termo_texto AS modelo, name AS academia,
            triagem_validade_dias AS dias
       FROM tenants WHERE id = current_tenant_id()`,
  );
  const t = rows[0];
  return {
    versao: t?.versao ?? 'v1',
    texto: montarTermo(t?.modelo ?? null, t?.academia ?? 'a academia'),
    academia: t?.academia ?? '',
    validadeDias: t?.dias ?? 365,
  };
}

export interface AssinaturaRecebida {
  respostas: Record<string, boolean>;
  observacoes: string | null;
  assinadoNome: string;
  assinadoPeloAluno: boolean;
  ip: string | null;
  agente: string | null;
  registradoPor: string | null;
}

export class RespostaFaltandoError extends Error {
  readonly faltando: string[];
  constructor(faltando: string[]) {
    super(`Faltam respostas: ${faltando.join(', ')}`);
    this.name = 'RespostaFaltandoError';
    this.faltando = faltando;
  }
}

/**
 * Grava a assinatura.
 *
 * TODAS AS PERGUNTAS SÃO OBRIGATÓRIAS, e a checagem é aqui e não só na
 * tela. Uma pergunta em branco vira `undefined` no jsonb, e a coluna
 * gerada só enxerga `true` — o que faria uma pergunta não respondida
 * contar como "não". Num questionário cujo propósito inteiro é detectar
 * o "sim", pular uma pergunta não pode ser o mesmo que negar.
 *
 * O TEXTO DO TERMO É COPIADO PARA DENTRO DA LINHA no momento da
 * assinatura. É a razão de esta função ler o termo vigente em vez de
 * receber um id.
 */
export async function assinar(
  client: TenantClient,
  tenantId: string,
  studentId: string,
  dados: AssinaturaRecebida,
): Promise<{ id: string; precisaLiberacaoMedica: boolean }> {
  const faltando = [...CHAVES_PARQ].filter(
    (chave) => typeof dados.respostas[chave] !== 'boolean',
  );
  if (faltando.length > 0) throw new RespostaFaltandoError(faltando);

  /* Só as chaves do PAR-Q entram. Sem este filtro, um cliente qualquer
     grava o que quiser dentro do jsonb de um registro de saúde. */
  const limpas: Record<string, boolean> = {};
  for (const chave of CHAVES_PARQ) limpas[chave] = dados.respostas[chave] === true;

  const termo = await termoVigente(client);

  const { rows } = await client.query<{ id: string; precisa_liberacao_medica: boolean }>(
    `INSERT INTO health_screenings
       (tenant_id, student_id, respostas, observacoes,
        termo_versao, termo_texto, assinado_nome, assinado_ip, assinado_agente,
        assinado_pelo_aluno, registrado_por, valido_ate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             /* Validade zero significa "nunca vence" — e "nunca" aqui é
                uma data absurdamente distante, e não NULL: NULL obrigaria
                toda consulta de vencimento a tratar o caso especial, e é
                nessas consultas que o erro se esconde. */
             CASE WHEN $12::int = 0 THEN DATE '9999-12-31'
                  ELSE (now() AT TIME ZONE (SELECT timezone FROM tenants WHERE id = $1))::date
                       + $12::int
             END)
     RETURNING id, precisa_liberacao_medica`,
    [
      tenantId,
      studentId,
      JSON.stringify(limpas),
      dados.observacoes,
      termo.versao,
      termo.texto,
      dados.assinadoNome,
      dados.ip,
      dados.agente?.slice(0, 500) ?? null,
      dados.assinadoPeloAluno,
      dados.registradoPor,
      termo.validadeDias,
    ],
  );

  const r = rows[0]!;
  return { id: r.id, precisaLiberacaoMedica: r.precisa_liberacao_medica };
}

/**
 * Registra a liberação médica.
 *
 * SÓ LIBERA QUEM PRECISAVA. Marcar como liberada uma triagem que não
 * pediu atestado esconde o fato de que ninguém examinou nada — e depois
 * ninguém consegue distinguir "não precisava" de "alguém clicou".
 */
export async function liberar(
  client: TenantClient,
  triagemId: string,
  usuarioId: string,
  atestadoId: string | null,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE health_screenings
        SET liberado_em = now(), liberado_por = $2, atestado_id = COALESCE($3, atestado_id)
      WHERE id = $1 AND precisa_liberacao_medica AND liberado_em IS NULL`,
    [triagemId, usuarioId, atestadoId],
  );
  return (rowCount ?? 0) > 0;
}

/** Quem está sem triagem válida — a lista que a academia precisa correr atrás. */
export async function pendentes(
  client: TenantClient,
): Promise<{ id: string; nome: string; codigo: string | null; situacao: SituacaoDaTriagem }[]> {
  const { rows } = await client.query<{
    id: string;
    nome: string;
    codigo: string | null;
    situacao: SituacaoDaTriagem;
  }>(
    `WITH hoje AS (
       SELECT (now() AT TIME ZONE t.timezone)::date AS d
         FROM tenants t WHERE t.id = current_tenant_id()
     ),
     ultima AS (
       SELECT DISTINCT ON (student_id)
              student_id, valido_ate, precisa_liberacao_medica, liberado_em
         FROM health_screenings
        ORDER BY student_id, assinado_em DESC
     )
     SELECT s.id, s.full_name AS nome, s.codigo::text AS codigo,
            CASE
              WHEN u.student_id IS NULL THEN 'NUNCA_ASSINOU'
              WHEN u.valido_ate < (SELECT d FROM hoje) THEN 'VENCIDA'
              ELSE 'AGUARDANDO_ATESTADO'
            END AS situacao
       FROM students s
       LEFT JOIN ultima u ON u.student_id = s.id
      WHERE s.status = 'ACTIVE'
        AND (u.student_id IS NULL
             OR u.valido_ate < (SELECT d FROM hoje)
             OR (u.precisa_liberacao_medica AND u.liberado_em IS NULL))
      ORDER BY s.full_name`,
  );
  return rows;
}
