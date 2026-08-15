#!/usr/bin/env bash
#
# Backup do banco e dos anexos.
#
# A PARTE QUE IMPORTA É A LINHA `verificar_restauracao`.
#
# Um backup nunca testado não é backup — é a crença de que existe um.
# Os dois modos de falha clássicos são silenciosos: o dump sai truncado
# porque o disco encheu, ou sai válido mas de um banco vazio porque a
# credencial mudou. Nos dois casos o arquivo existe, tem tamanho, e a
# equipe dorme tranquila até o dia do desastre.
#
# Por isso, aqui, todo backup é RESTAURADO num banco descartável e
# conferido antes de ser dado como bom.
#
# Uso (cron diário):
#   0 3 * * * /opt/stabilize/deploy/backup.sh >> /var/log/stabilize-backup.log 2>&1
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO="${STABILIZE_BACKUP_DIR:-/var/backups/stabilize}"
MANTER_DIAS="${STABILIZE_BACKUP_DIAS:-30}"
CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"

cd "$RAIZ"
# shellcheck disable=SC1091
set -a; . ./.env; set +a

mkdir -p "$DESTINO"
umask 077

ARQ_BANCO="$DESTINO/banco-$CARIMBO.dump"
ARQ_ANEXOS="$DESTINO/anexos-$CARIMBO.tar.zst"

registrar() { echo "[$(date -u +%H:%M:%S)] $*"; }

# --- banco ---------------------------------------------------------
registrar "dump do banco"
# Formato custom (-Fc): comprimido e restaurável seletivamente, ao
# contrário do SQL puro, que só serve inteiro.
docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
  pg_dump -U "${POSTGRES_SUPERUSER:-postgres}" -d "${POSTGRES_DB:-stabilize}" -Fc \
  > "$ARQ_BANCO"

# --- anexos --------------------------------------------------------
registrar "arquivo dos anexos"
docker compose exec -T api tar -C /app/storage -cf - . \
  | zstd -q -T0 -o "$ARQ_ANEXOS"

# --- a verificação que faz o backup valer ---------------------------
verificar_restauracao() {
  local dump="$1"
  local banco="verificacao_backup_$$"

  registrar "restaurando num banco descartável para conferir"
  docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
    createdb -U "${POSTGRES_SUPERUSER:-postgres}" "$banco"

  # Limpa o banco de teste aconteça o que acontecer.
  trap 'docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
          dropdb --if-exists -U "${POSTGRES_SUPERUSER:-postgres}" "$banco" >/dev/null 2>&1 || true' RETURN

  if ! docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
        pg_restore -U "${POSTGRES_SUPERUSER:-postgres}" -d "$banco" --no-owner < "$dump" 2>/dev/null; then
    registrar "FALHA: o dump não restaura"
    return 1
  fi

  # Restaurou — mas restaurou ALGUMA COISA? Um dump de banco vazio
  # restaura sem erro nenhum, e é o modo de falha mais traiçoeiro:
  # a credencial mudou, o pg_dump não viu tabela, e o arquivo parece bom.
  local contagem
  contagem=$(docker compose exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" postgres \
    psql -U "${POSTGRES_SUPERUSER:-postgres}" -d "$banco" -Atc \
    "SELECT count(*) FROM tenants" 2>/dev/null || echo 0)

  if [ "${contagem:-0}" -lt 1 ]; then
    registrar "FALHA: o dump restaura mas não tem empresa nenhuma dentro"
    return 1
  fi

  registrar "verificado: $contagem empresa(s) no backup"
  return 0
}

if ! verificar_restauracao "$ARQ_BANCO"; then
  # O arquivo ruim é renomeado, não apagado: pode ser a única cópia de
  # algo, e serve para investigar o que deu errado.
  mv "$ARQ_BANCO" "$ARQ_BANCO.SUSPEITO"
  registrar "ERRO: backup marcado como SUSPEITO. NÃO CONTE COM ELE."
  exit 1
fi

# --- rotação -------------------------------------------------------
# Só depois da verificação: apagar backup antigo antes de confirmar que
# o novo presta é como se perde as duas pontas.
registrar "removendo backups com mais de $MANTER_DIAS dias"
find "$DESTINO" -name 'banco-*.dump' -mtime "+$MANTER_DIAS" -delete
find "$DESTINO" -name 'anexos-*.tar.zst' -mtime "+$MANTER_DIAS" -delete

registrar "concluído: $(du -h "$ARQ_BANCO" | cut -f1) banco, $(du -h "$ARQ_ANEXOS" | cut -f1) anexos"
echo
echo "LEMBRETE: backup que mora no mesmo disco do sistema não é backup."
echo "Copie $DESTINO para fora da VPS (rclone, rsync, S3)."
