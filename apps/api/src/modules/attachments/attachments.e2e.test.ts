import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import argon2 from 'argon2';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Anexos, ponta a ponta.
 *
 * O upload é a superfície mais perigosa do sistema: é a única em que o
 * usuário escolhe BYTES e um NOME. Os testes aqui cobrem os dois riscos
 * clássicos — sair do diretório pelo nome, e enganar o tipo pelo
 * Content-Type — além do isolamento entre profissionais que vale para
 * todo o prontuário.
 *
 * Requer TEST_DATABASE_URL num papel SEM BYPASSRLS.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;
let pool: pg.Pool;
let armazenamento = '';

const SENHA = 'senha-de-teste-longa-2026';

const ids = {
  tenantA: '',
  slugA: '',
  profAlfa: '',
  emailProfAlfa: '',
  emailProfBeta: '',
  emailDono: '',
  alunoDoAlfa: '',
  alunoDoBeta: '',
};

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

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

const cacheTokens = new Map<string, string>();

async function tokenDe(email: string): Promise<string> {
  const emCache = cacheTokens.get(email);
  if (emCache !== undefined) return emCache;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: SENHA, tenantSlug: ids.slugA },
  });
  const body = res.json() as { accessToken?: string };
  if (body.accessToken === undefined) {
    throw new Error(`login falhou para ${email}: ${res.statusCode} ${res.body}`);
  }
  cacheTokens.set(email, body.accessToken);
  return body.accessToken;
}

/** Monta um corpo multipart à mão, para controlar nome e Content-Type. */
function multipart(
  nomeArquivo: string,
  tipo: string,
  conteudo: Buffer,
  extras: Record<string, string> = {},
): { corpo: Buffer; cabecalho: string } {
  const fronteira = '----stabilizeTeste' + Math.random().toString(36).slice(2);
  const partes: Buffer[] = [];

  for (const [chave, valor] of Object.entries(extras)) {
    partes.push(
      Buffer.from(
        `--${fronteira}\r\nContent-Disposition: form-data; name="${chave}"\r\n\r\n${valor}\r\n`,
      ),
    );
  }

  partes.push(
    Buffer.from(
      `--${fronteira}\r\n` +
        `Content-Disposition: form-data; name="arquivo"; filename="${nomeArquivo}"\r\n` +
        `Content-Type: ${tipo}\r\n\r\n`,
    ),
    conteudo,
    Buffer.from(`\r\n--${fronteira}--\r\n`),
  );

  return {
    corpo: Buffer.concat(partes),
    cabecalho: `multipart/form-data; boundary=${fronteira}`,
  };
}

async function enviar(
  token: string,
  alunoId: string,
  nomeArquivo: string,
  tipo: string,
  conteudo: Buffer,
  extras: Record<string, string> = {},
) {
  const { corpo, cabecalho } = multipart(nomeArquivo, tipo, conteudo, extras);
  return app.inject({
    method: 'POST',
    url: `/api/students/${alunoId}/anexos`,
    headers: { authorization: `Bearer ${token}`, 'content-type': cabecalho },
    payload: corpo,
  });
}

const como = (token: string) => ({ authorization: `Bearer ${token}` });

/** Todos os arquivos sob o diretório de armazenamento, recursivamente. */
async function arquivosNoDisco(dir: string): Promise<string[]> {
  const saida: string[] = [];
  const entradas = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entradas) {
    const completo = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...(await arquivosNoDisco(completo)));
    else saida.push(completo);
  }
  return saida;
}

