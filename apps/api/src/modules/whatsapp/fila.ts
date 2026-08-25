import type { FastifyBaseLogger } from 'fastify';
import { getPool, withTenant } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { configuracao, enviarTexto } from './uazapi.js';
import { decifrar } from './segredo.js';

/**
 * O worker da fila do WhatsApp.
 *
 * ESTA PEÇA FALTAVA E ERA O BURACO DO MÓDULO INTEIRO. A fila existia com
 * hora de envio, contador de tentativas e vínculo com o agendamento;
 * ninguém a lia. Confirmação de horário e lembrete de véspera eram
 * configurações que a academia ligava e que não faziam nada.
 *
 * A LINHA É RESERVADA COM UM UPDATE, e não lida com SELECT e atualizada
 * depois. Entre o SELECT e o UPDATE cabe outro processo — o da segunda
 * réplica, ou o do tique anterior que demorou — e nesse intervalo os
 * dois mandam a mesma mensagem. O `UPDATE ... WHERE status = 'PENDING'
 * ... RETURNING` decide o dono da linha dentro do próprio banco: quem
 * conseguir escrever, envia; o outro não recebe linha nenhuma.
 *
 * FALHA NÃO É FIM. Uma instância desconectada por dez minutos não pode
 * queimar as mensagens da manhã inteira. Cada falha empurra a hora de
 * envio para frente — 5 min, 25 min, 2 h — e só depois da quarta a linha
 * vira FAILED de vez, com o motivo gravado para alguém ver na tela.
 *
 * O LEMBRETE VELHO É DESCARTADO, NÃO ENVIADO. Se a fila ficou parada e o
 * lembrete de uma aula de ontem só saísse agora, o aluno receberia
 * "lembrete: sua aula é hoje às 7h" um dia depois. Mensagem atrasada
 * demais é pior que mensagem nenhuma.
 */

/** Depois disto a linha vira FAILED e para de tentar. */
const TENTATIVAS_MAXIMAS = 4;

/** Quanto tempo depois da hora marcada uma mensagem ainda faz sentido. */
const VALIDADE_HORAS = 6;

/** Teto por giro, por academia — para uma fila represada não segurar o
    processo nem estourar o limite do provedor de uma vez. */
const POR_GIRO = 25;

export interface ResultadoDaFila {
  enviadas: number;
  falhas: number;
  descartadas: number;
  semInstancia: number;
}

export async function esvaziarFila(log: FastifyBaseLogger): Promise<ResultadoDaFila> {
  const total: ResultadoDaFila = { enviadas: 0, falhas: 0, descartadas: 0, semInstancia: 0 };

  /* PELA CONFIGURAÇÃO EFETIVA, e não só pela variável de ambiente: a
     integração passou a poder ser configurada no painel da plataforma, e
     olhar só o ambiente deixaria a fila parada para quem configurou por
     lá — sem erro, sem log, sem nada acontecendo. */
  if ((await configuracao()).base === null) {
    log.debug('uazapi não configurado; fila do WhatsApp parada');
    return total;
  }

  /* SÓ AS ACADEMIAS COM ALGO A ENVIAR. Varrer todas de dois em dois
     minutos seria uma consulta por empresa para nada em 99% dos giros. */
  const { rows: tenants } = await getPool().query<{ tenant_id: string }>(
    `SELECT t.tenant_id
       FROM jobs_tenants_ativos() t
      WHERE EXISTS (
        SELECT 1 FROM whatsapp_messages m
         WHERE m.tenant_id = t.tenant_id
           AND m.status = 'PENDING'
           AND m.enviar_apos <= now())`,
  );

  for (const { tenant_id: tenantId } of tenants) {
    try {
      await processarEmpresa(tenantId, total, log);
    } catch (erro) {
      log.error({ tenantId, err: erro }, 'falha ao processar a fila de WhatsApp da empresa');
    }
  }

  return total;
}

