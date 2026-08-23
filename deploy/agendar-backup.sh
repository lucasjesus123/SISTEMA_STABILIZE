#!/usr/bin/env bash
#
# Coloca o backup no cron. Roda uma vez, na VPS.
#
# POR QUE UM SCRIPT E NÃO UMA LINHA NO README
#
# O backup existia e estava escrito, com verificação de restauração e
# tudo. O que não existia era alguém rodando ele. Um backup manual é um
# backup que acontece nos primeiros quinze dias — e é justamente no
# décimo sexto que o disco enche.
#
# TRÊS COISAS QUE ESTE SCRIPT FAZ E QUE UMA LINHA COLADA NO CRONTAB NÃO
# FAZ:
#
#   1. NÃO DUPLICA. Rodar de novo substitui a entrada em vez de criar a
#      segunda — duas cópias do mesmo backup às 3h disputando o mesmo
#      arquivo é como se corrompe o dump.
#
#   2. ESCREVE O CAMINHO ABSOLUTO. Cron não tem o PATH nem o diretório
#      de trabalho do seu terminal, e o `cd` de dentro do backup.sh
#      depende do caminho do próprio arquivo.
#
#   3. CONFERE QUE FUNCIONA ANTES DE AGENDAR. Agendar um comando que não
#      roda é agendar um silêncio: o cron não reclama, e a primeira
#      notícia vem no dia do desastre.
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/_crontab.sh
. "$(dirname "${BASH_SOURCE[0]}")/_crontab.sh"
BACKUP="$RAIZ/deploy/backup.sh"
LOG="${STABILIZE_BACKUP_LOG:-/var/log/stabilize-backup.log}"
HORA="${STABILIZE_BACKUP_HORA:-3}"
MARCA="# stabilize-backup"

azul()    { printf '\033[36m%s\033[0m\n' "$*"; }
verde()   { printf '\033[32m%s\033[0m\n' "$*"; }
amarelo() { printf '\033[33m%s\033[0m\n' "$*"; }
vermelho(){ printf '\033[31m%s\033[0m\n' "$*"; }

[ -x "$BACKUP" ] || { vermelho "não encontrei $BACKUP (ou não é executável)"; exit 1; }
[ -f "$RAIZ/.env" ] || { vermelho "não encontrei $RAIZ/.env — rode isto dentro da pasta instalada"; exit 1; }

# ---------------------------------------------------------------------
# 1. Provar que funciona ANTES de agendar
#
# O backup.sh já restaura o dump num banco descartável e confere o
# conteúdo, então esta chamada não é um teste de fumaça: é o backup
# inteiro, com a verificação que faz dele um backup de verdade.
# ---------------------------------------------------------------------
azul "==> 1/3  rodando um backup agora, para provar que funciona"
if ! "$BACKUP"; then
  vermelho ""
  vermelho "PAREI AQUI. O backup falhou, e agendar um comando que falha"
  vermelho "só troca 'sem backup' por 'sem backup e sem ninguém sabendo'."
  exit 1
fi

# ---------------------------------------------------------------------
# 2. O log precisa existir e ser escrevível pelo cron
# ---------------------------------------------------------------------
azul "==> 2/3  preparando o log em $LOG"
touch "$LOG" 2>/dev/null || { vermelho "não consigo escrever em $LOG"; exit 1; }
chmod 600 "$LOG"

# ---------------------------------------------------------------------
# 3. A entrada do cron
# ---------------------------------------------------------------------
azul "==> 3/3  agendando para todo dia às ${HORA}h"

linha="0 ${HORA} * * * ${BACKUP} >> ${LOG} 2>&1 ${MARCA}"

# A leitura passa por `ler_crontab`: só "ainda não há crontab" vira
# vazio. Qualquer outra falha para o script ANTES de escrever — este
# crontab é do root e é compartilhado com as outras gavetas da VPS.
atual="$(ler_crontab)"
novo="$(printf '%s\n' "$atual" | grep -v -- "$MARCA" || true)"
printf '%s\n%s\n' "$novo" "$linha" | grep -v '^$' | crontab -

verde ""
verde "Agendado. Confira com: crontab -l"
crontab -l | grep -- "$MARCA"

echo
amarelo "FALTA A PARTE QUE ESTE SCRIPT NÃO PODE FAZER POR VOCÊ:"
amarelo ""
amarelo "  Backup que mora no mesmo disco do sistema não é backup. Se a VPS"
amarelo "  morrer, morrem os dois juntos. Copie ${STABILIZE_BACKUP_DIR:-/var/backups/stabilize}"
amarelo "  para fora — rclone para um bucket, rsync para outra máquina, o que"
amarelo "  for. Sem isso, o que existe aqui protege contra erro humano e"
amarelo "  contra migration ruim, e não protege contra perder a máquina."
echo
echo "Para restaurar um dia:  ./deploy/restaurar.sh <arquivo.dump> [anexos.tar.zst]"
