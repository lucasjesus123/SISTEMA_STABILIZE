import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Plataforma from './Plataforma.jsx';
import './fontes.css';
import './theme.css';
import './app.css';
import './app-aluno.css';
import './plataforma.css';

const raiz = document.getElementById('root');
if (raiz === null) {
  throw new Error('elemento #root não encontrado no documento');
}

/*
 * Duas aplicações, um pacote.
 *
 * `/plataforma` é o painel de quem opera o SERVIÇO; todo o resto é o
 * sistema das ACADEMIAS. Eles não compartilham sessão nem token, e a
 * separação é por caminho porque não há nada a compartilhar entre os
 * dois — nem menu, nem cabeçalho, nem estado.
 *
 * Um roteador seria uma dependência a mais para decidir entre DUAS
 * telas. O Caddy já faz `try_files {path} /index.html`, então qualquer
 * caminho chega aqui e este `startsWith` resolve.
 */
const noPainel = window.location.pathname.startsWith('/plataforma');

createRoot(raiz).render(
  <StrictMode>{noPainel ? <Plataforma /> : <App />}</StrictMode>,
);

/*
 * Instalação do service worker — só na versão publicada.
 *
 * Em desenvolvimento ele atrapalharia: o Vite troca módulos a quente e um
 * cache no meio do caminho serviria a versão anterior do arquivo que
 * acabou de ser editado. Perde-se meia hora procurando um bug já
 * corrigido. `import.meta.env.PROD` resolve isso na build, então o bloco
 * inteiro some do pacote de desenvolvimento.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    /* Falha aqui não é fatal: sem service worker o aplicativo funciona
       igual, só não abre offline. Navegador antigo, aba anônima e origem
       sem HTTPS caem todos neste catch. */
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
