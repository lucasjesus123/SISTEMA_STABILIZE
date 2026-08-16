import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Só no loopback: em desenvolvimento a API e o front rodam na mesma
    // máquina, e expor o dev server na rede é convite desnecessário.
    host: '127.0.0.1',
    proxy: {
      /* O front chama /api e o Vite repassa para a API. Assim o
         navegador vê UMA origem só: o cookie de refresh (SameSite=Strict)
         é enviado normalmente e não há CORS no caminho de
         desenvolvimento. Em produção o proxy reverso faz o mesmo papel. */
      '/api': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: false,
      },
    },
  },
  /* `vite preview` serve o pacote JÁ construído. É o único jeito de
     exercitar localmente o que só existe em produção — o service worker,
     que é desligado em desenvolvimento de propósito (ver main.tsx). Sem
     o mesmo proxy do dev server, a tela de login do pacote de produção
     não teria API para chamar e o teste pararia no primeiro passo. */
  preview: {
    port: 4173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3333', changeOrigin: false },
    },
  },
  build: {
    // Sem source map em produção: ele entrega o código-fonte original,
    // incluindo nomes de função e comentários, para quem abrir o
    // DevTools. Útil em desenvolvimento, desnecessário em produção.
    sourcemap: false,
    target: 'es2022',
  },
});
