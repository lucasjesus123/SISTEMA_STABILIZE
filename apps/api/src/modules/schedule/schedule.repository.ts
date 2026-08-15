import type { TenantClient } from '../../db/pool.js';
import { type AccessScope, professionalScopeSql } from '../../auth/scope.js';
import type { Intervalo, RegraDisponibilidade } from './slots.js';

/**
 * Acesso a dados da agenda.
 *
 * Mesma regra dos alunos: `scope` é obrigatório em toda consulta que
 * devolve compromisso, e o TypeScript não deixa esquecer.
 *
 * Há uma exceção deliberada e nomeada: `listarOcupacoes()`, que devolve
 * blocos ANONIMIZADOS. Um profissional precisa saber que a Sala 2 está
 * ocupada às 9h para não marcar em cima — mas não precisa saber quem
 * está lá, nem de qual colega é o aluno. A função devolve apenas início
 * e fim, sem nome, sem id de aluno, sem motivo.
 */

export interface AppointmentRow {
  id: string;
  student_id: string;
  student_name: string;
  professional_id: string;
  professional_name: string;
  room_id: string | null;
  room_name: string | null;
  inicio: Date;
  fim: Date;
  status: string;
  notes: string | null;
  student_note: string | null;
  price_cents: number | null;
  is_included_in_plan: boolean;
  checked_in_at: Date | null;
}

/** Compromissos visíveis para quem consulta, com dados completos. */
export async function listarCompromissos(
  client: TenantClient,
  scope: AccessScope,
  filtros: { de: Date; ate: Date; professionalId?: string | undefined; roomId?: string | undefined },
): Promise<AppointmentRow[]> {
  const values: unknown[] = [filtros.de, filtros.ate];
  const condicoes = [`a.period && tstzrange($1, $2, '[)')`, `a.status <> 'CANCELLED'`];

  const escopo = professionalScopeSql(scope, values.length, 'a');
  condicoes.push(escopo.sql);
  values.push(...escopo.values);

  if (filtros.professionalId !== undefined) {
    values.push(filtros.professionalId);
    condicoes.push(`a.professional_id = $${values.length}`);
  }
  if (filtros.roomId !== undefined) {
    values.push(filtros.roomId);
    condicoes.push(`a.room_id = $${values.length}`);
  }

  const result = await client.query<AppointmentRow>(
    `SELECT a.id, a.student_id, s.full_name AS student_name,
            a.professional_id, u.full_name AS professional_name,
            a.room_id, r.name AS room_name,
            lower(a.period) AS inicio, upper(a.period) AS fim,
            a.status::text AS status, a.notes, a.student_note,
            a.price_cents, a.is_included_in_plan, a.checked_in_at
       FROM appointments a
       JOIN students s ON s.id = a.student_id
       JOIN users u    ON u.id = a.professional_id
       LEFT JOIN rooms r ON r.id = a.room_id
      WHERE ${condicoes.join(' AND ')}
      ORDER BY lower(a.period)
      LIMIT 500`,
    values,
  );

  return result.rows;
}

/**
 * Ocupação do estabelecimento, ANONIMIZADA.
 *
 * Sem escopo de propósito — e é seguro justamente porque não devolve
 * nada identificável. Serve para montar a visão "a academia está assim"
 * e para o cálculo de horários livres.
 */
export async function listarOcupacoes(
  client: TenantClient,
  filtros: { de: Date; ate: Date; professionalId?: string | undefined; roomId?: string | undefined },
): Promise<Intervalo[]> {
  /* Os parâmetros são os mesmos nas duas metades da união, e as
     condições são escritas SEPARADAMENTE de propósito: as duas tabelas
     têm semânticas diferentes de nulo, e reaproveitar a mesma string
     entre elas produziria um filtro sutilmente errado. */
  const values: unknown[] = [
    filtros.de,
    filtros.ate,
    filtros.professionalId ?? null,
    filtros.roomId ?? null,
  ];

  /* Em appointments, professional_id e room_id são do compromisso.
     `$3 IS NULL OR ...` faz o filtro ser opcional sem montar SQL
     condicional — o parâmetro ausente simplesmente não restringe.

     Em availability_blocks, um bloqueio pode mirar só o profissional
     (room_id nulo), só a sala (professional_id nulo) ou ambos. Um
     bloqueio de sala precisa aparecer mesmo quando a consulta é por
     profissional: a sala interditada impede o atendimento ali de
     qualquer forma. Por isso a condição é de INTERSEÇÃO — o bloqueio
     entra se toca o profissional consultado OU a sala consultada. */
  const result = await client.query<{ inicio: Date; fim: Date }>(
    `SELECT lower(period) AS inicio, upper(period) AS fim
       FROM appointments
      WHERE period && tstzrange($1, $2, '[)')
        AND status <> 'CANCELLED'
        AND ($3::uuid IS NULL OR professional_id = $3::uuid)
        AND ($4::uuid IS NULL OR room_id = $4::uuid)

      UNION ALL

     SELECT lower(period) AS inicio, upper(period) AS fim
       FROM availability_blocks
      WHERE period && tstzrange($1, $2, '[)')
        AND (
          ($3::uuid IS NOT NULL AND professional_id = $3::uuid)
          OR ($4::uuid IS NOT NULL AND room_id = $4::uuid)
          OR ($3::uuid IS NULL AND $4::uuid IS NULL)
        )

      ORDER BY 1
      LIMIT 2000`,
    values,
  );

  return result.rows.map((r) => ({ inicio: r.inicio, fim: r.fim }));
}

