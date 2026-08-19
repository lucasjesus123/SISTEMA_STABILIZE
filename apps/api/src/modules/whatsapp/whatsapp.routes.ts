import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant } from '../../http/plugins/authenticate.js';
import { writeAudit } from '../../audit/audit.js';
import { badRequest } from '../../http/errors.js';
import { cifrar, decifrar } from './segredo.js';
import { criarInstancia, enviarTexto, obterQrCode, statusDaInstancia } from './uazapi.js';
import { enviarAniversariosDoDia } from './aniversarios.js';

/**
 * Conexão do WhatsApp da academia.
 *
 * O TOKEN NUNCA SAI DAQUI. Ele é criado na uazapi, cifrado e gravado; a
 * API devolve status e QR Code, jamais o token. Um token que chega ao
 * navegador está a um XSS de ser exfiltrado — e com ele se manda
 * mensagem em nome da academia para a base inteira de alunos.
 *
 * Tudo aqui exige `user:write`, que só OWNER e ADMIN têm: conectar o
 * WhatsApp é decisão de quem responde pela empresa.
 */

export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  /* Estado atual da conexão. */
  app.get('/', { preHandler: [app.authorize('user:write')] }, async (request) => {
    return inTenant(request, async (client) => {
      const { rows } = await client.query<{
        id: string;
        instance_name: string;
        phone_number: string | null;
        status: string;
        connected_at: Date | null;
        token_encrypted: string | null;
      }>(
        `SELECT id, instance_name, phone_number, status, connected_at, token_encrypted
           FROM whatsapp_instances ORDER BY created_at LIMIT 1`,
      );

      const linha = rows[0];
      if (linha === undefined) return { data: null };

      /* Se há token, perguntamos ao provedor o estado REAL. O banco tem a
         última coisa que soubemos; o celular pode ter desconectado desde
         então, e mostrar "conectado" para quem já não está é pior que
         não mostrar nada — a academia só descobre quando a mensagem não
         chega. */
      let status = linha.status;
      let numero = linha.phone_number;
      if (linha.token_encrypted !== null) {
        try {
          const atual = await statusDaInstancia(decifrar(linha.token_encrypted));
          status = atual.status;
          numero = atual.numero ?? numero;
          await client.query(
            `UPDATE whatsapp_instances
                SET status = $2, phone_number = COALESCE($3, phone_number),
                    connected_at = CASE WHEN $2 = 'CONNECTED' AND connected_at IS NULL
                                        THEN now() ELSE connected_at END
              WHERE id = $1`,
            [linha.id, status, numero],
          );
        } catch (erro) {
          request.log.warn({ err: erro }, 'não foi possível consultar a uazapi');
          status = 'DESCONHECIDO';
        }
      }

      return {
        data: {
          id: linha.id,
          nome: linha.instance_name,
          numero,
          status,
          conectadoEm: linha.connected_at?.toISOString() ?? null,
        },
      };
    });
  });

  /* Cria a instância e devolve o QR para escanear. */
  app.post('/conectar', { preHandler: [app.authorize('user:write')] }, async (request) => {
    return inTenant(request, async (client, principal) => {
      const existente = await client.query<{ id: string; token_encrypted: string | null }>(
        `SELECT id, token_encrypted FROM whatsapp_instances ORDER BY created_at LIMIT 1`,
      );

      let token: string;
      let instanciaId: string;

      if (existente.rows[0]?.token_encrypted != null) {
        // Reconectar: reaproveita a instância, só pede QR novo.
        token = decifrar(existente.rows[0].token_encrypted);
        instanciaId = existente.rows[0].id;
      } else {
        /* O nome da instância na uazapi carrega o id da empresa: quando
           houver trinta academias no mesmo provedor, "stabilize" não
           diria a qual pertence. */
        const nome = `stz-${principal.tenantId.slice(0, 8)}`;
        const criada = await criarInstancia(nome);
        token = criada.token;

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO whatsapp_instances (tenant_id, instance_name, token_encrypted, status)
           VALUES ($1, $2, $3, 'CONNECTING')
           ON CONFLICT (tenant_id, instance_name)
           DO UPDATE SET token_encrypted = EXCLUDED.token_encrypted, status = 'CONNECTING'
           RETURNING id`,
          [principal.tenantId, nome, cifrar(token)],
        );
        instanciaId = rows[0]!.id;
      }

      const qr = await obterQrCode(token);

      await writeAudit(client, principal.tenantId, {
        action: 'whatsapp.connect',
        resourceType: 'whatsapp_instance',
        resourceId: instanciaId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
      });

      // Nunca o token — só o desenho do QR e o estado.
      return { data: { qr: qr.qr, status: qr.status } };
    });
  });

  /* Envio manual, para testar a conexão. */
  app.post('/testar', { preHandler: [app.authorize('user:write')] }, async (request) => {
    const { numero, texto } = z
      .object({
        numero: z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/, 'Use o formato +5531999998888'),
        texto: z.string().trim().min(1).max(1000),
      })
      .parse(request.body);

    return inTenant(request, async (client, principal) => {
      const { rows } = await client.query<{ token_encrypted: string | null }>(
        `SELECT token_encrypted FROM whatsapp_instances
          WHERE status = 'CONNECTED' AND token_encrypted IS NOT NULL LIMIT 1`,
      );
      if (rows[0]?.token_encrypted == null) {
        throw badRequest('Nenhum WhatsApp conectado. Conecte um número antes de testar.');
      }

      const resposta = await enviarTexto(decifrar(rows[0].token_encrypted), numero, texto);

      await client.query(
        `INSERT INTO whatsapp_messages
           (tenant_id, to_number, body, kind, status, provider_id, sent_at, idempotency_key)
         VALUES ($1,$2,$3,'MANUAL','SENT',$4, now(), $5)`,
        [principal.tenantId, numero, texto, resposta.id, `manual:${crypto.randomUUID()}`],
      );

      return { ok: true };
    });
  });

  /* Histórico do que o sistema mandou. */
  app.get('/mensagens', { preHandler: [app.authorize('user:write')] }, async (request) => {
    return inTenant(request, async (client) => {
      const { rows } = await client.query<{
        id: string;
        to_number: string;
        body: string;
        kind: string;
        status: string;
        error: string | null;
        created_at: Date;
        aluno: string | null;
      }>(
        `SELECT m.id, m.to_number, m.body, m.kind, m.status, m.error, m.created_at,
                s.full_name AS aluno
           FROM whatsapp_messages m
           LEFT JOIN students s ON s.id = m.student_id
          ORDER BY m.created_at DESC
          LIMIT 100`,
      );

      return {
        data: rows.map((l) => ({
          id: l.id,
          numero: l.to_number,
          texto: l.body,
          tipo: l.kind,
          status: l.status,
          erro: l.error,
          aluno: l.aluno,
          criadoEm: l.created_at.toISOString(),
        })),
      };
    });
  });

  /* Dispara os aniversários do dia sob demanda.
     Existe para o dia em que alguém precisa conferir se está funcionando
     sem esperar as 9h — e é seguro justamente porque a idempotência mora
     no banco: chamar dez vezes manda uma mensagem. */
  app.post('/aniversarios/executar', { preHandler: [app.authorize('user:write')] }, async (request) => {
    const resultado = await enviarAniversariosDoDia(request.log);
    return { data: resultado };
  });

  /* ------------------------------------------------------------------
   * Avisos automáticos de agendamento
   *
   * ESTAS DUAS CONFIGURAÇÕES EXISTIAM NO BANCO DESDE A MIGRAÇÃO 016 E
   * NÃO TINHAM ROTA NEM TELA. Eram lidas por ninguém e editáveis por
   * ninguém — a academia ficava com o padrão para sempre e sem saber
   * que havia padrão.
   * ---------------------------------------------------------------- */
  app.get('/avisos', { preHandler: [app.authorize('user:write')] }, async (request) =>
    inTenant(request, async (client) => {
      const { rows } = await client.query<{ confirmar: boolean; horas: number }>(
        `SELECT wa_confirmar_agendamento AS confirmar, wa_lembrete_horas AS horas
           FROM tenants WHERE id = current_tenant_id()`,
      );
      const l = rows[0];
      return {
        data: {
          confirmarAgendamento: l?.confirmar ?? true,
          lembreteHoras: l?.horas ?? 3,
        },
      };
    }),
  );

  app.put('/avisos', { preHandler: [app.authorize('user:write')] }, async (request) => {
    const body = z
      .object({
        confirmarAgendamento: z.boolean(),
        /* O teto de 168 h é uma semana, e é o mesmo CHECK do banco:
           repetido aqui só para a mensagem de erro sair em português em
           vez de vir como violação de constraint. */
        lembreteHoras: z.coerce.number().int().min(0).max(168),
      })
      .parse(request.body);

    return inTenant(request, async (client, principal) => {
      await client.query(
        `UPDATE tenants
            SET wa_confirmar_agendamento = $1, wa_lembrete_horas = $2
          WHERE id = current_tenant_id()`,
        [body.confirmarAgendamento, body.lembreteHoras],
      );

      await writeAudit(client, principal.tenantId, {
        action: 'tenant.settings',
        resourceType: 'tenant',
        resourceId: principal.tenantId,
        actorId: principal.userId,
        actorRole: principal.role,
        ip: request.ip,
        metadata: { avisos: body },
      });
      return { ok: true };
    });
  });
}
