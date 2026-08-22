import PDFDocument from 'pdfkit';
import { MARCA_STABILIZE } from './marca-padrao.js';

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

/**
 * A marca da academia no papel.
 *
 * Vem do módulo `academia`, que é a fonte única. Este arquivo só
 * DESENHA — não sabe de banco, não sabe de arquivo em disco, e recebe o
 * logo já em memória. É o que permite testar o timbre sem subir
 * infraestrutura, e o que impede o gerador de PDF virar mais um lugar
 * que consulta o tenant.
 */
export interface Timbre {
  /** PNG ou JPEG já lido. `undefined` = academia sem logo. */
  logo?: Buffer | undefined;
  /** Já formatado para leitura humana: `(51) 99999-9999`. */
  telefone?: string | undefined;
  /** Endereço em uma linha, montado por quem chama. */
  endereco?: string | undefined;
}

export interface Cabecalho {
  titulo: string;
  subtitulo?: string | undefined;
  academia: string;
  /** Identificação que se repete no rodapé de todas as páginas. */
  rodape: string;
  /** Ausente = documento sem marca, e ele sai assim mesmo. */
  timbre?: Timbre | undefined;
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
    /* A PRIMEIRA PÁGINA NÃO NASCE COM O DOCUMENTO, e isso é o que faz a
       marca d'água funcionar.

       O pdfkit cria a página 1 dentro do construtor. Um
       `doc.on('pageAdded')` registrado depois nunca ouviria essa
       primeira — a marca apareceria da página 2 em diante, e o defeito
       passaria em qualquer relatório de uma folha só, que é a maioria.

       Desligando a página automática, o ouvinte é registrado antes de
       existir página alguma e todas passam pelo mesmo caminho. */
    autoFirstPage: false,
  });

  /* A MARCA D'ÁGUA É DESENHADA QUANDO A PÁGINA NASCE, e não no
     fechamento junto com a numeração.

     A tentação é óbvia: o `fecharDocumento` já percorre as páginas para
     numerá-las, e desenhar a marca ali seria uma linha no laço que já
     existe. Estaria errado. O pdfkit pinta na ordem em que se chama, e
     a marca cairia POR CIMA do texto — um relatório bonito com os
     valores atrás de uma imagem. */
  doc.on('pageAdded', () => desenharMarcaDagua(doc, info.timbre));

  doc.addPage();
  desenharCabecalho(doc, info);
  return doc;
}

/* Quanto da largura da folha a marca ocupa. Grande o bastante para ser
   marca d'água e não selo perdido; pequena o bastante para não encostar
   nas margens do texto. */
const MARCA_LARGURA = 0.52;
/* Tinta quase transparente. Acima disto o texto por cima perde
   contraste, e o piso de legibilidade vale no papel como vale na tela. */
const MARCA_OPACIDADE = 0.13;

function desenharMarcaDagua(doc: Documento, timbre: Timbre | undefined): void {
  /* A ACADEMIA QUE NÃO SUBIU LOGO RECEBE A MARCA DA STABILIZE.
     É a marca do fornecedor no papel do cliente, e some no instante em
     que ela sobe a própria — decisão de produto, não recuo técnico.
     Vale só aqui, na marca d'água: o cabeçalho continua levando o NOME
     da academia, porque ali é a identidade de quem assina o documento. */
  const imagem = timbre?.logo ?? MARCA_STABILIZE;

  const largura = doc.page.width * MARCA_LARGURA;
  const x = (doc.page.width - largura) / 2;
  const y = (doc.page.height - largura) / 2;

  /* `save`/`restore` em volta da opacidade: sem isso o resto do
     documento inteiro sairia a 5% de tinta. */
  doc.save().opacity(MARCA_OPACIDADE);
  try {
    doc.image(imagem, x, y, {
      fit: [largura, largura],
      align: 'center',
      valign: 'center',
    });
  } catch {
    /* PNG que o pdfkit não decodifica — entrelaçado, por exemplo. O
       relatório não pode morrer por causa de um enfeite: sai sem marca.
       O upload já recusa formato errado; isto cobre o exótico que passa
       na assinatura e falha no decodificador. */
  }
  doc.restore();

  /* O `image` move o cursor. Sem devolver o `y` ao topo, o conteúdo da
     página começaria no meio da folha, logo abaixo da marca. */
  doc.y = MARGEM;
  doc.x = MARGEM;
}

