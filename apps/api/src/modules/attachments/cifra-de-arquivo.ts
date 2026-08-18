import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Transform } from 'node:stream';
import { env } from '../../config/env.js';

/**
 * Cifra dos anexos EM REPOUSO.
 *
 * O que está no disco de anexos é exame, laudo e foto de aluno — dado de
 * saúde, o mais sensível que este sistema guarda. Até aqui os bytes
 * ficavam em claro: quem copiasse o volume `anexos` (um backup
 * extraviado, um snapshot da VPS, um contêiner comprometido) lia tudo.
 * Cifrar em repouso torna essa cópia inútil sem a chave, que vive na
 * variável de ambiente e não no volume.
 *
 * A MESMA CHAVE E O MESMO ALGORITMO dos segredos do banco (`segredo.ts`,
 * AES-256-GCM): uma segunda chave seria uma segunda coisa a rotacionar,
 * a guardar e a esquecer. O que muda é o formato, porque aqui o dado é
 * um fluxo de megabytes e não uma string.
 *
 *   ┌────────┬─────┬──────────┬────────────────┬──────────┐
 *   │ 'STZ1' │ ver │ IV (12B) │ cifrado (n B)  │ tag (16B)│
 *   └────────┴─────┴──────────┴────────────────┴──────────┘
 *        4      1        12           n              16
 *
 * A TAG VAI NO FIM, e não no cabeçalho, porque em GCM ela só existe
 * depois do último byte cifrado. Pô-la no começo obrigaria a escrever o
 * arquivo inteiro num temporário e recompor — o dobro de I/O em cada
 * upload. Na leitura, o tamanho do arquivo diz onde ela está: um `stat`,
 * uma leitura de 16 bytes, e o fluxo do meio passa pela decifragem.
 *
 * O CABEÇALHO MÁGICO EXISTE PELOS ARQUIVOS ANTIGOS. Os anexos enviados
 * antes desta mudança estão em claro no disco, e não há como recifrá-los
 * sem uma migração de arquivos que precisaria rodar com o sistema
 * parado. Quem lê confere os quatro primeiros bytes: com a marca,
 * decifra; sem ela, entrega o arquivo como está. É por isso que a marca
 * é 'STZ1' e não algo que um PDF ou JPEG pudesse ter no começo por
 * acaso — os dois começam com assinaturas conhecidas e diferentes desta.
 */

const MARCA = Buffer.from('STZ1', 'ascii');
const VERSAO = 1;
const TAMANHO_IV = 12; // 96 bits, o recomendado para GCM
const TAMANHO_TAG = 16;
const TAMANHO_CABECALHO = MARCA.length + 1 + TAMANHO_IV; // 17

function chave(): Buffer {
  const bruto = Buffer.from(env().ENCRYPTION_KEY, 'base64');
  if (bruto.length !== 32) {
    throw new Error('ENCRYPTION_KEY precisa ter 32 bytes (openssl rand -base64 32)');
  }
  return bruto;
}

/**
 * O cabeçalho e o transformador que cifram o fluxo.
 *
 * Devolve as peças em vez de gravar: quem chama já tem a lógica de
 * arquivo temporário, renomeio atômico, hash e contagem de bytes, e
 * costurar isso aqui duplicaria tudo. A regra é que o cabeçalho seja
 * escrito ANTES do primeiro byte do transformador.
 */
export function cifrarFluxo(): { cabecalho: Buffer; cifra: Transform; tag: () => Buffer } {
  const iv = randomBytes(TAMANHO_IV);
  const cifra = createCipheriv('aes-256-gcm', chave(), iv);
  const cabecalho = Buffer.concat([MARCA, Buffer.from([VERSAO]), iv]);
  return { cabecalho, cifra, tag: () => cifra.getAuthTag() };
}

/** Quanto o envelope acrescenta ao tamanho do arquivo original. */
export const BYTES_DE_ENVELOPE = TAMANHO_CABECALHO + TAMANHO_TAG;

/**
 * Abre o anexo para leitura, decifrando quando ele está cifrado.
 *
 * Devolve um fluxo pronto para ir ao cliente, e a AUTENTICIDADE JÁ
 * VERIFICADA: um arquivo adulterado no disco faz esta função lançar
 * ANTES de qualquer byte sair, e a rota responde erro em vez de começar
 * um download. O porquê de não encanar direto está no comentário longo
 * lá embaixo — em resumo, encanando, um laudo alterado chegava ao
 * cliente com HTTP 200 e sem aviso nenhum.
 */