async function processarEmpresa(
  tenantId: string,
  total: ResultadoDaFila,
  log: FastifyBaseLogger,
): Promise<void> {
  /* Fora da validade não se tenta: descarta com o motivo escrito, para
     que a tela mostre "não enviada porque venceu" e não um silêncio. */
  const descartadas = await withTenant({ tenantId }, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE whatsapp_messages
          SET status = 'FAILED',
              error  = 'Descartada: passou de ${VALIDADE_HORAS}h da hora de envio.'
        WHERE status = 'PENDING'
          AND enviar_apos < now() - make_interval(hours => ${VALIDADE_HORAS})`,
    );
    return rowCount ?? 0;
  });
  total.descartadas += descartadas;

  const instancia = await withTenant({ tenantId }, async (client) => {
    const { rows } = await client.query<{ token_encrypted: string | null }>(
      `SELECT token_encrypted FROM whatsapp_instances
        WHERE status = 'CONNECTED' AND token_encrypted IS NOT NULL LIMIT 1`,
    );
    return rows[0] ?? null;
  });

  if (instancia === null) {
    /* A FILA NÃO É QUEIMADA por falta de instância. A academia pode
       conectar o WhatsApp à tarde e o lembrete de amanhã ainda sai; o
       descarte por validade acima é que dá o fim de linha. */
    total.semInstancia += 1;
    log.debug({ tenantId }, 'fila com mensagens e nenhuma instância conectada');
    return;
  }

  const token = decifrar(instancia.token_encrypted!);

  /* A RESERVA E O ENVIO SÃO SEPARADOS. Segurar a transação aberta
     durante uma chamada HTTP prenderia uma conexão do pool pelo tempo do
     provedor — e o provedor às vezes leva segundos. */
  const lote = await withTenant({ tenantId }, async (client) => {
    const { rows } = await client.query<{ id: string; to_number: string; body: string }>(
      `UPDATE whatsapp_messages
          SET tentativas = tentativas + 1, ultima_tentativa_em = now()
        WHERE id IN (
          SELECT id FROM whatsapp_messages
           WHERE status = 'PENDING' AND enviar_apos <= now()
           ORDER BY enviar_apos
           LIMIT ${POR_GIRO}
           FOR UPDATE SKIP LOCKED)
      RETURNING id, to_number, body`,
    );
    return rows;
  });

  for (const m of lote) {
    try {
      const resposta = await enviarTexto(token, m.to_number, m.body);
      await withTenant({ tenantId }, async (client) => {
        await client.query(
          `UPDATE whatsapp_messages
              SET status = 'SENT', provider_id = $2, sent_at = now(), error = NULL
            WHERE id = $1`,
          [m.id, resposta.id],
        );
      });
      total.enviadas += 1;
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : 'erro desconhecido';
      await withTenant({ tenantId }, async (client) => {
        /* A espera cresce com a tentativa: 5 min, 25 min, 2 h. Tentar de
           novo em dois minutos contra um provedor fora do ar só gasta as
           quatro tentativas em oito minutos. */
        await client.query(
          `UPDATE whatsapp_messages
              SET status = CASE WHEN tentativas >= $3 THEN 'FAILED' ELSE 'PENDING' END,
                  error  = $2,
                  enviar_apos = CASE WHEN tentativas >= $3 THEN enviar_apos
                                     ELSE now() + make_interval(mins => power(5, tentativas)::int)
                                END
            WHERE id = $1`,
          [m.id, motivo.slice(0, 500), TENTATIVAS_MAXIMAS],
        );
      });
      total.falhas += 1;
      /* O NÚMERO NÃO VAI PARA O LOG: telefone é dado pessoal, e log é
         lido por mais gente e guardado por mais tempo que o banco. */
      log.warn({ tenantId, mensagemId: m.id, motivo }, 'falha ao enviar mensagem da fila');
    }
  }
}
