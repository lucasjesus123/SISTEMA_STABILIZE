#!/usr/bin/env bash
#
# Restaura um backup. O par do backup.sh.
#
# Existe para que a restauração seja um comando conhecido e não uma
# improvisação às três da manhã. Quem restaura pela primeira vez durante
# o incidente descobre os problemas durante o incidente.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP="${1:-}"
ANEXOS="${2:-}"

if [ -z "$DUMP" ]; then
  echo "uso: $0 <banco-....dump> [anexos-....tar.zst]"
  echo
  echo "backups disponíveis:"
  ls -1t "${STABILIZE_BACKUP_DIR:-/var/backups/stabilize}"/banco-*.dump 2>/dev/null | head -10 || echo "  nenhum"
  exit 1
fi

[ -r "$DUMP" ] || { echo "ERRO: não consigo ler $DUMP"; exit 1; }

cd "$RAIZ"
# shellcheck disable=SC1091
set -a; . ./.env; set +a

echo "Isto SUBSTITUI o banco '${POSTGRES_DB:-stabilize}' pelo conteúdo de:"
echo "  $DUMP"
[ -n "$ANEXOS" ] && echo "  $ANEXOS"
echo
read -rp "Digite RESTAURAR para confirmar: " confirmacao
[ "$confirmacao" = "RESTAURAR" ] || { echo "cancelado."; exit 1; }

# A API para antes: restaurar com ela escrevendo produz um banco
# meio novo, meio velho — pior que qualquer um dos dois.
echo "==> parando a API"
docker compose stop api

echo "==> recriando o banco"
docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
  psql -U "${POSTGRES_SUPERUSER:-postgres}" -d postgres -c \
  "DROP DATABASE IF EXISTS ${POSTGRES_DB:-stabilize} WITH (FORCE)"
docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
  createdb -U "${POSTGRES_SUPERUSER:-postgres}" "${POSTGRES_DB:-stabilize}"

echo "==> restaurando"
docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
  pg_restore -U "${POSTGRES_SUPERUSER:-postgres}" -d "${POSTGRES_DB:-stabilize}" --no-owner < "$DUMP"

if [ -n "$ANEXOS" ]; then
  echo "==> restaurando anexos"
  docker compose start api
  sleep 3
  zstd -dc "$ANEXOS" | docker compose exec -T api tar -C /app/storage -xf -
else
  docker compose start api
fi

echo
echo "==> conferindo"
docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
  psql -U "${POSTGRES_SUPERUSER:-postgres}" -d "${POSTGRES_DB:-stabilize}" -Atc \
  "SELECT count(*) || ' empresas, ' || (SELECT count(*) FROM users) || ' usuários' FROM tenants"

echo
echo "Restauração concluída. Confira o acesso antes de avisar que voltou."