export async function abrirParaLeitura(caminho: string): Promise<Readable> {
  const arquivo = await open(caminho, 'r');
  let cabecalho: Buffer;
  try {
    cabecalho = Buffer.alloc(TAMANHO_CABECALHO);
    const { bytesRead } = await arquivo.read(cabecalho, 0, TAMANHO_CABECALHO, 0);
    cabecalho = cabecalho.subarray(0, bytesRead);
  } finally {
    await arquivo.close();
  }

  /* Sem a marca, é anexo de antes da cifra: vai como está. */
  if (cabecalho.length < TAMANHO_CABECALHO || !cabecalho.subarray(0, 4).equals(MARCA)) {
    return createReadStream(caminho);
  }
  if (cabecalho[4] !== VERSAO) {
    throw new Error(`anexo cifrado em versão desconhecida: ${String(cabecalho[4])}`);
  }

  const iv = cabecalho.subarray(5, 5 + TAMANHO_IV);
  const { size } = await stat(caminho);
  const fimDoCifrado = size - TAMANHO_TAG;
  if (fimDoCifrado < TAMANHO_CABECALHO) {
    throw new Error('anexo cifrado truncado');
  }

  /* A tag mora nos últimos 16 bytes. Lida antes de qualquer decifragem
     porque o GCM precisa dela ANTES do `final()`. */
  const fim = await open(caminho, 'r');
  let tag: Buffer;
  try {
    tag = Buffer.alloc(TAMANHO_TAG);
    await fim.read(tag, 0, TAMANHO_TAG, fimDoCifrado);
  } finally {
    await fim.close();
  }

  const decifra = createDecipheriv('aes-256-gcm', chave(), iv);
  decifra.setAuthTag(tag);

  /* DECIFRA POR INTEIRO ANTES DE DEVOLVER, em vez de encanar o fluxo
     direto para a resposta. A diferença é a que separa "arquivo
     corrompido" de "arquivo corrompido entregue como laudo".
     
     GCM é cifra de fluxo: a decifragem produz texto claro byte a byte e
     só descobre a adulteração no `final()`, depois do último byte. Se o
     fluxo vai direto para o cliente, quando a verificação falha os
     cabeçalhos já foram enviados, o `Content-Length` já prometeu o
     tamanho todo e o navegador já gravou o arquivo. Medido: adulterar um
     byte do texto cifrado devolvia HTTP 200 com o PDF inteiro e alguns
     bytes trocados no meio — sem erro nenhum para quem baixou.
     
     Ler tudo primeiro custa memória: até 20 MB por download em curso, que
     é o teto de upload do sistema. Numa clínica com noventa usuários e
     documentos de exame, é um preço pequeno diante de entregar um laudo
     alterado sem avisar. Se um dia houver anexo de centenas de
     megabytes, este é o ponto a repensar — e aí a resposta é
     descriptografar para um temporário e servir de lá, não voltar a
     encanar direto.
     
     `end` é INCLUSIVO em createReadStream, daí o -1: sem ele, o primeiro
     byte da tag entraria como texto cifrado. */
  const pedacos: Buffer[] = [];
  const cifrado = createReadStream(caminho, {
    start: TAMANHO_CABECALHO,
    end: fimDoCifrado - 1,
  });
  for await (const pedaco of cifrado) {
    pedacos.push(decifra.update(pedaco as Buffer));
  }
  /* LANÇA se a tag não confere — antes de qualquer byte sair daqui. */
  pedacos.push(decifra.final());

  return Readable.from(Buffer.concat(pedacos));
}

/** O anexo está cifrado? Usado pelo diagnóstico e pelos testes. */
export async function estaCifrado(caminho: string): Promise<boolean> {
  const arquivo = await open(caminho, 'r');
  try {
    const marca = Buffer.alloc(4);
    const { bytesRead } = await arquivo.read(marca, 0, 4, 0);
    return bytesRead === 4 && marca.equals(MARCA);
  } finally {
    await arquivo.close();
  }
}
