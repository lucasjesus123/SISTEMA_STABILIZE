import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, unavailable } from '../../http/errors.js';

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

/* ---------------------------------------------------------------------
   DISJUNTOR — o que fazer quando o serviço externo está fora

   O timeout de 3s já impede que uma consulta segure a conexão para
   sempre. O que ele NÃO resolve é o serviço fora do ar por um tempo
   longo: cada CEP digitado paga os 3 segundos inteiros de novo. No dia
   em que a academia cadastra duzentos alunos, isso é duzentas esperas
   de três segundos num campo que já se sabe que não vai responder — e
   a recepção conclui que o sistema é lento, não que os Correios caíram.

   A indisponibilidade de propósito NÃO entra no cache de CEP (guardar
   "não sei" ao lado de "não existe" foi um defeito real deste arquivo).
   O disjuntor é outra coisa: não guarda resposta nenhuma, guarda o
   ESTADO DO SERVIÇO. Depois de algumas falhas seguidas, as próximas
   consultas voltam na hora com "não consegui perguntar", sem sair para
   a rede.

   Meia janela depois ele deixa UMA consulta passar para sondar. Se ela
   volta, o disjuntor fecha e tudo segue como antes; se falha, a janela
   recomeça. Qualquer sucesso zera o contador — o estado normal é o
   circuito fechado.
   ------------------------------------------------------------------ */
const FALHAS_PARA_ABRIR = 3;
const JANELA_ABERTO_MS = 60 * 1000;

const disjuntor = { falhasSeguidas: 0, abertoAte: 0 };

/** true = nem tenta a rede, o serviço está reconhecidamente fora. */
function circuitoAberto(agora: number): boolean {
  return disjuntor.abertoAte > agora;
}

function registrarFalha(agora: number): void {
  disjuntor.falhasSeguidas += 1;
  if (disjuntor.falhasSeguidas >= FALHAS_PARA_ABRIR) {
    disjuntor.abertoAte = agora + JANELA_ABERTO_MS;
  }
}

function registrarSucesso(): void {
  disjuntor.falhasSeguidas = 0;
  disjuntor.abertoAte = 0;
}

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

      /* NÃO CONSEGUIR CONSULTAR NÃO É "NÃO EXISTE", e esta distinção não
         é preciosismo — era um defeito com duas consequências.

         A primeira: a pessoa digitava um CEP correto, o serviço externo
         piscava, e o sistema respondia "CEP não encontrado". Ela então
         duvidava do próprio dado e redigitava, sempre com o mesmo
         resultado.

         A segunda é pior: o "não encontrado" era GUARDADO POR DEZ
         MINUTOS. Uma instabilidade de três segundos fazia um CEP válido
         ser declarado inexistente para todo mundo até o cache expirar.

         Agora a indisponibilidade não entra no cache e tem resposta
         própria, que diz o que fazer. */
      if (endereco === 'indisponivel') {
        throw unavailable(
          'Não consegui consultar o CEP agora. Digite o endereço à mão — depois dá para corrigir.',
        );
      }

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

/**
 * `null` = o serviço respondeu e disse que este CEP não existe.
 * `'indisponivel'` = não deu para perguntar. São coisas diferentes, e
 * misturá-las fazia o sistema afirmar que um CEP válido não existia.
 */
export async function consultarCepParaTeste(
  cep: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<EnderecoDeCep | null | 'indisponivel'> {
  return consultar(cep, log);
}

async function consultar(
  cep: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<EnderecoDeCep | null | 'indisponivel'> {
  const agora = Date.now();

  /* O SERVIÇO JÁ SE MOSTROU FORA. Responder na hora é melhor que fazer
     a recepcionista esperar três segundos para chegar na mesma
     conclusão — a tela dela já diz "preencha à mão". */
  if (circuitoAberto(agora)) return 'indisponivel';

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
    /* Serviço externo fora do ar não é erro DESTE sistema, e também não
       é "CEP inexistente". O cadastro segue sem ele — a pessoa digita o
       endereço à mão, que é o que faria de qualquer forma. */
    registrarFalha(agora);
    log.warn(
      { erro: String(erro), falhasSeguidas: disjuntor.falhasSeguidas },
      'consulta de CEP falhou',
    );
    return 'indisponivel';
  }

  /* 5xx é problema deles; 404 no host inteiro também. Nenhum dos dois
     autoriza afirmar que o CEP não existe. */
  if (!resposta.ok) {
    registrarFalha(agora);
    log.warn(
      { status: resposta.status, falhasSeguidas: disjuntor.falhasSeguidas },
      'consulta de CEP respondeu erro',
    );
    return 'indisponivel';
  }

  /* CHEGOU RESPOSTA: o serviço está de pé. Vale mesmo quando o CEP não
     existe — "não existe" é uma resposta, e resposta é sinal de que o
     circuito pode fechar. */
  registrarSucesso();

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
  disjuntor.falhasSeguidas = 0;
  disjuntor.abertoAte = 0;
}

/** Só para teste: o estado do disjuntor, que não tem rota própria. */
export function estadoDoDisjuntorDeCep(): { falhasSeguidas: number; aberto: boolean } {
  return { falhasSeguidas: disjuntor.falhasSeguidas, aberto: circuitoAberto(Date.now()) };
}