function desenharCabecalho(doc: Documento, info: Cabecalho): void {
  /* A LINHA DA ACADEMIA VEM PRIMEIRO, e o cursor é reposicionado à mão
     depois dela.

     Na primeira versão ela era desenhada DEPOIS do título, com um `y`
     explícito acima — e o pdfkit deixava o cursor lá em cima. O bloco
     seguinte (os indicadores) era então desenhado por cima do título.
     Os testes não pegaram: o PDF era válido e continha todo o texto.
     Só apareceu ao abrir o arquivo. */
  /* O LOGO À ESQUERDA, O NOME À DIREITA — a divisão de um papel
     timbrado de verdade: quem assina de um lado, como falar com quem
     assina do outro.

     A altura é fixa e a largura livre (`fit` preserva a proporção).
     Fixar a largura em vez da altura faria um logo horizontal e um
     quadrado ocuparem faixas de alturas diferentes, e a linha do nome
     dançaria de academia para academia.

     SEM LOGO PRÓPRIO, ENTRA A MARCA DA STABILIZE — a mesma da marca
     d'água. Decisão de produto do dono do sistema, e ela vale enquanto
     a academia não subir a dela: no instante em que subir, a marca do
     fornecedor some da folha inteira. O nome ao lado continua sendo
     sempre o da academia, então o documento nunca deixa de dizer quem
     assina. */
  const alturaDoLogo = 34;
  const marca = info.timbre?.logo ?? MARCA_STABILIZE;
  let temLogo = false;

  try {
    /* Sem `align`/`valign`: esquerda e topo são o padrão do pdfkit, e
       o tipo dele só aceita os valores que mudam alguma coisa. */
    doc.image(marca, MARGEM, MARGEM - 4, { fit: [150, alturaDoLogo] });
    temLogo = true;
  } catch {
    /* Mesmo raciocínio da marca d'água: enfeite não derruba
       relatório. Cai no cabeçalho de texto, que sempre funciona. */
  }

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MENTA)
    .text(info.academia.toUpperCase(), MARGEM, MARGEM, {
      width: LARGURA_UTIL,
      align: 'right',
      characterSpacing: 1.2,
    });

  /* O telefone acompanha o nome, à direita, como no papel impresso.
     Só quando existe: um rótulo "Telefone" sem número é pior que a
     ausência dele. */
  if (info.timbre?.telefone !== undefined) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(APOIO)
      .text(info.timbre.telefone, MARGEM, MARGEM + 11, {
        width: LARGURA_UTIL,
        align: 'right',
      });
  }

  /* Com logo o cabeçalho é mais alto, e o título precisa descer — senão
     encosta na imagem. Sem logo, a geometria é a de sempre. */
  doc.y = temLogo ? MARGEM + alturaDoLogo + 8 : MARGEM + 14;

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

    /* O CONTATO DA ACADEMIA GANHA UMA SEGUNDA LINHA, e o fio sobe para
       abrir espaço. Sem contato, a geometria continua exatamente a de
       antes: uma academia que ainda não preencheu o endereço não pode
       ver o rodapé dos relatórios dela mudar de lugar. */
    const contato = [info.timbre?.telefone, info.timbre?.endereco]
      .filter((p): p is string => p !== undefined && p !== '')
      .join('  ·  ');

    const y = doc.page.height - (contato === '' ? 42 : 52);
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

    if (contato !== '') {
      doc
        .font('Helvetica')
        .fontSize(6.8)
        .fillColor(APOIO)
        .text(contato, MARGEM, y + 16, { width: LARGURA_UTIL, lineBreak: false });
    }

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

/* --------------------------------------------------------------------
 * Gráficos
 *
 * DESENHADOS À MÃO no próprio PDF, sem biblioteca de gráfico e sem
 * gerar imagem. Duas razões: uma biblioteca de gráfico para servidor
 * arrasta um runtime de navegador inteiro (Chromium headless) só para
 * produzir um PNG de trezentos pixels; e um PNG embutido fica borrado
 * quando alguém imprime ou dá zoom, enquanto linha e retângulo em PDF
 * são vetor e continuam nítidos em qualquer tamanho.
 * ------------------------------------------------------------------ */

export interface PontoDoGrafico {
  rotulo: string;
  valor: number;
}

/**
 * Linha da evolução de uma medida ao longo do tempo.
 *
 * A ESCALA NÃO COMEÇA EM ZERO, e é deliberado. Peso de 74 a 78 kg num
 * eixo que começa em zero vira uma linha reta — a variação que importa
 * some dentro da escala. Começar na faixa dos dados é o que torna a
 * mudança visível, e a legenda diz os extremos para ninguém ler a
 * inclinação como se fosse proporção.
 */
