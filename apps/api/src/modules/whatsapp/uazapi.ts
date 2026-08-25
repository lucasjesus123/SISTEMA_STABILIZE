import { env } from '../../config/env.js';
import { badRequest } from '../../http/errors.js';
import { lerConfig } from '../plataforma/plataforma.repository.js';
import { decifrar } from './segredo.js';

/**
 * Cliente da uazapi.
 *
 * Três cuidados que valem para qualquer integração com serviço externo,
 * e que aqui não são opcionais porque este serviço fala com os alunos:
 *
 * 1. TIMEOUT SEMPRE. `fetch` sem AbortSignal espera indefinidamente. Um
 *    provedor lento sem timeout não deixa a integração lenta — deixa o
 *    JOB pendurado, segurando conexão do pool, até o processo morrer.
 *
 * 2. O CORPO DA RESPOSTA DELE NUNCA VIRA MENSAGEM NOSSA. O que o
 *    provedor devolve num erro pode conter caminho de arquivo, versão de
 *    software e às vezes o próprio token ecoado. Vai para o log; o
 *    usuário recebe texto escrito por nós.
 *
 * 3. O TOKEN VAI NO CABEÇALHO, nunca na URL. Endereço aparece em log de
 *    proxy, em histórico e no `Referer`; cabeçalho, não.
 *
 * 4. SÃO DOIS TOKENS DIFERENTES, e confundi-los é o erro clássico desta
 *    API. O ADMIN token vai no cabeçalho `admintoken` e serve para criar
 *    e listar instâncias; o token DA INSTÂNCIA vai no cabeçalho `token` e
 *    serve para conectar, ver status e enviar. Mandar o admin no
 *    cabeçalho errado devolve 401 sem dizer por quê.
 */

const TEMPO_LIMITE_MS = 15_000;

/**
 * De onde vem a configuração.
 *
 * DO PAINEL PRIMEIRO, do ambiente depois. O painel da plataforma tem uma
 * tela para o endereço e o token administrativo, e até aqui ela gravava
 * numa tabela que ninguém lia: quem salvasse por lá via "Configuração
 * salva" e nada acontecia, porque este arquivo só olhava variável de
 * ambiente. Duas fontes de verdade para a mesma coisa, e a que a pessoa
 * usa era a que não valia.
 *
 * O ambiente continua valendo como reserva — é como a integração foi
 * instalada antes de existir a tela, e tirá-lo desligaria o WhatsApp de
 * quem já estava no ar no momento da atualização.
 */
interface ConfiguracaoUazapi {
  base: string | null;
  admin: string | null;
}

/* Cache curto porque isto é lido no caminho de CADA mensagem da fila —
   uma consulta por mensagem enviada seria uma consulta por mensagem
   enviada. Trinta segundos é menos do que qualquer pessoa leva entre
   salvar a configuração e testá-la. */
const VALIDADE_MS = 30_000;
let cache: { valor: ConfiguracaoUazapi; em: number } | null = null;

/** Chamado quando o painel grava: sem isto o teste roda com o valor velho. */
export function esquecerConfiguracao(): void {
  cache = null;
}

export async function configuracao(): Promise<ConfiguracaoUazapi> {
  if (cache !== null && Date.now() - cache.em < VALIDADE_MS) return cache.valor;

  let doPainel: ConfiguracaoUazapi = { base: null, admin: null };
  try {
    const c = await lerConfig();
    doPainel = {
      base: c.uazapiBaseUrl,
      /* Guardado cifrado. Se a chave de cifra mudou, decifrar lança — e
         cair para o ambiente é melhor do que derrubar a fila inteira. */
      admin: c.uazapiAdminCifrado === null ? null : decifrar(c.uazapiAdminCifrado),
    };
  } catch {
    doPainel = { base: null, admin: null };
  }

  const valor: ConfiguracaoUazapi = {
    base: doPainel.base ?? env().UAZAPI_BASE_URL ?? null,
    admin: doPainel.admin ?? env().UAZAPI_ADMIN_TOKEN ?? null,
  };
  cache = { valor, em: Date.now() };
  return valor;
}

async function base(): Promise<string> {
  const url = (await configuracao()).base;
  if (url === null) {
    throw badRequest('A integração de WhatsApp não está configurada neste servidor.');
  }
  return url.replace(/\/+$/, '');
}

