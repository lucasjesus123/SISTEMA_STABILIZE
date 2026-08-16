/*
 * Service worker do Stabilize.
 *
 * O QUE ELE FAZ: guarda a casca do aplicativo (HTML, JS, CSS, ícones,
 * fonte) para que abrir o atalho da tela de início pinte a interface na
 * hora, mesmo no elevador da academia, sem sinal. É a diferença entre
 * "abriu" e "está carregando".
 *
 * O QUE ELE DELIBERADAMENTE NÃO FAZ: tocar em /api.
 *
 *   Esta é a decisão mais importante do arquivo. Guardar resposta de API
 *   significaria gravar no disco do celular o treino, a agenda e os dados
 *   de saúde do aluno — em um armazenamento que sobrevive ao logout, que
 *   não é apagado ao trocar de usuário e que nenhuma tela do sistema
 *   consegue limpar. O ganho seria ver a tela de ontem offline; o custo
 *   seria dado clínico persistido fora do controle da aplicação.
 *
 *   Então: requisição para /api passa direto, sem cache, sempre. Se não
 *   há rede, a tela mostra o estado vazio e o aluno entende que está
 *   offline — que é a verdade.
 *
 * Também não intercepta nada que não seja GET de mesma origem: POST,
 * DELETE e requisições a outras origens seguem o caminho normal do
 * navegador.
 */

const VERSAO = 'stz-v1';
const CASCA = `casca-${VERSAO}`;

/* O que dá para prever antes do primeiro acesso. */
const ESSENCIAIS = [
  '/',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icone-192.png',
  '/apple-touch-icon.png',
  /* As fontes do bloco latino. Sem elas o aplicativo offline abre na
     fonte do sistema e TODO o texto reflui — o tipo de detalhe que faz
     parecer página quebrada em vez de aplicativo. As de `latin-ext`
     ficam de fora: entram no cache se algum texto precisar delas. */
  '/fontes/Outfit-latin.woff2',
  '/fontes/SourceSans3-latin.woff2',
];

/*
 * O JS e o CSS têm nome com hash gerado pela build (index-a1b2c3.js), e
 * não dá para escrevê-los aqui: um nome errado derrubaria o install
 * inteiro, e acertá-los exigiria um passo de build gerando este arquivo.
 *
 * Então o service worker LÊ o index.html e tira os nomes de lá.
 *
 * Isso não é preciosismo. Sem este passo, a primeira instalação guardava
 * a casca mas nenhum dos pacotes: o registro acontece no evento `load`,
 * ou seja, DEPOIS de o navegador já ter buscado o JS e o CSS, então eles
 * nunca passavam pelo `fetch` do worker. Offline, o HTML era servido do
 * cache, os pacotes não existiam e a tela ficava EM BRANCO — pior que o
 * erro do navegador, porque parece aplicativo quebrado em vez de falta
 * de sinal. Verificado recarregando sem rede.
 */
async function guardarPacotes(cache) {
  const resposta = await fetch('/', { cache: 'reload' });
  if (!resposta.ok) return;
  const html = await resposta.text();
  const nomes = new Set();
  for (const [, url] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    nomes.add(url);
  }
  await cache.addAll([...nomes]);
}

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches
      .open(CASCA)
      .then(async (cache) => {
        await cache.addAll(ESSENCIAIS);
        /* Falhar aqui não pode abortar a instalação: sem os pacotes o
           aplicativo ainda funciona com rede, e eles entram no cache na
           primeira vez que forem pedidos. */
        await guardarPacotes(cache).catch(() => undefined);
      })
      /* A versão nova assume sem esperar o fechamento de todas as abas.
         Em um aplicativo de tela cheia "todas as abas" é a única aba, e
         ela pode ficar aberta por semanas no celular. */
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((nomes) =>
        Promise.all(nomes.filter((nome) => nome !== CASCA).map((nome) => caches.delete(nome))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (evento) => {
  const requisicao = evento.request;
  if (requisicao.method !== 'GET') return;

  const url = new URL(requisicao.url);
  if (url.origin !== self.location.origin) return;

  // Dado do aluno nunca encosta no disco. Ver o cabeçalho do arquivo.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  /* Navegação (abrir o aplicativo, recarregar): tenta a rede primeiro,
     porque uma versão nova do sistema deve aparecer assim que existir.
     Sem rede, serve a casca guardada — o React sobe e pede os dados. */
  if (requisicao.mode === 'navigate') {
    evento.respondWith(
      fetch(requisicao)
        .then((resposta) => {
          const copia = resposta.clone();
          caches.open(CASCA).then((cache) => cache.put('/', copia));
          return resposta;
        })
        .catch(() => caches.match('/').then((guardada) => guardada ?? Response.error())),
    );
    return;
  }

  /* Recursos com hash no nome (/assets/index-a1b2c3.js) são imutáveis:
     se o conteúdo mudar, o nome muda. Cache primeiro, sem revalidar, é
     correto e é o que deixa a abertura instantânea. */
  /* A BUSCA É PELA URL, não pelo objeto Request.
     `caches.match(requisicao)` errava o alvo justamente quando mais
     importa: numa recarga, o navegador emite os pedidos de subrecurso
     com `cache: 'reload'`, e a busca com esse Request devolvia
     `undefined` mesmo com o arquivo guardado — `caches.match(url)` no
     mesmo instante o encontrava. O efeito era o pior possível: sem rede
     o HTML vinha do cache mas o JS e o CSS falhavam, e o aplicativo
     abria com a TELA EM BRANCO, que parece defeito e não falta de
     sinal. `ignoreVary` remove a outra fonte de erro pelo mesmo motivo:
     nada aqui é negociado por cabeçalho. */
  evento.respondWith(
    caches.match(url.pathname + url.search, { ignoreVary: true }).then((guardada) => {
      if (guardada !== undefined) return guardada;
      return fetch(requisicao).then((resposta) => {
        /* Só guarda o que veio inteiro e da nossa origem. `type` opaco
           (resposta de outra origem sem CORS) não dá para inspecionar —
           guardar às cegas enche a cota com lixo. */
        if (resposta.ok && resposta.type === 'basic') {
          const copia = resposta.clone();
          caches.open(CASCA).then((cache) => cache.put(requisicao, copia));
        }
        return resposta;
      });
    }),
  );
});

/* Sair da conta apaga a casca guardada. A casca não tem dado pessoal,
   mas se o aparelho é compartilhado — e na academia é — o próximo a
   entrar não deve herdar nem a versão do aplicativo do anterior. */
self.addEventListener('message', (evento) => {
  if (evento.data === 'stz:limpar') {
    evento.waitUntil(caches.keys().then((nomes) => Promise.all(nomes.map((n) => caches.delete(n)))));
  }
});
