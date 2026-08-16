/*
 * Gera os ícones PNG do aplicativo a partir do SVG do símbolo.
 *
 * POR QUE PNG, se o SVG é melhor em tudo?
 *   Porque quem consome estes arquivos não é um navegador desenhando uma
 *   página: é o Android montando o ícone da gaveta de aplicativos e o iOS
 *   montando o atalho da tela de início. O iOS ignora `manifest.icons` em
 *   SVG e o Android só aceita SVG a partir de versões recentes do Chrome.
 *   Ícone que não aparece derruba a ilusão de aplicativo antes mesmo da
 *   primeira tela.
 *
 * O RENDERIZADOR é o próprio Chromium (via Playwright), não uma biblioteca
 * de conversão. O objetivo é que o ícone seja exatamente o que o navegador
 * desenharia — mesmo motor, mesmo resultado.
 *
 * Uso:  node brand/icones.mjs
 */
import { chromium } from '/root/.npm/_npx/705bc6b22212b352/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = path.join(RAIZ, 'apps/web/public');

const simbolo = fs.readFileSync(path.join(RAIZ, 'apps/web/public/favicon.svg'), 'utf8');

/* O fundo dos ícones é o --superficie do tema escuro. O símbolo é claro;
   sobre fundo claro ele some no ícone do iOS, que não respeita
   transparência e pinta preto por baixo. */
const FUNDO = '#0a1213';

/* Máscara adaptativa (Android): o sistema recorta o ícone em círculo, em
   losango ou em "squircle", à escolha do fabricante. Só os 80% centrais
   sobrevivem com certeza — a "zona segura". Desenhar o símbolo a 60% da
   largura deixa folga confortável dentro dela. */
const ALVOS = [
  { arquivo: 'icone-192.png', lado: 192, escala: 0.78, fundo: FUNDO },
  { arquivo: 'icone-512.png', lado: 512, escala: 0.78, fundo: FUNDO },
  { arquivo: 'icone-mascara-512.png', lado: 512, escala: 0.6, fundo: FUNDO },
  { arquivo: 'apple-touch-icon.png', lado: 180, escala: 0.72, fundo: FUNDO },
];

const navegador = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

for (const alvo of ALVOS) {
  const pagina = await navegador.newPage({
    viewport: { width: alvo.lado, height: alvo.lado },
    deviceScaleFactor: 1,
  });
  await pagina.setContent(
    `<!doctype html><html><body style="margin:0;background:${alvo.fundo};
       width:${alvo.lado}px;height:${alvo.lado}px;
       display:flex;align-items:center;justify-content:center">
       <div style="width:${Math.round(alvo.lado * alvo.escala)}px;line-height:0">${simbolo}</div>
     </body></html>`,
  );
  await pagina.screenshot({ path: path.join(DESTINO, alvo.arquivo), omitBackground: false });
  await pagina.close();
  const bytes = fs.statSync(path.join(DESTINO, alvo.arquivo)).size;
  console.log(`${alvo.arquivo.padEnd(24)} ${alvo.lado}x${alvo.lado}  ${bytes} bytes`);
}

await navegador.close();