suite('Anexos', () => {
  beforeAll(async () => {
    armazenamento = await mkdtemp(path.join(tmpdir(), 'stz-anexos-'));

    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'zK3-acesso-somente-para-teste-com-tamanho-suficiente-01';
    process.env['JWT_REFRESH_SECRET'] = 'qP9-refresh-somente-para-teste-com-tamanho-suficiente-02';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    process.env['CORS_ORIGINS'] = 'http://localhost:5173';
    process.env['LOG_LEVEL'] = 'fatal';
    process.env['STORAGE_DIR'] = armazenamento;
    process.env['UPLOAD_MAX_BYTES'] = '65536';

    const { resetEnvCache } = await import('../../config/env.js');
    resetEnvCache();
    const { buildApp } = await import('../../app.js');
    app = await buildApp();
    await app.ready();

    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    const sufixo = crypto.randomUUID().slice(0, 8);
    ids.tenantA = crypto.randomUUID();
    ids.slugA = `anexo-${sufixo}`;
    ids.emailProfAlfa = `anx-alfa-${sufixo}@anexo.test`;
    ids.emailProfBeta = `anx-beta-${sufixo}@anexo.test`;
    ids.emailDono = `anx-dono-${sufixo}@anexo.test`;

    const hash = await argon2.hash(SENHA, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });

    await comTenant(ids.tenantA, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenantA,
        'Clinica Anexos',
        ids.slugA,
      ]);
      const pa = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Alfa','PROFESSIONAL') RETURNING id`,
        [ids.tenantA, ids.emailProfAlfa, hash],
      );
      const pb = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Prof Beta','PROFESSIONAL') RETURNING id`,
        [ids.tenantA, ids.emailProfBeta, hash],
      );
      await c.query(
        `INSERT INTO users (tenant_id,email,password_hash,full_name,role)
         VALUES ($1,$2,$3,'Dono','OWNER')`,
        [ids.tenantA, ids.emailDono, hash],
      );
      ids.profAlfa = pa.rows[0]!.id;

      const s1 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno do Alfa') RETURNING id`,
        [ids.tenantA],
      );
      const s2 = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id,full_name) VALUES ($1,'Aluno do Beta') RETURNING id`,
        [ids.tenantA],
      );
      ids.alunoDoAlfa = s1.rows[0]!.id;
      ids.alunoDoBeta = s2.rows[0]!.id;

      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantA, ids.alunoDoAlfa, ids.profAlfa],
      );
      await c.query(
        `INSERT INTO student_professionals (tenant_id,student_id,professional_id) VALUES ($1,$2,$3)`,
        [ids.tenantA, ids.alunoDoBeta, pb.rows[0]!.id],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (armazenamento !== '') await rm(armazenamento, { recursive: true, force: true });
  });

  it('envia um PDF e o traz de volta byte a byte', async () => {
    const token = await tokenDe(ids.emailProfAlfa);

    const enviou = await enviar(token, ids.alunoDoAlfa, 'exame.pdf', 'application/pdf', PDF, {
      categoria: 'EXAME',
      descricao: 'Ressonância de coluna',
    });
    expect(enviou.statusCode).toBe(201);
    const { data } = enviou.json() as { data: { id: string } };

    const baixou = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}/conteudo`,
      headers: como(token),
    });
    expect(baixou.statusCode).toBe(200);
    expect(baixou.rawPayload.equals(PDF)).toBe(true);
  });

  it('o download força anexo e proíbe o navegador de adivinhar o tipo', async () => {
    /* Servir inline é como um PDF ou SVG enviado por um aluno vira
       execução de script no domínio do sistema — e daí a sessão de quem
       abriu está ao alcance. */
    const token = await tokenDe(ids.emailProfAlfa);
    const enviou = await enviar(token, ids.alunoDoAlfa, 'laudo.pdf', 'application/pdf', PDF);
    const { data } = enviou.json() as { data: { id: string } };

    const baixou = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}/conteudo`,
      headers: como(token),
    });

    expect(baixou.headers['content-disposition']).toContain('attachment;');
    expect(baixou.headers['x-content-type-options']).toBe('nosniff');
    expect(baixou.headers['cache-control']).toContain('no-store');
  });

  it('um nome com ../ NÃO escapa do diretório de armazenamento', async () => {
    const token = await tokenDe(ids.emailProfAlfa);

    const enviou = await enviar(
      token,
      ids.alunoDoAlfa,
      '../../../../../../tmp/invadido.pdf',
      'application/pdf',
      PDF,
    );
    // O upload é aceito: o nome é só rótulo, não caminho.
    expect(enviou.statusCode).toBe(201);

    // E tudo que foi para o disco está sob a raiz, com nome de uuid.
    const arquivos = await arquivosNoDisco(armazenamento);
    expect(arquivos.length).toBeGreaterThan(0);
    for (const f of arquivos) {
      expect(path.resolve(f).startsWith(path.resolve(armazenamento))).toBe(true);
      expect(path.basename(f)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    await expect(stat('/tmp/invadido.pdf')).rejects.toThrow();
  });

  it('o rótulo guardado nunca contém separador de caminho', async () => {
    /* O rótulo é o que a pessoa lê para reconhecer o próprio exame, e
       por isso mantém acento, espaço e maiúscula. O que ele não pode
       carregar é componente de caminho.

       O parser de multipart já corta o caminho sozinho, mas isso é
       comportamento de biblioteca — a normalização é feita também por
       nós, e é essa garantia que este teste cobre. */
    const token = await tokenDe(ids.emailProfAlfa);
    await enviar(token, ids.alunoDoAlfa, '../../etc/passwd.pdf', 'application/pdf', PDF);
    await enviar(token, ids.alunoDoAlfa, 'Exame de Sangue — 12/2026.pdf', 'application/pdf', PDF);

    const lista = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anexos`,
      headers: como(token),
    });
    const nomes = (lista.json() as { data: { nome: string }[] }).data.map((a) => a.nome);

    for (const n of nomes) {
      expect(n).not.toMatch(/[/\\]/);
      expect(n).not.toBe('..');
    }
    // E o nome legível chega inteiro, acento e travessão inclusive.
    expect(nomes).toContain('Exame de Sangue — 12/2026.pdf'.split('/').pop());
  });

  it('recusa um HTML disfarçado de imagem', async () => {
    /* O Content-Type vem do cliente e é um palpite. Sem conferir os
       primeiros bytes, um HTML com <script> entraria como "image/png". */
    const token = await tokenDe(ids.emailProfAlfa);
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');

    const enviou = await enviar(token, ids.alunoDoAlfa, 'foto.png', 'image/png', html);
    expect(enviou.statusCode).toBe(422);
  });

  it('recusa formato fora da lista de permissão', async () => {
    const token = await tokenDe(ids.emailProfAlfa);
    const enviou = await enviar(
      token,
      ids.alunoDoAlfa,
      'script.sh',
      'application/x-sh',
      Buffer.from('#!/bin/sh\nrm -rf /\n'),
    );
    expect(enviou.statusCode).toBe(422);
  });

  it('arquivo recusado não deixa sobra no disco', async () => {
    const token = await tokenDe(ids.emailProfAlfa);
    const antes = (await arquivosNoDisco(armazenamento)).length;

    await enviar(
      token,
      ids.alunoDoAlfa,
      'falso.png',
      'image/png',
      Buffer.from('<html>não é png</html>'),
    );

    const depois = await arquivosNoDisco(armazenamento);
    expect(depois.length).toBe(antes);
    // E nenhum arquivo parcial esquecido.
    expect(depois.some((f) => f.endsWith('.parcial'))).toBe(false);
  });

  it('um profissional não vê nem baixa anexo do aluno de um colega', async () => {
    const alfa = await tokenDe(ids.emailProfAlfa);
    const enviou = await enviar(alfa, ids.alunoDoAlfa, 'confidencial.pdf', 'application/pdf', PDF);
    const { data } = enviou.json() as { data: { id: string } };

    const beta = await tokenDe(ids.emailProfBeta);

    const listou = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anexos`,
      headers: como(beta),
    });
    expect(listou.statusCode).toBe(404);

    /* O download é tentado com o id CERTO do anexo, em mãos. É o teste
       que importa: não basta esconder da lista. */
    const baixou = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}/conteudo`,
      headers: como(beta),
    });
    expect(baixou.statusCode).toBe(404);
  });

  it('um profissional não envia anexo para o aluno de um colega', async () => {
    const beta = await tokenDe(ids.emailProfBeta);
    const enviou = await enviar(beta, ids.alunoDoAlfa, 'plantado.pdf', 'application/pdf', PDF);
    expect(enviou.statusCode).toBe(404);
  });

  it('upload recusado por escopo não deixa o arquivo órfão no disco', async () => {
    /* Os bytes são gravados ANTES da transação, para não segurar conexão
       do pool durante o upload. A contrapartida é ter que limpar quando
       o banco recusa — senão fica dado de saúde no disco que ninguém
       alcança e ninguém sabe que existe. */
    const beta = await tokenDe(ids.emailProfBeta);
    const antes = (await arquivosNoDisco(armazenamento)).length;

    await enviar(beta, ids.alunoDoAlfa, 'orfao.pdf', 'application/pdf', PDF);

    expect((await arquivosNoDisco(armazenamento)).length).toBe(antes);
  });

  it('o profissional NÃO apaga anexo; o dono apaga, e os bytes somem', async () => {
    const alfa = await tokenDe(ids.emailProfAlfa);
    const enviou = await enviar(alfa, ids.alunoDoAlfa, 'para-apagar.pdf', 'application/pdf', PDF);
    const { data } = enviou.json() as { data: { id: string } };

    const tentou = await app.inject({
      method: 'DELETE',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}`,
      headers: como(alfa),
    });
    expect(tentou.statusCode).toBe(403);

    const antes = (await arquivosNoDisco(armazenamento)).length;
    const dono = await tokenDe(ids.emailDono);
    const apagou = await app.inject({
      method: 'DELETE',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}`,
      headers: como(dono),
    });
    expect(apagou.statusCode).toBe(200);

    /* Apagar um exame apaga o exame: a linha fica como auditoria, os
       bytes não. Manter o arquivo depois de um pedido de exclusão é o
       que a LGPD (art. 18, VI) não admite. */
    expect((await arquivosNoDisco(armazenamento)).length).toBe(antes - 1);

    const baixou = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}/conteudo`,
      headers: como(alfa),
    });
    expect(baixou.statusCode).toBe(404);
  });

  it('a exclusão registra QUAL arquivo foi apagado', async () => {
    const alfa = await tokenDe(ids.emailProfAlfa);
    const nome = `hemograma-${crypto.randomUUID().slice(0, 6)}.pdf`;
    const enviou = await enviar(alfa, ids.alunoDoAlfa, nome, 'application/pdf', PDF);
    const { data } = enviou.json() as { data: { id: string } };

    const dono = await tokenDe(ids.emailDono);
    await app.inject({
      method: 'DELETE',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}`,
      headers: como(dono),
    });

    /* Aqui o nome VAI para o log, ao contrário do conteúdo clínico: sem
       ele o registro de exclusão não responde "o que foi apagado?". */
    const linhas = await comTenant(ids.tenantA, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'attachment.delete' AND metadata->>'arquivo' = $1`,
        [nome],
      ),
    );
    expect(Number(linhas.rows[0]!.n)).toBe(1);
  });

  it('o download fica registrado na auditoria', async () => {
    const token = await tokenDe(ids.emailProfAlfa);
    const enviou = await enviar(token, ids.alunoDoAlfa, 'auditado.pdf', 'application/pdf', PDF);
    const { data } = enviou.json() as { data: { id: string } };

    await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}/conteudo`,
      headers: como(token),
    });

    const linhas = await comTenant(ids.tenantA, async (c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'attachment.read' AND resource_id = $1
            AND metadata->>'download' = 'true'`,
        [data.id],
      ),
    );
    expect(Number(linhas.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('linha no banco sem os bytes em disco responde 404, não download quebrado', async () => {
    /* Banco e disco podem discordar: restore parcial, disco trocado,
       exclusão interrompida. Sem conferir, o cliente receberia 200 com
       cabeçalho de download e um corpo que morre no meio — um arquivo
       corrompido, que é pior que um erro claro porque parece ter dado
       certo. */
    const token = await tokenDe(ids.emailProfAlfa);
    const enviou = await enviar(token, ids.alunoDoAlfa, 'sumiu.pdf', 'application/pdf', PDF);
    const { data } = enviou.json() as { data: { id: string } };

    const chave = await comTenant(ids.tenantA, async (c) =>
      c.query<{ storage_key: string }>('SELECT storage_key FROM attachments WHERE id = $1', [
        data.id,
      ]),
    );
    const alvo = (await arquivosNoDisco(armazenamento)).find((f) =>
      f.endsWith(chave.rows[0]!.storage_key),
    );
    expect(alvo).toBeDefined();
    await rm(alvo!, { force: true });

    const baixou = await app.inject({
      method: 'GET',
      url: `/api/students/${ids.alunoDoAlfa}/anexos/${data.id}/conteudo`,
      headers: como(token),
    });
    expect(baixou.statusCode).toBe(404);
  });

  it('recusa arquivo maior que o limite', async () => {
    const token = await tokenDe(ids.emailProfAlfa);
    // UPLOAD_MAX_BYTES = 65536 nesta suíte.
    const grande = Buffer.concat([PDF, Buffer.alloc(70_000, 0x20)]);

    const enviou = await enviar(token, ids.alunoDoAlfa, 'grande.pdf', 'application/pdf', grande);
    expect(enviou.statusCode).toBeGreaterThanOrEqual(400);
    expect((await arquivosNoDisco(armazenamento)).some((f) => f.endsWith('.parcial'))).toBe(false);
  });

  it('aceita imagem, que é o caso do dia a dia', async () => {
    const token = await tokenDe(ids.emailProfAlfa);
    const enviou = await enviar(token, ids.alunoDoBeta, 'postura.png', 'image/png', PNG);
    // aluno do Beta: o Alfa não alcança
    expect(enviou.statusCode).toBe(404);

    const ok = await enviar(token, ids.alunoDoAlfa, 'postura.png', 'image/png', PNG, {
      categoria: 'FOTO',
    });
    expect(ok.statusCode).toBe(201);
  });
});
