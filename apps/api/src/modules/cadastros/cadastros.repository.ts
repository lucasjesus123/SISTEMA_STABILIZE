import type { TenantClient } from '../../db/pool.js';

/**
 * Cadastros que a agenda e o financeiro precisam ler para funcionar:
 * quem é a equipe, quais são os espaços e quanto cada aluno paga.
 *
 * Tudo aqui roda dentro do contexto de empresa (`inTenant`), então a RLS
 * já limita cada consulta à academia de quem pergunta — nenhuma destas
 * funções filtra tenant à mão, e não deve passar a filtrar: um `WHERE
 * tenant_id = $1` aqui daria a impressão de que a proteção mora no
 * código, e no dia em que alguém o esquecesse ninguém notaria.
 */

export interface LinhaProfissional {
  id: string;
  full_name: string;
  role: string;
  color: string | null;
  is_active: boolean;
}

/**
 * A equipe, para a legenda da agenda e para escolher em nome de quem
 * marcar.
 *
 * SÓ NOME, PAPEL E COR. Sem e-mail, sem telefone, sem último acesso: o
 * profissional que lê isto tem `schedule:read`, não `user:read`, e a
 * lista existe para pintar o calendário — não para virar um diretório de
 * contatos da concorrência interna.
 */
export async function listarProfissionais(client: TenantClient): Promise<LinhaProfissional[]> {
  const { rows } = await client.query<LinhaProfissional>(
    /* A coluna chama `cor`, e não `color`: a migration que a criou é
       posterior ao esquema em inglês e seguiu o vocabulário do resto do
       projeto. O apelido aqui mantém a resposta da API estável. */
    `SELECT id, full_name, role::text AS role, cor AS color, is_active
       FROM users
      WHERE role IN ('OWNER','ADMIN','PROFESSIONAL')
      ORDER BY is_active DESC, full_name`,
  );
  return rows;
}

export interface LinhaSala {
  id: string;
  name: string;
  description: string | null;
  capacity: number;
  color: string | null;
  is_active: boolean;
}

export async function listarSalas(client: TenantClient): Promise<LinhaSala[]> {
  const { rows } = await client.query<LinhaSala>(
    `SELECT id, name, description, capacity, color, is_active
       FROM rooms
      ORDER BY is_active DESC, name`,
  );
  return rows;
}

export async function criarSala(
  client: TenantClient,
  tenantId: string,
  dados: { nome: string; descricao: string | null; capacidade: number; cor: string | null },
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO rooms (tenant_id, name, description, capacity, color)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, dados.nome, dados.descricao, dados.capacidade, dados.cor],
  );
  return rows[0]!;
}

export async function atualizarSala(
  client: TenantClient,
  id: string,
  dados: {
    nome: string;
    descricao: string | null;
    capacidade: number;
    cor: string | null;
    ativa: boolean;
  },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE rooms
        SET name = $2, description = $3, capacity = $4, color = $5, is_active = $6
      WHERE id = $1`,
    [id, dados.nome, dados.descricao, dados.capacidade, dados.cor, dados.ativa],
  );
  return (rowCount ?? 0) > 0;
}

/** A cor com que o profissional aparece no calendário. */
export async function definirCor(
  client: TenantClient,
  usuarioId: string,
  cor: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE users SET cor = $2
      WHERE id = $1 AND role IN ('OWNER','ADMIN','PROFESSIONAL')`,
    [usuarioId, cor],
  );
  return (rowCount ?? 0) > 0;
}

/* --------------------------------------------------------------------
 * Contrato do aluno — quanto ele paga e quanto é do professor
 * ------------------------------------------------------------------ */

export interface LinhaContrato {
  id: string;
  cycle: string;
  amount_cents: string;
  commission_bp: number;
  sessions_included: number | null;
  billing_day: number | null;
  starts_on: Date;
  ends_on: Date | null;
  professional_id: string | null;
  professional_name: string | null;
}

export async function buscarContratoAtivo(
  client: TenantClient,
  studentId: string,
): Promise<LinhaContrato | null> {
  const { rows } = await client.query<LinhaContrato>(
    `SELECT c.id, c.cycle::text AS cycle, c.amount_cents::text AS amount_cents,
            c.commission_bp, c.sessions_included, c.billing_day,
            c.starts_on, c.ends_on, c.professional_id, u.full_name AS professional_name
       FROM student_contracts c
       LEFT JOIN users u ON u.id = c.professional_id
      WHERE c.student_id = $1 AND c.is_active
      ORDER BY c.starts_on DESC
      LIMIT 1`,
    [studentId],
  );
  return rows[0] ?? null;
}

