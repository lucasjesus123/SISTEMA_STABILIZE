import type { TenantClient } from '../../db/pool.js';
import { type AccessScope, studentScopeSql } from '../../auth/scope.js';

/**
 * Anexos do prontuário.
 *
 * Vale o mesmo do resto do prontuário: nada é alcançado sem passar pelo
 * ALUNO, e o escopo é aplicado na junção com `students`. Um anexo não
 * pertence a quem o subiu — pertence ao prontuário do aluno.
 */

export interface Anexo {
  id: string;
  nome: string;
  tipo: string;
  tamanhoBytes: number;
  categoria: string | null;
  descricao: string | null;
  /** A data do DOCUMENTO, que raramente é a do envio. */
  dataDoDocumento: string | null;
  criadoEm: Date;
  enviadoPor: string | null;
  /** Última pessoa a mexer na descrição. NULL = nunca editado. */
  editadoPor: string | null;
  editadoEm: Date | null;
  enviadoPeloAluno: boolean;
}

export async function listarAnexos(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
): Promise<Anexo[]> {
  const valores: unknown[] = [alunoId];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{
    id: string;
    original_name: string;
    mime_type: string;
    size_bytes: string;
    category: string | null;
    description: string | null;
    document_date: string | null;
    created_at: Date;
    autor: string | null;
    editor: string | null;
    editado_em: Date | null;
    enviado_pelo_aluno: boolean;
  }>(
    `SELECT a.id, a.original_name, a.mime_type, a.size_bytes,
            a.category, a.description, a.document_date::text AS document_date,
            a.created_at, a.editado_em, a.enviado_pelo_aluno,
            u.full_name AS autor,
            e.full_name AS editor
       FROM attachments a
       JOIN students s ON s.id = a.student_id
       LEFT JOIN users u ON u.id = a.uploaded_by
       LEFT JOIN users e ON e.id = a.editado_por
      WHERE a.student_id = $1
        AND a.deleted_at IS NULL
        AND ${escopo.sql}
      /* PELA DATA DO DOCUMENTO quando ela existe, e só então pela do
         envio. Um exame de janeiro digitalizado em julho pertence a
         janeiro na leitura do prontuário — ordenar pelo envio embaralha
         a linha do tempo clínica. */
      ORDER BY COALESCE(a.document_date, a.created_at::date) DESC, a.created_at DESC
      LIMIT 200`,
    valores,
  );

  return rows.map((l) => ({
    id: l.id,
    nome: l.original_name,
    tipo: l.mime_type,
    // bigint chega como string no driver; Number aqui é seguro porque o
    // tamanho é limitado a poucos MB muito antes de chegar ao banco.
    tamanhoBytes: Number(l.size_bytes),
    categoria: l.category,
    descricao: l.description,
    dataDoDocumento: l.document_date,
    criadoEm: l.created_at,
    enviadoPor: l.autor,
    editadoPor: l.editor,
    editadoEm: l.editado_em,
    enviadoPeloAluno: l.enviado_pelo_aluno,
  }));
}

/**
 * Edita o que descreve o anexo — nunca o arquivo.
 *
 * O ARQUIVO É IMUTÁVEL de propósito. Ele tem checksum gravado e é peça
 * de prontuário: trocar os bytes por baixo de um registro que já foi
 * lido e auditado apagaria a prova do que estava lá. Corrigir um exame
 * errado é enviar outro e apagar o primeiro, e as duas ações ficam no
 * log — a edição em cima do mesmo id não ficaria.
 */
export async function editarAnexo(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
  anexoId: string,
  dados: { descricao: string | null; categoria: string | null; dataDoDocumento: string | null },
  editorId: string,
): Promise<boolean> {
  const valores: unknown[] = [anexoId, alunoId];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);
  valores.push(dados.descricao, dados.categoria, dados.dataDoDocumento, editorId);
  const base = valores.length;

  const { rowCount } = await client.query(
    `UPDATE attachments a
        SET description   = $${base - 3},
            category      = $${base - 2},
            document_date = $${base - 1}::date,
            editado_por   = $${base},
            editado_em    = now()
       FROM students s
      WHERE a.id = $1
        AND a.student_id = $2
        AND s.id = a.student_id
        AND a.deleted_at IS NULL
        AND ${escopo.sql}`,
    valores,
  );
  return (rowCount ?? 0) > 0;
}

