#!/usr/bin/env bash
#
# Ler o crontab de root SEM correr o risco de apagar o dos vizinhos.
#
# O PERIGO QUE ISTO FECHA
#
# Os dois agendadores deste sistema montam o crontab novo a partir do
# atual: leem tudo, tiram a própria linha e escrevem de volta. O padrão
# antigo lia assim —
#
#     atual="$(crontab -l 2>/dev/null || true)"
#
# — e aí está o problema: `crontab -l` sai com erro nos DOIS casos, o de
# "ainda não existe crontab" e o de "não consegui ler". O `|| true`
# tratava os dois como vazio, e a linha seguinte reescrevia o crontab
# INTEIRO com uma entrada só. Tudo o que estivesse lá — inclusive o
# agendamento de outro sistema — sumia calado, e o script ainda
# imprimia "Agendado" como se estivesse tudo bem.
#
# Nesta VPS isso é grave e não teórico: o crontab é o do `root` e é
# compartilhado com as outras gavetas. Um erro de leitura transitório
# aqui apaga a rotina do vizinho, e ninguém fica sabendo até o backup
# dele não rodar.
#
# A REGRA: só o "não existe crontab" pode virar vazio. Qualquer outra
# falha PARA o script antes de escrever. Não escrever é sempre
# recuperável; escrever por cima do que não se conseguiu ler, não.

ler_crontab() {
  local saida codigo
  set +e
  saida="$(crontab -l 2>&1)"
  codigo=$?
  set -e

  if [ "$codigo" -eq 0 ]; then
    printf '%s\n' "$saida"
    return 0
  fi

  # A mensagem do "ainda não tem nada" varia de implementação (Vixie,
  # cronie, busybox) mas todas dizem "no crontab for <usuário>". Só ela
  # autoriza tratar como vazio.
  if printf '%s' "$saida" | grep -qi 'no crontab for'; then
    return 0
  fi

  printf '\033[31m%s\033[0m\n' "PAREI. Não consegui ler o crontab atual:" >&2
  printf '\033[31m%s\033[0m\n' "  ${saida}" >&2
  printf '\033[31m%s\033[0m\n' "Não vou reescrevê-lo às cegas: este crontab é do root e" >&2
  printf '\033[31m%s\033[0m\n' "é compartilhado com os outros sistemas desta VPS." >&2
  exit 1
}
