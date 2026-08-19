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

# ---------------------------------------------------------------------
# A ETAPA QUE FALTAVA — e que só apareceu ao restaurar de verdade.
#
# `--no-owner` faz tudo nascer pertencendo ao superusuário. O sistema
# volta e funciona: a API entra como stabilize_app, as permissões vêm no
# dump, a RLS continua valendo. Tudo parece certo.
#
# Até o próximo deploy, quando as migrations rodam como
# stabilize_migrator e morrem na primeira:
#
#     ERROR:  must be owner of table students
#
# É o pior tipo de defeito: aparece semanas depois, longe do incidente
# que o causou, e o sintoma não parece ter nada a ver com a restauração.
# ---------------------------------------------------------------------
echo "==> devolvendo dono e permissões aos papéis certos"
docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
  psql -v ON_ERROR_STOP=1 -U "${POSTGRES_SUPERUSER:-postgres}" -d "${POSTGRES_DB:-stabilize}" \
  < "$RAIZ/deploy/normalizar-donos.sql"

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

# CONFERIR QUE O PRÓXIMO DEPLOY VAI FUNCIONAR, e não só que o banco
# voltou. A pergunta "dá para atualizar o sistema depois disto" tem que
# ser respondida agora, e não no dia em que houver uma versão nova.
echo "==> conferindo se o sistema ainda pode ser atualizado"
if docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
     psql -U "${POSTGRES_SUPERUSER:-postgres}" -d "${POSTGRES_DB:-stabilize}" -Atc \
     "SELECT CASE WHEN count(*) = 0 THEN 'ok' ELSE 'erro' END
        FROM pg_tables WHERE schemaname='public' AND tableowner <> 'stabilize_migrator'" \
     | grep -q '^ok$'; then
  echo "    ok — as migrations vão rodar no próximo deploy"
else
  echo "    ATENÇÃO: há tabelas com dono errado. Rode deploy/normalizar-donos.sql"
  echo "    como superusuário antes do próximo ./deploy/atualizar.sh."
fi

echo
echo "Restauração concluída. Confira o acesso antes de avisar que voltou."