export interface DadosContrato {
  ciclo: string;
  valorCentavos: number;
  comissaoBp: number;
  sessoesIncluidas: number | null;
  diaDeCobranca: number | null;
  inicioEm: string;
  profissionalId: string | null;
}

/**
 * Grava o contrato do aluno.
 *
 * O CONTRATO ANTIGO É ENCERRADO, NÃO APAGADO. Um aluno que mudou de
 * plano em março continua tendo cobrado em fevereiro o valor de
 * fevereiro; sobrescrever a linha reescreveria o passado, e a primeira
 * conferência de comissão do mês seguinte acusaria uma diferença que
 * ninguém conseguiria explicar.
 */
export async function gravarContrato(
  client: TenantClient,
  tenantId: string,
  studentId: string,
  dados: DadosContrato,
): Promise<{ id: string }> {
  await client.query(
    `UPDATE student_contracts
        SET is_active = false,
            ends_on = LEAST(COALESCE(ends_on, $2::date - 1), $2::date - 1)
      WHERE student_id = $1 AND is_active`,
    [studentId, dados.inicioEm],
  );

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO student_contracts
       (tenant_id, student_id, professional_id, cycle, amount_cents, commission_bp,
        sessions_included, billing_day, starts_on)
     VALUES ($1,$2,$3,$4::billing_cycle,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      tenantId,
      studentId,
      dados.profissionalId,
      dados.ciclo,
      dados.valorCentavos,
      dados.comissaoBp,
      dados.sessoesIncluidas,
      dados.diaDeCobranca,
      dados.inicioEm,
    ],
  );
  return rows[0]!;
}

export async function encerrarContrato(client: TenantClient, studentId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE student_contracts
        SET is_active = false, ends_on = COALESCE(ends_on, CURRENT_DATE)
      WHERE student_id = $1 AND is_active`,
    [studentId],
  );
  return (rowCount ?? 0) > 0;
}

/* --------------------------------------------------------------------
 * Horários de atendimento
 *
 * A janela semanal de cada profissional. Sem ela o servidor recusa
 * QUALQUER marcação com "horário indisponível" — e é a recusa certa: o
 * contrário seria marcar aluno às três da manhã porque ninguém disse que
 * não podia.
 * ------------------------------------------------------------------ */

export interface LinhaHorario {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  slot_minutes: number;
  room_id: string | null;
}

export async function listarHorarios(
  client: TenantClient,
  professionalId: string,
): Promise<LinhaHorario[]> {
  const { rows } = await client.query<LinhaHorario>(
    `SELECT id, weekday, start_time::text AS start_time, end_time::text AS end_time,
            slot_minutes, room_id
       FROM availability_rules
      WHERE professional_id = $1 AND is_active
      ORDER BY weekday, start_time`,
    [professionalId],
  );
  return rows;
}

export interface FaixaDeHorario {
  diaDaSemana: number;
  inicio: string;
  fim: string;
  duracaoMinutos: number;
  salaId: string | null;
}

/**
 * Substitui a semana inteira de uma vez.
 *
 * SUBSTITUI, e não acrescenta: a tela edita a grade completa, e um PUT
 * que só insere deixaria a faixa apagada continuar valendo no servidor.
 * O profissional tiraria a quinta-feira da tela, salvaria, e continuaria
 * recebendo aluno na quinta.
 *
 * As antigas são DESATIVADAS, não removidas — um agendamento já feito
 * aponta para o dia e a hora dele, mas o histórico de quem atendia
 * quando é o que explica uma agenda antiga.
 */
export async function gravarHorarios(
  client: TenantClient,
  tenantId: string,
  professionalId: string,
  faixas: FaixaDeHorario[],
): Promise<number> {
  await client.query(
    `UPDATE availability_rules SET is_active = false
      WHERE professional_id = $1 AND is_active`,
    [professionalId],
  );

  for (const f of faixas) {
    await client.query(
      `INSERT INTO availability_rules
         (tenant_id, professional_id, weekday, start_time, end_time, slot_minutes, room_id)
       VALUES ($1,$2,$3,$4::time,$5::time,$6,$7)`,
      [tenantId, professionalId, f.diaDaSemana, f.inicio, f.fim, f.duracaoMinutos, f.salaId],
    );
  }
  return faixas.length;
}
