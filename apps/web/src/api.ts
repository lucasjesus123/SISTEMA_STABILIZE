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
  name: string;
  role: string;
  roleLabel: string;
  permissions: string[];
  /** O fuso da ACADEMIA — é nele que o servidor valida a agenda. */
  timezone?: string;
  /** Entrou com senha provisória e precisa trocar antes de usar. */
  mustChangePassword?: boolean;
  /** Nome da academia — num SaaS, saber onde se está é a primeira coisa. */
  tenantNome?: string;
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

/**
 * O login, para as duas portas.
 *
 * A MESMA tela serve quem opera uma academia e quem opera o serviço. É o
 * servidor que decide qual das duas o e-mail abre — ver o comentário em
 * `auth.routes.ts`. Quando é o dono do serviço, a resposta traz
 * `plataforma` no lugar de `user`, e aí não há `Principal` nenhum para
 * guardar: o painel é outra aplicação, com sessão própria.
 */
export async function entrar(
  email: string,
  senha: string,
): Promise<
  | { tipo: 'academia'; user: Principal & { mustChangePassword: boolean } }
  | { tipo: 'plataforma' }
> {
  const r = await bruto<{
    accessToken: string;
    user?: Principal & { mustChangePassword: boolean };
    plataforma?: { id: string; nome: string; precisaTrocarSenha: boolean };
  }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: senha }),
  });

  if (r.plataforma !== undefined) {
    /* O token do painel NÃO entra no `accessToken` deste módulo: ele tem
       audiência de plataforma e seria recusado por toda rota daqui. O
       painel se levanta sozinho pelo cookie que o servidor acabou de
       gravar. */
    return { tipo: 'plataforma' };
  }

  accessToken = r.accessToken;
  return { tipo: 'academia', user: r.user! };
}

export async function sair(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  accessToken = null;
}

/**
 * Quem é o usuário do token que está em memória.
 *
 * Separado de `restaurarSessao` porque o acesso de SUPORTE já chega com
 * o token na mão e não tem cookie de refresh — chamar a restauração
 * inteira tentaria renovar, falharia, e derrubaria um token que estava
 * perfeitamente válido.
 */
export function buscarPrincipal(): Promise<Principal> {
  return bruto<Principal>('/api/auth/me');
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
  venceHojeCentavos: number;
  venceHojeQtd: number;
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
  dataDoDocumento?: string | null;
  editadoPor?: string | null;
  editadoEm?: string | null;
  enviadoPeloAluno?: boolean;
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
  temFoto: boolean;
  ativo: boolean;
}

/**
 * Baixa a foto de um exercício e devolve um endereço de blob.
 *
 * NÃO DÁ PARA PÔR A URL DIRETO NO `<img src>`: a rota exige o token no
 * cabeçalho `Authorization`, e uma tag `<img>` não manda cabeçalho
 * nenhum — o cookie que existe é o de refresh, restrito ao caminho de
 * autenticação. Sem este desvio pelo `fetch`, toda figura viria 401.
 *
 * Quem chamar precisa revogar o endereço ao desmontar, senão o blob
 * fica na memória da aba até ela ser fechada.
 */
export async function baixarFotoDoExercicio(id: string): Promise<string | null> {
  const resposta = await fetch(`/api/exercises/${id}/foto`, {
    headers: accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin',
  });
  if (!resposta.ok) return null;
  return URL.createObjectURL(await resposta.blob());
}

export async function enviarFotoDoExercicio(id: string, arquivo: File): Promise<void> {
  const corpo = new FormData();
  corpo.append('arquivo', arquivo);
  await api<{ ok: boolean }>(`/api/exercises/${id}/foto`, { method: 'POST', body: corpo });
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

/* --------------------------------------------------------------------
 * Relatórios e WhatsApp
 * ------------------------------------------------------------------ */

/**
 * Baixa um PDF.
 *
 * Mesmo motivo do anexo: o token vive em memória e viaja no cabeçalho,
 * que um `<a href>` não envia. Buscamos os bytes e disparamos o download
 * por um endereço temporário, revogado depois.
 */
export async function baixarRelatorio(caminho: string, nome: string): Promise<void> {
  const resposta = await fetch(caminho, {
    headers: accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin',
  });

  if (!resposta.ok) {
    if (resposta.status === 401 && (await renovar())) return baixarRelatorio(caminho, nome);
    throw new ApiError(resposta.status, 'ERRO', 'Não foi possível gerar o relatório.');
  }

  const endereco = URL.createObjectURL(await resposta.blob());
  try {
    const link = document.createElement('a');
    link.href = endereco;
    link.download = nome;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(endereco), 10_000);
  }
}

export interface ConexaoWhatsapp {
  id: string;
  nome: string;
  numero: string | null;
  status: string;
  conectadoEm: string | null;
}

export interface MensagemWhatsapp {
  id: string;
  numero: string;
  texto: string;
  tipo: string;
  status: string;
  erro: string | null;
  aluno: string | null;
  criadoEm: string;
}

export const buscarWhatsapp = () => api<{ data: ConexaoWhatsapp | null }>('/api/whatsapp');

export const conectarWhatsapp = () =>
  api<{ data: { qr: string | null; status: string } }>('/api/whatsapp/conectar', {
    method: 'POST',
  });

export const buscarMensagens = () =>
  api<{ data: MensagemWhatsapp[] }>('/api/whatsapp/mensagens');

export const testarWhatsapp = (numero: string, texto: string) =>
  api<{ ok: boolean }>('/api/whatsapp/testar', {
    method: 'POST',
    body: JSON.stringify({ numero, texto }),
  });

export const dispararAniversarios = () =>
  api<{ data: { enviadas: number; jaEnviadas: number; falhas: number } }>(
    '/api/whatsapp/aniversarios/executar',
    { method: 'POST' },
  );

/* --------------------------------------------------------------------
 * Aplicativo do aluno
 *
 * Nenhuma destas rotas carrega id de aluno: ele vem do token. É a
 * diferença central em relação ao resto da API — não existe parâmetro
 * para adulterar.
 * ------------------------------------------------------------------ */

