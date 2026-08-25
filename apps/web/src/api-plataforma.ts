/**
 * Cliente do painel da plataforma.
 *
 * ARQUIVO SEPARADO DE `api.ts` de propósito, e não por organização: são
 * DUAS sessões diferentes, com tokens de audiências diferentes. Se
 * compartilhassem a variável do token, entrar no painel derrubaria a
 * sessão da academia na mesma aba — que é exatamente o que acontece com
 * quem opera o serviço e testa como cliente ao mesmo tempo.
 *
 * O token também vive só em memória, pelo mesmo motivo do outro: em
 * localStorage, qualquer script da página o lê. O que sobrevive ao
 * recarregamento é o cookie de refresh, que é HttpOnly e tem `path`
 * restrito a `/api/plataforma`.
 */

let token: string | null = null;
let renovando: Promise<boolean> | null = null;

/* Quem está logado, segundo a última resposta do servidor. Guardado aqui
   e não na tela porque o `refresh` também o devolve: assim recarregar a
   página recupera o nome verdadeiro e o estado da senha provisória, em
   vez de inventar um operador genérico com a troca já dada por feita. */
let quem: Operador | null = null;

export function temSessao(): boolean {
  return token !== null;
}

export class ErroPlataforma extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly campos: { campo: string; problema: string }[] = [],
  ) {
    super(message);
    this.name = 'ErroPlataforma';
  }
}

interface Envelope {
  error?: { message?: string; details?: unknown };
}

