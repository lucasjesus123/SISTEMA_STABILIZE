import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { textoDoPdf } from './texto-do-pdf.js';

/**
 * O caso que derrubava a extração aparecia em ~1 de cada 256 documentos
 * e vinha em blocos de um minuto — esperar por ele num teste seria
 * esperar sentado. Então ele é CONSTRUÍDO aqui: procuramos um conteúdo
 * cujo fluxo comprimido termine em 0x0D e montamos o PDF com ele.
 */
function fluxoTerminadoEm(byte: number): { texto: string; comprimido: Buffer } {
  for (let i = 0; i < 4000; i += 1) {
    const texto = `Prof Alvo ${'x'.repeat(i)}`;
    const conteudo = `BT /F1 12 Tf 40 700 Td <${Buffer.from(texto, 'latin1').toString('hex')}> Tj ET`;
    const comprimido = zlib.deflateSync(Buffer.from(conteudo, 'latin1'));
    if (comprimido[comprimido.length - 1] === byte) return { texto, comprimido };
  }
  throw new Error('nao foi possivel construir o fluxo de teste');
}

function pdfCom(comprimido: Buffer): Buffer {
  const cabeca = Buffer.from('%PDF-1.3\n1 0 obj\n<<\n/Length ' + String(comprimido.length) + '\n/Filter /FlateDecode\n>>\nstream\n', 'latin1');
  const cauda = Buffer.from('\nendstream\nendobj\n', 'latin1');
  return Buffer.concat([cabeca, comprimido, cauda]);
}

describe('extração de texto do PDF', () => {
  it('lê o texto quando o fluxo comprimido TERMINA em \\r', () => {
    /* O furo antigo: o `\r?` do delimitador comia o último byte dos
       dados, o inflate falhava e a extração voltava vazia. */
    const { texto, comprimido } = fluxoTerminadoEm(0x0d);
    expect(comprimido[comprimido.length - 1]).toBe(0x0d);
    expect(textoDoPdf(pdfCom(comprimido))).toContain(texto);
  });

  it('lê o texto no caso comum', () => {
    const conteudo = 'BT /F1 12 Tf 40 700 Td <50726f6620416c766f> Tj ET';
    expect(textoDoPdf(pdfCom(zlib.deflateSync(Buffer.from(conteudo, 'latin1'))))).toContain('Prof Alvo');
  });

  it('LEVANTA ERRO quando não consegue extrair nada', () => {
    /* A proteção que importa: sem ela, `not.toContain('segredo')`
       passaria num documento ilegível — um vazamento passaria batido. */
    expect(() => textoDoPdf(Buffer.from('%PDF-1.3\nnada aqui\n', 'latin1'))).toThrow(/extrair texto/);
  });
});
