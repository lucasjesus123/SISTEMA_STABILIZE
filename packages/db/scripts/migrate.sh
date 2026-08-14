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

echo "==> aplicando migrations de ${SQL_DIR}"

# Ordem lexicográfica, ignorando os arquivos 9xx (testes).
for file in "${SQL_DIR}"/[0-8]*.sql; do
  [ -e "${file}" ] || continue
  echo "--> $(basename "${file}")"
  psql "${DATABASE_MIGRATION_URL}" -v ON_ERROR_STOP=1 -q -f "${file}"
done

echo "==> migrations aplicadas"
