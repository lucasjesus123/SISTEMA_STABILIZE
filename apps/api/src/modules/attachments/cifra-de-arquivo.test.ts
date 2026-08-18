import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A cifra dos anexos em repouso.
 *
 * O que estes testes protegem, em ordem de importância:
 *
 *   1. O anexo volta IDÊNTICO. Uma cifra que corrompe um bit é pior que
 *      cifra nenhuma, porque o estrago só aparece quando alguém precisa
 *      do exame.
 *   2. Os anexos ANTIGOS continuam abrindo. Havia arquivos em claro no
 *      disco quando a cifra entrou, e não há como recifrá-los sem parar
 *      o sistema — se a leitura deles quebrar, o prontuário perde
 *      histórico.
 *   3. Arquivo adulterado NÃO é entregue. E não é entregue ANTES do
 *      primeiro byte sair: encanando o fluxo direto, um laudo alterado
 *      chegava com HTTP 200 e sem aviso.
 */

let dir: string;

beforeAll(async () => {
  /* A chave precisa existir antes do primeiro import do módulo, porque
     `env()` a lê e valida. 32 bytes, como em produção. */
  process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  process.env['DATABASE_URL'] = 'postgresql://n/a@127.0.0.1:1/n_a';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['CORS_ORIGINS'] = 'http://127.0.0.1';
  dir = await mkdtemp(path.join(tmpdir(), 'stz-cifra-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Grava um arquivo pelo mesmo caminho que o `storage.gravar` usa. */
async function gravarCifrado(destino: string, conteudo: Buffer): Promise<void> {
  const { cifrarFluxo } = await import('./cifra-de-arquivo.js');
  const { appendFile } = await import('node:fs/promises');
  const { cabecalho, cifra, tag } = cifrarFluxo();
  const saida = createWriteStream(destino);
  saida.write(cabecalho);
  await pipeline(Readable.from(conteudo), cifra, saida);
  await appendFile(destino, tag());
}

async function lerTudo(fluxo: Readable): Promise<Buffer> {
  const pedacos: Buffer[] = [];
  for await (const p of fluxo) pedacos.push(p as Buffer);
  return Buffer.concat(pedacos);
}

describe('cifra dos anexos em repouso', () => {
  it('devolve o arquivo byte a byte igual ao original', async () => {
    const { abrirParaLeitura } = await import('./cifra-de-arquivo.js');
    /* Aleatório e grande o suficiente para atravessar mais de um pedaço
       do fluxo: um round-trip que só testa 10 bytes não exercita a
       fronteira entre blocos, que é onde erro de cifra costuma morar. */
    const original = randomBytes(300_000);
    const destino = path.join(dir, 'exame.bin');
    await gravarCifrado(destino, original);

    expect(await lerTudo(await abrirParaLeitura(destino))).toEqual(original);
  });

  it('o que fica no disco não é o conteúdo original', async () => {
    const { estaCifrado, BYTES_DE_ENVELOPE } = await import('./cifra-de-arquivo.js');
    const original = Buffer.from('%PDF-1.4 laudo confidencial do aluno');
    const destino = path.join(dir, 'laudo.bin');
    await gravarCifrado(destino, original);

    const emDisco = await readFile(destino);
    expect(await estaCifrado(destino)).toBe(true);
    expect(emDisco.subarray(0, 4).toString()).toBe('STZ1');
    /* O texto claro não pode aparecer em lugar nenhum do arquivo — é o
       ponto inteiro de cifrar. */
    expect(emDisco.includes(Buffer.from('confidencial'))).toBe(false);
    expect(emDisco.length).toBe(original.length + BYTES_DE_ENVELOPE);
  });

  it('anexo antigo, gravado em claro, continua abrindo', async () => {
    const { abrirParaLeitura, estaCifrado } = await import('./cifra-de-arquivo.js');
    /* Exatamente o que existe hoje no disco da VPS: bytes crus, sem
       envelope nenhum. */
    const antigo = Buffer.from('%PDF-1.4 exame enviado antes da cifra existir');
    const destino = path.join(dir, 'antigo.pdf');
    await writeFile(destino, antigo);

    expect(await estaCifrado(destino)).toBe(false);
    expect(await lerTudo(await abrirParaLeitura(destino))).toEqual(antigo);
  });

  it('arquivo adulterado é recusado ANTES de qualquer byte sair', async () => {
    const { abrirParaLeitura } = await import('./cifra-de-arquivo.js');
    const original = randomBytes(50_000);
    const destino = path.join(dir, 'adulterado.bin');
    await gravarCifrado(destino, original);

    const bytes = await readFile(destino);
    bytes[200] = (bytes[200] ?? 0) ^ 0xff;
    await writeFile(destino, bytes);

    /* Rejeita na ABERTURA, não no meio do fluxo: se a verificação
       acontecesse depois, os cabeçalhos HTTP já teriam ido e o cliente
       gravaria um laudo com bytes trocados sem erro nenhum. */
    await expect(abrirParaLeitura(destino)).rejects.toThrow();
  });

  it('tag adulterada também é recusada', async () => {
    const { abrirParaLeitura } = await import('./cifra-de-arquivo.js');
    const destino = path.join(dir, 'tag-ruim.bin');
    await gravarCifrado(destino, randomBytes(1000));

    const bytes = await readFile(destino);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await writeFile(destino, bytes);

    await expect(abrirParaLeitura(destino)).rejects.toThrow();
  });

  it('cada gravação usa um IV novo', async () => {
    /* Reusar IV em GCM é catastrófico: dois textos com o mesmo IV vazam
       o XOR dos claros e permitem forjar a autenticação. O mesmo
       conteúdo gravado duas vezes tem que produzir arquivos diferentes. */
    const conteudo = Buffer.from('mesmo conteudo, duas vezes');
    const a = path.join(dir, 'iv-a.bin');
    const b = path.join(dir, 'iv-b.bin');
    await gravarCifrado(a, conteudo);
    await gravarCifrado(b, conteudo);

    const [da, db] = [await readFile(a), await readFile(b)];
    expect(da.subarray(5, 17).equals(db.subarray(5, 17))).toBe(false);
    expect(da.equals(db)).toBe(false);
  });

  it('arquivo truncado no envelope não passa por arquivo em claro', async () => {
    const { abrirParaLeitura } = await import('./cifra-de-arquivo.js');
    const destino = path.join(dir, 'truncado.bin');
    await gravarCifrado(destino, Buffer.from('conteudo'));
    /* Corta a maior parte, deixando a marca: sem a checagem de tamanho,
       o cálculo de onde está a tag daria negativo e o erro sairia como
       algo incompreensível vindo do createReadStream. */
    const bytes = await readFile(destino);
    await writeFile(destino, bytes.subarray(0, 20));

    await expect(abrirParaLeitura(destino)).rejects.toThrow(/truncado/);
  });
});
