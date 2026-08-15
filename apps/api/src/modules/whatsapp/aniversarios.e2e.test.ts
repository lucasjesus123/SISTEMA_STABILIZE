import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * Aniversários, contra o banco de verdade.
 *
 * O teste que importa é o da IDEMPOTÊNCIA. Parabenizar alguém duas vezes
 * no mesmo dia é o tipo de erro que a pessoa comenta com os amigos, e a
 * proteção não está no agendador — está no UNIQUE de `idempotency_key`.
 * Por isso este teste roda a tarefa DUAS vezes e conta as chamadas ao
 * provedor.
 *
 * A uazapi é substituída por um espião: o teste não fala com a internet,
 * e o que se verifica é o que o sistema TENTOU enviar.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let pool: pg.Pool;
const ids = { tenant: '', alunoAniversariante: '', alunoOutraData: '', alunoSemWhats: '' };

/* Número ÚNICO por execução.
   A tarefa varre todas as empresas ativas — comportamento certo em
   produção. A consequência para o teste é que academias deixadas por
   execuções anteriores continuam recebendo parabéns, e um filtro por
   número fixo contaria as delas junto. Com número exclusivo, o que este
   teste mede é só o que este teste criou. */
const NUMERO = `+5531${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const NUMERO_DIGITOS = NUMERO.replace(/\D/g, '');

/** Chamadas capturadas: [caminho, corpo]. */
const chamadas: { caminho: string; corpo: unknown }[] = [];

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

const logSilencioso = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

suite('Aniversários', () => {
  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = TEST_DATABASE_URL!;
    process.env['JWT_ACCESS_SECRET'] = 'zK3-acesso-somente-para-teste-com-tamanho-suficiente-01';
    process.env['JWT_REFRESH_SECRET'] = 'qP9-refresh-somente-para-teste-com-tamanho-suficiente-02';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    process.env['CORS_ORIGINS'] = 'http://localhost:5173';
    process.env['UAZAPI_BASE_URL'] = 'https://uazapi.invalido';
    process.env['UAZAPI_ADMIN_TOKEN'] = 'token-admin-de-teste';

    const { resetEnvCache } = await import('../../config/env.js');
    resetEnvCache();

    // Espião no lugar da rede.
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      chamadas.push({
        caminho: new URL(url).pathname,
        corpo: init.body === undefined || init.body === null ? null : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ id: `msg-${chamadas.length}` }), { status: 200 });
    });

    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    const { cifrar } = await import('./segredo.js');
    const hoje = new Date();
    const nascimentoHoje = `1990-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    // Uma data que garantidamente não é hoje.
    const outroDia = new Date(hoje.getTime() + 3 * 86_400_000);
    const nascimentoOutro = `1990-${String(outroDia.getMonth() + 1).padStart(2, '0')}-${String(outroDia.getDate()).padStart(2, '0')}`;

    ids.tenant = crypto.randomUUID();
    const sufixo = crypto.randomUUID().slice(0, 8);

    await comTenant(ids.tenant, async (c) => {
      await c.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [
        ids.tenant,
        'Academia Aniversário',
        `aniv-${sufixo}`,
      ]);
      await c.query(
        `INSERT INTO whatsapp_instances (tenant_id, instance_name, token_encrypted, status)
         VALUES ($1,$2,$3,'CONNECTED')`,
        [ids.tenant, `stz-${sufixo}`, cifrar('token-da-instancia')],
      );

      const a = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name, birth_date, whatsapp, status)
         VALUES ($1,'Joana Faz Anos Hoje',$2,$3,'ACTIVE') RETURNING id`,
        [ids.tenant, nascimentoHoje, NUMERO],
      );
      const b = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name, birth_date, whatsapp, status)
         VALUES ($1,'Pedro Faz Depois',$2,'+5531988886666','ACTIVE') RETURNING id`,
        [ids.tenant, nascimentoOutro],
      );
      const d = await c.query<{ id: string }>(
        `INSERT INTO students (tenant_id, full_name, birth_date, status)
         VALUES ($1,'Sem Whatsapp Hoje',$2,'ACTIVE') RETURNING id`,
        [ids.tenant, nascimentoHoje],
      );
      ids.alunoAniversariante = a.rows[0]!.id;
      ids.alunoOutraData = b.rows[0]!.id;
      ids.alunoSemWhats = d.rows[0]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    const { closePool } = await import('../../db/pool.js');
    await closePool().catch(() => undefined);
    await pool?.end();
  });

  it('manda UMA mensagem, e só para quem faz aniversário hoje', async () => {
    const { enviarAniversariosDoDia } = await import('./aniversarios.js');
    await enviarAniversariosDoDia(logSilencioso);

    /* As asserções são POR EMPRESA, filtrando pelo número que este teste
       criou. Os contadores que a tarefa devolve são globais — ela varre
       todas as academias ativas, que é o comportamento certo em produção
       e o errado para medir aqui: um banco com outras empresas (as de
       outros testes, por exemplo) faria o total variar sem que nada
       tivesse quebrado. */
    const envios = chamadas.filter(
      (c) => c.caminho === '/send/text' && (c.corpo as { number?: string }).number === NUMERO_DIGITOS,
    );
    expect(envios).toHaveLength(1);

    const corpo = envios[0]!.corpo as { number: string; text: string };
    // O número vai só com dígitos, como a uazapi espera; o banco guarda E.164.
    expect(corpo.number).toBe(NUMERO_DIGITOS);
    expect(corpo.text).toContain('Joana');
    // Quem faz aniversário em outra data não recebe nada.
    expect(corpo.text).not.toContain('Pedro');
  });

  it('rodar DE NOVO no mesmo dia não manda mensagem nenhuma', async () => {
    /* A proteção é o UNIQUE (tenant_id, idempotency_key) no banco, não a
       memória do agendador. É isso que permite o tique de hora em hora,
       um disparo manual e até duas réplicas da API sem risco. */
    const meus = () =>
      chamadas.filter(
        (c) =>
          c.caminho === '/send/text' && (c.corpo as { number?: string }).number === NUMERO_DIGITOS,
      ).length;
    const antes = meus();

    const { enviarAniversariosDoDia } = await import('./aniversarios.js');
    const r = await enviarAniversariosDoDia(logSilencioso);

    expect(r.jaEnviadas).toBeGreaterThanOrEqual(1);
    expect(meus()).toBe(antes);
  });

  it('registra a mensagem com o texto que foi realmente enviado', async () => {
    const { rows } = await comTenant(ids.tenant, async (c) =>
      c.query<{ status: string; body: string; kind: string; provider_id: string | null }>(
        `SELECT status, body, kind, provider_id FROM whatsapp_messages
          WHERE student_id = $1`,
        [ids.alunoAniversariante],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('SENT');
    expect(rows[0]!.kind).toBe('BIRTHDAY');
    expect(rows[0]!.body).toContain('Joana');
    expect(rows[0]!.provider_id).not.toBeNull();
  });

  it('aluno sem WhatsApp não vira mensagem nem erro', async () => {
    /* Não ter telefone é normal, não é falha. Se virasse erro, o log
       encheria todo dia e as falhas de verdade sumiriam no meio. */
    const { rows } = await comTenant(ids.tenant, async (c) =>
      c.query(`SELECT 1 FROM whatsapp_messages WHERE student_id = $1`, [ids.alunoSemWhats]),
    );
    expect(rows).toHaveLength(0);
  });

  it('sem instância conectada, a empresa é pulada em silêncio', async () => {
    await comTenant(ids.tenant, async (c) => {
      await c.query(`UPDATE whatsapp_instances SET status = 'DISCONNECTED'`);
      await c.query(`DELETE FROM whatsapp_messages`);
    });

    const meus = () =>
      chamadas.filter(
        (c) =>
          c.caminho === '/send/text' && (c.corpo as { number?: string }).number === NUMERO_DIGITOS,
      ).length;
    const antes = meus();

    const { enviarAniversariosDoDia } = await import('./aniversarios.js');
    await enviarAniversariosDoDia(logSilencioso);

    expect(meus()).toBe(antes);

    await comTenant(ids.tenant, async (c) => {
      await c.query(`UPDATE whatsapp_instances SET status = 'CONNECTED'`);
    });
  });
});
