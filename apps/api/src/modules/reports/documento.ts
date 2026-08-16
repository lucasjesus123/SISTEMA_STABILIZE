import PDFDocument from 'pdfkit';

/**
 * A folha em que todo relatório do sistema é impresso.
 *
 * POR QUE PDF GERADO NO SERVIDOR, e não "imprimir a tela".
 *
 * Um relatório de prontuário sai da academia: vai por e-mail para o
 * aluno, para o convênio, para o advogado. Precisa de um arquivo estável
 * — que abra igual em qualquer máquina, daqui a dois anos — e não do que
 * o navegador de quem clicou resolveu desenhar naquele dia. Também não
 * pode passar por serviço de terceiro: é dado de saúde.
 *
 * O DESENHO SEGUE O SISTEMA, sem imitá-lo. Papel não tem tema escuro,
 * não tem hover e não tem neon. O que atravessa é a estrutura: fios em
 * vez de caixas, hierarquia por peso e espaço, números tabulares
 * alinhados à direita.
 *
 * RODAPÉ COM IDENTIFICAÇÃO EM TODA PÁGINA. Um relatório impresso se
 * separa: alguém tira a primeira folha, o resto circula. Sem o nome do
 * aluno e a data em cada página, a terceira folha de um prontuário é um
 * papel anônimo com dado clínico dentro.
 */

/* Cores do arquivo de marca, as mesmas do sistema. */
const GRAFITE = '#3b3f40';
const APOIO = '#6b7276';
const MENTA = '#4cc2c8';
const FIO = '#d9e0e2';

const MARGEM = 48;
const LARGURA_UTIL = 595.28 - MARGEM * 2; // A4 retrato

export interface Cabecalho {
  titulo: string;
  subtitulo?: string | undefined;
  academia: string;
  /** Identificação que se repete no rodapé de todas as páginas. */
  rodape: string;
}

export type Documento = InstanceType<typeof PDFDocument>;

export function abrirDocumento(info: Cabecalho): Documento {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGEM, bottom: MARGEM + 20, left: MARGEM, right: MARGEM },
    info: {
      Title: info.titulo,
      Author: info.academia,
      Creator: 'Stabilize',
    },
    /* `bufferPages` permite voltar às páginas anteriores no fim para
       numerá-las. Sem isso não dá para escrever "3 de 7": na hora de
       desenhar a página 3 ainda não se sabe que existirão sete. */
    bufferPages: true,
  });

  desenharCabecalho(doc, info);
  return doc;
}

function desenharCabecalho(doc: Documento, info: Cabecalho): void {
  /* A LINHA DA ACADEMIA VEM PRIMEIRO, e o cursor é reposicionado à mão
     depois dela.

     Na primeira versão ela era desenhada DEPOIS do título, com um `y`
     explícito acima — e o pdfkit deixava o cursor lá em cima. O bloco
     seguinte (os indicadores) era então desenhado por cima do título.
     Os testes não pegaram: o PDF era válido e continha todo o texto.
     Só apareceu ao abrir o arquivo. */
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MENTA)
    .text(info.academia.toUpperCase(), MARGEM, MARGEM, {
      width: LARGURA_UTIL,
      align: 'right',
      characterSpacing: 1.2,
    });

  doc.y = MARGEM + 14;

  doc
    .font('Helvetica-Bold')
    .fontSize(17)
    .fillColor(GRAFITE)
    .text(info.titulo, MARGEM, doc.y, { width: LARGURA_UTIL });

  if (info.subtitulo !== undefined) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(APOIO)
      .text(info.subtitulo, MARGEM, doc.y + 2, { width: LARGURA_UTIL });
  }

  doc.moveDown(0.8);
  fio(doc);
  doc.moveDown(0.8);
}

/** Fio horizontal — a única "borda" que este desenho usa. */
export function fio(doc: Documento, cor = FIO): void {
  const y = doc.y;
  doc
    .save()
    .strokeColor(cor)
    .lineWidth(0.5)
    .moveTo(MARGEM, y)
    .lineTo(MARGEM + LARGURA_UTIL, y)
    .stroke()
    .restore();
  doc.y = y + 1;
}

export function secao(doc: Documento, titulo: string): void {
  garantirEspaco(doc, 60);
  doc.moveDown(0.7);
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(APOIO)
    .text(titulo.toUpperCase(), MARGEM, doc.y, { characterSpacing: 1 });
  doc.moveDown(0.35);
}

/** Rótulo à esquerda, valor à direita — a linha básica de toda ficha. */
export function linha(doc: Documento, rotulo: string, valor: string | null): void {
  garantirEspaco(doc, 20);
  const y = doc.y;
  doc.font('Helvetica').fontSize(9.5).fillColor(APOIO).text(rotulo, MARGEM, y, { width: 150 });
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(GRAFITE)
    /* Traço quando vazio, como na tela: campo em branco parece falha de
       geração e faz a pessoa pedir o relatório de novo. */
    .text(valor === null || valor.trim() === '' ? '—' : valor, MARGEM + 158, y, {
      width: LARGURA_UTIL - 158,
    });
  doc.y = Math.max(doc.y, y) + 3;
}

