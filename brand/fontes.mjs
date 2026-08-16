/*
 * Baixa as fontes do Google e as guarda no projeto.
 *
 * POR QUE NÃO USAR O <link> DO GOOGLE FONTS:
 *
 * 1. OFFLINE. O aplicativo do aluno é instalável e precisa abrir sem
 *    sinal. Com a fonte vindo de fonts.gstatic.com, toda abertura sem
 *    rede começa com uma requisição que falha e o texto reflui quando
 *    desiste. Verificado recarregando sem rede: ERR_INTERNET_DISCONNECTED
 *    para fonts.googleapis.com em toda abertura.
 *
 * 2. PRIVACIDADE. Cada carregamento entrega a um terceiro o IP do aluno,
 *    o User-Agent e o Referer — que é o endereço do sistema de saúde que
 *    ele está usando. Não é dado clínico, mas é metadado de uso de um
 *    serviço de saúde, saindo para fora sem necessidade nenhuma. Um
 *    tribunal alemão já tratou exatamente esse embed como violação de
 *    proteção de dados (LG München I, 3 O 17493/20).
 *
 * 3. CADEIA DE SUPRIMENTOS. Um <link> para um domínio de terceiro é
 *    execução de CSS remoto na origem do sistema, a cada carregamento,
 *    sem verificação de integridade.
 *
 * Rodar de novo só é necessário para trocar de fonte ou de peso:
 *   node brand/fontes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = path.join(RAIZ, 'apps/web/public/fontes');

/* User-Agent de navegador moderno: é o que faz o Google devolver woff2,
   que é metade do tamanho do woff. Com o UA padrão do Node ele responde
   com formatos legados. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FAMILIAS = [
  { css: 'Outfit:wght@300;400;500;600', nome: 'Outfit' },
  { css: 'Source+Sans+3:wght@400;500;600;700', nome: 'SourceSans3' },
];

/* Só latino. O português usa ã, õ, ç, é — todos no bloco `latin`; o
   `latin-ext` cobre o resto das línguas europeias e custa pouco. Grego,
   cirílico e vietnamita seriam 60% do peso para zero uso. */
const SUBCONJUNTOS = new Set(['latin', 'latin-ext']);

fs.mkdirSync(DESTINO, { recursive: true });

const regras = [];
/** familia|subconjunto → o único arquivo daquele par, e os pesos que ele cobre. */
const porArquivo = new Map();

for (const familia of FAMILIAS) {
  const resposta = await fetch(
    `https://fonts.googleapis.com/css2?family=${familia.css}&display=swap`,
    { headers: { 'User-Agent': UA } },
  );
  if (!resposta.ok) throw new Error(`CSS de ${familia.nome}: HTTP ${resposta.status}`);
  const css = await resposta.text();

  /* O CSS vem em blocos, cada um precedido por um comentário com o nome
     do subconjunto: `/* latin *​/ @font-face { ... }`. */
  const blocos = css.split('/*').slice(1);

  for (const bloco of blocos) {
    const subconjunto = bloco.slice(0, bloco.indexOf('*/')).trim();
    if (!SUBCONJUNTOS.has(subconjunto)) continue;

    const peso = /font-weight:\s*(\d+)/.exec(bloco)?.[1];
    const estilo = /font-style:\s*(\w+)/.exec(bloco)?.[1] ?? 'normal';
    const url = /url\((https:[^)]+\.woff2)\)/.exec(bloco)?.[1];
    const unicode = /unicode-range:\s*([^;]+);/.exec(bloco)?.[1];
    if (peso === undefined || url === undefined) continue;

    /* UM ARQUIVO POR SUBCONJUNTO, não um por peso.
       As duas famílias são variáveis: o Google devolve a MESMA URL para
       os quatro pesos, e a primeira versão deste script gravava quatro
       cópias byte a byte idênticas de cada arquivo — 540 KB de fonte
       onde bastavam 135 KB. Uma regra `@font-face` com FAIXA de peso
       (`font-weight: 300 600`) é como fonte variável se declara: o
       navegador baixa uma vez e interpola a espessura que a página
       pedir. */
    const chave = `${familia.nome}|${subconjunto}`;
    const anterior = porArquivo.get(chave);
    if (anterior !== undefined) {
      anterior.pesos.push(Number(peso));
      continue;
    }
    porArquivo.set(chave, {
      familia,
      subconjunto,
      estilo,
      url,
      unicode,
      pesos: [Number(peso)],
    });
  }
}

for (const face of porArquivo.values()) {
  const arquivo = `${face.familia.nome}-${face.subconjunto}.woff2`;
  const bytes = Buffer.from(
    await (await fetch(face.url, { headers: { 'User-Agent': UA } })).arrayBuffer(),
  );
  fs.writeFileSync(path.join(DESTINO, arquivo), bytes);
  const menor = Math.min(...face.pesos);
  const maior = Math.max(...face.pesos);
  console.log(`${arquivo.padEnd(30)} ${String(bytes.length).padStart(6)} bytes  ${menor}–${maior}`);

  regras.push(
    [
      '@font-face {',
      `  font-family: '${face.familia.nome === 'SourceSans3' ? 'Source Sans 3' : face.familia.nome}';`,
      `  font-style: ${face.estilo};`,
      `  font-weight: ${menor === maior ? menor : `${menor} ${maior}`};`,
      /* `swap` mostra o texto na fonte do sistema enquanto a definitiva
         carrega. Texto invisível esperando fonte é a pior troca
         possível numa tela de trabalho. */
      '  font-display: swap;',
      `  src: url('/fontes/${arquivo}') format('woff2-variations');`,
      face.unicode === undefined ? null : `  unicode-range: ${face.unicode};`,
      '}',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  );
}

const cabecalho = `/* =====================================================================
   Fontes SERVIDAS PELO PRÓPRIO SISTEMA.

   ARQUIVO GERADO por brand/fontes.mjs — não edite à mão.

   O motivo de não usar o <link> do Google está no cabeçalho daquele
   script: abrir sem rede, não entregar o IP do aluno a terceiro a cada
   carregamento, e não executar CSS remoto na nossa origem.
   ===================================================================== */

`;

fs.writeFileSync(path.join(RAIZ, 'apps/web/src/fontes.css'), cabecalho + regras.join('\n\n') + '\n');
console.log(`\n${regras.length} regras @font-face em apps/web/src/fontes.css`);
