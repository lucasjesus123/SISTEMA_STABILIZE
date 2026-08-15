import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Cifra de segredos e idempotência do aniversário.
 *
 * Estes dois são testados fora do banco porque não dependem dele — e o
 * que precisa de banco (a unicidade da chave) tem seu próprio teste no
 * arquivo e2e.
 */

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = 'postgresql://x:y@127.0.0.1:5432/z';
  process.env['JWT_ACCESS_SECRET'] = 'zK3-acesso-somente-para-teste-com-tamanho-suficiente-01';
  process.env['JWT_REFRESH_SECRET'] = 'qP9-refresh-somente-para-teste-com-tamanho-suficiente-02';
  process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
  process.env['CORS_ORIGINS'] = 'http://localhost:5173';
  const { resetEnvCache } = await import('../../config/env.js');
  resetEnvCache();
});

describe('cifra de segredos', () => {
  it('o texto volta igual ao que entrou', async () => {
    const { cifrar, decifrar } = await import('./segredo.js');
    const token = 'uazapi-token-de-exemplo-9f8a7b6c5d4e';
    expect(decifrar(cifrar(token))).toBe(token);
  });

  it('cifrar duas vezes o mesmo texto dá resultados DIFERENTES', async () => {
    /* IV aleatório por operação. Se saíssem iguais, quem lê o banco
       descobriria que duas academias usam o mesmo token — e reusar IV em
       GCM vaza o XOR dos textos claros. */
    const { cifrar } = await import('./segredo.js');
    const a = cifrar('mesmo-token');
    const b = cifrar('mesmo-token');
    expect(a).not.toBe(b);
  });

  it('adulterar o texto cifrado FALHA em vez de devolver lixo', async () => {
    /* É a diferença entre GCM e CBC. Sem autenticação, quem escreve na
       coluna altera o cifrado e a decifragem devolve bytes quaisquer,
       que o código trata como token. */
    const { cifrar, decifrar } = await import('./segredo.js');
    const original = cifrar('token-legitimo');
    const partes = original.split('.');
    const corpo = Buffer.from(partes[3]!, 'base64');
    corpo[0] = (corpo[0]! ^ 0xff) & 0xff;
    const adulterado = [partes[0], partes[1], partes[2], corpo.toString('base64')].join('.');

    expect(() => decifrar(adulterado)).toThrow();
  });

  it('trocar a tag de autenticação também falha', async () => {
    const { cifrar, decifrar } = await import('./segredo.js');
    const a = cifrar('token-a').split('.');
    const b = cifrar('token-b').split('.');
    const misturado = [a[0], a[1], b[2], a[3]].join('.');
    expect(() => decifrar(misturado)).toThrow();
  });

  it('formato desconhecido é recusado', async () => {
    const { decifrar } = await import('./segredo.js');
    expect(() => decifrar('token-em-claro')).toThrow(/formato desconhecido/);
    expect(() => decifrar('v2.a.b.c')).toThrow(/formato desconhecido/);
  });

  it('comparação de segredo aceita iguais e recusa diferentes', async () => {
    const { segredosIguais } = await import('./segredo.js');
    expect(segredosIguais('abc123', 'abc123')).toBe(true);
    expect(segredosIguais('abc123', 'abc124')).toBe(false);
    // Comprimentos diferentes não podem lançar exceção.
    expect(segredosIguais('abc', 'abcdef')).toBe(false);
  });
});
