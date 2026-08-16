/**
 * O IP que a API enxerga não pode ser escolhido pelo cliente.
 *
 * POR QUE ISTO MERECE UM TESTE PRÓPRIO:
 *
 * `request.ip` não é informação decorativa. É a chave do rate limit do
 * login (o `LoginGuard` conta tentativas por IP, e é a defesa contra
 * pulverização de senha) e é o que vai para o `audit_log`. Se o cliente
 * consegue escolher o próprio IP, ele consegue as duas coisas: força
 * bruta sem limite, trocando o cabeçalho a cada tentativa, e um registro
 * de auditoria que aponta para endereços inventados.
 *
 * O detalhe que torna isso fácil de errar: `trustProxy: true` — a opção
 * que parece a correta quando existe um proxy na frente — faz o Fastify
 * usar a entrada MAIS À ESQUERDA do X-Forwarded-For, que é exatamente a
 * que o cliente escreve. `trustProxy: 1` confia só no salto imediato e
 * lê a ponta direita, escrita pelo nosso proxy.
 *
 * A configuração do Caddy também descarta o cabeçalho do cliente na
 * borda. As duas defesas existem de propósito: este teste garante que a
 * da API sozinha já basta, então mexer no proxy não abre o buraco em
 * silêncio.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetEnvCache } from '../config/env.js';

/** O IP que o proxy escreve — o verdadeiro. */
const REAL = '203.0.113.7';
/** O endereço do contêiner do proxy, do ponto de vista do socket. */
const PROXY = '172.18.0.5';

describe('IP do cliente atrás do proxy', () => {
  let app: FastifyInstance;
  const anterior = { ...process.env };

  beforeAll(async () => {
    /* Este é o único teste que precisa do app em modo PRODUÇÃO: é lá que
       `trustProxy` deixa de ser `false`. Os valores abaixo existem só
       para satisfazer a validação de configuração — nenhum é usado. */
    process.env['NODE_ENV'] = 'production';
    process.env['DATABASE_URL'] = 'postgresql://ninguem:nada@127.0.0.1:1/vazio';
    process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(11) + '-teste-de-proxy-nao-usado';
    process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(11) + '-teste-de-proxy-diferente';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    // Em produção a validação recusa origem sem HTTPS — e é assim mesmo.
    process.env['CORS_ORIGINS'] = 'https://sistema.exemplo.com.br';
    resetEnvCache();

    const { buildApp } = await import('../app.js');
    app = await buildApp();
    app.get('/__ip_do_teste', async (request) => ({ ip: request.ip }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    process.env = anterior;
    resetEnvCache();
  });

  const ipVisto = async (xff?: string): Promise<string> => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/__ip_do_teste',
      remoteAddress: PROXY,
      ...(xff === undefined ? {} : { headers: { 'x-forwarded-for': xff } }),
    });
    return (JSON.parse(resposta.body) as { ip: string }).ip;
  };

  it('sem X-Forwarded-For, usa o endereço do socket', async () => {
    expect(await ipVisto()).toBe(PROXY);
  });

  it('com a cadeia escrita pelo proxy, usa o IP real', async () => {
    expect(await ipVisto(REAL)).toBe(REAL);
  });

  it('IGNORA o X-Forwarded-For forjado pelo cliente', async () => {
    // O cliente manda 9.9.9.9; o proxy acrescenta o IP real à direita.
    expect(await ipVisto(`9.9.9.9, ${REAL}`)).toBe(REAL);
  });

  it('ignora uma cadeia inteira forjada, não só uma entrada', async () => {
    expect(await ipVisto(`1.1.1.1, 2.2.2.2, 3.3.3.3, ${REAL}`)).toBe(REAL);
  });

  it('não aceita nem endereço privado forjado, que passaria por "interno"', async () => {
    expect(await ipVisto(`127.0.0.1, ${REAL}`)).toBe(REAL);
  });
});