export interface MeuPerfil {
  nome: string;
  foto: string | null;
  mensalista: boolean;
  plano: { ciclo: string; valorCentavos: number; sessoesIncluidas: number | null } | null;
  frequencia: {
    presencas: number;
    faltas: number;
    proximos: number;
    /* ENTRADAS NA RECEPÇÃO. Para quem faz musculação são a frequência
       inteira — essa pessoa não tem agendamento nenhum, e até aqui o app
       dizia "0 presenças" para quem treinava toda semana. */
    entradas: number;
    treinosFeitos: number;
  };
  /** Só o que já venceu: a mensalidade do dia 10 não é dívida no dia 3. */
  devendoCentavos: number;
  devendoFormatado: string;
}

export interface MeuItemTreino {
  dia: string;
  exercicio: string;
  equipamento: string | null;
  series: number | null;
  repeticoes: string | null;
  cargaG: number | null;
  descansoSegundos: number | null;
}

export interface MeuTreino {
  nome: string;
  objetivo: string | null;
  observacoes: string | null;
  profissional: string;
  itens: MeuItemTreino[];
}

export interface MeuHorario {
  id: string;
  inicio: string;
  fim: string;
  status: string;
  profissional: string;
  sala: string | null;
  precoCentavos: number | null;
  observacao: string | null;
  podeCancelar: boolean;
}

export interface VagaProfissional {
  profissional: { id: string; nome: string };
  horarios: { inicio: string; fim: string }[];
}

export const meuPerfil = () => api<{ data: MeuPerfil }>('/api/eu');
export const meuTreino = () => api<{ data: MeuTreino | null }>('/api/eu/treino');
export const minhaAgenda = () => api<{ data: MeuHorario[] }>('/api/eu/agenda');

export const vagas = (de: Date, ate: Date) =>
  api<{ data: VagaProfissional[] }>(
    `/api/eu/horarios?de=${de.toISOString()}&ate=${ate.toISOString()}`,
  );

