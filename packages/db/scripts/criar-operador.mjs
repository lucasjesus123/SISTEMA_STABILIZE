/**
 * Cria (ou redefine a senha de) um operador da plataforma.
 *
 * O operador é o dono do SERVIÇO — quem cadastra academias, nomeia os
 * administradores delas e liga a integração de WhatsApp. Não é usuário
 * de academia nenhuma e não aparece na lista de usuários de nenhuma;
 * mora em `platform_admins`, fora da matriz de papéis.
 *
 * POR QUE UM SCRIPT E NÃO UMA TELA DE CADASTRO: o primeiro operador
 * precisa existir antes de haver painel para criá-lo, e uma rota pública
 * de "criar o primeiro administrador" é a porta que fica aberta quando
 * alguém esquece de fechá-la depois do primeiro uso. Rodar um comando na
 * VPS exige acesso à VPS, que é exatamente a prova que se quer aqui.
 *
 * Uso:
 *   docker compose run --rm operador "nome@exemplo.com" "Nome Completo"
 *
 * A senha é gerada aqui e mostrada UMA VEZ. Não é guardada em claro em
 * lugar nenhum, e o operador é obrigado a trocá-la no primeiro acesso.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import argon2 from 'argon2';

const [email, nome] = process.argv.slice(2);

if (!email || !nome) {
  console.error('uso: criar-operador.mjs <email> <"Nome Completo">');
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`e-mail inválido: ${email}`);
  process.exit(1);
}

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('defina DATABASE_MIGRATION_URL (a credencial de migração).');
  process.exit(1);
}

/* Alfabeto sem 0/O e 1/l/I: esta senha costuma ser ditada por telefone
   ou copiada de um terminal, e o par confundido custa uma ligação. */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const senha = [...randomBytes(16)].map((b) => ALFABETO[b % ALFABETO.length]).join('');

/* Os MESMOS parâmetros que a API usa em `auth/password.ts`. Se
   divergirem, o hash gravado aqui é válido mas mais fraco (ou mais
   lento) que o do resto do sistema, e ninguém percebe. */
const hash = await argon2.hash(senha, {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

const cliente = new pg.Client({ connectionString: url });
await cliente.connect();

try {
  const { rows } = await cliente.query(
    `INSERT INTO platform_admins (email, password_hash, full_name, must_change_password)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (email) DO UPDATE SET
       password_hash        = EXCLUDED.password_hash,
       full_name            = EXCLUDED.full_name,
       must_change_password = true,
       is_active            = true,
       failed_login_count   = 0,
       locked_until         = NULL
     RETURNING id, (xmax = 0) AS criado`,
    [email, hash, nome],
  );

  const { id, criado } = rows[0];

  /* Trocar a senha derruba as sessões abertas daquele operador. Sem
     isto, quem tivesse o token continuaria entrando por até doze horas
     depois de a senha ser redefinida — que é justamente o cenário em que
     se redefine uma senha. */
  await cliente.query(
    `UPDATE platform_sessions SET revoked_at = now()
      WHERE admin_id = $1 AND revoked_at IS NULL`,
    [id],
  );

  console.log('');
  console.log(criado ? '  operador criado' : '  senha redefinida');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  e-mail  ${email}`);
  console.log(`  senha   ${senha}`);
  console.log('  ─────────────────────────────────────────────');
  console.log('');
  console.log('  Esta senha aparece UMA VEZ e é provisória: o sistema');
  console.log('  exige a troca no primeiro acesso.');
  console.log('');
  console.log('  ENTRE PELA TELA NORMAL DO SISTEMA, a mesma das academias.');
  console.log('  Ela reconhece o operador pelo e-mail e abre o painel da');
  console.log('  plataforma sozinha — não há endereço separado para decorar.');
  console.log('');
} finally {
  await cliente.end();
}
