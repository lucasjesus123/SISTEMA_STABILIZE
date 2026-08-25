import { getPool, withTenant } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { configuracao, enviarTexto } from './uazapi.js';
import { decifrar } from './segredo.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Mensagem de aniversário.
 *
 * TRÊS DECISÕES QUE VALEM MAIS QUE O CÓDIGO
 *
 * 1. IDEMPOTÊNCIA POR CONSTRUÇÃO, não por controle de execução. A chave
 *    é `aniversario:<aluno>:<data>` com UNIQUE no banco. Rodar o job
 *    dez vezes no mesmo dia manda UMA mensagem, porque a décima
 *    tentativa de INSERT falha por unicidade. Isso é o que permite a
 *    solução simples do agendador (um tique por hora) sem risco de
 *    parabenizar a mesma pessoa dez vezes — que é o tipo de erro que
 *    ninguém perdoa.
 *
 * 2. A LINHA É GRAVADA ANTES DO ENVIO. Se gravássemos depois, uma queda
 *    entre o envio e o INSERT faria a mensagem sair de novo no próximo
 *    tique. Gravar antes troca "pode duplicar" por "pode não enviar" —
 *    e não enviar é recuperável (a linha fica em FAILED e aparece na
 *    tela), enquanto dez mensagens não são.
 *
 * 3. UMA TRANSAÇÃO POR EMPRESA. O job descobre os ids pela função
 *    SECURITY DEFINER `jobs_tenants_ativos()` — que devolve só ids — e
 *    a partir daí opera dentro do contexto de cada uma, com a RLS
 *    valendo integralmente. Um erro numa academia não contamina as
 *    outras.
 */

/* Variações para a mesma data não soarem como robô quando dois alunos
   da mesma academia fazem aniversário no mesmo dia — e eles conversam. */
const MODELOS = [
  '🎉 Parabéns, {nome}! Que este novo ano venha com muita saúde e treinos bons. Time Stabilize 💪',
  '🥳 Feliz aniversário, {nome}! Saúde, disciplina e um ano de evolução. Conte com a gente 💪',
  '🎂 Hoje é seu dia, {nome}! Que venha mais um ano de conquistas — dentro e fora da sala 🎉',
] as const;

export interface ResultadoAniversarios {
  tenants: number;
  enviadas: number;
  jaEnviadas: number;
  falhas: number;
  semWhatsapp: number;
}

export async function enviarAniversariosDoDia(
  log: FastifyBaseLogger,
): Promise<ResultadoAniversarios> {
  const total: ResultadoAniversarios = {
    tenants: 0,
    enviadas: 0,
    jaEnviadas: 0,
    falhas: 0,
    semWhatsapp: 0,
  };

  /* PELA CONFIGURAÇÃO EFETIVA, e não só pela variável de ambiente: a
     integração passou a poder ser configurada no painel da plataforma, e
     olhar só o ambiente deixaria a fila parada para quem configurou por
     lá — sem erro, sem log, sem nada acontecendo. */
  if ((await configuracao()).base === null) {
    log.debug('uazapi não configurado; aniversários ignorados');
    return total;
  }

  const { rows: tenants } = await getPool().query<{ tenant_id: string }>(
    'SELECT tenant_id FROM jobs_tenants_ativos()',
  );
  total.tenants = tenants.length;

  for (const { tenant_id: tenantId } of tenants) {
    try {
      await processarEmpresa(tenantId, total, log);
    } catch (erro) {
      /* Uma academia com problema não pode impedir as outras de
         receberem seus parabéns. O erro é registrado e o laço segue. */
      total.falhas += 1;
      log.error({ tenantId, err: erro }, 'falha ao processar aniversários da empresa');
    }
  }

  return total;
}

async function processarEmpresa(
  tenantId: string,
  total: ResultadoAniversarios,
  log: FastifyBaseLogger,
): Promise<void> {
  const hoje = new Date();
  const dataChave = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

  const pendentes = await withTenant({ tenantId }, async (client) => {
    const instancia = await client.query<{ token_encrypted: string | null; instance_name: string }>(
      `SELECT token_encrypted, instance_name
         FROM whatsapp_instances
        WHERE status = 'CONNECTED' AND token_encrypted IS NOT NULL
        LIMIT 1`,
    );
    if (instancia.rows[0] === undefined) return null;

    /* Usa a coluna gerada `birth_month_day` — a mesma que tem índice.
       Comparar `EXTRACT(...)` na consulta impediria o uso do índice e
       varreria a tabela de alunos inteira, todo dia, para nada. */
    const mesDia = (hoje.getMonth() + 1) * 100 + hoje.getDate();

    const { rows } = await client.query<{ id: string; full_name: string; whatsapp: string }>(
      `SELECT s.id, s.full_name, s.whatsapp
         FROM students s
        WHERE s.birth_month_day = $1
          AND s.status = 'ACTIVE'
          AND s.whatsapp IS NOT NULL`,
      [mesDia],
    );

    return { instancia: instancia.rows[0], alunos: rows };
  });

  if (pendentes === null) {
    log.debug({ tenantId }, 'empresa sem instância de WhatsApp conectada');
    return;
  }

  const token = decifrar(pendentes.instancia.token_encrypted!);

  for (const aluno of pendentes.alunos) {
    const chave = `aniversario:${aluno.id}:${dataChave}`;
    const primeiroNome = aluno.full_name.trim().split(/\s+/)[0] ?? aluno.full_name;
    /* Modelo escolhido pelo id do aluno, não por sorteio: a mesma pessoa
       recebe a mesma variação se o job for reexecutado, e o texto no
       banco confere com o que foi enviado. */
    const modelo = MODELOS[somaDeCaracteres(aluno.id) % MODELOS.length]!;
    const corpo = modelo.replace('{nome}', primeiroNome);

    // --- reserva a mensagem ANTES de enviar ---
    const reservada = await withTenant({ tenantId }, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_messages
           (tenant_id, student_id, to_number, body, kind, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'BIRTHDAY', 'PENDING', $5)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [tenantId, aluno.id, aluno.whatsapp, corpo, chave],
      );
      return rows[0] ?? null;
    });

    if (reservada === null) {
      // Já existia: o job rodou hoje. Não é erro.
      total.jaEnviadas += 1;
      continue;
    }

    try {
      const resposta = await enviarTexto(token, aluno.whatsapp, corpo);
      await withTenant({ tenantId }, async (client) => {
        await client.query(
          `UPDATE whatsapp_messages
              SET status = 'SENT', provider_id = $2, sent_at = now()
            WHERE id = $1`,
          [reservada.id, resposta.id],
        );
      });
      total.enviadas += 1;
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : 'erro desconhecido';
      await withTenant({ tenantId }, async (client) => {
        await client.query(
          `UPDATE whatsapp_messages SET status = 'FAILED', error = $2 WHERE id = $1`,
          [reservada.id, motivo.slice(0, 500)],
        );
      });
      total.falhas += 1;
      /* O NÚMERO NÃO VAI PARA O LOG. Telefone é dado pessoal, e log é
         lido por mais gente e guardado por mais tempo que o banco. */
      log.warn({ tenantId, alunoId: aluno.id, motivo }, 'falha ao enviar aniversário');
    }
  }
}

function somaDeCaracteres(s: string): number {
  let soma = 0;
  for (let i = 0; i < s.length; i += 1) soma += s.charCodeAt(i);
  return soma;
}