/** Regras de disponibilidade vigentes de um profissional. */
export async function listarRegras(
  client: TenantClient,
  professionalId: string,
): Promise<RegraDisponibilidade[]> {
  const result = await client.query<{
    weekday: number;
    start_time: string;
    end_time: string;
    slot_minutes: number;
    room_id: string | null;
    valid_from: Date | null;
    valid_until: Date | null;
  }>(
    `SELECT weekday, start_time::text, end_time::text, slot_minutes,
            room_id, valid_from, valid_until
       FROM availability_rules
      WHERE professional_id = $1 AND is_active
      ORDER BY weekday, start_time`,
    [professionalId],
  );

  return result.rows.map((r) => ({
    weekday: r.weekday,
    startTime: r.start_time,
    endTime: r.end_time,
    slotMinutes: r.slot_minutes,
    roomId: r.room_id,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  }));
}

export interface CriarCompromissoInput {
  readonly studentId: string;
  readonly professionalId: string;
  readonly roomId?: string | undefined;
  readonly inicio: Date;
  readonly fim: Date;
  readonly studentNote?: string | undefined;
  readonly notes?: string | undefined;
  readonly priceCents?: number | undefined;
  readonly isIncludedInPlan: boolean;
  readonly createdBy: string;
}

/**
 * Cria o compromisso.
 *
 * Sem verificação prévia de "está livre?". Isso é intencional: essa
 * checagem em código é uma corrida que dois cliques simultâneos vencem
 * — ambos passam pelo SELECT e ambos gravam. A EXCLUSION CONSTRAINT do
 * banco decide, e quem chama traduz o erro 23P01 em "horário ocupado".
 * Ver fromDatabaseError() em http/errors.ts.
 */
export async function criarCompromisso(
  client: TenantClient,
  tenantId: string,
  input: CriarCompromissoInput,
): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO appointments
       (tenant_id, student_id, professional_id, room_id, period,
        student_note, notes, price_cents, is_included_in_plan, created_by)
     VALUES ($1,$2,$3,$4, tstzrange($5,$6,'[)'), $7,$8,$9,$10,$11)
     RETURNING id`,
    [
      tenantId,
      input.studentId,
      input.professionalId,
      input.roomId ?? null,
      input.inicio,
      input.fim,
      input.studentNote ?? null,
      input.notes ?? null,
      input.isIncludedInPlan ? null : (input.priceCents ?? null),
      input.isIncludedInPlan,
      input.createdBy,
    ],
  );

  return result.rows[0]!;
}

/** Cancela, respeitando o escopo de quem cancela. */
export async function cancelarCompromisso(
  client: TenantClient,
  scope: AccessScope,
  appointmentId: string,
  canceladoPor: string,
  motivo?: string,
): Promise<boolean> {
  const values: unknown[] = [appointmentId, canceladoPor, motivo ?? null];
  const escopo = professionalScopeSql(scope, values.length, 'appointments');
  values.push(...escopo.values);

  const result = await client.query(
    `UPDATE appointments
        SET status = 'CANCELLED', cancelled_at = now(),
            cancelled_by = $2, cancellation_reason = $3
      WHERE id = $1 AND status <> 'CANCELLED' AND ${escopo.sql}`,
    values,
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Registra presença ou falta.
 *
 * O contador de presenças do aluno NÃO é uma coluna mantida à mão: é
 * derivado desta tabela por contagem (ver `contarPresencas`). Guardar um
 * contador denormalizado exigiria atualizá-lo em toda transição de
 * estado — inclusive nas que ninguém lembra, como cancelar um
 * atendimento já marcado como presente — e ele divergiria em silêncio.
 */
export async function marcarPresenca(
  client: TenantClient,
  scope: AccessScope,
  appointmentId: string,
  compareceu: boolean,
): Promise<boolean> {
  /* Status e horário de check-in entram como PARÂMETRO, não interpolados
     por ternário no texto da query. O valor aqui é derivado de um
     booleano e seria inofensivo — mas montar SQL com ternário é o
     hábito que, seis meses depois, alguém repete com um valor que veio
     do cliente. O custo de parametrizar é zero. */
  const values: unknown[] = [appointmentId, compareceu ? 'ATTENDED' : 'NO_SHOW', compareceu];
  const escopo = professionalScopeSql(scope, values.length, 'appointments');
  values.push(...escopo.values);

  const result = await client.query(
    `UPDATE appointments
        SET status = $2::appointment_status,
            checked_in_at = CASE WHEN $3 THEN now() ELSE NULL END
      WHERE id = $1 AND status <> 'CANCELLED' AND ${escopo.sql}`,
    values,
  );

  return (result.rowCount ?? 0) > 0;
}

export interface ResumoPresenca {
  presencas: number;
  faltas: number;
  agendados: number;
}

/** Presenças e faltas de um aluno num período. */
export async function contarPresencas(
  client: TenantClient,
  scope: AccessScope,
  studentId: string,
  de: Date,
  ate: Date,
): Promise<ResumoPresenca> {
  const values: unknown[] = [studentId, de, ate];
  const escopo = professionalScopeSql(scope, values.length, 'a');
  values.push(...escopo.values);

  const result = await client.query<{ presencas: number; faltas: number; agendados: number }>(
    `SELECT
       count(*) FILTER (WHERE a.status = 'ATTENDED')::int AS presencas,
       count(*) FILTER (WHERE a.status = 'NO_SHOW')::int  AS faltas,
       count(*) FILTER (WHERE a.status IN ('SCHEDULED','CONFIRMED'))::int AS agendados
     FROM appointments a
     WHERE a.student_id = $1
       AND a.period && tstzrange($2, $3, '[)')
       AND ${escopo.sql}`,
    values,
  );

  return result.rows[0] ?? { presencas: 0, faltas: 0, agendados: 0 };
}
