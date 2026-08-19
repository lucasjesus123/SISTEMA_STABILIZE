import type { TenantClient } from '../../db/pool.js';

/**
 * Confirmação e lembrete de agendamento — a parte que ENFILEIRA.
 *
 * A FILA EXISTIA E NINGUÉM ESCREVIA NELA. A migração 016 criou
 * `enviar_apos`, `tentativas` e `appointment_id`, e criou as duas
 * configurações da academia — `wa_confirmar_agendamento` e
 * `wa_lembrete_horas`. Nenhuma linha de código lia nada disso. O
 * resultado era pior do que não ter o recurso: a tela oferecia a
 * configuração, a academia ligava, e nenhuma mensagem saía. Software que
 * mente sobre o que faz é pior que software que não faz.
 *
 * A HORA DA MENSAGEM É CALCULADA NO BANCO, e não em JavaScript. O texto
 * diz "quinta, 7h" e quem lê está no fuso da academia; o servidor pode
 * estar em qualquer lugar. `AT TIME ZONE t.timezone` resolve isso na
 * única fonte que conhece o fuso de cada empresa.
 *
 * O LEMBRETE ATRASADO NÃO É ENFILEIRADO. Aula daqui a duas horas com
 * lembrete de três horas antes teria hora de envio no passado — e sairia
 * no mesmo minuto que a confirmação, dizendo "sua aula é amanhã". Quando
 * a hora já passou, o lembrete simplesmente não nasce: a confirmação já
 * avisou.
 */

/** Quantas mensagens uma academia sem WhatsApp conectado enfileira: zero
    trabalho perdido, porque a fila é lida só por quem tem instância. Mas
    enfileirar mesmo assim é de propósito — a academia pode conectar o
    WhatsApp hoje à tarde e o lembrete de amanhã ainda sai. */

export async function enfileirarAvisosDoAgendamento(
  client: TenantClient,
  tenantId: string,
  appointmentId: string,
): Promise<{ confirmacao: boolean; lembrete: boolean }> {
  const { rows } = await client.query<{
    confirmar: boolean;
    lembrete_horas: number;
    whatsapp: string | null;
    primeiro_nome: string;
    quando: string;
    profissional: string | null;
    academia: string;
    lembrete_no_futuro: boolean;
  }>(
    `SELECT t.wa_confirmar_agendamento AS confirmar,
            t.wa_lembrete_horas        AS lembrete_horas,
            s.whatsapp,
            split_part(btrim(s.full_name), ' ', 1) AS primeiro_nome,
            /* "segunda 24/08 às 09:00" no fuso da ACADEMIA.

               O DIA DA SEMANA É ESCRITO À MÃO, e não com o TMday do
               to_char. O TM usa o lc_time da CONEXÃO — que na VPS é o
               que o Postgres herdou do sistema, quase sempre C ou
               en_US. O primeiro teste real desta mensagem saiu com
               "monday, 24/08": o formato certo, no idioma errado, para
               um aluno brasileiro. Depender da configuração de locale
               do servidor para o idioma de uma mensagem é uma aposta
               que se perde justamente em produção. */
            (CASE extract(dow FROM lower(a.period) AT TIME ZONE t.timezone)::int
               WHEN 0 THEN 'domingo'  WHEN 1 THEN 'segunda' WHEN 2 THEN 'terça'
               WHEN 3 THEN 'quarta'   WHEN 4 THEN 'quinta'  WHEN 5 THEN 'sexta'
               ELSE 'sábado' END)
              || ' ' || to_char(lower(a.period) AT TIME ZONE t.timezone, 'DD/MM')
              || ' às ' || to_char(lower(a.period) AT TIME ZONE t.timezone, 'HH24:MI') AS quando,
            u.full_name AS profissional,
            t.name      AS academia,
            (lower(a.period) - make_interval(hours => t.wa_lembrete_horas)) > now()
              AS lembrete_no_futuro
       FROM appointments a
       JOIN tenants  t ON t.id = a.tenant_id
       JOIN students s ON s.id = a.student_id
       LEFT JOIN users u ON u.id = a.professional_id
      WHERE a.id = $1`,
    [appointmentId],
  );

  const d = rows[0];
  /* SEM TELEFONE NÃO HÁ O QUE ENFILEIRAR. Gravar a linha assim mesmo
     encheria a fila de mensagens que só podem falhar. */
  if (d === undefined || d.whatsapp === null || d.whatsapp.trim() === '') {
    return { confirmacao: false, lembrete: false };
  }

  const comQuem = d.profissional === null ? '' : ` com ${primeiro(d.profissional)}`;
  const saida = { confirmacao: false, lembrete: false };

  if (d.confirmar) {
    const corpo =
      `✅ ${d.primeiro_nome}, seu horário está marcado: ${d.quando}${comQuem}.\n` +
      `${d.academia}. Se precisar remarcar, é só avisar.`;
    saida.confirmacao = await enfileirar(client, {
      tenantId,
      appointmentId,
      numero: d.whatsapp,
      corpo,
      kind: 'BOOKING',
      chave: `agendamento:${appointmentId}:confirmacao`,
      /* `now()` e não uma data calculada aqui: a confirmação sai no
         próximo giro da fila, que é de minutos. */
      quandoSql: 'now()',
    });
  }

  if (d.lembrete_horas > 0 && d.lembrete_no_futuro) {
    const corpo =
      `⏰ ${d.primeiro_nome}, lembrete: seu horário é ${d.quando}${comQuem}.\n` +
      `Até já! ${d.academia}`;
    saida.lembrete = await enfileirar(client, {
      tenantId,
      appointmentId,
      numero: d.whatsapp,
      corpo,
      kind: 'REMINDER',
      chave: `agendamento:${appointmentId}:lembrete`,
      quandoSql: `(SELECT lower(period) - make_interval(hours => $7::int) FROM appointments WHERE id = $8)`,
      horas: d.lembrete_horas,
    });
  }

  return saida;
}