export function graficoDeLinha(
  doc: Documento,
  titulo: string,
  pontos: PontoDoGrafico[],
  formatar: (v: number) => string,
): void {
  if (pontos.length < 2) return;
  garantirEspaco(doc, 150);

  const alturaGrafico = 92;
  const topo = doc.y + 16;
  const esquerda = MARGEM + 46;
  const largura = LARGURA_UTIL - 46;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAFITE).text(titulo, MARGEM, doc.y);

  const valores = pontos.map((p) => p.valor);
  const menor = Math.min(...valores);
  const maior = Math.max(...valores);
  /* Faixa mínima para uma série constante não virar divisão por zero e
     desenhar a linha no topo do quadro. */
  const faixa = maior - menor || Math.max(1, Math.abs(maior) * 0.1);
  const emY = (v: number): number => topo + alturaGrafico - ((v - menor) / faixa) * alturaGrafico;

  // Grade horizontal em três níveis, e os rótulos à esquerda.
  for (const fracao of [0, 0.5, 1]) {
    const v = menor + faixa * fracao;
    const y = emY(v);
    doc.strokeColor(FIO).lineWidth(0.5).moveTo(esquerda, y).lineTo(esquerda + largura, y).stroke();
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(APOIO)
      .text(formatar(v), MARGEM, y - 3, { width: 42, align: 'right' });
  }

  const emX = (i: number): number => esquerda + (largura / (pontos.length - 1)) * i;

  doc.strokeColor(MENTA).lineWidth(1.4);
  pontos.forEach((p, i) => {
    const x = emX(i);
    const y = emY(p.valor);
    if (i === 0) doc.moveTo(x, y);
    else doc.lineTo(x, y);
  });
  doc.stroke();

  pontos.forEach((p, i) => {
    doc.circle(emX(i), emY(p.valor), 2).fillColor(MENTA).fill();
  });

  /* Só o primeiro e o último rótulo: com doze avaliações, escrever as
     doze datas embaixo produz uma tarja ilegível. */
  doc
    .font('Helvetica')
    .fontSize(6.5)
    .fillColor(APOIO)
    .text(pontos[0]!.rotulo, esquerda, topo + alturaGrafico + 5, { width: 60 })
    .text(pontos[pontos.length - 1]!.rotulo, esquerda + largura - 60, topo + alturaGrafico + 5, {
      width: 60,
      align: 'right',
    });

  doc.y = topo + alturaGrafico + 22;
}

/**
 * Barras verticais para uma série curta — frequência por mês, por
 * exemplo. Ao contrário da linha, ESTA escala começa em zero: barra é
 * comparação de tamanho, e cortar a base faz duas barras parecerem o
 * dobro uma da outra quando são 10% diferentes.
 */
export function graficoDeBarras(
  doc: Documento,
  titulo: string,
  pontos: PontoDoGrafico[],
  formatar: (v: number) => string,
): void {
  if (pontos.length === 0) return;
  garantirEspaco(doc, 140);

  const altura = 78;
  const topo = doc.y + 16;
  const esquerda = MARGEM;
  const largura = LARGURA_UTIL;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAFITE).text(titulo, MARGEM, doc.y);

  const maior = Math.max(1, ...pontos.map((p) => p.valor));
  const passo = largura / pontos.length;
  const larguraBarra = Math.min(22, passo * 0.55);

  pontos.forEach((p, i) => {
    const alturaBarra = (p.valor / maior) * altura;
    const x = esquerda + passo * i + (passo - larguraBarra) / 2;
    const y = topo + altura - alturaBarra;

    doc.rect(x, y, larguraBarra, Math.max(1, alturaBarra)).fillColor(MENTA).fill();
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(APOIO)
      .text(p.rotulo, esquerda + passo * i, topo + altura + 4, { width: passo, align: 'center' });
    if (p.valor > 0) {
      doc
        .font('Helvetica-Bold')
        .fontSize(6.5)
        .fillColor(GRAFITE)
        .text(formatar(p.valor), esquerda + passo * i, y - 9, { width: passo, align: 'center' });
    }
  });

  doc.strokeColor(FIO).lineWidth(0.5)
    .moveTo(esquerda, topo + altura)
    .lineTo(esquerda + largura, topo + altura)
    .stroke();

  doc.y = topo + altura + 20;
}
