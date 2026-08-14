#!/usr/bin/env bash
#
# Prova de isolamento multi-tenant.
#
# Roda 900_isolation_test.sql COMO A APLICAÇÃO (DATABASE_URL, papel
# stabilize_app, sem BYPASSRLS). Rodar como superusuário passaria mesmo
# com a RLS quebrada e daria uma falsa sensação de segurança — por isso
# o script recusa credencial privilegiada.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$(cd "${SCRIPT_DIR}/../sql" && pwd)"

: "${DATABASE_URL:?defina DATABASE_URL (credencial de runtime da API)}"

echo "==> verificando que a credencial de teste NÃO ignora RLS"
PRIVILEGED=$(psql "${DATABASE_URL}" -tAc \
  "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")

if [ "${PRIVILEGED}" != "f" ]; then
  echo "ERRO: DATABASE_URL usa um papel superusuário ou com BYPASSRLS." >&2
  echo "      A prova de isolamento passaria mesmo com a RLS desligada." >&2
  echo "      Configure a API para conectar como stabilize_app." >&2
  exit 1
fi

echo "==> rodando prova de isolamento como $(psql "${DATABASE_URL}" -tAc 'SELECT current_user')"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${SQL_DIR}/900_isolation_test.sql"
