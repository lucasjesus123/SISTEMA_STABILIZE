import { withoutTenantContext } from '../../db/pool.js';

/**
 * Acesso ao painel da plataforma.
 *
 * TUDO AQUI PASSA POR `withoutTenantContext`, e isso é intencionalmente
 * incômodo de escrever. A função é nomeada assim para que cada chamada
 * nova chame atenção em revisão de código: ela abre uma transação SEM o
 * contexto de empresa, onde a RLS devolveria zero linhas em qualquer
 * tabela com policy.
 *
 * O que faz este módulo funcionar apesar disso são as funções
 * `plataforma_*` do banco — SECURITY DEFINER, pertencentes a um papel
 * com BYPASSRLS que ninguém consegue usar para conectar. A conexão da
 * API não alcança `platform_admins`, `platform_sessions`,
 * `platform_audit` nem `platform_settings` diretamente: responde
 * `permission denied`. Só chega até elas por estas funções, e cada uma
 * faz uma coisa só.
 *
 * NENHUMA FUNÇÃO AQUI DEVOLVE DADO DE ALUNO. As contagens devolvem
 * números, que é o que o faturamento precisa e o que não identifica
 * ninguém. Ver o cabeçalho de `014_plataforma_super.sql`.
 */

export interface Empresa {
  id: string;
  nome: string;
  slug: string;
  documento: string | null;
  timezone: string;
  ativa: boolean;
  plano: string | null;
  contatoNome: string | null;
  contatoEmail: string | null;
  contatoWhatsapp: string | null;
  observacoes: string | null;
  testeAte: string | null;
  suspensaEm: string | null;
  suspensaMotivo: string | null;
  criadaEm: string;
  alunos: number;
  alunosAtivos: number;
  usuarios: number;
}

export interface Gestor {
  id: string;
  nome: string;
  email: string;
  papel: string;
  ativo: boolean;
  ultimoAcesso: string | null;
}

interface LinhaEmpresa {
  id: string;
  nome: string;
  slug: string;
  documento: string | null;
  timezone: string;
  ativa: boolean;
  plano: string | null;
  contato_nome: string | null;
  contato_email: string | null;
  contato_whatsapp: string | null;
  observacoes: string | null;
  teste_ate: Date | null;
  suspensa_em: Date | null;
  suspensa_motivo: string | null;
  criada_em: Date;
  alunos: string;
  alunos_ativos: string;
  usuarios: string;
}

