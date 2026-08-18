#!/usr/bin/env bash
#
# Aplica as migrations em ordem, com DUAS CREDENCIAIS.
#
# A regra é o prefixo do arquivo:
#
#   000_*        credencial de SUPERUSUÁRIO — cria os papéis do banco
#   *_super.sql  credencial de SUPERUSUÁRIO — o que exige poder que o
#                migrator não tem, DEPOIS do schema existir
#   demais       credencial de MIGRAÇÃO (stabilize_migrator)
#
# POR QUE DUAS, e não a de migração para tudo:
#
# `CREATE ROLE` exige superusuário, e é o 000 que cria justamente o papel
# `stabilize_migrator`. Usar a credencial de migração desde o começo é um
# ovo-e-galinha que só aparece em banco NOVO — em banco já preparado à
# mão passa despercebido. Na primeira instalação real numa VPS, o
# resultado foi:
#
#   psql: FATAL: password authentication failed for user "stabilize_migrator"
#
# ...logo no 001, porque o papel ainda não existia.
#
# E POR QUE NÃO A DE SUPERUSUÁRIO PARA TUDO, que resolveria igual: porque
# aí o dono das tabelas passa a ser `postgres`, e o papel de migração —
# que existe para que a API rode sem poder de DDL — perde o sentido. A
# credencial de superusuário aparece uma vez, no arquivo que precisa
# dela, e some.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$(cd "${SCRIPT_DIR}/../sql" && pwd)"

: "${DATABASE_MIGRATION_URL:?defina DATABASE_MIGRATION_URL (credencial de migração, não a da API)}"

# As senhas dos papéis entram como variáveis do psql. O 000_roles.sql se
# recusa a rodar sem elas — de propósito: é melhor a instalação travar do
# que subir com credencial conhecida.
: "${STABILIZE_APP_PASSWORD:?defina STABILIZE_APP_PASSWORD (gere com: openssl rand -base64 32)}"
: "${STABILIZE_MIGRATOR_PASSWORD:?defina STABILIZE_MIGRATOR_PASSWORD (gere com: openssl rand -base64 32)}"

# ---------------------------------------------------------------------
# A URL de superusuário.
#
# Se não vier pronta, é DERIVADA da de migração trocando só o usuário e a
# senha — mesmo host, mesma porta, mesmo banco. Assim quem instala não
# precisa manter duas URLs em sincronia, e não há como apontar uma delas
# para o banco errado.
# ---------------------------------------------------------------------
if [ -z "${DATABASE_SUPERUSER_URL:-}" ]; then
  : "${POSTGRES_SUPERUSER:?defina POSTGRES_SUPERUSER ou DATABASE_SUPERUSER_URL}"
  : "${POSTGRES_SUPERUSER_PASSWORD:?defina POSTGRES_SUPERUSER_PASSWORD ou DATABASE_SUPERUSER_URL}"
  # Tudo depois do '@' é host:porta/banco — inclusive parâmetros de query.
  destino="${DATABASE_MIGRATION_URL#*@}"
  DATABASE_SUPERUSER_URL="postgresql://${POSTGRES_SUPERUSER}:${POSTGRES_SUPERUSER_PASSWORD}@${destino}"
fi

aplicar() {
  local url="$1" arquivo="$2"
  psql "${url}" -v ON_ERROR_STOP=1 -q \
    -v app_password="${STABILIZE_APP_PASSWORD}" \
    -v migrator_password="${STABILIZE_MIGRATOR_PASSWORD}" \
    -f "${arquivo}"
}

echo "==> aplicando migrations de ${SQL_DIR}"

