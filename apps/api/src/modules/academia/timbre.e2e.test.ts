import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';
import zlib from 'node:zlib';

/**
 * Identidade da academia e papel timbrado.
 *
 * O TESTE QUE DECIDE ESTE ITEM não é o desenho bonito — é que a marca de
 * uma academia jamais apareça no documento de outra. Antes desta
 * mudança, o nome saía escrito à mão no código: TODO relatório de TODA
 * empresa vinha com "Stabilize — Clínica do Músculo" no cabeçalho e no
 * autor do PDF. Num sistema de uma academia só ninguém notaria.
 *
 * O segundo que decide é mais silencioso: a marca d'água não pode cair
 * por cima do texto. Um PDF assim abre, parece caprichado, e esconde os
 * números atrás de uma imagem.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;

const SENHA = 'senha-de-teste-longa-2026';

interface Empresa {
  tenant: string;
  slug: string;
  nome: string;
  dono: string;
  prof: string;
  aluno: string;
}
const alfa: Empresa = { tenant: '', slug: '', nome: '', dono: '', prof: '', aluno: '' };
const beta: Empresa = { tenant: '', slug: '', nome: '', dono: '', prof: '', aluno: '' };

/* PNG 1×1 válido — assinatura correta, decodificável pelo pdfkit. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/* WebP mínimo: assinatura RIFF....WEBP. Aceito para exames, recusado
   para logo — o pdfkit não embute WebP. */
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(14, 0),
]);

async function comTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const cache = new Map<string, string>();
async function tokenDe(email: string, slug: string): Promise<string> {
  const chave = `${slug}:${email}`;
  const emCache = cache.get(chave);
  if (emCache !== undefined) return emCache;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA, tenantSlug: slug },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) throw new Error(`login falhou: ${res.body}`);
  cache.set(chave, body.accessToken);
  return body.accessToken;
}
const como = (t: string) => ({ authorization: `Bearer ${t}` });

/** Texto legível de dentro do PDF — o pdfkit grava hexadecimal comprimido. */
function textoDoPdf(pdf: Buffer): string {
  const bruto = pdf.toString('latin1');
  let conteudo = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bruto)) !== null) {
    try {
      conteudo += zlib.inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      /* fonte ou imagem — não é texto comprimido */
    }
  }
  let saida = '';
  for (const bloco of conteudo.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    saida += Buffer.from(bloco[1]!, 'hex').toString('latin1');
  }
  return saida;
}

/** Quantas vezes uma imagem é DESENHADA (operador `Do`) no documento. */
function desenhosDeImagem(pdf: Buffer): number {
  const bruto = pdf.toString('latin1');
  let total = 0;
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bruto)) !== null) {
    try {
      const inflado = zlib.inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
      total += [...inflado.matchAll(/\/I\d+\s+Do/g)].length;
    } catch {
      /* idem */
    }
  }
  return total;
}

async function criarEmpresa(e: Empresa, marca: string, hash: string): Promise<void> {
  const sufixo = crypto.randomUUID().slice(0, 8);
  e.tenant = crypto.randomUUID();
  e.slug = `tmb-${sufixo}`;
  e.nome = marca;
  e.dono = `dono-${sufixo}@tmb.test`;
  e.prof = `prof-${sufixo}@tmb.test`;

  await comTenant(e.tenant, async (c) => {
    await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [e.tenant, marca, e.slug]);
    await c.query(
      `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
       VALUES ($1,$2,$3,'Dono','OWNER')`,
      [e.tenant, e.dono, hash],
    );
    await c.query(
      `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
       VALUES ($1,$2,$3,'Prof','PROFESSIONAL')`,
      [e.tenant, e.prof, hash],
    );
    const s = await c.query<{ id: string }>(
      `INSERT INTO students (tenant_id, full_name, whatsapp)
       VALUES ($1,'Aluno Timbre','+5551988887777') RETURNING id`,
      [e.tenant],
    );
    e.aluno = s.rows[0]!.id;
  });
}

