#!/usr/bin/env bash
#
# Checkup de regressão — "algo está voltando sozinho?"
#
# Roda o verificador em `deploy/checkup.sql` e imprime um placar.
# SÓ LEITURA: todas as consultas são SELECT. Pode rodar em produção, com
# o sistema no ar, a qualquer hora.
#
#   ./deploy/checkup.sh
#
# COMO LER O PLACAR
#
#   As conferências 1 a 6 NÃO dependem da trilha de auditoria — leem o
#   dado atual e perguntam se ele é coerente consigo mesmo. Valem
#   sempre, inclusive contra alteração feita por SQL direto no servidor.
#   São as que pegam perda de dinheiro.
#
#   As conferências 7 a 9 leem a trilha, que é escrita pela APLICAÇÃO.
#   Valem apenas dentro do período impresso no cabeçalho. Se a
#   reclamação é anterior a esse período, a resposta honesta é "não
#   tenho como saber" — e não "está tudo bem".
#
# O VERIFICADOR FOI TESTADO COM DEFEITO PLANTADO, e não só numa base
# saudável: rodar numa base limpa e ver nove OK não prova nada, porque
# um `SELECT 'OK'` faria o mesmo. Os oito defeitos foram inseridos de
# propósito numa transação desfeita no fim, e cada conferência acusou o
# seu. Três deles NÃO puderam nem ser plantados sem derrubar restrições
# do banco — `entry_not_overpaid`, `appt_no_professional_overlap` e
# `appt_no_student_overlap` são CHECK e EXCLUDE, que sobrevivem até ao
# desligamento de gatilhos.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${POSTGRES_SUPERUSER:=postgres}"
: "${POSTGRES_DB:=stabilize}"

# `CHECKUP_PSQL_URL` existe para rodar contra um banco local sem Docker.
if [ -n "${CHECKUP_PSQL_URL:-}" ]; then
  psql "$CHECKUP_PSQL_URL" -X -f deploy/checkup.sql
else
  docker compose exec -T -e PGPASSWORD="${POSTGRES_SUPERUSER_PASSWORD:-}" postgres \
    psql -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" -X < deploy/checkup.sql
fi
