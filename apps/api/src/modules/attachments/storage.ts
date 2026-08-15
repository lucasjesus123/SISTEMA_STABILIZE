import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import { badRequest, unprocessable } from '../../http/errors.js';

/**
 * Armazenamento de anexos em disco.
 *
 * A REGRA QUE ORGANIZA ESTE ARQUIVO: o nome que o usuário enviou NUNCA
 * toca um caminho. Um anexo chamado "../../../etc/passwd" ou
 * "..\\..\\web.config" escreveria fora do diretório de armazenamento, e
 * é o jeito clássico de transformar upload em execução remota. O nome
 * original é guardado no banco como RÓTULO, para exibir e para sugerir
 * ao baixar; o caminho vem de uma chave opaca gerada aqui.
 *
 * A regra tem guarda automática: `.semgrep/stabilize.yml` recusa
 * qualquer `path.join` que receba nome vindo do request.
 */

/* Tipos aceitos. Lista de permissão, não de bloqueio: uma lista de
   bloqueio está sempre um formato atrás de quem quer burlá-la. */
const TIPOS_ACEITOS = new Map<string, { extensao: string; assinaturas: readonly Uint8Array[] }>([
  ['application/pdf', { extensao: 'pdf', assinaturas: [bytes('%PDF-')] }],
  ['image/jpeg', { extensao: 'jpg', assinaturas: [new Uint8Array([0xff, 0xd8, 0xff])] }],
  ['image/png', { extensao: 'png', assinaturas: [new Uint8Array([0x89, 0x50, 0x4e, 0x47])] }],
  ['image/webp', { extensao: 'webp', assinaturas: [bytes('RIFF')] }],
  /* .docx, .xlsx e afins são ZIP por dentro — a assinatura é a do ZIP.
     Não dá para distinguir um do outro pelos primeiros bytes, e tudo
     bem: nenhum dos dois é executado por nós, só devolvido como
     download. */
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { extensao: 'docx', assinaturas: [new Uint8Array([0x50, 0x4b, 0x03, 0x04])] },
  ],
  ['application/msword', { extensao: 'doc', assinaturas: [new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])] }],
]);

export const TIPOS_PERMITIDOS = [...TIPOS_ACEITOS.keys()];

function bytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

/** Chave opaca: um uuid. Nada do usuário entra aqui. */
const FORMATO_CHAVE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Caminho em disco a partir da chave.
 *
 * Valida a chave mesmo ela vindo do BANCO, não do request. Não é
 * paranoia gratuita: se algum dia uma linha for gravada por outro
 * caminho — importação, correção manual, uma falha de injeção em outro
 * lugar — esta função é a última barreira antes de um `open()` seguir
 * um `..`. Custa uma regex por download.
 *
 * O `tenantId` entra no caminho para que apagar ou fazer backup de uma
 * empresa inteira seja uma operação de diretório. Ele vem do token,
 * nunca do corpo da requisição.
 */
function caminhoDe(tenantId: string, chave: string): string {
  if (!FORMATO_CHAVE.test(chave) || !FORMATO_CHAVE.test(tenantId)) {
    throw new Error('chave de armazenamento inválida');
  }
  const raiz = path.resolve(env().STORAGE_DIR);
  /* Dois níveis de fatiamento evitam um diretório com dezenas de
     milhares de entradas, que deixa lento até o `ls`. */
  const destino = path.join(raiz, tenantId, chave.slice(0, 2), chave.slice(2, 4), chave);

  /* Cinto e suspensório: mesmo com a chave validada, conferimos que o
     caminho final continua dentro da raiz. Se um dia alguém afrouxar a
     regex, esta linha ainda segura. */
  if (destino !== path.normalize(destino) || !destino.startsWith(raiz + path.sep)) {
    throw new Error('caminho de armazenamento escaparia da raiz');
  }
  return destino;
}

export interface ArquivoGravado {
  chave: string;
  tamanhoBytes: number;
  checksum: string;
}

/**
 * Grava o fluxo em disco e devolve o que o banco precisa saber.
 *
 * Escreve num arquivo temporário e só então renomeia. Renomear no mesmo
 * sistema de arquivos é atômico: ou o anexo existe inteiro, ou não
 * existe. Sem isso, uma conexão interrompida no meio do upload deixaria
 * um arquivo truncado que o banco jura estar completo.
 */
