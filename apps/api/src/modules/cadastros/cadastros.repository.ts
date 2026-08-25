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
export class ContratoAnteriorError extends Error {
  constructor(readonly desde: string) {
    super(
      `Já existe um contrato valendo desde ${desde}. Um contrato novo precisa começar depois dele.`,
    );
    this.name = 'ContratoAnteriorError';
  }
}

export async function gravarContrato(
  client: TenantClient,
  tenantId: string,
  studentId: string,
  dados: DadosContrato,
): Promise<{ id: string }> {
  /* RETROAGIR PARA ANTES DE UM CONTRATO EXISTENTE É RECUSADO, e com
     mensagem. O encerramento abaixo põe `ends_on` no dia anterior ao
     início do novo; se o contrato antigo começar DEPOIS disso, a data de
     fim cai antes da de início e o CHECK `contract_period_valid` estoura
     — o usuário via "erro interno" ao tentar corrigir uma data.

     Recusar é a resposta certa e não apenas a mais fácil: o pedido é
     ambíguo. Se o aluno fechou em setembro por R$ 429 e alguém agora
     lança agosto por R$ 199, ninguém sabe se setembro deve continuar
     valendo, ser substituído ou virar histórico — e adivinhar isso no
     código reescreve silenciosamente o que já foi cobrado. */
  const { rows: conflito } = await client.query<{ starts_on: Date }>(
    `SELECT starts_on FROM student_contracts
      WHERE student_id = $1 AND is_active AND starts_on >= $2::date
      ORDER BY starts_on DESC LIMIT 1`,
    [studentId, dados.inicioEm],
  );
  if (conflito[0] !== undefined) {
    const d = conflito[0].starts_on;
    const br = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    throw new ContratoAnteriorError(br);
  }

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

/* --------------------------------------------------------------------
 * Equipe: criar, editar, desligar
 *
 * A ACADEMIA CADASTRA A PRÓPRIA EQUIPE. Até aqui só o painel da
 * plataforma criava gente, e só criava OWNER e ADMIN — a academia não
 * tinha como cadastrar um personal nem uma recepcionista, que são
 * justamente os papéis que ela contrata e demite sozinha.
 *
 * Nenhuma função aqui filtra tenant à mão: tudo roda sob `inTenant`, e é
 * a RLS que prende cada consulta à academia de quem pergunta.
 * ------------------------------------------------------------------ */

export interface LinhaUsuario {
  id: string;
  full_name: string;
  email: string;
  role: string;
  phone: string | null;
  cor: string | null;
  areas: string[] | null;
  is_active: boolean;
  last_login_at: Date | null;
  must_change_password: boolean;
}

export async function listarUsuarios(client: TenantClient): Promise<LinhaUsuario[]> {
  const { rows } = await client.query<LinhaUsuario>(
    /* O ALUNO NÃO ENTRA NESTA LISTA. Ele tem login, mas não é equipe —
       misturá-los faria a tela de RH mostrar trezentos alunos. */
    `SELECT id, full_name, email, role::text AS role, phone, cor, areas, is_active,
            last_login_at, must_change_password
       FROM users
      WHERE role <> 'STUDENT'
      ORDER BY is_active DESC, full_name`,
  );
  return rows;
}

export async function criarUsuario(
  client: TenantClient,
  tenantId: string,
  dados: {
    nome: string;
    email: string;
    papel: string;
    telefone: string | null;
    cor: string | null;
    areas: string[] | null;
    hash: string;
    /* `true` quando a senha foi GERADA — viajou por telefone e quem
       cadastrou a conhece. `false` quando foi escolhida na hora, com a
       pessoa junto. */
    trocarSenha: boolean;
  },
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    /* `must_change_password` sempre verdadeiro: quem cria a conta digita
       uma senha provisória e nunca fica sabendo a definitiva de
       ninguém. */
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, phone, cor, areas,
                        must_change_password)
     VALUES ($1,$2,$3,$4,$5::user_role,$6,$7,$8,$9)
     RETURNING id`,
    [
      tenantId,
      dados.email,
      dados.hash,
      dados.nome,
      dados.papel,
      dados.telefone,
      dados.cor,
      dados.areas,
      dados.trocarSenha,
    ],
  );
  return rows[0]!;
}

export async function atualizarUsuario(
  client: TenantClient,
  id: string,
  dados: {
    nome: string;
    papel: string;
    telefone: string | null;
    cor: string | null;
    areas: string[] | null;
  },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE users
        SET full_name = $2, role = $3::user_role, phone = $4, cor = $5, areas = $6
      WHERE id = $1 AND role <> 'STUDENT'`,
    [id, dados.nome, dados.papel, dados.telefone, dados.cor, dados.areas],
  );
  return (rowCount ?? 0) > 0;
}