export const agendar = (dados: {
  profissionalId: string;
  inicio: string;
  fim: string;
  observacao?: string;
}) =>
  api<{ data: { id: string; precoCentavos: number | null } }>('/api/eu/agendamentos', {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const desmarcar = (id: string) =>
  api<{ ok: boolean }>(`/api/eu/agendamentos/${id}`, { method: 'DELETE' });

/* --------------------------------------------------------------------
 * Perfil de quem está autenticado
 *
 * Vale para todo mundo: dono, recepção, profissional e aluno. Nenhuma
 * destas rotas carrega id — ele vem do token, e o que não é parâmetro
 * não é adulterável.
 * ------------------------------------------------------------------ */

export interface EnderecoPerfil {
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
}

export interface Perfil {
  id: string;
  nome: string;
  email: string;
  papel: string;
  telefone: string | null;
  whatsapp: string | null;
  dataNascimento: string | null;
  temFoto: boolean;
  endereco: EnderecoPerfil;
}

export interface PerfilEntrada {
  nome: string;
  telefone: string | null;
  whatsapp: string | null;
  dataNascimento: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
}

export const lerPerfil = () => api<{ data: Perfil }>('/api/perfil');

export const salvarPerfil = (dados: PerfilEntrada) =>
  api<{ data: Perfil }>('/api/perfil', { method: 'PUT', body: JSON.stringify(dados) });

/**
 * Envia a foto.
 *
 * `FormData` sem `Content-Type` escrito à mão: o navegador precisa
 * gerar a fronteira do multipart, e sobrescrever o cabeçalho faz o
 * servidor não achá-la. O `bruto()` já trata esse caso.
 */
export function enviarFotoPerfil(arquivo: File) {
  const corpo = new FormData();
  corpo.append('arquivo', arquivo);
  return api<{ data: { ok: boolean } }>('/api/perfil/foto', { method: 'POST', body: corpo });
}

export const removerFotoPerfil = () => api<{ ok: boolean }>('/api/perfil/foto', { method: 'DELETE' });

export function enviarFotoAluno(alunoId: string, arquivo: File) {
  const corpo = new FormData();
  corpo.append('arquivo', arquivo);
  return api<{ data: { ok: boolean } }>(`/api/students/${alunoId}/foto`, {
    method: 'POST',
    body: corpo,
  });
}

export const removerFotoAluno = (alunoId: string) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/foto`, { method: 'DELETE' });

/* ====================================================================
 * A IDENTIDADE DA ACADEMIA
 *
 * Fonte única do que sai com a marca: papel timbrado dos relatórios,
 * carteirinha, termo e WhatsApp. Nenhum deles guarda cópia — quem
 * precisa da marca lê daqui.
 * ================================================================== */

export interface Academia {
  nome: string;
  documento: string | null;
  telefone: string | null;
  temLogo: boolean;
  endereco: {
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
  };
}

export const lerAcademia = () => api<{ data: Academia }>('/api/academia');

export const salvarAcademia = (dados: {
  nome: string;
  documento: string | null;
  telefone: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
}) => api<{ data: Academia }>('/api/academia', { method: 'PUT', body: JSON.stringify(dados) });

export function enviarLogoDaAcademia(arquivo: File) {
  const corpo = new FormData();
  corpo.append('arquivo', arquivo);
  return api<{ data: { ok: boolean } }>('/api/academia/logo', { method: 'POST', body: corpo });
}

export const removerLogoDaAcademia = () =>
  api<{ ok: boolean }>('/api/academia/logo', { method: 'DELETE' });

/** O logo como endereço temporário para `<img>`. Mesmas regras de `buscarFoto`. */
export const buscarLogoDaAcademia = () => buscarFoto('/api/academia/logo');

/**
 * Busca uma foto e devolve um endereço temporário para usar em `<img>`.
 *
 * NÃO DÁ PARA APONTAR O `<img src>` DIRETO PARA A ROTA. O access token
 * vive em memória e viaja no cabeçalho Authorization; o carregador de
 * imagem do navegador não manda cabeçalho nenhum, então a requisição
 * chegaria sem autenticação e voltaria 401. É o mesmo motivo do
 * download de anexo e do PDF.
 *
 * Devolve `null` para 404 — quem ainda não tem foto não é um erro a
 * mostrar na tela, é o estado normal de quem acabou de ser cadastrado.
 *
 * QUEM CHAMA PRECISA REVOGAR o endereço quando trocar de foto ou sair da
 * tela. Um blob vivo segura a imagem inteira na memória da aba.
 */
export async function buscarFoto(caminho: string): Promise<string | null> {
  const resposta = await fetch(caminho, {
    headers: accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin',
  });

  if (resposta.status === 404) return null;
  if (!resposta.ok) {
    if (resposta.status === 401 && (await renovar())) return buscarFoto(caminho);
    return null;
  }

  return URL.createObjectURL(await resposta.blob());
}

/* --------------------------------------------------------------------
 * CEP
 *
 * Passa pelo nosso servidor, não direto para os Correios: a CSP da
 * página é `default-src 'self'` e o IP do aluno não precisa ir para um
 * terceiro a cada digitação. Ver o cabeçalho de `cep.routes.ts`.
 * ------------------------------------------------------------------ */

export interface EnderecoDeCep {
  cep: string;
  logradouro: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
}

/**
 * Busca o endereço. Devolve `null` para CEP inexistente ou serviço fora
 * do ar — os dois casos terminam do mesmo jeito na tela: a pessoa
 * preenche à mão, sem mensagem de erro atravessada.
 */
/**
 * "Não existe" e "não consegui perguntar" são respostas diferentes.
 *
 * Antes as duas viravam `null`, e a tela dizia "CEP não encontrado" nas
 * duas — fazendo quem digitou um CEP correto duvidar do próprio dado
 * quando o serviço externo apenas piscou.
 */
export type ResultadoDeCep = EnderecoDeCep | 'nao-encontrado' | 'indisponivel';

export async function buscarCep(oitoDigitos: string): Promise<ResultadoDeCep> {
  try {
    const { data } = await api<{ data: EnderecoDeCep }>(`/api/cep/${oitoDigitos}`);
    return data;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return 'nao-encontrado';
    /* Rede caída, servidor fora, 503 do proxy de CEP: tudo isto é
       "não consegui", e nenhum deles autoriza dizer que o CEP não
       existe. */
    return 'indisponivel';
  }
}

/* ====================================================================
 * FINANCEIRO — contas a receber e a pagar, baixas e comissão
 * ================================================================== */

export type DirecaoLancamento = 'RECEIVABLE' | 'PAYABLE';
export type StatusLancamento = 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED';

export interface Lancamento {
  id: string;
  direcao: DirecaoLancamento;
  descricao: string;
  categoria: string | null;
  valorCentavos: number;
  valorFormatado: string;
  pagoCentavos: number;
  saldoCentavos: number;
  status: StatusLancamento;
  vencimento: string;
  competencia: string | null;
  aluno: { id: string; nome: string } | null;
  fornecedor: string | null;
  parcela: string | null;
}

export interface FiltroLancamentos {
  direcao?: DirecaoLancamento;
  de?: Date;
  ate?: Date;
  status?: StatusLancamento;
  apenasEmAberto?: boolean;
  pagina?: number;
}

export const buscarLancamentos = (f: FiltroLancamentos = {}) => {
  const q = new URLSearchParams({ page: String(f.pagina ?? 1), pageSize: '50' });
  if (f.direcao !== undefined) q.set('direcao', f.direcao);
  if (f.de !== undefined) q.set('de', iso(f.de));
  if (f.ate !== undefined) q.set('ate', iso(f.ate));
  if (f.status !== undefined) q.set('status', f.status);
  if (f.apenasEmAberto === true) q.set('apenasEmAberto', 'true');
  return api<{
    data: Lancamento[];
    pagination: { page: number; total: number; totalPages: number };
  }>(`/api/finance/lancamentos?${q.toString()}`);
};

export interface NovoLancamento {
  direcao: DirecaoLancamento;
  descricao: string;
  categoria?: string;
  valor: string;
  vencimento: string;
  studentId?: string;
  professionalId?: string;
  fornecedor?: string;
  observacao?: string;
}

export const criarLancamento = (dados: NovoLancamento) =>
  api<{ data: { id: string } }>('/api/finance/lancamentos', {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export type MetodoPagamento =
  | 'PIX'
  | 'CASH'
  | 'DEBIT_CARD'
  | 'CREDIT_CARD'
  | 'BANK_TRANSFER'
  | 'BOLETO'
  | 'OTHER';

export const darBaixa = (
  lancamentoId: string,
  dados: { valor: string; metodo: MetodoPagamento; pagoEm?: string; referencia?: string },
) =>
  api<{ data: { id: string } }>(`/api/finance/lancamentos/${lancamentoId}/pagamentos`, {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export interface FormaDePagamento {
  valor: string;
  metodo: MetodoPagamento;
  pagoEm?: string;
  referencia?: string;
}

/**
 * Baixa dividida em várias formas.
 *
 * O LOTE INTEIRO É UMA TRANSAÇÃO no servidor: ou entram todas as formas
 * ou não entra nenhuma. Mandar uma chamada por forma deixaria a conta
 * meio paga quando a segunda falhasse.
 */
export const darBaixaEmLote = (lancamentoId: string, pagamentos: FormaDePagamento[]) =>
  api<{ data: { ids: string[] } }>(
    `/api/finance/lancamentos/${lancamentoId}/pagamentos/lote`,
    { method: 'POST', body: JSON.stringify({ pagamentos }) },
  );

/* ====================================================================
 * CADASTROS — equipe, espaços e contrato do aluno
 * ================================================================== */

export interface Profissional {
  id: string;
  nome: string;
  papel: string;
  cor: string | null;
  ativo: boolean;
}

export const buscarProfissionais = () =>
  api<{ data: Profissional[] }>('/api/cadastros/profissionais');

export const definirCorDoProfissional = (id: string, cor: string) =>
  api<{ ok: boolean }>(`/api/cadastros/profissionais/${id}/cor`, {
    method: 'PUT',
    body: JSON.stringify({ cor }),
  });

export interface Sala {
  id: string;
  nome: string;
  descricao: string | null;
  capacidade: number;
  cor: string | null;
  ativa: boolean;
}

export const buscarSalas = () => api<{ data: Sala[] }>('/api/cadastros/salas');

export const criarSala = (dados: {
  nome: string;
  descricao?: string | null;
  capacidade: number;
  cor?: string | null;
}) => api<{ data: { id: string } }>('/api/cadastros/salas', {
  method: 'POST',
  body: JSON.stringify(dados),
});

export const salvarSala = (
  id: string,
  dados: {
    nome: string;
    descricao?: string | null;
    capacidade: number;
    cor?: string | null;
    ativa: boolean;
  },
) => api<{ ok: boolean }>(`/api/cadastros/salas/${id}`, {
  method: 'PUT',
  body: JSON.stringify(dados),
});

export type CicloCobranca =
  | 'SESSION'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL';

export interface Contrato {
  id: string;
  ciclo: CicloCobranca;
  valorCentavos: number;
  valorFormatado: string;
  comissaoBp: number;
  comissaoPercentual: number;
  sessoesIncluidas: number | null;
  diaDeCobranca: number | null;
  inicioEm: string;
  fimEm: string | null;
  profissional: { id: string; nome: string } | null;
}

export const buscarContrato = (alunoId: string) =>
  api<{ data: Contrato | null }>(`/api/students/${alunoId}/contrato`);

export const salvarContrato = (
  alunoId: string,
  dados: {
    ciclo: CicloCobranca;
    valor: string;
    comissaoPercentual: string | number;
    diaDeCobranca?: number | null;
    sessoesIncluidas?: number | null;
    profissionalId?: string | null;
    inicioEm?: string;
  },
) => api<{ data: { id: string } }>(`/api/students/${alunoId}/contrato`, {
  method: 'PUT',
  body: JSON.stringify(dados),
});

/* ====================================================================
 * AGENDA — marcar, cancelar, presença
 * ================================================================== */

export interface CompromissoDetalhado extends Compromisso {
  observacao: string | null;
  valorCentavos: number | null;
  incluidoNoPlano: boolean;
  presencaEm: string | null;
}

export const buscarAgendaDetalhada = (de: Date, ate: Date, filtro?: { profissionalId?: string; salaId?: string }) => {
  const q = new URLSearchParams({ de: de.toISOString(), ate: ate.toISOString() });
  if (filtro?.profissionalId !== undefined) q.set('professionalId', filtro.profissionalId);
  if (filtro?.salaId !== undefined) q.set('roomId', filtro.salaId);
  return api<{ data: CompromissoDetalhado[] }>(`/api/schedule?${q.toString()}`);
};

export const marcarCompromisso = (dados: {
  studentId: string;
  professionalId: string;
  roomId?: string;
  inicio: string;
  fim: string;
  observacao?: string;
}) => api<{ data: { id: string } }>('/api/schedule', {
  method: 'POST',
  body: JSON.stringify(dados),
});

export const cancelarCompromisso = (id: string, motivo?: string) =>
  api<{ ok: boolean }>(`/api/schedule/${id}/cancelar`, {
    method: 'POST',
    body: JSON.stringify({ motivo }),
  });

export const marcarPresenca = (id: string, compareceu: boolean) =>
  api<{ ok: boolean }>(`/api/schedule/${id}/presenca`, {
    method: 'POST',
    body: JSON.stringify({ compareceu }),
  });

export interface FaixaDeHorario {
  diaDaSemana: number;
  inicio: string;
  fim: string;
  duracaoMinutos: number;
  salaId: string | null;
}

export const buscarHorarios = (profissionalId: string) =>
  api<{ data: (FaixaDeHorario & { id: string })[] }>(
    `/api/cadastros/profissionais/${profissionalId}/horarios`,
  );

export const salvarHorarios = (profissionalId: string, faixas: FaixaDeHorario[]) =>
  api<{ ok: boolean; data: { faixas: number } }>(
    `/api/cadastros/profissionais/${profissionalId}/horarios`,
    { method: 'PUT', body: JSON.stringify({ faixas }) },
  );

/* ====================================================================
 * EQUIPE — quem trabalha na academia
 * ================================================================== */

export type PapelDaEquipe = 'OWNER' | 'ADMIN' | 'PROFESSIONAL' | 'RECEPTION';

export interface UsuarioDaEquipe {
  id: string;
  nome: string;
  email: string;
  papel: PapelDaEquipe;
  telefone: string | null;
  cor: string | null;
  ativo: boolean;
  ultimoAcesso: string | null;
  precisaTrocarSenha: boolean;
}

export const buscarEquipe = () => api<{ data: UsuarioDaEquipe[] }>('/api/cadastros/usuarios');

export interface DadosDeUsuario {
  nome: string;
  papel: PapelDaEquipe;
  telefone?: string | null;
  cor?: string | null;
}

export const criarUsuario = (dados: DadosDeUsuario & { email: string }) =>
  api<{ data: { id: string; senhaProvisoria: string } }>('/api/cadastros/usuarios', {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const salvarUsuario = (id: string, dados: DadosDeUsuario) =>
  api<{ ok: boolean }>(`/api/cadastros/usuarios/${id}`, {
    method: 'PUT',
    body: JSON.stringify(dados),
  });

export const definirUsuarioAtivo = (id: string, ativo: boolean) =>
  api<{ ok: boolean }>(`/api/cadastros/usuarios/${id}/situacao`, {
    method: 'POST',
    body: JSON.stringify({ ativo }),
  });

export const redefinirSenhaDeUsuario = (id: string) =>
  api<{ data: { senhaProvisoria: string } }>(`/api/cadastros/usuarios/${id}/senha`, {
    method: 'POST',
  });

/* ====================================================================
 * MEDIDAS CORPORAIS
 *
 * Tudo em INTEIRO: peso em gramas, circunferências em milímetros,
 * gordura em décimos de por cento. A tela converte na entrada e na
 * saída; o caminho do dado nunca passa por ponto flutuante.
 * ================================================================== */

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

export const buscarMedidas = (alunoId: string) =>
  api<{ data: Medida[] }>(`/api/students/${alunoId}/medidas`);

export interface DadosDeMedida {
  data: string;
  pesoG?: number | null;
  alturaCm?: number | null;
  gorduraPctX10?: number | null;
  observacoes?: string | null;
  circunferenciasMm?: Partial<Record<CampoMedida, number | null>>;
}

export const gravarMedida = (alunoId: string, dados: DadosDeMedida) =>
  api<{ data: Medida }>(`/api/students/${alunoId}/medidas`, {
    method: 'PUT',
    body: JSON.stringify(dados),
  });

export const excluirMedida = (alunoId: string, medidaId: string) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/medidas/${medidaId}`, { method: 'DELETE' });

/* ====================================================================
 * FOTO E ACESSO DO ALUNO
 * ================================================================== */

export async function baixarFotoDoAluno(alunoId: string): Promise<string | null> {
  const resposta = await fetch(`/api/students/${alunoId}/foto`, {
    headers: accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin',
  });
  if (!resposta.ok) return null;
  return URL.createObjectURL(await resposta.blob());
}

export async function enviarFotoDoAluno(alunoId: string, arquivo: File): Promise<void> {
  const corpo = new FormData();
  corpo.append('arquivo', arquivo);
  await api<{ ok: boolean }>(`/api/students/${alunoId}/foto`, { method: 'POST', body: corpo });
}

export const removerFotoDoAluno = (alunoId: string) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/foto`, { method: 'DELETE' });

export interface AcessoDoAluno {
  liberado: boolean;
  login: string | null;
  usouSenhaInicial: boolean;
  jaEntrou: boolean;
  temCpf: boolean;
}

export const buscarAcessoDoAluno = (alunoId: string) =>
  api<{ data: AcessoDoAluno }>(`/api/students/${alunoId}/acesso`);

export const liberarAcessoDoAluno = (alunoId: string) =>
  api<{ data: { login: string; senhaInicial: string; criado: boolean } }>(
    `/api/students/${alunoId}/acesso`,
    { method: 'POST' },
  );

export const bloquearAcessoDoAluno = (alunoId: string) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/acesso`, { method: 'DELETE' });

