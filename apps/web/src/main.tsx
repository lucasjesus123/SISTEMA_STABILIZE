import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './fontes.css';
import './theme.css';
import './app.css';
import './app-aluno.css';

const raiz = document.getElementById('root');
if (raiz === null) {
  throw new Error('elemento #root não encontrado no documento');
}

createRoot(raiz).render(
  <StrictMode>
    <App />
  </StrictMode>,
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
