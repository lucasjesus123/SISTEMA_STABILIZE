import { env } from '../../config/env.js';
import { badRequest } from '../../http/errors.js';

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
 */

const TEMPO_LIMITE_MS = 15_000;

function base(): string {
  const url = env().UAZAPI_BASE_URL;
  if (url === undefined) {
    throw badRequest('A integração de WhatsApp não está configurada neste servidor.');
  }
  return url.replace(/\/+$/, '');
}

async function chamar<T>(
  caminho: string,
  token: string,
  corpo: unknown,
  metodo = 'POST',
): Promise<T> {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);

  try {
    const resposta = await fetch(`${base()}${caminho}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        token,
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

/** Cria a instância e devolve o token dela. */
export async function criarInstancia(
  nome: string,
): Promise<{ token: string; instancia: string }> {
  const admin = env().UAZAPI_ADMIN_TOKEN;
  if (admin === undefined) {
    throw badRequest('Falta o token administrativo da uazapi neste servidor.');
  }
  const r = await chamar<{ token?: string; instance?: { token?: string; name?: string } }>(
    '/instance/init',
    admin,
    { name: nome },
  );
  const token = r.token ?? r.instance?.token;
  if (token === undefined) throw new Error('uazapi não devolveu o token da instância');
  return { token, instancia: r.instance?.name ?? nome };
}

/** QR Code para o celular escanear. */
export async function obterQrCode(token: string): Promise<{ qr: string | null; status: string }> {
  const r = await chamar<{ instance?: { status?: string }; qrcode?: string; status?: string }>(
    '/instance/connect',
    token,
    {},
  );
  return {
    qr: r.qrcode ?? null,
    status: r.instance?.status ?? r.status ?? 'DISCONNECTED',
  };
}

export async function statusDaInstancia(
  token: string,
): Promise<{ status: string; numero: string | null }> {
  const r = await chamar<{ instance?: { status?: string; owner?: string } }>(
    '/instance/status',
    token,
    undefined,
    'GET',
  );
  return {
    status: (r.instance?.status ?? 'DISCONNECTED').toUpperCase(),
    numero: r.instance?.owner ?? null,
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