/**
 * Troca a própria senha.
 *
 * O servidor derruba TODAS as sessões ao trocar, inclusive esta — é o
 * comportamento certo (uma senha trocada porque vazou não pode deixar a
 * sessão do invasor viva), e significa que a tela precisa mandar a
 * pessoa entrar de novo em seguida.
 */
export const trocarMinhaSenha = (atual: string, nova: string) =>
  api<{ ok: boolean }>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: atual, newPassword: nova }),
  });

/* ====================================================================
 * RELATÓRIOS E RECORRÊNCIAS DO FINANCEIRO
 * ================================================================== */

export interface Relatorios {
  fluxo: { mes: string; recebidoCentavos: number; pagoCentavos: number; saldoCentavos: number }[];
  categorias: {
    categoria: string;
    direcao: DirecaoLancamento;
    totalCentavos: number;
    totalFormatado: string;
    quantidade: number;
  }[];
  inadimplentes: {
    studentId: string;
    nome: string;
    telefone: string | null;
    devendoCentavos: number;
    devendoFormatado: string;
    cobrancas: number;
    diasDeAtraso: number;
  }[];
  totalDevendoCentavos: number;
}

export const buscarRelatorios = (de: Date, ate: Date) =>
  api<{ data: Relatorios }>(`/api/finance/relatorios?de=${iso(de)}&ate=${iso(ate)}`);