async function enfileirar(
  client: TenantClient,
  m: {
    tenantId: string;
    appointmentId: string;
    numero: string;
    corpo: string;
    kind: string;
    chave: string;
    quandoSql: string;
    horas?: number;
  },
): Promise<boolean> {
  const valores: unknown[] = [
    m.tenantId,
    m.appointmentId,
    m.numero,
    m.corpo,
    m.kind,
    m.chave,
  ];
  if (m.horas !== undefined) valores.push(m.horas, m.appointmentId);

  /* ON CONFLICT DO NOTHING sobre (tenant_id, idempotency_key): remarcar
     duas vezes no mesmo segundo, ou um retry do cliente, não gera duas
     confirmações. */
  const { rowCount } = await client.query(
    `INSERT INTO whatsapp_messages
       (tenant_id, student_id, appointment_id, to_number, body, kind, status,
        idempotency_key, enviar_apos)
     SELECT $1, a.student_id, $2, $3, $4, $5, 'PENDING', $6, ${m.quandoSql}
       FROM appointments a WHERE a.id = $2
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    valores,
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Cancelar a aula cancela o lembrete que ainda não saiu.
 *
 * SEM ISTO O SISTEMA MENTE PARA O ALUNO. Ele desmarca na quarta e recebe
 * na quinta de manhã "lembrete: seu horário é hoje às 7h" — e vai. É o
 * defeito mais caro desta função inteira, porque destrói a confiança na
 * mensagem: depois de uma dessas, ninguém acredita nas outras.
 *
 * A CONFIRMAÇÃO JÁ ENVIADA NÃO É APAGADA. Ela é verdade histórica: o
 * horário foi marcado. Some só o que ainda não saiu.
 */
export async function cancelarAvisosDoAgendamento(
  client: TenantClient,
  appointmentId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM whatsapp_messages
      WHERE appointment_id = $1 AND status = 'PENDING'`,
    [appointmentId],
  );
  return rowCount ?? 0;
}

/** Tratamentos que não são nome de ninguém. */
const TRATAMENTOS = new Set(['dr', 'dra', 'prof', 'profa', 'sr', 'sra', 'srta']);

/**
 * O nome pelo qual o aluno conhece quem vai atendê-lo.
 *
 * PEGAR A PRIMEIRA PALAVRA NÃO BASTA. Metade dos profissionais está
 * cadastrada como "Dr. Paulo Ferreira", e a primeira palavra dele é
 * "Dr." — a mensagem saía "seu horário está marcado com Dr..", com o
 * ponto do tratamento colado no ponto da frase. Foi exatamente o que
 * apareceu no primeiro envio de verdade.
 *
 * O tratamento é MANTIDO e não descartado: "com Dr. Paulo" é como o
 * aluno chama a pessoa. O que se corrige é engolir o nome.
 */
function primeiro(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter((p) => p !== '');
  const primeira = partes[0];
  if (primeira === undefined) return nome;
  if (TRATAMENTOS.has(primeira.replace(/\./g, '').toLowerCase())) {
    const seguinte = partes[1];
    return seguinte === undefined ? primeira : `${primeira} ${seguinte}`;
  }
  return primeira;
}