export interface NovoAnexo {
  chave: string;
  nomeOriginal: string;
  tipo: string;
  tamanhoBytes: number;
  checksum: string;
  categoria?: string | undefined;
  descricao?: string | undefined;
}

/**
 * Registra o anexo já gravado em disco.
 *
 * A verificação de escopo é feita na MESMA instrução do INSERT, via
 * `SELECT ... WHERE escopo`, pelo mesmo motivo da anamnese: um SELECT
 * separado antes do INSERT abre uma janela entre "posso" e "gravei".
 */
export async function registrarAnexo(
  client: TenantClient,
  scope: AccessScope,
  tenantId: string,
  alunoId: string,
  autorId: string,
  dados: NovoAnexo,
): Promise<{ id: string } | null> {
  const valores: unknown[] = [
    tenantId,
    dados.chave,
    dados.nomeOriginal,
    dados.tipo,
    dados.tamanhoBytes,
    dados.checksum,
    dados.categoria ?? null,
    dados.descricao ?? null,
    autorId,
    alunoId,
  ];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO attachments (
        tenant_id, student_id, storage_key, original_name, mime_type,
        size_bytes, checksum_sha256, category, description, uploaded_by)
     SELECT $1, s.id, $2, $3, $4, $5, $6, $7, $8, $9
       FROM students s
      WHERE s.id = $10
        AND ${escopo.sql}
     RETURNING id`,
    valores,
  );

  return rows[0] ?? null;
}

export interface AnexoParaLeitura {
  chave: string;
  nome: string;
  tipo: string;
  tamanhoBytes: number;
  alunoId: string;
}

/** Localiza um anexo para download, respeitando o escopo do aluno. */
export async function anexoParaLeitura(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
  anexoId: string,
): Promise<AnexoParaLeitura | null> {
  const valores: unknown[] = [anexoId, alunoId];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{
    storage_key: string;
    original_name: string;
    mime_type: string;
    size_bytes: string;
    student_id: string;
  }>(
    `SELECT a.storage_key, a.original_name, a.mime_type, a.size_bytes, a.student_id
       FROM attachments a
       JOIN students s ON s.id = a.student_id
      WHERE a.id = $1
        AND a.student_id = $2
        AND a.deleted_at IS NULL
        AND ${escopo.sql}`,
    valores,
  );

  const l = rows[0];
  if (l === undefined) return null;
  return {
    chave: l.storage_key,
    nome: l.original_name,
    tipo: l.mime_type,
    tamanhoBytes: Number(l.size_bytes),
    alunoId: l.student_id,
  };
}

/**
 * Marca como excluído e devolve a chave, para que quem chamou apague os
 * bytes.
 *
 * A linha permanece — com quem apagou e quando — porque o registro de
 * que o arquivo existiu é auditoria. O conteúdo é que vai embora.
 */
export async function excluirAnexo(
  client: TenantClient,
  scope: AccessScope,
  alunoId: string,
  anexoId: string,
): Promise<{ chave: string; nome: string } | null> {
  const valores: unknown[] = [anexoId, alunoId];
  const escopo = studentScopeSql(scope, valores.length, 's');
  valores.push(...escopo.values);

  const { rows } = await client.query<{ storage_key: string; original_name: string }>(
    `UPDATE attachments a
        SET deleted_at = now()
      WHERE a.id = $1
        AND a.student_id = $2
        AND a.deleted_at IS NULL
        AND EXISTS (
              SELECT 1 FROM students s
               WHERE s.id = a.student_id
                 AND ${escopo.sql}
            )
     RETURNING a.storage_key, a.original_name`,
    valores,
  );

  const l = rows[0];
  return l === undefined ? null : { chave: l.storage_key, nome: l.original_name };
}