export interface Recorrencia {
  contratoId: string;
  studentId: string;
  aluno: string;
  ciclo: string;
  valorCentavos: number;
  valorFormatado: string;
  diaDeCobranca: number | null;
  profissional: string | null;
  desde: string;
  encerrandoNoFim: boolean;
  vencidasAbertas: number;
}

export const buscarRecorrencias = () => api<{ data: Recorrencia[] }>('/api/finance/recorrencias');

/** Baixa o CSV do período. O contador do cliente sempre pede. */
export async function baixarCsvDoFinanceiro(de: Date, ate: Date): Promise<void> {
  await baixarRelatorio(
    `/api/finance/lancamentos.csv?de=${iso(de)}&ate=${iso(ate)}`,
    `lancamentos-${iso(de)}.csv`,
  );
}

/* ====================================================================
 * O PRONTUÁRIO PELO APLICATIVO DO ALUNO
 *
 * Nenhuma destas rotas leva o id dele: ele sai do token. O que não é
 * parâmetro não é adulterável.
 * ================================================================== */

export interface MinhaCarteirinha {
  nome: string;
  codigo: string | null;
  status: string;
  temFoto: boolean;
  academia: string;
  desde: string | null;
}

export const buscarMinhaCarteirinha = () =>
  api<{ data: MinhaCarteirinha }>('/api/eu/carteirinha');

export async function baixarMinhaFoto(): Promise<string | null> {
  const r = await fetch('/api/eu/foto', {
    headers: accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin',
  });
  if (!r.ok) return null;
  return URL.createObjectURL(await r.blob());
}

export async function enviarMinhaFoto(arquivo: File): Promise<void> {
  const corpo = new FormData();
  corpo.append('arquivo', arquivo);
  await api<{ ok: boolean }>('/api/eu/foto', { method: 'POST', body: corpo });
}

export interface MinhaAnamnese {
  id: string;
  respostas: Record<string, unknown>;
  criadoEm: string;
  profissional: string | null;
}

