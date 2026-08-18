import type { TenantClient } from '../../db/pool.js';

/**
 * O perfil de quem está autenticado.
 *
 * A REGRA DESTE ARQUIVO, e a única que importa: toda consulta filtra por
 * `id = $1` com o id vindo do TOKEN. Nenhuma delas recebe id por
 * parâmetro de rota, corpo ou query string.
 *
 * Por que isso precisa ser dito, se existe RLS: a policy de `users` é
 * `tenant_id = current_tenant_id()`. Ela impede que a recepcionista da
 * academia A alcance a linha de alguém da academia B — que é o ataque
 * que o sistema inteiro foi desenhado para barrar. Ela NÃO impede que a
 * recepcionista da academia A alcance a linha do dono da academia A: as
 * duas linhas têm o mesmo `tenant_id`, e para a RLS são igualmente
 * visíveis.
 *
 * O recorte "só a minha própria linha" é responsabilidade daqui. É o
 * mesmo tipo de recorte que o escopo OWN_PROFESSIONAL faz para os
 * alunos, só que estreitado até um: SELF.
 */

export interface Perfil {
  id: string;
  nome: string;
  email: string;
  papel: string;
  telefone: string | null;
  whatsapp: string | null;
  dataNascimento: string | null;
  temFoto: boolean;
  endereco: {
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
  };
}

export interface PerfilEntrada {
  nome: string;
  telefone: string | null;
  whatsapp: string | null;
  dataNascimento: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
}

interface LinhaPerfil {
  id: string;
  full_name: string;
  email: string;
  role: string;
  phone: string | null;
  whatsapp: string | null;
  birth_date: Date | null;
  avatar_path: string | null;
  address_zip: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
}

const COLUNAS = `
  id, full_name, email, role, phone, whatsapp, birth_date, avatar_path,
  address_zip, address_street, address_number, address_complement,
  address_district, address_city, address_state
`;

function paraPerfil(l: LinhaPerfil): Perfil {
  return {
    id: l.id,
    nome: l.full_name,
    email: l.email,
    papel: l.role,
    telefone: l.phone,
    whatsapp: l.whatsapp,
    /* `date` do PostgreSQL chega como Date em fuso local; formatar com
       toISOString() aqui devolveria o dia anterior para quem está a
       oeste de Greenwich. Fatiamos os campos locais. */
    dataNascimento: l.birth_date === null ? null : formatarData(l.birth_date),
    temFoto: l.avatar_path !== null,
    endereco: {
      cep: l.address_zip,
      logradouro: l.address_street,
      numero: l.address_number,
      complemento: l.address_complement,
      bairro: l.address_district,
      cidade: l.address_city,
      uf: l.address_state,
    },
  };
}

function formatarData(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** Lê o próprio perfil. */
export async function lerPerfil(client: TenantClient, userId: string): Promise<Perfil | null> {
  const { rows } = await client.query<LinhaPerfil>(
    `SELECT ${COLUNAS} FROM users WHERE id = $1`,
    [userId],
  );
  const linha = rows[0];
  return linha === undefined ? null : paraPerfil(linha);
}

/**
 * Grava o próprio perfil.
 *
 * O que NÃO está na lista de colunas atualizáveis é tão importante
 * quanto o que está: `role`, `email`, `is_active`, `tenant_id` e
 * `password_hash` ficam de fora. Um UPDATE genérico montado a partir do
 * corpo da requisição seria o caminho mais curto para alguém se promover
 * a OWNER editando o próprio perfil.
 */
export async function gravarPerfil(
  client: TenantClient,
  userId: string,
  dados: PerfilEntrada,
): Promise<Perfil | null> {
  const { rows } = await client.query<LinhaPerfil>(
    `UPDATE users SET
       full_name          = $2,
       phone              = $3,
       whatsapp           = $4,
       birth_date         = $5,
       address_zip        = $6,
       address_street     = $7,
       address_number     = $8,
       address_complement = $9,
       address_district   = $10,
       address_city       = $11,
       address_state      = $12
     WHERE id = $1
     RETURNING ${COLUNAS}`,
    [
      userId,
      dados.nome,
      dados.telefone,
      dados.whatsapp,
      dados.dataNascimento,
      dados.cep,
      dados.logradouro,
      dados.numero,
      dados.complemento,
      dados.bairro,
      dados.cidade,
      dados.uf,
    ],
  );
  const linha = rows[0];
  return linha === undefined ? null : paraPerfil(linha);
}

/**
 * Espelha o perfil na ficha do aluno.
 *
 * Só roda quando quem edita é um STUDENT, e existe por um motivo
 * concreto: a academia liga para o aluno usando `students.phone`, manda
 * mensagem para `students.whatsapp` e vê o endereço na ficha. Se o aluno
 * troca de número no aplicativo e isso fica só em `users`, a academia
 * continua ligando para o número velho — e o aluno tem toda a razão de
 * achar que atualizou.
 *
 * O `WHERE user_id = $1` é o que amarra: um aluno só alcança a ficha
 * ligada à própria conta. Não recebe `student_id` de lugar nenhum.
 *
 * O NOME NÃO É ESPELHADO. Na ficha ele é o nome de cadastro da academia,
 * às vezes com um complemento que a recepção usa para diferenciar dois
 * homônimos; deixar o aluno reescrevê-lo à distância bagunçaria a busca
 * de quem atende. O contato e o endereço, que são dele, são.
 */
export async function espelharNoAluno(
  client: TenantClient,
  userId: string,
  dados: PerfilEntrada,
): Promise<void> {
  await client.query(
    `UPDATE students SET
       phone              = $2,
       whatsapp           = $3,
       address_zip        = $4,
       address_street     = $5,
       address_number     = $6,
       address_complement = $7,
       address_district   = $8,
       address_city       = $9,
       address_state      = $10
     WHERE user_id = $1`,
    [
      userId,
      dados.telefone,
      dados.whatsapp,
      dados.cep,
      dados.logradouro,
      dados.numero,
      dados.complemento,
      dados.bairro,
      dados.cidade,
      dados.uf,
    ],
  );
}

/** A chave da foto atual, para poder apagar os bytes ao trocar. */
export async function chaveDaFoto(
  client: TenantClient,
  userId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ avatar_path: string | null }>(
    'SELECT avatar_path FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.avatar_path ?? null;
}

/** Aponta a foto do perfil para uma chave nova (ou para nenhuma). */
export async function definirFoto(
  client: TenantClient,
  userId: string,
  chave: string | null,
): Promise<void> {
  await client.query('UPDATE users SET avatar_path = $2 WHERE id = $1', [userId, chave]);
  /* O aluno que troca a foto no aplicativo troca a foto que a academia
     vê na ficha. É a mesma pessoa e a mesma foto — manter duas seria
     garantir que uma delas fica velha. */
  await client.query('UPDATE students SET photo_path = $2 WHERE user_id = $1', [userId, chave]);
}
