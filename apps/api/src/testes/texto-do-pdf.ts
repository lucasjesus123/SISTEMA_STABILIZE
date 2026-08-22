import zlib from 'node:zlib';

/**
 * O texto legível de dentro de um PDF — para os testes conferirem o que
 * o documento REALMENTE diz, e não só que ele tem 200 e começa com %PDF.
 *
 * Mora fora dos arquivos de teste porque a versão anterior era copiada
 * em três deles, e o defeito abaixo estava nas três cópias.
 *
 * ------------------------------------------------------------------
 * O DEFEITO QUE ESTA VERSÃO CONSERTA — e por que ele era grave
 *
 * A versão antiga achava o fim do fluxo procurando o delimitador:
 *
 *     /stream\r?\n([\s\S]*?)\r?\nendstream/
 *
 * O `\r?` do FIM é a armadilha. O pdfkit escreve os bytes comprimidos e
 * depois `\nendstream`. Quando o último byte dos DADOS calha de ser
 * 0x0D — um `\r`, que em dado comprimido é um byte como outro qualquer
 * — o `\r?` o engole como se fosse parte do delimitador, e a captura sai
 * com UM BYTE A MENOS. Medido no documento capturado: o objeto declara
 * `/Length 1029` e a expressão devolvia 1028. O `inflate` então falha
 * com "unexpected end of file", o `catch` engolia, e a extração inteira
 * voltava VAZIA.
 *
 * Acontece em ~1 de cada 256 documentos. Parecia aleatório e "sob
 * carga", mas não é: o rodapé carrega "emitido em DD/MM/AAAA HH:MM", o
 * PDF é idêntico byte a byte dentro do mesmo minuto, e por isso a falha
 * vinha em BLOCOS — todo teste daquele minuto quebrava, e no minuto
 * seguinte sarava sozinha.
 *
 * O ALARME FALSO ERA O LADO BOM. O lado ruim é que metade das
 * verificações destes PDFs é do tipo `not.toContain` — a recepção NÃO
 * pode receber o histórico clínico, a academia Beta NÃO pode ver o nome
 * da Alfa. Com a extração vazia, essas asserções passam SEM PROVAR
 * NADA. Um vazamento de verdade passaria despercebido no minuto errado.
 *
 * Daí as duas decisões desta versão:
 *   1. O tamanho vem do `/Length` declarado no objeto, que é a fonte
 *      autoritativa, e não de procurar um delimitador dentro de dado
 *      binário.
 *   2. Extração vazia LEVANTA ERRO. Um teste de vazamento não pode
 *      passar por não ter conseguido ler o documento.
 */
export function textoDoPdf(pdf: Buffer): string {
  const { fluxos, inflados, falhas } = fluxosInflados(pdf);
  const partes: string[] = [];

  for (const inflado of inflados) {
    /* SÓ FLUXO DE CONTEÚDO. O corpo de uma imagem também infla, e
       varrer 1,4 MB de pixel atrás de `<hex>` acha sequências que
       parecem texto e sujam o resultado. */
    if (!inflado.includes('Tj') && !inflado.includes('TJ')) continue;

    for (const bloco of inflado.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      partes.push(Buffer.from(bloco[1]!, 'hex').toString('latin1'));
    }
  }

  const saida = partes.join('');
  if (saida === '') {
    throw new Error(
      `nao foi possivel extrair texto do PDF (${pdf.length} bytes, ` +
        `${fluxos} fluxo(s), ${falhas} sem inflar). Uma extracao vazia faria ` +
        `toda assercao "not.toContain" passar sem provar nada.`,
    );
  }
  return saida;
}

/** Quantas vezes uma imagem é DESENHADA (operador `Do`) no documento. */
export function desenhosDeImagem(pdf: Buffer): number {
  let total = 0;
  for (const inflado of fluxosInflados(pdf).inflados) {
    total += [...inflado.matchAll(/\/I\d+\s+Do/g)].length;
  }
  return total;
}

/**
 * Cada fluxo do PDF que abriu com sucesso.
 *
 * É aqui que mora o cuidado com o `/Length` — as duas leituras acima
 * dependem dele, e é por isso que a fatia não é repetida em cada uma.
 */
function fluxosInflados(pdf: Buffer): { fluxos: number; inflados: string[]; falhas: number } {
  const bruto = pdf.toString('latin1');
  const inflados: string[] = [];
  let fluxos = 0;
  let falhas = 0;

  const abertura = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = abertura.exec(bruto)) !== null) {
    /* "endstream" termina em "stream" e casaria aqui. O byte anterior
       decide: num começo de fluxo de verdade vem `>>\n`, nunca um "d". */
    if (bruto.slice(Math.max(0, m.index - 3), m.index).endsWith('d')) continue;

    const inicio = m.index + m[0].length;
    fluxos += 1;

    const dados = fatiar(pdf, bruto, inicio);
    if (dados === undefined) {
      falhas += 1;
      continue;
    }

    try {
      inflados.push(zlib.inflateSync(dados).toString('latin1'));
    } catch {
      /* Fontes e imagens nem sempre são Flate — não é erro. */
      falhas += 1;
    }
  }

  return { fluxos, inflados, falhas };
}

/**
 * Os bytes do fluxo que começa em `inicio`.
 *
 * Preferimos o `/Length` declarado logo acima do `stream`. Só quando ele
 * não aparece — objeto com tamanho indireto — caímos na busca pelo
 * delimitador, e aí SEM `\r?`, para não repetir o furo de um byte.
 */
function fatiar(pdf: Buffer, bruto: string, inicio: number): Buffer | undefined {
  const cabecalho = bruto.slice(Math.max(0, inicio - 400), inicio);
  /* `/Length1` é outra coisa (tamanho da fonte descomprimida): o espaço
     obrigatório depois de "Length" já o descarta. */
  const achados = [...cabecalho.matchAll(/\/Length (\d+)/g)];
  const ultimo = achados[achados.length - 1];
  if (ultimo !== undefined) {
    const n = Number(ultimo[1]);
    if (n > 0 && inicio + n <= pdf.length) return pdf.subarray(inicio, inicio + n);
  }

  const fim = bruto.indexOf('\nendstream', inicio);
  if (fim === -1) return undefined;
  return pdf.subarray(inicio, fim);
}