export const buscarMinhasAnamneses = () =>
  api<{ data: MinhaAnamnese[] }>('/api/eu/anamneses');

export interface MeuExame {
  id: string;
  nome: string;
  tipo: string;
  tamanhoBytes: number;
  descricao: string | null;
  dataDoDocumento: string | null;
  criadoEm: string;
}

export const buscarMeusExames = () => api<{ data: MeuExame[] }>('/api/eu/exames');

export async function enviarMeuExame(arquivo: File, descricao: string): Promise<void> {
  const corpo = new FormData();
  /* A descrição vai ANTES do arquivo no multipart: o servidor lê o
     fluxo em ordem, e um campo de texto depois do arquivo já chegaria
     tarde demais para ser lido junto com ele. */
  corpo.append('descricao', descricao);
  corpo.append('arquivo', arquivo);
  await api<{ data: { id: string } }>('/api/eu/exames', { method: 'POST', body: corpo });
}

/* --------------------------------------------------------------------
 * Anexos: corrigir o que descreve
 * ------------------------------------------------------------------ */

export const editarAnexo = (
  alunoId: string,
  anexoId: string,
  dados: { descricao: string | null; categoria: string | null; dataDoDocumento: string | null },
) =>
  api<{ ok: boolean }>(`/api/students/${alunoId}/anexos/${anexoId}`, {
    method: 'PATCH',
    body: JSON.stringify(dados),
  });

/* ====================================================================
 * CHECK-IN NA RECEPÇÃO
 *
 * BUSCAR E REGISTRAR SÃO DUAS CHAMADAS de propósito. A recepcionista
 * digita, erra o nome, digita de novo — se a busca registrasse entrada,
 * cada tentativa viraria um check-in.
 * ================================================================== */

export type SituacaoNaPorta = 'EM_DIA' | 'DEVENDO' | 'SEM_CONTRATO' | 'INATIVO';

export interface AlunoNaPorta {
  id: string;
  nome: string;
  codigo: string | null;
  temFoto: boolean;
  situacao: SituacaoNaPorta;
  devendoCentavos: number;
  devendoFormatado: string;
  cobrancasVencidas: number;
  diasDeAtraso: number;
  dentro: boolean;
  ultimaEntrada: string | null;
  /** Só a situação, nunca as respostas: PAR-Q é dado de saúde. */
  triagem: SituacaoDaTriagem;
  /** O sistema avisa; quem decide é quem está no balcão. */
  precisaLiberar: boolean;
}

export const buscarNaPorta = (termo: string) =>
  api<{ data: AlunoNaPorta[] }>(`/api/checkin/buscar?termo=${encodeURIComponent(termo)}`);

export const registrarEntrada = (
  studentId: string,
  opcoes: { liberadoComAviso?: boolean; observacao?: string | null } = {},
) =>
  api<{ data: { id: string; situacao: SituacaoNaPorta; nome: string } }>('/api/checkin', {
    method: 'POST',
    body: JSON.stringify({
      studentId,
      liberadoComAviso: opcoes.liberadoComAviso ?? false,
      observacao: opcoes.observacao ?? null,
    }),
  });

export const registrarSaida = (checkinId: string) =>
  api<{ ok: boolean }>(`/api/checkin/${checkinId}/saida`, { method: 'POST' });

export interface PresenteNaAcademia {
  id: string;
  nome: string;
  codigo: string | null;
  entrouEm: string;
  situacao: SituacaoNaPorta;
}

export const quemEstaNaAcademia = () =>
  api<{ data: PresenteNaAcademia[] }>('/api/checkin/agora');

export interface MovimentoDoDia {
  total: number;
  dentro: number;
  devendo: number;
  porHora: { hora: number; n: number }[];
}

export const movimentoDoDia = () => api<{ data: MovimentoDoDia }>('/api/checkin/hoje');

export const definirToleranciaNaPorta = (bloquearApos: number) =>
  api<{ ok: boolean }>('/api/checkin/config', {
    method: 'PUT',
    body: JSON.stringify({ bloquearApos }),
  });

/* --------------------------------------------------------------------
 * Avisos automáticos de agendamento
 *
 * A confirmação sai quando o horário é marcado; o lembrete, N horas
 * antes da aula. Zero horas desliga o lembrete.
 * ------------------------------------------------------------------ */

export interface AvisosDeAgendamento {
  confirmarAgendamento: boolean;
  lembreteHoras: number;
}

export const buscarAvisos = () => api<{ data: AvisosDeAgendamento }>('/api/whatsapp/avisos');

export const salvarAvisos = (dados: AvisosDeAgendamento) =>
  api<{ ok: boolean }>('/api/whatsapp/avisos', { method: 'PUT', body: JSON.stringify(dados) });

/* ====================================================================
 * TRIAGEM DE SAÚDE — PAR-Q e termo de responsabilidade
 *
 * O termo chega PRONTO do servidor, com o nome da academia já dentro.
 * Montar o texto na tela faria o documento assinado depender da versão
 * do JavaScript que o navegador tinha em cache.
 * ================================================================== */

export type SituacaoDaTriagem = 'NUNCA_ASSINOU' | 'VALIDA' | 'VENCIDA' | 'AGUARDANDO_ATESTADO';

export interface PerguntaDoParq {
  chave: string;
  texto: string;
  /** Um SIM aqui obriga liberação médica antes de treinar. */
  exigeLiberacao: boolean;
  /** Do questionário padrão, ou criada pela academia. */
  origem: 'PARQ' | 'ACADEMIA';
}

export interface TermoVigente {
  versao: string;
  texto: string;
  academia: string;
  validadeDias: number;
}

export interface TriagemResumo {
  situacao: SituacaoDaTriagem;
  assinadaEm: string | null;
  validoAte: string | null;
  precisaLiberacaoMedica: boolean;
  temAtestado: boolean;
  liberadoEm: string | null;
}