/** As áreas marcadas hoje, para saber se a edição mexeu no acesso. */
export async function areasDe(client: TenantClient, id: string): Promise<string[] | null> {
  const { rows } = await client.query<{ areas: string[] | null }>(
    `SELECT areas FROM users WHERE id = $1 AND role <> 'STUDENT'`,
    [id],
  );
  return rows[0]?.areas ?? null;
}

/**
 * Derruba as sessões abertas de alguém.
 *
 * Usado quando o ACESSO muda — recortar as áreas de uma pessoa só vale
 * no token seguinte, e esperar a sessão rodar não é o que se espera de
 * tirar o financeiro de alguém.
 */
export async function derrubarSessoes(client: TenantClient, id: string): Promise<void> {
  await client.query(
    `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'acesso alterado'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [id],
  );
}

/**
 * Liga e desliga uma conta.
 *
 * DESLIGAR DERRUBA AS SESSÕES ABERTAS. Sem isso, quem foi demitido às
 * dez da manhã continua dentro do sistema com o token que já tinha —
 * por horas, e justamente no dia em que mais interessa que não continue.
 */
export async function definirUsuarioAtivo(
  client: TenantClient,
  id: string,
  ativo: boolean,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE users SET is_active = $2 WHERE id = $1 AND role <> 'STUDENT'`,
    [id, ativo],
  );
  if ((rowCount ?? 0) > 0 && !ativo) {
    await client.query(
      `UPDATE user_sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
  }
  return (rowCount ?? 0) > 0;
}

export async function redefinirSenha(
  client: TenantClient,
  id: string,
  hash: string,
  trocarSenha = true,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE users
        SET password_hash = $2, password_changed_at = now(), must_change_password = $3,
            failed_login_count = 0, locked_until = NULL
      WHERE id = $1 AND role <> 'STUDENT'`,
    [id, hash, trocarSenha],
  );
  if ((rowCount ?? 0) > 0) {
    await client.query(
      `UPDATE user_sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
  }
  return (rowCount ?? 0) > 0;
}

/** O papel de alguém, para as checagens que decidem quem mexe em quem. */
export async function papelDe(client: TenantClient, id: string): Promise<string | null> {
  const { rows } = await client.query<{ role: string }>(
    'SELECT role::text AS role FROM users WHERE id = $1',
    [id],
  );
  return rows[0]?.role ?? null;
}

/* --------------------------------------------------------------------
 * Funções da academia
 *
 * Uma função é um NOME para um par (papel, áreas). Ela não concede nada:
 * quem decide o acesso continua sendo o par, e a conta é a interseção
 * feita pelo `scopeComAreas`. O que a academia cria aqui é vocabulário.
 * ------------------------------------------------------------------ */

export interface FuncaoDaAcademia {
  id: string;
  nome: string;
  descricao: string | null;
  papel: string;
  areas: string[] | null;
}

export async function listarFuncoes(client: TenantClient): Promise<FuncaoDaAcademia[]> {
  const { rows } = await client.query<{
    id: string;
    nome: string;
    descricao: string | null;
    papel: string;
    areas: string[] | null;
  }>(
    `SELECT id, nome, descricao, papel::text AS papel, areas
       FROM tenant_funcoes
      ORDER BY nome`,
  );
  return rows;
}

export async function criarFuncao(
  client: TenantClient,
  tenantId: string,
  entrada: {
    nome: string;
    descricao: string | null;
    papel: string;
    areas: string[] | null;
    criadaPor: string;
  },
): Promise<FuncaoDaAcademia> {
  const { rows } = await client.query<{
    id: string;
    nome: string;
    descricao: string | null;
    papel: string;
    areas: string[] | null;
  }>(
    `INSERT INTO tenant_funcoes (tenant_id, nome, descricao, papel, areas, criada_por)
     VALUES ($1,$2,$3,$4::user_role,$5,$6)
     RETURNING id, nome, descricao, papel::text AS papel, areas`,
    [tenantId, entrada.nome, entrada.descricao, entrada.papel, entrada.areas, entrada.criadaPor],
  );
  return rows[0]!;
}

export async function excluirFuncao(client: TenantClient, id: string): Promise<boolean> {
  const r = await client.query('DELETE FROM tenant_funcoes WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}