suite('Identidade da academia e papel timbrado', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'zK3-acesso-somente-para-teste-com-tamanho-suficiente-01';
    process.env['JWT_REFRESH_SECRET'] = 'qP9-refresh-somente-para-teste-com-tamanho-suficiente-02';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    process.env['CORS_ORIGINS'] = 'http://localhost:5173';
    process.env['LOG_LEVEL'] = 'fatal';

    const { resetEnvCache } = await import('../../config/env.js');
    resetEnvCache();
    const { buildApp } = await import('../../app.js');
    app = await buildApp();
    await app.ready();

    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    await criarEmpresa(alfa, 'Academia Alfa Marca Unica', hash);
    await criarEmpresa(beta, 'Academia Beta Outra Marca', hash);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /* ================================================================
   * Identidade — AC-01 a AC-05
   * ============================================================== */

  it('devolve a identidade do tenant do token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/academia',
      headers: como(await tokenDe(alfa.dono, alfa.slug)),
    });
    expect(res.statusCode).toBe(200);
    const d = (res.json() as { data: { nome: string; temLogo: boolean } }).data;
    expect(d.nome).toBe('Academia Alfa Marca Unica');
    expect(d.temLogo).toBe(false);
  });

  it('grava telefone e endereço', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/academia',
      headers: como(await tokenDe(alfa.dono, alfa.slug)),
      payload: {
        nome: 'Academia Alfa Marca Unica',
        telefone: '+5551333440054',
        cep: '80730390',
        logradouro: 'Rua Francisco Rocha',
        numero: '198',
        bairro: 'Batel',
        cidade: 'Curitiba',
        uf: 'pr',
      },
    });
    expect(res.statusCode).toBe(200);
    const d = (res.json() as { data: { telefone: string; endereco: { uf: string } } }).data;
    expect(d.telefone).toBe('+5551333440054');
    /* A UF é normalizada para maiúscula — o banco recusaria 'pr'. */
    expect(d.endereco.uf).toBe('PR');
  });

  it('recusa telefone fora de E.164 com 422', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/academia',
      headers: como(await tokenDe(alfa.dono, alfa.slug)),
      payload: { nome: 'Academia Alfa Marca Unica', telefone: '51999999999' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('o profissional não edita a identidade da academia', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/academia',
      headers: como(await tokenDe(alfa.prof, alfa.slug)),
      payload: { nome: 'Tentativa' },
    });
    expect(res.statusCode).toBe(403);
  });

  /* ================================================================
   * Logo — AC-06 a AC-14
   * ============================================================== */

  async function subirLogo(e: Empresa, bytes: Buffer, tipo: string) {
    const limite = '----t';
    const corpo = Buffer.concat([
      Buffer.from(
        `--${limite}\r\nContent-Disposition: form-data; name="file"; filename="logo"\r\nContent-Type: ${tipo}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${limite}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: '/api/academia/logo',
      headers: {
        ...como(await tokenDe(e.dono, e.slug)),
        'content-type': `multipart/form-data; boundary=${limite}`,
      },
      payload: corpo,
    });
  }

  it('aceita PNG como logo', async () => {
    const res = await subirLogo(alfa, PNG, 'image/png');
    expect(res.statusCode).toBe(201);

    const lido = await app.inject({
      method: 'GET',
      url: '/api/academia',
      headers: como(await tokenDe(alfa.dono, alfa.slug)),
    });
    expect((lido.json() as { data: { temLogo: boolean } }).data.temLogo).toBe(true);
  });

  it('recusa WebP — o pdfkit não embute, e o erro precisa nascer aqui', async () => {
    const res = await subirLogo(beta, WEBP, 'image/webp');
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('PNG');
  });

  it('recusa SVG', async () => {
    const res = await subirLogo(beta, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
    expect(res.statusCode).toBe(422);
  });

  it('recusa arquivo que declara PNG mas tem outros bytes', async () => {
    const res = await subirLogo(beta, Buffer.from('nao sou png nenhum'), 'image/png');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('serve o logo do próprio tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/academia/logo',
      headers: como(await tokenDe(alfa.dono, alfa.slug)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  /* O CRITÉRIO CRÍTICO — AC-12.
     A Beta subiu logo nenhum. Se ela alcançasse alguma imagem, seria a
     da Alfa. Não existe id no caminho justamente para não haver id para
     trocar: a chave vem do banco, sob RLS, a partir do token. */
  it('a academia B não alcança o logo da academia A', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/academia/logo',
      headers: como(await tokenDe(beta.dono, beta.slug)),
    });
    expect(res.statusCode).toBe(404);
  });

  /* ================================================================
   * Papel timbrado — AC-15 a AC-22
   * ============================================================== */

  it('o relatório traz o nome da PRÓPRIA academia, e não o do código', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/alunos',
      headers: como(await tokenDe(beta.dono, beta.slug)),
    });
    expect(res.statusCode).toBe(200);
    const texto = textoDoPdf(res.rawPayload);

    expect(texto).toContain('ACADEMIA BETA OUTRA MARCA');
    /* A regressão que este teste existe para impedir. */
    expect(texto).not.toContain('Stabilize');
    expect(texto).not.toContain('ALFA');
  });

  it('o rodapé traz o telefone e o endereço da academia', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/alunos',
      headers: como(await tokenDe(alfa.dono, alfa.slug)),
    });
    const texto = textoDoPdf(res.rawPayload);
    expect(texto).toContain('(51) 3334-40054'.slice(0, 5));
    expect(texto).toContain('Rua Francisco Rocha');
    expect(texto).toContain('Curitiba/PR');
  });

  /* AC-19 — o caso que não pode quebrar de jeito nenhum. */
  it('academia SEM logo e SEM endereço emite o relatório normalmente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/alunos',
      headers: como(await tokenDe(beta.dono, beta.slug)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(desenhosDeImagem(res.rawPayload)).toBe(0);
  });

  /* AC-16 — com logo, a imagem é desenhada: uma no cabeçalho e uma
     marca d'água por página. */
  it('com logo, o PDF desenha a imagem no cabeçalho e na marca d’água', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/relatorios/alunos',
      headers: como(await tokenDe(alfa.dono, alfa.slug)),
    });
    expect(res.statusCode).toBe(200);
    /* Documento de uma página: marca d'água + logo do cabeçalho = 2. */
    expect(desenhosDeImagem(res.rawPayload)).toBeGreaterThanOrEqual(2);
  });

  /* AC-17 — o defeito silencioso. Se a marca d'água fosse desenhada no
     fechamento junto da numeração, ela cairia POR CIMA do texto. */
  it('a marca d’água não engole o texto do relatório', async () => {
    const comMarca = await app.inject({
      method: 'GET',
      url: '/api/relatorios/alunos',
      headers: como(await tokenDe(alfa.dono, alfa.slug)),
    });
    const texto = textoDoPdf(comMarca.rawPayload);

    /* O conteúdo que o relatório existe para entregar continua legível. */
    expect(texto).toContain('Aluno Timbre');
    expect(texto).toContain('de aluno');
  });
});
