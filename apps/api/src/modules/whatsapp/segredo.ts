import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Cifra simétrica para segredos guardados no banco.
 *
 * Uso hoje: o token da instância de WhatsApp. Ele dá acesso a enviar
 * mensagem em nome da academia — quem o tem fala com os alunos dela.
 * Guardar em claro faria de um dump de banco (um backup extraviado, um
 * `SELECT` indevido) um comprometimento imediato de todas as contas.
 *
 * AES-256-GCM, e não AES-CBC: o GCM AUTENTICA além de cifrar. Sem
 * autenticação, quem consegue escrever na coluna pode alterar o texto
 * cifrado e a decifragem devolve lixo *sem reclamar* — e lixo que o
 * código trata como token. Com GCM, adulteração falha na verificação.
 *
 * O IV é aleatório por operação e viaja junto do texto cifrado. Reusar
 * IV em GCM é catastrófico: dois textos com o mesmo IV vazam o XOR dos
 * claros e permitem forjar a autenticação.
 *
 * Formato: v1.<iv em base64>.<tag em base64>.<cifrado em base64>
 * O prefixo de versão existe para que trocar de algoritmo um dia não
 * exija adivinhar o formato do que já está gravado.
 */

const VERSAO = 'v1';
const TAMANHO_IV = 12; // 96 bits, o recomendado para GCM

function chave(): Buffer {
  const bruto = Buffer.from(env().ENCRYPTION_KEY, 'base64');
  if (bruto.length !== 32) {
    throw new Error('ENCRYPTION_KEY precisa ter 32 bytes (openssl rand -base64 32)');
  }
  return bruto;
}

export function cifrar(claro: string): string {
  const iv = randomBytes(TAMANHO_IV);
  const cifra = createCipheriv('aes-256-gcm', chave(), iv);
  const cifrado = Buffer.concat([cifra.update(claro, 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [VERSAO, iv.toString('base64'), tag.toString('base64'), cifrado.toString('base64')].join('.');
}

export function decifrar(guardado: string): string {
  const partes = guardado.split('.');
  if (partes.length !== 4 || partes[0] !== VERSAO) {
    throw new Error('segredo em formato desconhecido');
  }
  const [, ivB64, tagB64, cifradoB64] = partes as [string, string, string, string];

  const decifra = createDecipheriv('aes-256-gcm', chave(), Buffer.from(ivB64, 'base64'));
  decifra.setAuthTag(Buffer.from(tagB64, 'base64'));
  /* `final()` LANÇA se a tag não confere. É o comportamento desejado:
     melhor a integração cair do que operar com um token adulterado. */
  return Buffer.concat([decifra.update(Buffer.from(cifradoB64, 'base64')), decifra.final()]).toString(
    'utf8',
  );
}

/**
 * Comparação de segredo em tempo constante.
 *
 * Usada para conferir o token que o provedor manda no webhook. Um `===`
 * comum sai na primeira diferença, e a diferença de tempo entre "errou
 * no primeiro caractere" e "errou no último" é medível pela rede — dá
 * para descobrir o segredo caractere a caractere.
 */
export function segredosIguais(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  /* Comprimentos diferentes vazam pelo próprio tamanho, o que é
     inevitável; o que não pode vazar é o CONTEÚDO. Comparamos com um
     comprimento fixo para não sair cedo. */
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
