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

export interface ErroDeCampo {
  campo: string;
  problema: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  /**
   * Quais campos falharam e por quê, quando o servidor informa.
   *
   * Sem isto, o formulário só conseguia dizer "os dados enviados são
   * inválidos" — o servidor mandava o detalhe e o cliente jogava fora,
   * obrigando a pessoa a caçar o erro entre dezoito campos.
   */
  readonly campos: ErroDeCampo[];

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    campos: ErroDeCampo[] = [],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.campos = campos;
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
  /* FormData define o próprio Content-Type, com a fronteira do
     multipart embutida. Escrever "application/json" por cima faria o
     servidor não achar a fronteira e recusar o upload inteiro. */
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
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
    const detalhes = e?.details;
    throw new ApiError(
      resposta.status,
      e?.code ?? 'ERRO',
      e?.message ?? 'Não foi possível completar a operação.',
      e?.requestId,
      Array.isArray(detalhes) ? (detalhes as ErroDeCampo[]) : [],
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

/* -------------------------------------------------------------------- */

export interface AlunoEmRisco {
  id: string;
  nome: string;
  diasSemVir: number;
  presencasAnteriores: number;
  profissional: string | null;
  whatsapp: string | null;
  temHorarioMarcado: boolean;
}

export interface IndicadoresGestao {
  ativos: number;
  inativos: number;
  novosNoMes: number;
  saidasNoMes: number;
  churnPercentual: number | null;
  churnBase: number;
  leituraChurn: string;
  receitaMesFormatada: string;
  ticketMedioFormatado: string | null;
  tempoMedioVidaMeses: number | null;
  ltvFormatado: string | null;
  inadimplentes: number;
  inadimplenciaFormatada: string;
  frequenciaMediaPorAluno: number | null;
  taxaComparecimentoPercentual: number | null;
  emRisco: AlunoEmRisco[];
  aniversariantes: { id: string; nome: string; dia: number; mes: number }[];
}

export const buscarIndicadores = () =>
  api<{ data: IndicadoresGestao }>('/api/insights/gestao');

/* -------------------------------------------------------------------- */

export interface FichaAluno {
  id: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  whatsapp: string | null;
  dataNascimento: string | null;
  documento: string | null;
  status: string;
  observacoes: string | null;
  inicioEm: string | null;
  criadoEm: string;
  endereco: {
    cep: string | null; logradouro: string | null; numero: string | null;
    complemento: string | null; bairro: string | null; cidade: string | null; uf: string | null;
  };
  emergencia: { contato: string | null; telefone: string | null };
  profissional: { id: string; nome: string } | null;
  contrato: {
    ciclo: string; valorCentavos: number; comissaoBp: number;
    sessoesIncluidas: number | null; diaVencimento: number | null; inicioEm: string;
  } | null;
  frequencia: { presencas: number; faltas: number; agendados: number };
  financeiro: { emAbertoCentavos: number; vencidasQtd: number; pagoNoAnoCentavos: number };
  temAnamnese: boolean;
}

export type DadosAluno = Record<string, string | undefined>;

export const buscarFicha = (id: string) =>
  api<{ data: FichaAluno }>(`/api/students/${id}/ficha`);

export const criarAluno = (dados: DadosAluno) =>
  api<{ data: { id: string } }>('/api/students', {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const atualizarAluno = (id: string, dados: DadosAluno) =>
  api<{ ok: boolean }>(`/api/students/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(dados),
  });

/* --------------------------------------------------------------------
 * Prontuário
 *
 * Anamnese e evolução são dado de saúde. Nenhuma delas é guardada em
 * cache aqui de propósito: o que não fica em memória do navegador não
 * vaza numa máquina compartilhada do balcão.
 * ------------------------------------------------------------------ */

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
  realizadaEm: string;
  criadaEm: string;
  profissional: { id: string; nome: string } | null;
}

export interface VersaoAnamnese {
  id: string;
  realizadaEm: string;
  profissional: string | null;
}

export interface Evolucao {
  id: string;
  dataSessao: string;
  conteudo: string;
  escalaDor: number | null;
  medidas: Record<string, unknown>;
  criadaEm: string;
  atualizadaEm: string;
  profissional: { id: string; nome: string };
  editavel: boolean;
}

export type DadosAnamnese = Record<string, string | number | undefined>;

export const buscarAnamnese = (alunoId: string) =>
  api<{ data: { vigente: Anamnese | null; versoes: VersaoAnamnese[] } }>(
    `/api/students/${alunoId}/anamnese`,
  );

export const gravarAnamnese = (alunoId: string, dados: DadosAnamnese) =>
  api<{ data: { id: string } }>(`/api/students/${alunoId}/anamnese`, {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const buscarEvolucoes = (alunoId: string, pagina = 1) =>
  api<{ data: Evolucao[]; pagination: { total: number; totalPages: number } }>(
    `/api/students/${alunoId}/evolucoes?page=${pagina}&pageSize=20`,
  );

export const criarEvolucao = (
  alunoId: string,
  dados: { dataSessao: string; conteudo: string; escalaDor?: number },
) =>
  api<{ data: { id: string } }>(`/api/students/${alunoId}/evolucoes`, {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const editarEvolucao = (
  alunoId: string,
  evolucaoId: string,
  dados: { conteudo: string; escalaDor?: number },
) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/evolucoes/${evolucaoId}`, {
    method: 'PATCH',
    body: JSON.stringify(dados),
  });

/* --------------------------------------------------------------------
 * Anexos
 * ------------------------------------------------------------------ */

export interface Anexo {
  id: string;
  nome: string;
  tipo: string;
  tamanhoBytes: number;
  categoria: string | null;
  descricao: string | null;
  criadoEm: string;
  enviadoPor: string | null;
}

export const buscarAnexos = (alunoId: string) =>
  api<{ data: Anexo[] }>(`/api/students/${alunoId}/anexos`);

export const enviarAnexo = (
  alunoId: string,
  arquivo: File,
  extras: { categoria?: string; descricao?: string } = {},
) => {
  const corpo = new FormData();
  if (extras.categoria !== undefined) corpo.append('categoria', extras.categoria);
  if (extras.descricao !== undefined) corpo.append('descricao', extras.descricao);
  // O arquivo por último: o servidor lê os campos de texto enquanto o
  // fluxo caminha, e precisa deles antes de decidir o que fazer com os
  // bytes.
  corpo.append('arquivo', arquivo);

  return api<{ data: { id: string } }>(`/api/students/${alunoId}/anexos`, {
    method: 'POST',
    body: corpo,
  });
};

export const excluirAnexo = (alunoId: string, anexoId: string) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/anexos/${anexoId}`, { method: 'DELETE' });

/**
 * Baixa o anexo.
 *
 * Não dá para usar um `<a href>` simples: o access token vive em
 * memória e viaja no cabeçalho Authorization, que um link do navegador
 * não envia. Então buscamos os bytes, montamos um endereço temporário
 * e clicamos nele por baixo dos panos.
 *
 * O endereço é revogado logo depois — um blob vivo segura o arquivo
 * inteiro na memória da aba, e prontuário não é coisa para ficar
 * pendurada ali.
 */
export async function baixarAnexo(alunoId: string, anexoId: string, nome: string): Promise<void> {
  const resposta = await fetch(`/api/students/${alunoId}/anexos/${anexoId}/conteudo`, {
    headers: accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin',
  });

  if (!resposta.ok) {
    if (resposta.status === 401 && (await renovar())) {
      return baixarAnexo(alunoId, anexoId, nome);
    }
    throw new ApiError(resposta.status, 'ERRO', 'Não foi possível baixar o anexo.');
  }

  const blob = await resposta.blob();
  const endereco = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = endereco;
    link.download = nome;
    link.click();
  } finally {
    // setTimeout porque revogar no mesmo tick cancela o download no Safari.
    setTimeout(() => URL.revokeObjectURL(endereco), 10_000);
  }
}

/* --------------------------------------------------------------------
 * Treino
 * ------------------------------------------------------------------ */

export interface Exercicio {
  id: string;
  nome: string;
  grupo: string;
  equipamento: string | null;
  instrucoes: string | null;
  video: string | null;
  ativo: boolean;
}

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
  criadoEm: string;
  profissional: { id: string; nome: string };
  itens: ItemTreino[];
}

export const buscarExercicios = (busca?: string, grupo?: string) => {
  const q = new URLSearchParams();
  if (busca !== undefined && busca !== '') q.set('busca', busca);
  if (grupo !== undefined && grupo !== '') q.set('grupo', grupo);
  return api<{ data: Exercicio[] }>(`/api/exercises?${q.toString()}`);
};

export const buscarTreinos = (alunoId: string) =>
  api<{ data: Omit<Treino, 'itens'>[] }>(`/api/students/${alunoId}/treinos`);

export const buscarTreino = (alunoId: string, treinoId: string) =>
  api<{ data: Treino }>(`/api/students/${alunoId}/treinos/${treinoId}`);

export const criarTreino = (alunoId: string, dados: { nome: string; objetivo?: string }) =>
  api<{ data: { id: string } }>(`/api/students/${alunoId}/treinos`, {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const adicionarItemTreino = (
  alunoId: string,
  treinoId: string,
  dados: {
    exercicioId: string;
    dia?: string;
    posicao?: number;
    series?: number;
    repeticoes?: string;
    cargaKg?: number;
    descansoSegundos?: number;
  },
) =>
  api<{ data: { id: string } }>(`/api/students/${alunoId}/treinos/${treinoId}/itens`, {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const removerItemTreino = (alunoId: string, treinoId: string, itemId: string) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/treinos/${treinoId}/itens/${itemId}`, {
    method: 'DELETE',
  });

export const publicarTreino = (alunoId: string, treinoId: string) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/treinos/${treinoId}/ativar`, { method: 'POST' });
