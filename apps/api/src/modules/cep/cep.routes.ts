import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../http/errors.js';

/**
 * Consulta de CEP.
 *
 * POR QUE PASSA PELO NOSSO SERVIDOR, e não direto do navegador para os
 * Correios. Três motivos, e o primeiro sozinho já bastaria:
 *
 *   1. A CSP da aplicação é `default-src 'self'`. Buscar de outro
 *      domínio no navegador exigiria abrir `connect-src` para um host de
 *      terceiro — e uma CSP com exceção é uma CSP que ganha a segunda
 *      exceção sem discussão.
 *   2. Privacidade. Uma busca feita pelo navegador entrega o IP do aluno
 *      e o CEP dele a um serviço que não é nosso, em toda digitação.
 *      Saindo daqui, o terceiro vê o servidor.
 *   3. Cache. O mesmo CEP é digitado várias vezes ao dia numa academia
 *      de bairro; do lado do servidor a segunda consulta é instantânea.
 *
 * ISTO É UM PROXY DE SAÍDA, e proxy de saída é como nasce SSRF: o
 * clássico é a rota aceitar algo parecido com um endereço e o servidor
 * ir buscar em `http://169.254.169.254/` ou na rede interna. Aqui não há
 * endereço nenhum vindo do cliente — só oito dígitos, validados antes de
 * qualquer coisa, montando um caminho dentro de um host fixo escrito no
 * código. Não existe entrada capaz de trocar o destino.
 */

const cepParam = z.object({
  /* Oito dígitos, e só. A máscara é problema da tela; aqui o que chega
     fora do formato é recusado antes de virar URL. */
  cep: z.string().regex(/^\d{8}$/, 'CEP precisa ter 8 dígitos.'),
});

export interface EnderecoDeCep {
  cep: string;
  logradouro: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
}

/* Cache em memória do processo. Não é Redis de propósito: são poucos
   milhares de CEPs distintos numa academia, cada entrada tem menos de
   200 bytes, e uma dependência a mais para guardar endereço público não
   se paga. Reiniciar a API esvazia, e tudo bem. */
const cache = new Map<string, { valor: EnderecoDeCep | null; ate: number }>();
const VALIDADE_MS = 24 * 60 * 60 * 1000;
const TETO_CACHE = 5_000;

/* Um CEP inexistente também é guardado, por menos tempo: sem isso, quem
   digita errado e insiste manda uma consulta externa a cada tecla. */
const VALIDADE_VAZIO_MS = 10 * 60 * 1000;

export async function cepRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/:cep',
    {
      /* Autenticada. Uma rota que faz o servidor sair para a internet não
         fica aberta ao mundo, mesmo devolvendo dado público: seria um
         proxy anônimo de graça, e o custo da saída é nosso.

         O limite é generoso porque a tela consulta enquanto se digita —
         mas existe, para que uma aba travada em laço não vire tráfego
         de saída constante. */
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { cep } = cepParam.parse(request.params);

      const guardado = cache.get(cep);
      if (guardado !== undefined && guardado.ate > Date.now()) {
        if (guardado.valor === null) throw notFound('CEP');
        return { data: guardado.valor };
      }

      const endereco = await consultar(cep, request.log);

      if (cache.size >= TETO_CACHE) cache.clear();
      cache.set(cep, {
        valor: endereco,
        ate: Date.now() + (endereco === null ? VALIDADE_VAZIO_MS : VALIDADE_MS),
      });

      if (endereco === null) throw notFound('CEP');
      return { data: endereco };
    },
  );
}

interface RespostaViaCep {
  erro?: boolean | string;
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
}

async function consultar(
  cep: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<EnderecoDeCep | null> {
  let resposta: Response;
  try {
    resposta = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      /* Prazo curto: a tela está esperando enquanto a pessoa digita, e
         um endereço que demora cinco segundos para chegar é pior que um
         campo que ela preenche à mão. Sem timeout, uma indisponibilidade
         do serviço externo seguraria uma conexão nossa até o limite do
         sistema operacional. */
      signal: AbortSignal.timeout(3_000),
      headers: { Accept: 'application/json' },
    });
  } catch (erro) {
    /* Serviço externo fora do ar não é erro DESTE sistema. Devolvemos
       "não encontrei" e a pessoa digita o endereço à mão, que é o que
       ela faria de qualquer forma. Derrubar o cadastro inteiro porque os
       Correios estão instáveis seria transformar a comodidade em
       dependência. */
    log.warn({ erro: String(erro) }, 'consulta de CEP falhou');
    return null;
  }

  if (!resposta.ok) return null;

  const corpo = (await resposta.json().catch(() => null)) as unknown;
  return interpretarViaCep(cep, corpo);
}

/**
 * Traduz a resposta do serviço externo para o nosso formato.
 *
 * SEPARADA DA CHAMADA DE REDE de propósito: é aqui que mora tudo o que
 * pode dar errado de forma silenciosa — o `{"erro": true}` que vem com
 * status 200, o campo em branco que não é o mesmo que ausente, a UF que
 * chega fora do formato que o banco aceita. Uma função pura pode ser
 * exercitada sem internet, e é por isso que o teste desta rota não
 * depende de os Correios estarem no ar.
 */
export function interpretarViaCep(cep: string, corpo: unknown): EnderecoDeCep | null {
  if (corpo === null || typeof corpo !== 'object') return null;
  const c = corpo as RespostaViaCep;

  /* O serviço responde 200 com `{"erro": true}` para CEP inexistente.
     Aceita `true` e `"true"`: a API já devolveu as duas formas. */
  if (c.erro === true || c.erro === 'true') return null;

  const uf = texto(c.uf);
  const achado: EnderecoDeCep = {
    cep,
    logradouro: texto(c.logradouro),
    bairro: texto(c.bairro),
    cidade: texto(c.localidade),
    /* A sigla é a única coisa que o banco restringe (char(2)). Vem
       maiúscula e com duas letras, ou não vem. */
    uf: uf !== null && /^[A-Za-z]{2}$/.test(uf) ? uf.toUpperCase() : null,
  };

  /* Resposta sem cidade não é endereço: é um objeto vazio com status
     200, que o serviço devolve em algumas falhas internas. Preencher a
     tela com quatro campos em branco pareceria "encontrei e está vazio",
     quando o certo é "não encontrei, digite à mão". */
  if (achado.cidade === null && achado.bairro === null && achado.logradouro === null) {
    return null;
  }
  return achado;
}

/** Campo ausente e campo em branco são a mesma coisa: não preenchido. */
function texto(v: string | undefined): string | null {
  const limpo = (v ?? '').trim();
  return limpo === '' ? null : limpo;
}

/* Exportado só para o teste poder limpar entre casos. */
export function limparCacheDeCep(): void {
  cache.clear();
}
