import type { TenantClient } from '../../db/pool.js';
import { type AccessScope, studentScopeSql } from '../../auth/scope.js';

/**
 * Avaliação física.
 *
 * TODO INTEIRO ATRAVESSA ESTA CAMADA SEM VIRAR DECIMAL. Peso em gramas,
 * circunferência em milímetros, gordura em décimos de ponto. Converter
 * para centímetro aqui devolveria `0.30000000000000004` na primeira
 * subtração de "quanto ele perdeu de cintura" — é a mesma disciplina que
 * o dinheiro tem no resto do sistema, e pelo mesmo motivo. Quem divide
 * por dez é a tela, no último instante.
 *
 * O ESCOPO É OBRIGATÓRIO em toda função, como no repositório de alunos:
 * sem sobrecarga sem escopo e sem valor padrão, uma consulta nova que
 * esqueça o recorte não compila. E ele é aplicado NA CONSULTA, não
 * depois — filtrar em memória entregaria a lista inteira a quem lesse a
 * resposta antes do filtro.
 */

/** As colunas de circunferência, na ordem em que a ficha de papel as lê. */
export const CAMPOS_MEDIDA = [
  'busto_mm',
  'peito_mm',
  'ombro_mm',
  'braco_esq_mm',
  'braco_dir_mm',
  'antebraco_esq_mm',
  'antebraco_dir_mm',
  'abdomen_mm',
  'cintura_mm',
  'quadril_mm',
  'culote_mm',
  'coxa_esq_mm',
  'coxa_dir_mm',
  'panturrilha_esq_mm',
  'panturrilha_dir_mm',
] as const;

export type CampoMedida = (typeof CAMPOS_MEDIDA)[number];

export interface Medida {
  id: string;
  data: string;
  profissional: string | null;
  pesoG: number | null;
  alturaCm: number | null;
  gorduraPctX10: number | null;
  observacoes: string | null;
  circunferenciasMm: Record<CampoMedida, number | null>;
}

export interface EntradaMedida {
  data: string;
  pesoG: number | null;
  alturaCm: number | null;
  gorduraPctX10: number | null;
  observacoes: string | null;
  /* `undefined` é aceito além de `null` porque `.partial()` do Zod
     produz campos opcionais, e tratar os dois como "não medido" evita
     um mapeamento inteiro só para trocar um pelo outro. */
  circunferenciasMm: Partial<Record<CampoMedida, number | null | undefined>>;
}

interface Linha {
  id: string;
  measured_on: Date;
  profissional: string | null;
  weight_g: number | null;
  height_cm: number | null;
  gordura_pct_x10: number | null;
  notes: string | null;
  [coluna: string]: unknown;
}

function paraMedida(l: Linha): Medida {
  const circ = {} as Record<CampoMedida, number | null>;
  for (const c of CAMPOS_MEDIDA) circ[c] = (l[c] as number | null) ?? null;
  return {
    id: l.id,
    /* `date` do PostgreSQL chega como Date no fuso local; `toISOString()`
       devolveria o dia anterior para quem está a oeste de Greenwich. */
    data: formatarData(l.measured_on),
    profissional: l.profissional ?? null,
    pesoG: l.weight_g,
    alturaCm: l.height_cm,
    gorduraPctX10: l.gordura_pct_x10,
    observacoes: l.notes,
    circunferenciasMm: circ,
  };
}

function formatarData(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** As avaliações do aluno, da mais recente para a mais antiga. */
export async function listarMedidas(
  client: TenantClient,
  scope: AccessScope,
  studentId: string,
): Promise<Medida[]> {
  const values: unknown[] = [studentId];
  const recorte = studentScopeSql(scope, values.length, 's');
  values.push(...recorte.values);

  const { rows } = await client.query<Linha>(
    `SELECT m.id, m.measured_on, m.weight_g, m.height_cm, m.gordura_pct_x10, m.notes,
            ${CAMPOS_MEDIDA.map((c) => `m.${c}`).join(', ')},
            u.full_name AS profissional
       FROM body_measurements m
       JOIN students s ON s.id = m.student_id
       LEFT JOIN users u ON u.id = m.professional_id
      WHERE m.student_id = $1 AND ${recorte.sql}
      ORDER BY m.measured_on DESC`,
    values,
  );
  return rows.map(paraMedida);
}

/**
 * Grava a avaliação.
 *
 * `ON CONFLICT ... DO UPDATE` porque medir duas vezes no mesmo dia é
 * sempre correção da primeira, não uma segunda avaliação — e a correção
 * deve sobrescrever, não abrir uma coluna nova no comparativo.
 *
 * O INSERT lê de `students` com o escopo aplicado em vez de usar
 * `VALUES`, e isso é o que fecha a janela: sem o aluno alcançável,
 * nenhuma linha é produzida e nada é gravado — a verificação e a escrita
 * acontecem na MESMA instrução, sem intervalo entre uma e outra em que o
 * vínculo pudesse mudar.
 */
export async function gravarMedida(
  client: TenantClient,
  scope: AccessScope,
  tenantId: string,
  studentId: string,
  profissionalId: string,
  dados: EntradaMedida,
): Promise<Medida | null> {
  const values: unknown[] = [
    tenantId,
    studentId,
    profissionalId,
    dados.data,
    dados.pesoG,
    dados.alturaCm,
    dados.gorduraPctX10,
    dados.observacoes,
    ...CAMPOS_MEDIDA.map((c) => dados.circunferenciasMm[c] ?? null),
  ];
  const recorte = studentScopeSql(scope, values.length, 's');
  values.push(...recorte.values);

  const { rows } = await client.query<Linha>(
    `INSERT INTO body_measurements (
       tenant_id, student_id, professional_id, measured_on,
       weight_g, height_cm, gordura_pct_x10, notes,
       ${CAMPOS_MEDIDA.join(', ')}
     )
     SELECT $1, s.id, $3, $4::date, $5, $6, $7, $8,
            ${CAMPOS_MEDIDA.map((_, i) => `$${9 + i}`).join(', ')}
       FROM students s
      WHERE s.id = $2 AND ${recorte.sql}
     ON CONFLICT (tenant_id, student_id, measured_on) DO UPDATE SET
       professional_id = EXCLUDED.professional_id,
       weight_g        = EXCLUDED.weight_g,
       height_cm       = EXCLUDED.height_cm,
       gordura_pct_x10 = EXCLUDED.gordura_pct_x10,
       notes           = EXCLUDED.notes,
       ${CAMPOS_MEDIDA.map((c) => `${c} = EXCLUDED.${c}`).join(',\n       ')}
     RETURNING id, measured_on, weight_g, height_cm, gordura_pct_x10, notes,
               ${CAMPOS_MEDIDA.join(', ')}, NULL::text AS profissional`,
    values,
  );
  const linha = rows[0];
  return linha === undefined ? null : paraMedida(linha);
}

/** Apaga uma avaliação. `false` quando não existe ou está fora do escopo. */
export async function excluirMedida(
  client: TenantClient,
  scope: AccessScope,
  studentId: string,
  medidaId: string,
): Promise<boolean> {
  const values: unknown[] = [studentId, medidaId];
  const recorte = studentScopeSql(scope, values.length, 's');
  values.push(...recorte.values);

  const { rowCount } = await client.query(
    `DELETE FROM body_measurements m
       USING students s
      WHERE m.student_id = s.id
        AND m.student_id = $1
        AND m.id = $2
        AND ${recorte.sql}`,
    values,
  );
  return (rowCount ?? 0) > 0;
}