# ---------------------------------------------------------------------
# REGISTRO DO QUE JÁ FOI APLICADO.
#
# Sem isto, atualizar quebrava. O 001_schema.sql tem 22 CREATE TABLE, 40
# CREATE INDEX, 23 CREATE POLICY e 15 CREATE TRIGGER, e NENHUM deles usa
# `IF NOT EXISTS` — reexecutar morre em `relation "tenants" already
# exists`. Como toda atualização reexecuta, o segundo deploy do sistema
# falharia. (O DEPLOY.md chegou a afirmar que as migrations eram
# idempotentes; não eram, e a afirmação foi corrigida junto com isto.)
#
# A alternativa seria sair pondo `IF NOT EXISTS` em uma centena de
# comandos — mais arriscado, e para policy e trigger o PostgreSQL nem
# oferece a cláusula. Registrar o que já rodou resolve de uma vez e vale
# para as migrations futuras também, sem exigir disciplina de quem as
# escrever.
#
# A EXCEÇÃO SÃO OS ARQUIVOS DE PAPÉIS (*_roles.sql), que rodam SEMPRE:
# eles são idempotentes por construção e é reexecutá-los que rotaciona
# as senhas do banco. Marcá-los como "já aplicado" tiraria a rotação.
# ---------------------------------------------------------------------

# OS PAPÉIS VÊM ANTES DE TUDO — inclusive antes da tabela de registro,
# que é criada PELO migrator e portanto não pode existir antes dele.
for file in "${SQL_DIR}"/000_*.sql; do
  [ -e "${file}" ] || continue
  echo "--> $(basename "${file}")  (superusuário, sempre)"
  aplicar "${DATABASE_SUPERUSER_URL}" "${file}"
done

psql "${DATABASE_MIGRATION_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  arquivo     text PRIMARY KEY,
  aplicado_em timestamptz NOT NULL DEFAULT now()
);
-- A aplicação não tem nada que ver com o controle de migrations. Sem
-- este REVOKE ela herdaria acesso do ALTER DEFAULT PRIVILEGES do 000.
REVOKE ALL ON schema_migrations FROM stabilize_app;
SQL

ja_aplicado() {
  local resposta
  resposta=$(psql "${DATABASE_MIGRATION_URL}" -qAt \
    -c "SELECT 1 FROM schema_migrations WHERE arquivo = '$1'")
  [ "${resposta}" = "1" ]
}

marcar() {
  psql "${DATABASE_MIGRATION_URL}" -v ON_ERROR_STOP=1 -q \
    -c "INSERT INTO schema_migrations (arquivo) VALUES ('$1') ON CONFLICT DO NOTHING"
}

# Ordem lexicográfica, ignorando os arquivos 9xx (testes).
for file in "${SQL_DIR}"/[0-8]*.sql; do
  [ -e "${file}" ] || continue
  nome="$(basename "${file}")"

  case "${nome}" in
    000_*)
      continue  # já aplicado logo acima, antes da tabela de registro
      ;;
    *_super.sql)
      # Superusuário e sempre. Ajusta dono de função e privilégio de
      # papel — idempotente, e reexecutar conserta um banco que ficou
      # para trás.
      echo "--> ${nome}  (superusuário, sempre)"
      aplicar "${DATABASE_SUPERUSER_URL}" "${file}"
      ;;
    *_roles.sql)
      echo "--> ${nome}  (sempre)"
      aplicar "${DATABASE_MIGRATION_URL}" "${file}"
      ;;
    *)
      if ja_aplicado "${nome}"; then
        echo "--> ${nome}  (já aplicada, pulando)"
      else
        echo "--> ${nome}"
        aplicar "${DATABASE_MIGRATION_URL}" "${file}"
        marcar "${nome}"
      fi
      ;;
  esac
done

# ---------------------------------------------------------------------
# QUANTOS ARQUIVOS ESTA IMAGEM TEM.
#
# Parece supérfluo e não é: o serviço `migrate` tem `profiles`, e
# `docker compose build` sem `--profile ferramentas` NÃO reconstrói esta
# imagem. Quando isso acontece, o container sobe com os arquivos SQL
# ANTIGOS, reaplica o que já estava aplicado e imprime "migrations
# aplicadas" com ar de sucesso — enquanto a API nova já está no ar
# esperando colunas que não existem.
#
# Aconteceu numa atualização real. Esta linha é o que permite ao
# `deploy/atualizar.sh` comparar com o que existe no disco e PARAR antes
# de subir a API.
# ---------------------------------------------------------------------
total=$(find "${SQL_DIR}" -maxdepth 1 -name '[0-8]*.sql' | wc -l | tr -d ' ')
echo "==> arquivos de migration: ${total}"
echo "==> migrations aplicadas"