/** Bloco de texto corrido (evolução, anamnese). */
export function paragrafo(doc: Documento, texto: string): void {
  garantirEspaco(doc, 40);
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(GRAFITE)
    .text(texto, MARGEM, doc.y, { width: LARGURA_UTIL, align: 'left', lineGap: 2 });
  doc.moveDown(0.4);
}

export interface Coluna {
  titulo: string;
  largura: number;
  /** Números vão à direita: é o que permite comparar valores de relance. */
  direita?: boolean;
}

export function tabela(doc: Documento, colunas: Coluna[], linhas: string[][]): void {
  const desenharTitulos = (): void => {
    let x = MARGEM;
    const y = doc.y;
    for (const c of colunas) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(APOIO)
        .text(c.titulo.toUpperCase(), x, y, {
          width: c.largura,
          align: c.direita === true ? 'right' : 'left',
        });
      x += c.largura;
    }
    doc.y = y + 13;
    fio(doc);
    doc.y += 4;
  };

  desenharTitulos();

  for (const l of linhas) {
    /* Quebra de página REPETE os títulos. Uma tabela que continua na
       página seguinte sem cabeçalho vira uma grade de números sem
       significado — e é o erro mais comum de relatório impresso. */
    if (doc.y > doc.page.height - 80) {
      doc.addPage();
      desenharTitulos();
    }

    let x = MARGEM;
    const y = doc.y;
    let alturaMaxima = 0;

    for (let i = 0; i < colunas.length; i += 1) {
      const c = colunas[i]!;
      const texto = l[i] ?? '';
      doc.font('Helvetica').fontSize(9).fillColor(GRAFITE);
      const altura = doc.heightOfString(texto, { width: c.largura });
      doc.text(texto, x, y, {
        width: c.largura,
        align: c.direita === true ? 'right' : 'left',
      });
      alturaMaxima = Math.max(alturaMaxima, altura);
      x += c.largura;
    }

    doc.y = y + alturaMaxima + 5;
    fio(doc, '#eef2f3');
    doc.y += 3;
  }
}

/** Destaques numéricos lado a lado, como os KPIs da tela. */
export function indicadores(doc: Documento, itens: { rotulo: string; valor: string }[]): void {
  garantirEspaco(doc, 60);
  const largura = LARGURA_UTIL / itens.length;
  const y = doc.y;

  itens.forEach((item, i) => {
    const x = MARGEM + largura * i;
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(APOIO)
      .text(item.rotulo.toUpperCase(), x, y, { width: largura - 8, characterSpacing: 0.8 });
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(GRAFITE)
      .text(item.valor, x, y + 12, { width: largura - 8 });
  });

  doc.y = y + 36;
  fio(doc);
  doc.y += 4;
}

function garantirEspaco(doc: Documento, altura: number): void {
  if (doc.y + altura > doc.page.height - 70) doc.addPage();
}

/**
 * Fecha o documento numerando as páginas e repetindo a identificação.
 *
 * Precisa ser o último passo: só aqui se sabe quantas páginas existem.
 */
export function fecharDocumento(doc: Documento, info: Cabecalho): void {
  const faixa = doc.bufferedPageRange();
  const emitidoEm = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  for (let i = 0; i < faixa.count; i += 1) {
    doc.switchToPage(faixa.start + i);

    /* ZERAR A MARGEM INFERIOR ANTES DE ESCREVER O RODAPÉ.

       Escrever abaixo da margem faz o pdfkit criar uma página nova para
       acomodar o texto — e o relatório saía com uma folha em branco no
       fim, contendo só o rodapé. O `y` explícito não evita isso; a
       margem é que manda. */
    const margemOriginal = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - 42;
    doc.save().strokeColor(FIO).lineWidth(0.5).moveTo(MARGEM, y).lineTo(MARGEM + LARGURA_UTIL, y).stroke().restore();

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(APOIO)
      .text(`${info.rodape} · emitido em ${emitidoEm}`, MARGEM, y + 6, {
        width: LARGURA_UTIL - 80,
        lineBreak: false,
      });

    doc.text(`${i + 1} de ${faixa.count}`, MARGEM + LARGURA_UTIL - 80, y + 6, {
      width: 80,
      align: 'right',
      lineBreak: false,
    });

    doc.page.margins.bottom = margemOriginal;
  }

  doc.end();
}

/** Junta o documento num Buffer, para a resposta HTTP. */
export function paraBuffer(doc: Documento): Promise<Buffer> {
  return new Promise((resolver, rejeitar) => {
    const pedacos: Buffer[] = [];
    doc.on('data', (p: Buffer) => pedacos.push(p));
    doc.on('end', () => resolver(Buffer.concat(pedacos)));
    doc.on('error', rejeitar);
  });
}