export interface TriagemCompleta extends TriagemResumo {
  id: string;
  respostas: Record<string, boolean>;
  /** As perguntas como estavam no dia. Vazio nas assinaturas antigas. */
  perguntas: PerguntaDoParq[];
  observacoes: string | null;
  termoVersao: string;
  termoTexto: string;
  assinadoNome: string;
  assinadoPeloAluno: boolean;
}

export interface Assinatura {
  respostas: Record<string, boolean>;
  observacoes?: string | null;
  assinadoNome: string;
}

export const buscarPerguntasDaTriagem = () =>
  api<{ data: { perguntas: PerguntaDoParq[]; termo: TermoVigente } }>(
    '/api/students/triagem/perguntas',
  );

export const buscarTriagemDoAluno = (alunoId: string) =>
  api<{ data: { atual: TriagemResumo; historico: TriagemCompleta[] } }>(
    `/api/students/${alunoId}/triagem`,
  );

export const assinarTriagemPelaAcademia = (alunoId: string, dados: Assinatura) =>
  api<{ data: { id: string; precisaLiberacaoMedica: boolean } }>(
    `/api/students/${alunoId}/triagem`,
    { method: 'POST', body: JSON.stringify(dados) },
  );

export const liberarTriagem = (triagemId: string, atestadoId?: string | null) =>
  api<{ ok: boolean }>(`/api/students/triagem/${triagemId}/liberar`, {
    method: 'POST',
    body: JSON.stringify({ atestadoId: atestadoId ?? null }),
  });

export interface TriagemPendente {
  id: string;
  nome: string;
  codigo: string | null;
  situacao: SituacaoDaTriagem;
}

export const buscarTriagensPendentes = () =>
  api<{ data: TriagemPendente[] }>('/api/students/triagem/pendentes');

/* --- o lado do aluno, sem id nenhuma na URL --- */

export const buscarMinhaTriagem = () =>
  api<{ data: { perguntas: PerguntaDoParq[]; termo: TermoVigente; atual: TriagemResumo } }>(
    '/api/eu/triagem',
  );

export const assinarMinhaTriagem = (dados: Assinatura) =>
  api<{ data: { id: string; precisaLiberacaoMedica: boolean } }>('/api/eu/triagem', {
    method: 'POST',
    body: JSON.stringify(dados),
  });

/* ====================================================================
 * O DIÁRIO DE TREINO
 *
 * A tabela existia desde o começo e ninguém escrevia nela — o app
 * mostrava o treino e não deixava dizer que fez.
 * ================================================================== */

export interface TreinoFeito {
  id: string;
  dia: string;
  quando: string;
  esforco: number | null;
  notas: string | null;
  hoje: boolean;
}

export interface MeuDiario {
  registros: TreinoFeito[];
  /** As letras já marcadas hoje — para o botão virar "feito". */
  feitosHoje: string[];
  total: number;
  noMes: number;
  sequenciaDeSemanas: number;
}

export const buscarMeuDiario = () => api<{ data: MeuDiario }>('/api/eu/treino/diario');

/** Esforço de 1 a 5 — a escala que o banco declara desde o começo. */
export const marcarTreinoFeito = (dia: string, esforco?: number | null, notas?: string | null) =>
  api<{ data: { id: string; quando: string } }>('/api/eu/treino/feito', {
    method: 'POST',
    body: JSON.stringify({ dia, esforco: esforco ?? null, notas: notas ?? null }),
  });

export const desmarcarTreinoFeito = (id: string) =>
  api<{ ok: boolean }>(`/api/eu/treino/feito/${id}`, { method: 'DELETE' });

/** O que o aluno marcou, visto pelo professor. */
export interface TreinoFeitoDoAluno {
  registros: { id: string; dia: string; quando: string; esforco: number | null; notas: string | null }[];
  ultimos7: number;
  ultimos30: number;
  esforcoMedio: number | null;
}

export const buscarTreinoFeitoDoAluno = (alunoId: string) =>
  api<{ data: TreinoFeitoDoAluno }>(`/api/students/${alunoId}/treino-feito`);

/* ====================================================================
 * RESERVA DE ESPAÇO
 *
 * `de` e `ate` são DATAS (YYYY-MM-DD) e `ate` é INCLUSIVO — uma tela de
 * calendário pensa em dias, não em instantes.
 * ================================================================== */

export interface Reserva {
  id: string;
  /** Agrupa as ocorrências de uma reserva repetida. NULL = avulsa. */
  serieId: string | null;
  inicio: string;
  fim: string;
  titulo: string;
  espacoId: string | null;
  espaco: string | null;
  cor: string | null;
  reservadoPor: string | null;
}

export const buscarReservas = (de: string, ate: string) =>
  api<{ data: Reserva[] }>(`/api/reservas?de=${de}&ate=${ate}`);

export interface NovaReserva {
  roomId: string;
  titulo: string;
  de: string;
  horaInicio: string;
  horaFim: string;
  /** Vazio = um dia só. Domingo = 0, como `getDay()`. */
  diasDaSemana?: number[];
  ate?: string;
}

