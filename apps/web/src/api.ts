/**
 * Cliente da API.
 *
 * Duas decisões de segurança que moldam este arquivo:
 *
 * 1. O ACCESS TOKEN VIVE EM MEMÓRIA, nunca em localStorage.
 *    localStorage é legível por qualquer script da página — um XSS, ou
 *    uma dependência comprometida, lê o token e assume a sessão. Em
 *    memória, o token morre com a aba. O custo é ter que renovar ao
 *    recarregar a página, e é aí que entra o refresh.
 *
 * 2. O REFRESH VIVE EM COOKIE HttpOnly, que este código NÃO CONSEGUE
 *    LER — de propósito. O navegador o envia sozinho para /api/auth.
 *    É o que permite recarregar a página sem pedir a senha de novo,
 *    mantendo o token fora do alcance de script.
 */

export interface Principal {
  id: string;
  role: string;
  roleLabel: string;
  permissions: string[];
  studentId?: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

let accessToken: string | null = null;
let renovando: Promise<boolean> | null = null;

export function definirToken(token: string | null): void {
  accessToken = token;
}

export function temToken(): boolean {
  return accessToken !== null;
}

interface RespostaErro {
  error?: { code?: string; message?: string; requestId?: string; details?: unknown };
}

async function bruto<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (accessToken !== null) headers.set('Authorization', `Bearer ${accessToken}`);

  const resposta = await fetch(caminho, {
    ...init,
    headers,
    // Necessário para o cookie de refresh acompanhar a requisição.
    credentials: 'same-origin',
  });

  if (resposta.status === 204) return undefined as T;

  const corpo = (await resposta.json().catch(() => ({}))) as RespostaErro & T;

  if (!resposta.ok) {
    const e = corpo.error;
    throw new ApiError(
      resposta.status,
      e?.code ?? 'ERRO',
      e?.message ?? 'Não foi possível completar a operação.',
      e?.requestId,
    );
  }

  return corpo;
}

/**
 * Renova o access token.
 *
 * A promessa é COMPARTILHADA entre chamadas simultâneas. Sem isso, uma
 * tela que dispara cinco requisições ao carregar produziria cinco
 * refreshes em paralelo — e como cada refresh rotaciona o token, os
 * quatro perdedores apresentariam um token já usado, o servidor
 * interpretaria como roubo e derrubaria a sessão inteira. O usuário
 * seria deslogado por abrir o painel.
 */
async function renovar(): Promise<boolean> {
  renovando ??= (async () => {
    try {
      const r = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!r.ok) return false;
      const dados = (await r.json()) as { accessToken: string };
      accessToken = dados.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Libera para a próxima vez, seja qual for o desfecho.
      setTimeout(() => {
        renovando = null;
      }, 0);
    }
  })();

  return renovando;
}

/**
 * Requisição com renovação automática.
 *
 * Ao receber 401, tenta renovar UMA vez e repete. Se a renovação
 * falhar, o 401 sobe e a aplicação manda para o login.
 */
export async function api<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  try {
    return await bruto<T>(caminho, init);
  } catch (erro) {
    if (erro instanceof ApiError && erro.status === 401 && (await renovar())) {
      return bruto<T>(caminho, init);
    }
    throw erro;
  }
}

/* -------------------------------------------------------------------- */

export async function entrar(
  email: string,
  senha: string,
): Promise<{ accessToken: string; user: Principal & { name: string; mustChangePassword: boolean } }> {
  const r = await bruto<{
    accessToken: string;
    user: Principal & { name: string; mustChangePassword: boolean };
  }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: senha }),
  });
  accessToken = r.accessToken;
  return r;
}

export async function sair(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  accessToken = null;
}

/** Restaura a sessão ao recarregar a página, usando o cookie. */
export async function restaurarSessao(): Promise<Principal | null> {
  if (!(await renovar())) return null;
  try {
    return await bruto<Principal>('/api/auth/me');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- */

export interface ResumoFinanceiro {
  aReceberCentavos: number;
  recebidoCentavos: number;
  aPagarCentavos: number;
  pagoCentavos: number;
  inadimplenteCentavos: number;
  inadimplentesQtd: number;
  saldoRealizadoCentavos: number;
}

export interface Aluno {
  id: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  whatsapp: string | null;
  dataNascimento: string | null;
  status: string;
  criadoEm: string;
}

export interface Compromisso {
  id: string;
  inicio: string;
  fim: string;
  status: string;
  aluno: { id: string; nome: string };
  profissional: { id: string; nome: string };
  sala: { id: string; nome: string } | null;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

export const buscarResumo = (de: Date, ate: Date) =>
  api<{ data: ResumoFinanceiro }>(`/api/finance/resumo?de=${iso(de)}&ate=${iso(ate)}`);

export const buscarAlunos = (pagina = 1, busca?: string) =>
  api<{ data: Aluno[]; pagination: { total: number; totalPages: number } }>(
    `/api/students?page=${pagina}&pageSize=25${busca ? `&search=${encodeURIComponent(busca)}` : ''}`,
  );

export const buscarAgenda = (de: Date, ate: Date) =>
  api<{ data: Compromisso[] }>(
    `/api/schedule?de=${de.toISOString()}&ate=${ate.toISOString()}`,
  );

export const buscarComissao = (profissionalId: string, mes: Date) =>
  api<{
    data: {
      totalCentavos: number;
      totalFormatado: string;
      baseTotalCentavos: number;
      aliquotaMediaBp: number;
      itens: { descricao: string; baseFormatada: string; valorFormatado: string }[];
    };
  }>(`/api/finance/comissoes/${profissionalId}?mes=${iso(mes)}`);
