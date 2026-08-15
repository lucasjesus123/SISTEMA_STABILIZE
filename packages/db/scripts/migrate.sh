#!/usr/bin/env bash
#
# Aplica as migrations em ordem.
#
# Roda com a credencial de MIGRAÇÃO (DATABASE_MIGRATION_URL), que é
# distinta da credencial de runtime da API (DATABASE_URL). Separar as duas
# é o que permite a API rodar sem privilégio de DDL: se a API for
# comprometida, o atacante não consegue derrubar tabela nem desligar RLS.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$(cd "${SCRIPT_DIR}/../sql" && pwd)"

: "${DATABASE_MIGRATION_URL:?defina DATABASE_MIGRATION_URL (credencial de migração, não a da API)}"

# As senhas dos papéis entram como variáveis do psql. O 002_roles.sql se
# recusa a rodar sem elas — de propósito: é melhor a instalação travar do
# que subir com credencial conhecida.
: "${STABILIZE_APP_PASSWORD:?defina STABILIZE_APP_PASSWORD (gere com: openssl rand -base64 32)}"
: "${STABILIZE_MIGRATOR_PASSWORD:?defina STABILIZE_MIGRATOR_PASSWORD (gere com: openssl rand -base64 32)}"

echo "==> aplicando migrations de ${SQL_DIR}"

# Ordem lexicográfica, ignorando os arquivos 9xx (testes).
for file in "${SQL_DIR}"/[0-8]*.sql; do
  [ -e "${file}" ] || continue
  echo "--> $(basename "${file}")"
  psql "${DATABASE_MIGRATION_URL}" -v ON_ERROR_STOP=1 -q \
    -v app_password="${STABILIZE_APP_PASSWORD}" \
    -v migrator_password="${STABILIZE_MIGRATOR_PASSWORD}" \
    -f "${file}"
done

echo "==> migrations aplicadas"