async function chamar<T>(
  caminho: string,
  token: string,
  corpo: unknown,
  metodo = 'POST',
  cabecalhoDoToken: 'token' | 'admintoken' = 'token',
): Promise<T> {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);

  try {
    const resposta = await fetch(`${await base()}${caminho}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        [cabecalhoDoToken]: token,
      },
      body: corpo === undefined ? null : JSON.stringify(corpo),
      signal: controle.signal,
    });

    const texto = await resposta.text();

    if (!resposta.ok) {
      /* A mensagem do provedor é anexada ao Error para ir ao log de quem
         chamou — e nunca para a resposta HTTP do nosso usuário. */
      throw new Error(`uazapi ${resposta.status}: ${texto.slice(0, 300)}`);
    }

    return (texto === '' ? {} : JSON.parse(texto)) as T;
  } catch (erro) {
    if (erro instanceof Error && erro.name === 'AbortError') {
      throw new Error(`uazapi não respondeu em ${TEMPO_LIMITE_MS / 1000}s`);
    }
    throw erro;
  } finally {
    clearTimeout(relogio);
  }
}

async function tokenAdministrativo(): Promise<string> {
  const admin = (await configuracao()).admin;
  if (admin === null) {
    throw badRequest('Falta o token administrativo da uazapi. Configure no painel da plataforma.');
  }
  return admin;
}

/**
 * Cria a instância e devolve o token dela.
 *
 * `/instance/create` com o cabeçalho `admintoken` — é o único passo
 * administrativo do fluxo de conexão. A versão anterior chamava
 * `/instance/init` mandando o admin no cabeçalho `token`, que é o
 * cabeçalho da instância: os dois errados ao mesmo tempo, e o sintoma
 * seria um 401 sem explicação na hora de conectar o primeiro número.
 */
export async function criarInstancia(
  nome: string,
): Promise<{ token: string; instancia: string }> {
  const r = await chamar<{ token?: string; instance?: { token?: string; name?: string } }>(
    '/instance/create',
    await tokenAdministrativo(),
    { name: nome, systemName: 'stabilize' },
    'POST',
    'admintoken',
  );
  const token = r.token ?? r.instance?.token;
  if (token === undefined) throw new Error('uazapi não devolveu o token da instância');
  return { token, instancia: r.instance?.name ?? nome };
}

/**
 * O servidor responde e o token administrativo é aceito?
 *
 * `/instance/all` é o endpoint de Super Admin — lista as instâncias de
 * todas as academias — e por isso é a prova certa: se ele responde, o
 * endereço está certo E o token vale. Uma rota que qualquer token abrisse
 * não distinguiria "configurado" de "configurado errado".
 *
 * Devolve o número de instâncias e NENHUMA delas: o painel precisa saber
 * que a ponte está de pé, não quem está do outro lado.
 */
export async function verificarAdmin(): Promise<{ instancias: number }> {
  const r = await chamar<unknown>(
    '/instance/all',
    await tokenAdministrativo(),
    undefined,
    'GET',
    'admintoken',
  );
  const lista = Array.isArray(r) ? r : ((r as { instances?: unknown[] }).instances ?? []);
  return { instancias: Array.isArray(lista) ? lista.length : 0 };
}

/**
 * QR Code para o celular escanear.
 *
 * O DESENHO VEM EM `instance.qrcode`, e não na raiz da resposta. Era daí
 * que saía "o provedor não devolveu um código": a instância era criada,
 * a conexão começava — o status voltava certo, "aguardando leitura" —, e
 * a única coisa que faltava era ler o campo no lugar onde ele está.
 *
 * E PODE VIR SEM O PREFIXO `data:`. É base64 puro em alguns servidores e
 * data URL em outros; um `<img src>` com base64 cru não desenha nada, e
 * o sintoma seria um quadrado vazio no lugar do QR — pior do que o erro,
 * porque parece que funcionou.
 *
 * O `paircode` vai junto: são oito caracteres que a pessoa digita no
 * celular quando a câmera não coopera — luz ruim, tela suja, mão trêmula
 * —, e é a diferença entre conectar e desistir.
 */
export async function obterQrCode(
  token: string,
): Promise<{ qr: string | null; codigo: string | null; status: string }> {
  const r = await chamar<{
    instance?: { status?: string; qrcode?: string; paircode?: string };
    qrcode?: string;
    paircode?: string;
    status?: string;
  }>('/instance/connect', token, {});

  const bruto = r.instance?.qrcode ?? r.qrcode ?? null;

  return {
    qr: bruto === null || bruto === '' ? null : comoImagem(bruto),
    codigo: r.instance?.paircode ?? r.paircode ?? null,
    status: r.instance?.status ?? r.status ?? 'DISCONNECTED',
  };
}

/** Base64 cru vira data URL; data URL passa direto. */
function comoImagem(valor: string): string {
  return valor.startsWith('data:') ? valor : `data:image/png;base64,${valor}`;
}

/**
 * Está conectado de verdade?
 *
 * A VERDADE É `status.connected && status.loggedIn`, e não o texto de
 * `instance.status`. Os dois discordam justamente no meio do caminho: a
 * instância fica "connecting" com o QR na tela, e existe um instante em
 * que o texto já diz "connected" mas a sessão do WhatsApp ainda não
 * subiu. Confiar no texto faz a tela anunciar sucesso e a primeira
 * mensagem falhar.
 *
 * O NÚMERO vem de `status.jid.user`. `instance.owner` — que esta função
 * lia — não existe na resposta, então o número nunca aparecia: a tela
 * mostrava "conectado" sem dizer conectado a quê.
 */
export async function statusDaInstancia(
  token: string,
): Promise<{ status: string; numero: string | null }> {
  const r = await chamar<{
    instance?: { status?: string; owner?: string; profileName?: string };
    status?: { connected?: boolean; loggedIn?: boolean; jid?: { user?: string } | string };
  }>('/instance/status', token, undefined, 'GET');

  const ligado = r.status?.connected === true && r.status?.loggedIn === true;

  const jid = r.status?.jid;
  const numero =
    typeof jid === 'string' ? (jid.split('@')[0] ?? null) : (jid?.user ?? r.instance?.owner ?? null);

  return {
    status: ligado ? 'CONNECTED' : (r.instance?.status ?? 'DISCONNECTED').toUpperCase(),
    numero: numero === undefined || numero === '' ? null : numero,
  };
}

export async function enviarTexto(
  token: string,
  numero: string,
  texto: string,
): Promise<{ id: string | null }> {
  /* A uazapi espera o número só com dígitos. O banco guarda em E.164
     (+5531...), que é a forma certa de ARMAZENAR — a conversão é aqui,
     na borda, e não no formato guardado. */
  const r = await chamar<{ id?: string; messageid?: string; key?: { id?: string } }>(
    '/send/text',
    token,
    { number: numero.replace(/\D/g, ''), text: texto },
  );
  return { id: r.id ?? r.messageid ?? r.key?.id ?? null };
}