export const criarReserva = (dados: NovaReserva) =>
  api<{ data: { criadas: number; serieId: string | null } }>('/api/reservas', {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const cancelarReserva = (id: string) =>
  api<{ ok: boolean }>(`/api/reservas/${id}`, { method: 'DELETE' });

/** Cancela a série daqui para a frente. O passado não é apagado. */
export const cancelarSerieDeReservas = (serieId: string) =>
  api<{ data: { canceladas: number } }>(`/api/reservas/serie/${serieId}`, { method: 'DELETE' });

/* --------------------------------------------------------------------
 * A academia edita o próprio questionário
 * ------------------------------------------------------------------ */

/** `chave` ausente = pergunta nova; o servidor a batiza a partir do texto. */
export interface PerguntaEditavel {
  chave?: string;
  texto: string;
  exigeLiberacao: boolean;
  origem: 'PARQ' | 'ACADEMIA';
}

export const salvarPerguntasDaTriagem = (perguntas: PerguntaEditavel[]) =>
  api<{ data: { perguntas: PerguntaDoParq[] } }>('/api/students/triagem/perguntas', {
    method: 'PUT',
    body: JSON.stringify({ perguntas }),
  });

/** Volta ao PAR-Q padrão do sistema. */
export const restaurarPerguntasDaTriagem = () =>
  api<{ data: { perguntas: PerguntaDoParq[] } }>('/api/students/triagem/perguntas', {
    method: 'DELETE',
  });

/* ====================================================================
 * A TABELA DE VALORES
 *
 * A tabela `price_plans` existia no banco desde o primeiro dia, com RLS
 * e tudo, e nenhum código a lia. Toda mensalidade era digitada aluno a
 * aluno. Estas funções são o que faltava para ligá-la.
 * ================================================================== */

export interface Plano {
  id: string;
  nome: string;
  ciclo: string;
  valorCentavos: number;
  sessoesIncluidas: number | null;
  comissaoBp: number;
  ativo: boolean;
  /** Contratos ATIVOS que usam este plano. Torna desativar uma decisão informada. */
  emUso: number;
}

export interface PlanoParaGravar {
  nome: string;
  ciclo: string;
  valorCentavos: number;
  sessoesIncluidas: number | null;
  comissaoBp: number;
}

export const listarPlanos = (incluirInativos = false) =>
  api<{ data: Plano[] }>(`/api/planos${incluirInativos ? '?incluirInativos=true' : ''}`);

export const criarPlano = (dados: PlanoParaGravar) =>
  api<{ data: { id: string } }>('/api/planos', { method: 'POST', body: JSON.stringify(dados) });

export const salvarPlano = (id: string, dados: PlanoParaGravar) =>
  api<{ data: { ok: boolean } }>(`/api/planos/${id}`, {
    method: 'PUT',
    body: JSON.stringify(dados),
  });

/** DESATIVA. Apagar deixaria contratos apontando para o nada. */
export const apagarPlano = (id: string) =>
  api<{ data: { desativado: boolean; contratosMantidos: number } }>(`/api/planos/${id}`, {
    method: 'DELETE',
  });

/* ====================================================================
 * OS RELATÓRIOS DE GESTÃO
 *
 * Os que olham a academia inteira e não um aluno. Todos saem em PDF
 * timbrado, e todos recebem o período de fora — um relatório que decide
 * sozinho o mês corrente não serve para fechar o mês anterior, que é
 * justamente quando ele é pedido.
 * ================================================================== */

export const baixarPresenca = (de: Date, ate: Date, profissionalId?: string) =>
  baixarRelatorio(
    `/api/relatorios/presenca?de=${iso(de)}&ate=${iso(ate)}${
      profissionalId === undefined || profissionalId === '' ? '' : `&profissionalId=${profissionalId}`
    }`,
    `presenca-${iso(de)}.pdf`,
  );

export const baixarOcupacao = (de: Date, ate: Date) =>
  baixarRelatorio(
    `/api/relatorios/ocupacao?de=${iso(de)}&ate=${iso(ate)}`,
    `ocupacao-${iso(de)}.pdf`,
  );

export const baixarInadimplencia = () =>
  baixarRelatorio('/api/relatorios/inadimplencia', 'inadimplencia.pdf');

/* ====================================================================
 * CRM — QUEM AINDA NÃO É ALUNO
 * ================================================================== */

export interface Lead {
  id: string;
  nome: string;
  whatsapp: string | null;
  email: string | null;
  origem: string;
  status: string;
  interesse: string | null;
  observacoes: string | null;
  responsavelId: string | null;
  responsavel: string | null;
  proximoContato: string | null;
  virouAlunoId: string | null;
  convertidoEm: string | null;
  perdidoMotivo: string | null;
  criadoEm: string;
  contatos: number;
  /** Dias de atraso. Negativo ainda vai vencer. Calculado no servidor. */
  atrasoDias: number | null;
}

export interface LeadDetalhe extends Lead {
  historico: { id: string; texto: string; autor: string | null; em: string }[];
}

export interface Funil {
  dias: number;
  total: number;
  etapas: { status: string; quantos: number }[];
  decididos: number;
  conversao: number | null;
}

export interface LeadParaGravar {
  nome: string;
  whatsapp: string | null;
  email: string | null;
  origem: string;
  status?: string;
  interesse: string | null;
  observacoes: string | null;
  responsavelId: string | null;
  proximoContato: string | null;
  perdidoMotivo?: string | null;
}

export const listarFila = (responsavelId?: string) =>
  api<{ data: Lead[] }>(
    `/api/crm/fila${responsavelId === undefined || responsavelId === '' ? '' : `?responsavelId=${responsavelId}`}`,
  );

export const listarLeads = (status?: string, busca?: string) => {
  const q = new URLSearchParams();
  if (status !== undefined && status !== '') q.set('status', status);
  if (busca !== undefined && busca !== '') q.set('busca', busca);
  const s = q.toString();
  return api<{ data: Lead[] }>(`/api/crm${s === '' ? '' : `?${s}`}`);
};

export const buscarLead = (id: string) => api<{ data: LeadDetalhe }>(`/api/crm/${id}`);
export const buscarFunil = (dias = 90) => api<{ data: Funil }>(`/api/crm/funil?dias=${dias}`);

export const criarLead = (dados: LeadParaGravar) =>
  api<{ data: { id: string } }>('/api/crm', { method: 'POST', body: JSON.stringify(dados) });

export const salvarLead = (id: string, dados: LeadParaGravar) =>
  api<{ data: { ok: boolean } }>(`/api/crm/${id}`, { method: 'PUT', body: JSON.stringify(dados) });

export const registrarContato = (
  id: string,
  dados: { texto: string; proximoContato?: string | null; status?: string },
) =>
  api<{ data: { ok: boolean } }>(`/api/crm/${id}/contato`, {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const converterLead = (id: string, cpf?: string) =>
  api<{ data: { alunoId: string } }>(`/api/crm/${id}/converter`, {
    method: 'POST',
    body: JSON.stringify(cpf === undefined || cpf === '' ? {} : { cpf }),
  });
