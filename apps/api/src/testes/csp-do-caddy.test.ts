/**
 * A CSP que o Caddy entrega ao navegador.
 *
 * ESTE TESTE EXISTE POR UM DEFEITO QUE SÓ APARECIA EM PRODUÇÃO, e por
 * isso passou por toda a bateria local sem ser visto.
 *
 * Nenhuma foto do sistema carregava no ar — perfil, aluno, exercício,
 * logo da academia. A mensagem que sobrava para quem usava era "Não
 * consegui abrir a imagem. Envie outra, de preferência JPG ou PNG",
 * que manda trocar de arquivo quando o arquivo nunca foi o problema.
 *
 * A causa está no desenho do acesso: o token vive em MEMÓRIA e o
 * carregador de imagem do navegador não manda cabeçalho nenhum, então
 * `<img src="/api/perfil/foto">` chegaria sem autenticação e voltaria
 * 401. Toda foto é buscada por `fetch` e exibida como
 * `URL.createObjectURL(blob)` — ou seja, TODA imagem do sistema é
 * `blob:`. E a CSV do Caddy trazia `img-src 'self' data:`, sem `blob:`.
 *
 * POR QUE O TESTE É DO ARQUIVO, E NÃO DE UMA REQUISIÇÃO: quem emite
 * este cabeçalho é o Caddy, não a API — a API nem serve HTML. Não há
 * requisição a fazer contra o Fastify que exercite isso. Ler o
 * `Caddyfile` é o único ponto onde a regra pode ser verificada sem
 * subir o proxy inteiro, e é melhor que não verificar.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A partir de apps/api/src/testes até a raiz do repositório. */
const CADDYFILE = join(import.meta.dirname, '..', '..', '..', '..', 'deploy', 'Caddyfile');

function diretiva(csp: string, nome: string): string {
  const parte = csp
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${nome} `));
  return parte ?? '';
}

describe('CSP entregue pelo Caddy', () => {
  const arquivo = readFileSync(CADDYFILE, 'utf8');
  const linha = arquivo
    .split('\n')
    .find((l) => l.includes('Content-Security-Policy') && l.includes('default-src'));

  it('a diretiva existe no arquivo', () => {
    expect(linha, 'Content-Security-Policy sumiu do Caddyfile').toBeDefined();
  });

  const csp = linha?.match(/"([^"]+)"/)?.[1] ?? '';

  it('img-src aceita blob: — sem isso NENHUMA foto carrega', () => {
    /* Medido servindo a mesma página sob as duas CSPs:
         img-src 'self' data:        -> "Refused to load the image
                                         'blob:...' because it violates
                                         ... Content Security Policy"
         img-src 'self' data: blob:  -> a imagem carrega, 600x600 */
    expect(diretiva(csp, 'img-src')).toContain('blob:');
  });

  it('continua fechada onde importa', () => {
    /* `blob:` em `img-src` não afrouxa nada disto, e estas são as
       linhas que impedem XSS de virar execução. Se um dia alguém
       afrouxar `script-src` para resolver outra coisa, é aqui que
       aparece. */
    expect(diretiva(csp, 'script-src')).toBe("script-src 'self'");
    expect(diretiva(csp, 'object-src')).toBe("object-src 'none'");
    expect(diretiva(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(diretiva(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(diretiva(csp, 'default-src')).toBe("default-src 'self'");
  });

  it('não abre origem externa em img-src', () => {
    /* `blob:` e `data:` são gerados pela própria página, a partir de
       bytes que ela buscou de `'self'`. Um host externo aqui seria
       outra conversa — e é o que este teste impede de entrar de
       carona. */
    const img = diretiva(csp, 'img-src');
    expect(img).not.toMatch(/https?:/);
    expect(img).not.toContain('*');
  });
});