export async function gravar(
  tenantId: string,
  fluxo: Readable,
  tipoDeclarado: string,
  excedeuLimite: () => boolean,
): Promise<ArquivoGravado> {
  const aceito = TIPOS_ACEITOS.get(tipoDeclarado);
  if (aceito === undefined) {
    throw unprocessable(
      'Formato não aceito. Envie PDF, Word ou imagem (JPG, PNG ou WebP).',
    );
  }

  const chave = randomUUID();
  const destino = caminhoDe(tenantId, chave);
  const temporario = `${destino}.parcial`;
  await mkdir(path.dirname(destino), { recursive: true });

  const hash = createHash('sha256');
  let tamanho = 0;
  let inicio: Buffer | null = null;

  try {
    await pipeline(
      fluxo,
      async function* (origem) {
        for await (const pedaco of origem) {
          const bloco = pedaco as Buffer;
          if (inicio === null) inicio = bloco.subarray(0, 16);
          hash.update(bloco);
          tamanho += bloco.length;
          yield bloco;
        }
      },
      createWriteStream(temporario),
    );

    /* O limite é aplicado pelo próprio multipart, que corta o fluxo. Se
       cortou, o que está em disco é um pedaço — não serve como anexo. */
    if (excedeuLimite()) {
      throw badRequest(
        `Arquivo maior que o limite de ${Math.floor(env().UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`,
      );
    }
    if (tamanho === 0) throw badRequest('Arquivo vazio.');

    /* O Content-Type vem do cliente e é um palpite, não um fato.
       Conferimos os primeiros bytes contra a assinatura do formato
       declarado. Não impede tudo, mas impede o caso que interessa: um
       HTML disfarçado de imagem, que viraria XSS se algum dia alguém
       servir isto inline. */
    if (inicio === null || !confere(inicio, aceito.assinaturas)) {
      throw unprocessable('O conteúdo do arquivo não corresponde ao formato informado.');
    }

    await rename(temporario, destino);
    return { chave, tamanhoBytes: tamanho, checksum: hash.digest('hex') };
  } catch (erro) {
    // Não deixa lixo para trás quando a validação recusa o arquivo.
    await rm(temporario, { force: true }).catch(() => undefined);
    throw erro;
  }
}

function confere(inicio: Buffer, assinaturas: readonly Uint8Array[]): boolean {
  return assinaturas.some(
    (a) => inicio.length >= a.length && a.every((b, i) => inicio[i] === b),
  );
}

/** Fluxo de leitura do anexo, para o download. */
export function ler(tenantId: string, chave: string): Readable {
  return createReadStream(caminhoDe(tenantId, chave));
}

export async function existe(tenantId: string, chave: string): Promise<boolean> {
  try {
    await stat(caminhoDe(tenantId, chave));
    return true;
  } catch {
    return false;
  }
}

/**
 * Apaga os bytes.
 *
 * Apagar um exame apaga o exame. A alternativa — marcar como excluído e
 * manter o arquivo — deixaria dado de saúde no disco depois de alguém
 * pedir para removê-lo, que é exatamente o que a LGPD chama de direito
 * à eliminação (art. 18, VI). A linha no banco continua, com quem
 * apagou e quando, porque o registro de que existiu é auditoria, não
 * dado clínico.
 *
 * A contrapartida é assumida: não há lixeira. A tela pede confirmação.
 */
export async function apagar(tenantId: string, chave: string): Promise<void> {
  await rm(caminhoDe(tenantId, chave), { force: true });
}

/**
 * O nome que vira RÓTULO no banco.
 *
 * O parser de multipart já entrega só o último componente do caminho —
 * "../../etc/passwd.pdf" chega como "passwd.pdf". Não dependemos disso:
 * é comportamento de biblioteca, e biblioteca muda de versão. Aqui a
 * garantia passa a ser nossa.
 *
 * O rótulo NÃO é higienizado além disso, de propósito: acentos, espaços
 * e maiúsculas são o que faz a pessoa reconhecer o próprio exame na
 * lista. O que não pode é separador de caminho ou caractere de controle
 * — o primeiro confunde quem lê, o segundo injeta cabeçalho no
 * download.
 */
export function rotuloDeArquivo(nome: string | undefined): string {
  const semCaminho = (nome ?? '').split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const limpo = semCaminho.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return limpo === '' || limpo === '.' || limpo === '..' ? 'anexo' : limpo.slice(0, 250);
}

/**
 * Nome seguro para o cabeçalho de download.
 *
 * Um nome com aspas ou quebra de linha injetaria cabeçalho HTTP. Vai
 * um nome higienizado no formato antigo e o nome real percent-encoded
 * em `filename*`, que é o que navegador moderno usa (RFC 5987).
 */
export function cabecalhoDeNome(nomeOriginal: string): string {
  const simples = nomeOriginal.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'anexo';
  return `attachment; filename="${simples}"; filename*=UTF-8''${encodeURIComponent(nomeOriginal)}`;
}