/** `date` chega como Date no fuso local; ISO devolveria o dia anterior. */
function dia(d: Date | null): string | null {
  if (d === null) return null;
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dd}`;
}

function paraEmpresa(l: LinhaEmpresa): Empresa {
  return {
    id: l.id,
    nome: l.nome,
    slug: l.slug,
    documento: l.documento,
    timezone: l.timezone,
    ativa: l.ativa,
    plano: l.plano,
    contatoNome: l.contato_nome,
    contatoEmail: l.contato_email,
    contatoWhatsapp: l.contato_whatsapp,
    observacoes: l.observacoes,
    testeAte: dia(l.teste_ate),
    suspensaEm: l.suspensa_em?.toISOString() ?? null,
    suspensaMotivo: l.suspensa_motivo,
    criadaEm: l.criada_em.toISOString(),
    /* `count(*)` do PostgreSQL é bigint e o driver o entrega como
       STRING, para não perder precisão em números maiores que 2^53. São
       contagens de alunos: cabem em number com folga. */
    alunos: Number(l.alunos),
    alunosAtivos: Number(l.alunos_ativos),
    usuarios: Number(l.usuarios),
  };
}

/* --------------------------------------------------------------------
 * Autenticação do operador
 * ------------------------------------------------------------------ */

export interface AdminDaPlataforma {
  id: string;
  passwordHash: string;
  nome: string;
  ativo: boolean;
  bloqueadoAte: Date | null;
  precisaTrocarSenha: boolean;
}

export async function buscarAdmin(email: string): Promise<AdminDaPlataforma | null> {
  return withoutTenantContext('login', async (client) => {
    const { rows } = await client.query<{
      id: string;
      password_hash: string;
      full_name: string;
      is_active: boolean;
      locked_until: Date | null;
      must_change_password: boolean;
    }>('SELECT * FROM plataforma_lookup_admin($1)', [email]);

    const l = rows[0];
    return l === undefined
      ? null
      : {
          id: l.id,
          passwordHash: l.password_hash,
          nome: l.full_name,
          ativo: l.is_active,
          bloqueadoAte: l.locked_until,
          precisaTrocarSenha: l.must_change_password,
        };
  });
}

export async function buscarAdminPorId(id: string): Promise<AdminDaPlataforma | null> {
  return withoutTenantContext('login', async (client) => {
    const { rows } = await client.query<{
      id: string;
      password_hash: string;
      full_name: string;
      is_active: boolean;
      locked_until: Date | null;
      must_change_password: boolean;
    }>('SELECT * FROM plataforma_lookup_admin_por_id($1)', [id]);
    const l = rows[0];
    return l === undefined
      ? null
      : {
          id: l.id,
          passwordHash: l.password_hash,
          nome: l.full_name,
          ativo: l.is_active,
          bloqueadoAte: l.locked_until,
          precisaTrocarSenha: l.must_change_password,
        };
  });
}

export async function registrarTentativa(id: string, sucesso: boolean): Promise<void> {
  await withoutTenantContext('login', (client) =>
    client.query('SELECT plataforma_registrar_tentativa($1, $2)', [id, sucesso]),
  );
}

export async function criarSessao(
  adminId: string,
  hash: string,
  familia: string,
  expira: Date,
  agente: string | null,
  ip: string | null,
): Promise<void> {
  await withoutTenantContext('login', (client) =>
    client.query('SELECT plataforma_criar_sessao($1, $2, $3, $4, $5, $6)', [
      adminId,
      hash,
      familia,
      expira,
      agente,
      ip,
    ]),
  );
}

export interface SessaoPlataforma {
  id: string;
  adminId: string;
  familiaId: string;
  expiraEm: Date;
  revogadaEm: Date | null;
}

export async function buscarSessao(hash: string): Promise<SessaoPlataforma | null> {
  return withoutTenantContext('login', async (client) => {
    const { rows } = await client.query<{
      id: string;
      admin_id: string;
      family_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>('SELECT * FROM plataforma_lookup_sessao($1)', [hash]);
    const l = rows[0];
    return l === undefined
      ? null
      : {
          id: l.id,
          adminId: l.admin_id,
          familiaId: l.family_id,
          expiraEm: l.expires_at,
          revogadaEm: l.revoked_at,
        };
  });
}

export async function revogarFamilia(familia: string): Promise<void> {
  await withoutTenantContext('login', (client) =>
    client.query('SELECT plataforma_revogar_familia($1)', [familia]),
  );
}

export async function trocarSenhaDoAdmin(id: string, hash: string): Promise<void> {
  await withoutTenantContext('login', (client) =>
    client.query('SELECT plataforma_trocar_senha($1, $2)', [id, hash]),
  );
}

/* --------------------------------------------------------------------
 * Empresas
 * ------------------------------------------------------------------ */

export async function listarEmpresas(): Promise<Empresa[]> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<LinhaEmpresa>('SELECT * FROM plataforma_listar_empresas()');
    return rows.map(paraEmpresa);
  });
}

export interface NovaEmpresa {
  nome: string;
  slug: string;
  documento: string | null;
  timezone: string | null;
  plano: string | null;
  contatoNome: string | null;
  contatoEmail: string | null;
  contatoWhatsapp: string | null;
  testeAte: string | null;
  donoNome: string;
  donoEmail: string;
}

export async function criarEmpresa(
  dados: NovaEmpresa,
  hashDaSenha: string,
): Promise<{ empresaId: string; donoId: string }> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{ empresa_id: string; dono_id: string }>(
      'SELECT * FROM plataforma_criar_empresa($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        dados.nome,
        dados.slug,
        dados.documento,
        dados.timezone,
        dados.plano,
        dados.contatoNome,
        dados.contatoEmail,
        dados.contatoWhatsapp,
        dados.testeAte,
        dados.donoNome,
        dados.donoEmail,
        hashDaSenha,
      ],
    );
    const l = rows[0]!;
    return { empresaId: l.empresa_id, donoId: l.dono_id };
  });
}

export async function atualizarEmpresa(
  id: string,
  dados: Omit<NovaEmpresa, 'slug' | 'donoNome' | 'donoEmail'> & { observacoes: string | null },
): Promise<boolean> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{ plataforma_atualizar_empresa: boolean }>(
      'SELECT plataforma_atualizar_empresa($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        id,
        dados.nome,
        dados.documento,
        dados.timezone,
        dados.plano,
        dados.contatoNome,
        dados.contatoEmail,
        dados.contatoWhatsapp,
        dados.observacoes,
        dados.testeAte,
      ],
    );
    return rows[0]?.plataforma_atualizar_empresa === true;
  });
}

export async function definirAtiva(
  id: string,
  ativa: boolean,
  motivo: string | null,
): Promise<boolean> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{ plataforma_definir_ativa: boolean }>(
      'SELECT plataforma_definir_ativa($1, $2, $3)',
      [id, ativa, motivo],
    );
    return rows[0]?.plataforma_definir_ativa === true;
  });
}

/* --------------------------------------------------------------------
 * Gestores de cada empresa
 * ------------------------------------------------------------------ */

export async function listarGestores(empresaId: string): Promise<Gestor[]> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{
      id: string;
      nome: string;
      email: string;
      papel: string;
      ativo: boolean;
      ultimo_acesso: Date | null;
    }>('SELECT * FROM plataforma_listar_gestores($1)', [empresaId]);
    return rows.map((l) => ({
      id: l.id,
      nome: l.nome,
      email: l.email,
      papel: l.papel,
      ativo: l.ativo,
      ultimoAcesso: l.ultimo_acesso?.toISOString() ?? null,
    }));
  });
}

export async function criarGestor(
  empresaId: string,
  nome: string,
  email: string,
  hash: string,
  papel: 'OWNER' | 'ADMIN',
): Promise<string> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{ plataforma_criar_gestor: string }>(
      'SELECT plataforma_criar_gestor($1,$2,$3,$4,$5)',
      [empresaId, nome, email, hash, papel],
    );
    return rows[0]!.plataforma_criar_gestor;
  });
}

export async function redefinirSenhaDoGestor(userId: string, hash: string): Promise<boolean> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{ plataforma_redefinir_senha_gestor: boolean }>(
      'SELECT plataforma_redefinir_senha_gestor($1, $2)',
      [userId, hash],
    );
    return rows[0]?.plataforma_redefinir_senha_gestor === true;
  });
}

export async function ativarGestor(userId: string, ativo: boolean): Promise<boolean> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{ plataforma_ativar_gestor: boolean }>(
      'SELECT plataforma_ativar_gestor($1, $2)',
      [userId, ativo],
    );
    return rows[0]?.plataforma_ativar_gestor === true;
  });
}

/**
 * Edita nome, e-mail e papel de um gestor.
 *
 * Devolve o motivo da recusa em vez de um booleano seco porque as
 * recusas são diferentes entre si e o operador precisa saber qual foi:
 * "não encontrado" é engano de link, "último dono" é uma regra do
 * sistema que ele não pode contornar, e as duas viravam a mesma tela
 * cinza se a função só dissesse "não".
 */
export type RecusaAoEditar = 'papel_invalido' | 'nao_encontrado' | 'ultimo_dono';

export async function editarGestor(
  userId: string,
  nome: string,
  email: string,
  papel: 'OWNER' | 'ADMIN',
): Promise<RecusaAoEditar | null> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{ ok: boolean; motivo: RecusaAoEditar | null }>(
      'SELECT * FROM plataforma_editar_usuario($1,$2,$3,$4)',
      [userId, nome, email, papel],
    );
    const r = rows[0];
    if (r === undefined) return 'nao_encontrado';
    return r.ok ? null : (r.motivo ?? 'nao_encontrado');
  });
}

export interface ResultadoDaExclusao {
  ok: boolean;
  motivo: 'nao_encontrado' | 'confirmacao_errada' | 'precisa_suspender' | null;
  nome: string | null;
  alunos: number;
  usuarios: number;
}

/**
 * Exclui a academia inteira. Ver o comentário da função no 029: a
 * academia precisa estar SUSPENSA e o chamador precisa repetir o slug.
 * As contagens voltam para o registro de auditoria poder dizer o tamanho
 * do que foi destruído — depois do DELETE não há mais o que contar.
 */
export async function excluirEmpresa(id: string, slug: string): Promise<ResultadoDaExclusao> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{
      ok: boolean;
      motivo: ResultadoDaExclusao['motivo'];
      nome: string | null;
      alunos: string;
      usuarios: string;
    }>('SELECT * FROM plataforma_excluir_empresa($1,$2)', [id, slug]);

    const r = rows[0];
    if (r === undefined) return { ok: false, motivo: 'nao_encontrado', nome: null, alunos: 0, usuarios: 0 };
    return {
      ok: r.ok,
      motivo: r.motivo,
      nome: r.nome,
      alunos: Number(r.alunos),
      usuarios: Number(r.usuarios),
    };
  });
}

/* --------------------------------------------------------------------
 * Configuração e diário
 * ------------------------------------------------------------------ */

export interface ConfigPlataforma {
  uazapiBaseUrl: string | null;
  uazapiAdminCifrado: string | null;
  atualizadoEm: string | null;
}

export async function lerConfig(): Promise<ConfigPlataforma> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{
      uazapi_base_url: string | null;
      uazapi_admin_encrypted: string | null;
      atualizado_em: Date | null;
    }>('SELECT * FROM plataforma_ler_config()');
    const l = rows[0];
    return {
      uazapiBaseUrl: l?.uazapi_base_url ?? null,
      uazapiAdminCifrado: l?.uazapi_admin_encrypted ?? null,
      atualizadoEm: l?.atualizado_em?.toISOString() ?? null,
    };
  });
}

export async function gravarConfig(
  url: string | null,
  tokenCifrado: string | null,
  adminId: string,
): Promise<void> {
  await withoutTenantContext('cron', (client) =>
    client.query('SELECT plataforma_gravar_config($1, $2, $3)', [url, tokenCifrado, adminId]),
  );
}

export async function registrar(
  adminId: string | null,
  acao: string,
  empresaId: string | null,
  alvo: string | null,
  ip: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await withoutTenantContext('cron', (client) =>
    client.query('SELECT plataforma_registrar($1,$2,$3,$4,$5,$6)', [
      adminId,
      acao,
      empresaId,
      alvo,
      ip,
      JSON.stringify(meta),
    ]),
  );
}

export async function historico(
  limite: number,
): Promise<{ quando: string; quem: string; acao: string; empresa: string; alvo: string | null }[]> {
  return withoutTenantContext('cron', async (client) => {
    const { rows } = await client.query<{
      quando: Date;
      quem: string;
      acao: string;
      empresa: string;
      alvo: string | null;
    }>('SELECT * FROM plataforma_historico($1)', [limite]);
    return rows.map((l) => ({ ...l, quando: l.quando.toISOString() }));
  });
}
