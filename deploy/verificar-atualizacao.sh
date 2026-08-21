#!/usr/bin/env bash
#
# Pergunta ao GitHub se o ramo andou e, se andou, atualiza. Feito para
# rodar no cron, sozinho, sem ninguém olhando.
#
# POR QUE O VPS PUXA, EM VEZ DE O GITHUB EMPURRAR
#
# A forma comum de automatizar deploy é uma action que entra na máquina
# por SSH. Para isso a chave privada do servidor precisa morar nos
# secrets do repositório — e quem tem escrita no repositório, ou uma
# action de terceiro comprometida, passa a ter a máquina inteira.
#
# Aqui isso seria pior do que o normal: esta VPS hospeda outros sistemas
# em pastas vizinhas, e nenhuma chave que abre esta pasta para de abrir
# na porta ao lado. Invertendo o sentido, nada sai daqui: o servidor faz
# uma consulta de leitura ao GitHub e decide sozinho.
#
# QUATRO COISAS QUE ESTE SCRIPT FAZ E QUE UM `git pull` NO CRON NÃO FAZ:
#
#   1. FICA CALADO QUANDO NÃO HÁ NADA. Cron manda e-mail a cada linha
#      impressa. Um script que fala a cada cinco minutos é um script cujo
#      log ninguém lê mais — e é no dia em que ele tem algo a dizer que
#      isso custa caro.
#
#   2. NÃO DEIXA DOIS DEPLOYS SE CRUZAREM. A atualização demora mais que
#      o intervalo do cron quando as imagens são reconstruídas. Sem
#      trava, o segundo `docker compose up` sobe no meio do primeiro.
#
#   3. RECUSA HISTÓRIA REESCRITA. Se o ramo remoto não descende do que
#      está aqui, alguém fez force-push. Isso pode ser legítimo, mas não
#      é rotina — e rotina é a única coisa que uma máquina deve fazer
#      sozinha às três da manhã. Ela para e chama você.
#
#   4. NÃO ENCOSTA EM OUTRA PASTA. Tudo acontece dentro da raiz deste
#      sistema, calculada a partir do caminho deste arquivo.
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${STABILIZE_LOCK:-/var/lock/stabilize-atualizacao.lock}"

vermelho(){ printf '\033[31m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------
# Trava — antes de qualquer outra coisa
#
# O script chama a si mesmo sob `flock`. O `-E 75` separa "não consegui
# travar" de um erro do próprio deploy: sem isso, os dois sairiam com 1 e
# um deploy quebrado passaria por "já estava rodando".
# ---------------------------------------------------------------------
if [ "${STABILIZE_COM_TRAVA:-}" != "1" ]; then
  set +e
  STABILIZE_COM_TRAVA=1 flock -n -E 75 "$LOCK" "$0" "$@"
  codigo=$?
  set -e
  # 75 = outra atualização em andamento. É o caso esperado quando o
  # deploy passa do intervalo do cron, e não é problema: sai calado.
  [ "$codigo" -eq 75 ] && exit 0
  exit "$codigo"
fi

cd "$RAIZ"

[ -f .env ] || { vermelho "não encontrei $RAIZ/.env — esta não é a pasta instalada"; exit 1; }

ramo="$(git rev-parse --abbrev-ref HEAD)"

# Falha de rede não é motivo para alarme: a próxima passada do cron tenta
# de novo. Só reclama se persistir, e quem percebe isso é o log.
if ! git fetch --quiet origin "$ramo" 2>/dev/null; then
  echo "[$(date '+%F %T')] não consegui falar com o GitHub; tento na próxima."
  exit 0
fi

aqui="$(git rev-parse HEAD)"
la="$(git rev-parse "origin/${ramo}")"

# O caso mais comum, de longe. Sai sem imprimir nada.
[ "$aqui" = "$la" ] && exit 0

# ---------------------------------------------------------------------
# Só avança em linha reta
#
# `--is-ancestor` responde "o que está aqui faz parte do que está lá?".
# Quando não faz, o histórico foi reescrito e o que viria a seguir não
# seria uma atualização, e sim uma troca de versão — com migrations que
# talvez já rodaram. Isso é decisão de gente.
# ---------------------------------------------------------------------
if ! git merge-base --is-ancestor "$aqui" "$la"; then
  vermelho "[$(date '+%F %T')] PAREI. O ramo ${ramo} foi reescrito no GitHub."
  vermelho "  aqui: ${aqui:0:7}    lá: ${la:0:7}"
  vermelho "  Nada foi alterado. Confira e rode ./deploy/atualizar.sh à mão."
  exit 1
fi

echo "[$(date '+%F %T')] ${aqui:0:7} → ${la:0:7} — atualizando."
./deploy/atualizar.sh

# ---------------------------------------------------------------------
# Conferir que o HEAD andou mesmo
#
# Quem faz o `git pull` é o `atualizar.sh`, não este script. Se por
# qualquer motivo ele terminar bem sem ter avançado — pull recusado por
# arquivo alterado à mão na VPS, ramo trocado no meio do caminho —, o
# commit continuaria diferente do remoto e a próxima passada do cron
# começaria tudo de novo. E de novo. A cada dez minutos.
#
# Não seria um laço inofensivo: a primeira coisa que o `atualizar.sh`
# faz é um backup completo. Um deploy que se repete sozinho vira um dump
# a cada dez minutos até o disco encher, e disco cheio numa VPS que
# hospeda outros sistemas derruba os vizinhos junto.
#
# Então: se não andou, isto grita e sai com erro, para o cron avisar.
# ---------------------------------------------------------------------
agora="$(git rev-parse HEAD)"
if [ "$agora" != "$la" ]; then
  vermelho "[$(date '+%F %T')] O atualizar.sh terminou sem erro, mas o HEAD não avançou."
  vermelho "  esperado: ${la:0:7}    está em: ${agora:0:7}"
  vermelho "  NÃO vou tentar de novo sozinho: repetir isto a cada ${STABILIZE_ATUALIZACAO_MINUTOS:-10} min"
  vermelho "  geraria um backup completo por passada até encher o disco."
  vermelho "  Rode ./deploy/atualizar.sh à mão e veja o que ele reclama."
  exit 1
fi

echo "[$(date '+%F %T')] atualização concluída em ${la:0:7}."