async function bruto<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);

  const resposta = await fetch(`/api/plataforma${caminho}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  if (resposta.status === 204) return undefined as T;
  const corpo = (await resposta.json().catch(() => ({}))) as Envelope & T;

  if (!resposta.ok) {
    const detalhes = corpo.error?.details;
    throw new ErroPlataforma(
      resposta.status,
      corpo.error?.message ?? 'Não foi possível completar a operação.',
      Array.isArray(detalhes) ? (detalhes as { campo: string; problema: string }[]) : [],
    );
  }
  return corpo;
}

/**
 * Renova o token quando ele expira.
 *
 * A promessa é COMPARTILHADA entre chamadas simultâneas: a tela do
 * painel dispara métricas, empresas e histórico juntos, e sem isso os
 * três tentariam renovar ao mesmo tempo. Como cada renovação rotaciona o
 * refresh, os perdedores apresentariam um token já usado — que o
 * servidor trata como sinal de roubo e derruba a sessão inteira.
 */
async function renovar(): Promise<boolean> {
  renovando ??= (async () => {
    try {
      const r = await fetch('/api/plataforma/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!r.ok) return false;
      const d = (await r.json()) as { accessToken: string; admin?: Operador };
      token = d.accessToken;
      if (d.admin !== undefined) quem = d.admin;
      return true;
    } catch {
      return false;
    } finally {
      renovando = null;
    }
  })();
  return renovando;
}

async function api<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  try {
    return await bruto<T>(caminho, init);
  } catch (e) {
    if (e instanceof ErroPlataforma && e.status === 401 && (await renovar())) {
      return bruto<T>(caminho, init);
    }
    throw e;
  }
}

/* --------------------------------------------------------------------
 * Sessão
 * ------------------------------------------------------------------ */

export interface Operador {
  id: string;
  nome: string;
  precisaTrocarSenha: boolean;
}

export async function entrar(email: string, senha: string): Promise<Operador> {
  const d = await bruto<{ accessToken: string; admin: Operador }>('/login', {
    method: 'POST',
    body: JSON.stringify({ email, senha }),
  });
  token = d.accessToken;
  quem = d.admin;
  return d.admin;
}

/**
 * Retoma a sessão a partir do cookie de refresh, devolvendo QUEM está
 * logado — ou `null` se não há sessão. Devolver o operador em vez de um
 * booleano é o que permite à tela reabrir com o nome certo e com a troca
 * de senha ainda pendente quando ela estiver pendente.
 */
export async function restaurar(): Promise<Operador | null> {
  return (await renovar()) ? quem : null;
}

export async function sair(): Promise<void> {
  token = null;
  quem = null;
  await fetch('/api/plataforma/logout', { method: 'POST', credentials: 'same-origin' }).catch(
    () => undefined,
  );
}

/**
 * Troca a senha e JÁ FICA DENTRO.
 *
 * A troca revoga todas as sessões do operador, esta inclusive, e por isso
 * o servidor devolve uma sessão nova na mesma resposta. Guardar o token
 * daqui é o que evita a tela de login logo depois de escolher a senha —
 * uma parede que não protegia nada, porque quem chegou até aqui digitou a
 * senha antiga e a nova na mesma tela.
 */
export async function trocarSenha(atual: string, nova: string): Promise<Operador> {
  const d = await api<{ ok: boolean; accessToken: string; admin: Operador }>('/senha', {
    method: 'POST',
    body: JSON.stringify({ atual, nova }),
  });
  token = d.accessToken;
  quem = d.admin;
  return d.admin;
}

/* --------------------------------------------------------------------
 * Métricas e diagnóstico
 * ------------------------------------------------------------------ */

export interface Metricas {
  empresas: number;
  empresasAtivas: number;
  empresasSuspensas: number;
  usuarios: number;
  alunos: number;
  alunosAtivos: number;
  agendamentos30d: number;
  mensagensPendentes: number;
  mensagensFalhas: number;
  logins24h: number;
  loginsFalhos24h: number;
}

export const buscarMetricas = () => api<{ data: Metricas }>('/metricas');

export interface Ocorrencia {
  quando: string;
  empresa: string;
  acao: string;
  recurso: string;
  resultado: string;
}
export const buscarErros = (limite = 30) => api<{ data: Ocorrencia[] }>(`/erros?limite=${limite}`);

export interface Movimento {
  quando: string;
  quem: string;
  acao: string;
  empresa: string;
  alvo: string | null;
}
export const buscarHistorico = (limite = 40) =>
  api<{ data: Movimento[] }>(`/historico?limite=${limite}`);

/* --------------------------------------------------------------------
 * Empresas
 * ------------------------------------------------------------------ */

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

export const listarEmpresas = () => api<{ data: Empresa[] }>('/empresas');

export interface DadosEmpresa {
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

export const criarEmpresa = (dados: DadosEmpresa) =>
  api<{ data: { empresaId: string; dono: { email: string; senhaProvisoria: string } } }>(
    '/empresas',
    { method: 'POST', body: JSON.stringify(dados) },
  );

export const salvarEmpresa = (
  id: string,
  dados: Omit<DadosEmpresa, 'slug' | 'donoNome' | 'donoEmail'> & { observacoes: string | null },
) => api<{ ok: boolean }>(`/empresas/${id}`, { method: 'PUT', body: JSON.stringify(dados) });

/**
 * Exclui a academia inteira e tudo o que é dela.
 *
 * `confirmacao` é o slug digitado de novo por quem está excluindo — o
 * servidor recusa se não bater, e recusa também se a academia ainda
 * estiver no ar. As duas travas moram no banco; aqui elas só não são
 * escondidas de quem lê este arquivo.
 */
export const excluirEmpresa = (id: string, confirmacao: string) =>
  api<{ ok: boolean; data: { nome: string | null; alunos: number; usuarios: number } }>(
    `/empresas/${id}`,
    { method: 'DELETE', body: JSON.stringify({ confirmacao }) },
  );

export const definirSituacao = (id: string, ativa: boolean, motivo: string | null) =>
  api<{ ok: boolean }>(`/empresas/${id}/situacao`, {
    method: 'POST',
    body: JSON.stringify({ ativa, motivo }),
  });

/* --------------------------------------------------------------------
 * Usuários
 * ------------------------------------------------------------------ */

export interface UsuarioDaEmpresa {
  id: string;
  nome: string;
  email: string;
  papel: string;
  ativo: boolean;
  ultimoAcesso: string | null;
}

export const listarUsuarios = (empresaId: string) =>
  api<{ data: UsuarioDaEmpresa[] }>(`/empresas/${empresaId}/usuarios`);

export const criarGestor = (
  empresaId: string,
  dados: { nome: string; email: string; papel: 'OWNER' | 'ADMIN' },
) =>
  api<{ data: { id: string; senhaProvisoria: string } }>(`/empresas/${empresaId}/gestores`, {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const salvarUsuario = (
  usuarioId: string,
  dados: { nome: string; email: string; papel: 'OWNER' | 'ADMIN' },
) => api<{ ok: boolean }>(`/usuarios/${usuarioId}`, { method: 'PUT', body: JSON.stringify(dados) });

export const redefinirSenha = (usuarioId: string) =>
  api<{ data: { senhaProvisoria: string } }>(`/usuarios/${usuarioId}/senha`, { method: 'POST' });

export const definirUsuarioAtivo = (usuarioId: string, ativo: boolean) =>
  api<{ ok: boolean }>(`/usuarios/${usuarioId}/situacao`, {
    method: 'POST',
    body: JSON.stringify({ ativo }),
  });

export interface AcessoDeSuporte {
  accessToken: string;
  expiresIn: number;
  comoUsuario: { nome: string; email: string; papel: string };
  empresa: string;
}

export const entrarComoUsuario = (usuarioId: string) =>
  api<{ data: AcessoDeSuporte }>(`/usuarios/${usuarioId}/entrar`, { method: 'POST' });

/* --------------------------------------------------------------------
 * Configuração do WhatsApp
 * ------------------------------------------------------------------ */

export interface ConfigWhatsapp {
  uazapiBaseUrl: string | null;
  temToken: boolean;
  atualizadoEm: string | null;
}

export const lerConfig = () => api<{ data: ConfigWhatsapp }>('/config');

export const salvarConfig = (uazapiBaseUrl: string | null, uazapiAdminToken: string | null) =>
  api<{ ok: boolean }>('/config', {
    method: 'PUT',
    body: JSON.stringify({ uazapiBaseUrl, uazapiAdminToken }),
  });
