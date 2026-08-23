#!/usr/bin/env bash
#
# Põe a verificação de atualização no cron. Roda uma vez, na VPS.
#
# O QUE VOCÊ ESTÁ LIGANDO, dito sem enfeite: depois disto, todo commit
# que chegar no ramo do GitHub entra no ar sozinho, sem ninguém olhando.
# Isso tira trabalho seu e tira também a conferência humana entre
# escrever e publicar.
#
# O QUE SEGURA A QUEDA, e por isso a troca se paga:
#
#   - O `atualizar.sh` faz backup ANTES de tocar no banco, sem opção de
#     pular.
#   - Ele confere se a imagem de migration é a mesma do disco e PARA
#     antes de subir a API nova quando não é — deixando o sistema antigo
#     servindo, que é o estado seguro.
#   - A CI do repositório roda os testes a cada push. Um commit que
#     quebra os testes chega aqui do mesmo jeito: o cron não lê a CI.
#     Se isso te incomoda, este script não é para você — o comando à mão
#     continua valendo.
#
# NÃO EXISTE CREDENCIAL NENHUMA AQUI. Nada é guardado no GitHub, nada
# entra na máquina de fora. O servidor só faz uma leitura e decide.
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/_crontab.sh
. "$(dirname "${BASH_SOURCE[0]}")/_crontab.sh"
VERIFICAR="$RAIZ/deploy/verificar-atualizacao.sh"
LOG="${STABILIZE_ATUALIZACAO_LOG:-/var/log/stabilize-atualizacao.log}"
MINUTOS="${STABILIZE_ATUALIZACAO_MINUTOS:-10}"
MARCA="# stabilize-atualizacao"

azul()    { printf '\033[36m%s\033[0m\n' "$*"; }
verde()   { printf '\033[32m%s\033[0m\n' "$*"; }
amarelo() { printf '\033[33m%s\033[0m\n' "$*"; }
vermelho(){ printf '\033[31m%s\033[0m\n' "$*"; }

[ -x "$VERIFICAR" ] || { vermelho "não encontrei $VERIFICAR (ou não é executável)"; exit 1; }
[ -f "$RAIZ/.env" ] || { vermelho "não encontrei $RAIZ/.env — rode isto dentro da pasta instalada"; exit 1; }
command -v flock >/dev/null || { vermelho "flock não está instalado: apt install util-linux"; exit 1; }

case "$MINUTOS" in
  ''|*[!0-9]*) vermelho "STABILIZE_ATUALIZACAO_MINUTOS precisa ser um número"; exit 1 ;;
esac
[ "$MINUTOS" -ge 1 ] && [ "$MINUTOS" -le 59 ] || {
  vermelho "STABILIZE_ATUALIZACAO_MINUTOS precisa estar entre 1 e 59"; exit 1; }

# ---------------------------------------------------------------------
# 1. Provar que a leitura funciona ANTES de agendar
#
# Se o `git fetch` do cron não autenticar — chave de deploy ausente,
# `origin` em SSH sem agente — o script sairia calado a cada dez minutos
# e você só descobriria ao notar que uma atualização nunca chegou.
# Melhor descobrir agora, com alguém lendo a tela.
# ---------------------------------------------------------------------
azul "==> 1/3  conferindo se dá para consultar o GitHub daqui"
ramo="$(cd "$RAIZ" && git rev-parse --abbrev-ref HEAD)"
if ! (cd "$RAIZ" && git fetch --quiet origin "$ramo"); then
  vermelho ""
  vermelho "PAREI AQUI. Não consegui buscar o ramo ${ramo} no GitHub."
  vermelho "No cron não há terminal para pedir senha nem agente de SSH,"
  vermelho "então isto falharia em silêncio. Resolva o acesso primeiro."
  exit 1
fi
verde "    ramo ${ramo}, leitura do GitHub funcionando"

# ---------------------------------------------------------------------
# 2. Log
# ---------------------------------------------------------------------
azul "==> 2/3  preparando o log em $LOG"
touch "$LOG" 2>/dev/null || { vermelho "não consigo escrever em $LOG"; exit 1; }
chmod 600 "$LOG"

# ---------------------------------------------------------------------
# 3. A entrada do cron
#
# Substitui a anterior em vez de somar: duas verificações concorrentes
# não quebrariam nada (existe a trava), mas encheriam o log de linhas
# repetidas até ele deixar de ser lido.
# ---------------------------------------------------------------------
azul "==> 3/3  agendando a cada ${MINUTOS} min"

linha="*/${MINUTOS} * * * * ${VERIFICAR} >> ${LOG} 2>&1 ${MARCA}"

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
amarelo "PARA DESLIGAR, quando quiser voltar a publicar à mão:"
amarelo "  crontab -l | grep -v '${MARCA}' | crontab -"
echo
echo "Acompanhar:  tail -f ${LOG}"
echo "Publicar agora, sem esperar o cron:  ${VERIFICAR}"
