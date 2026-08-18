#!/usr/bin/env bash
#
# Atualiza o Stabilize numa VPS já instalada.
#
# POR QUE ESTE ARQUIVO EXISTE, e não uma lista de comandos no README:
#
# A sequência tem um detalhe que o olho não pega e que já causou uma
# atualização silenciosamente pela metade:
#
#     docker compose build          # NÃO constrói a imagem de migration
#     docker compose --profile ferramentas build   # constrói
#
# O serviço `migrate` tem `profiles: [ferramentas]` para ficar fora do
# `docker compose up` — ele é ferramenta, não processo do sistema. Só que
# o `profiles` também o exclui do `build`. Sem a flag, o `run --rm
# migrate` sobe a imagem ANTIGA, com os arquivos SQL antigos, aplica as
# migrations que já estavam aplicadas e imprime "migrations aplicadas"
# com ar de sucesso — enquanto a API nova já está no ar esperando colunas
# que não existem.
#
# O sintoma é cruel: tudo verde, nada quebrado à vista, e o erro só
# aparece quando alguém abre a tela nova.
#
# Uma lista de comandos num README depende de quem copia não perder uma
# palavra. Um script não depende.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
RAIZ="$(pwd)"

azul()    { printf '\033[36m%s\033[0m\n' "$*"; }
verde()   { printf '\033[32m%s\033[0m\n' "$*"; }
amarelo() { printf '\033[33m%s\033[0m\n' "$*"; }
vermelho(){ printf '\033[31m%s\033[0m\n' "$*"; }

if [ ! -f .env ]; then
  vermelho "Não encontrei o .env em ${RAIZ}."
  vermelho "Este script roda dentro da pasta do sistema já instalado."
  exit 1
fi

# ---------------------------------------------------------------------
# 1. Backup, sempre, antes de qualquer coisa
#
# Não é opcional e não tem flag para pular: a etapa seguinte mexe na
# estrutura do banco, e a única defesa contra migration que dá errado é
# ter de onde voltar. O script de backup já confere o dump restaurando
# num banco descartável.
# ---------------------------------------------------------------------
azul "==> 1/5  backup antes de mexer no banco"
./deploy/backup.sh

# ---------------------------------------------------------------------
# 2. Código
# ---------------------------------------------------------------------
azul "==> 2/5  trazendo o código"
ramo="$(git rev-parse --abbrev-ref HEAD)"
git fetch origin "${ramo}"
antes="$(git rev-parse HEAD)"
git pull --ff-only origin "${ramo}"
depois="$(git rev-parse HEAD)"

if [ "${antes}" = "${depois}" ]; then
  amarelo "    já estava atualizado (${depois:0:7})"
else
  verde "    ${antes:0:7} → ${depois:0:7}"
fi

# ---------------------------------------------------------------------
# 3. Imagens — COM o perfil de ferramentas
#
# É esta linha que o README pedia e que se perde ao copiar à mão.
# ---------------------------------------------------------------------
azul "==> 3/5  construindo as imagens (inclusive a de migration)"
docker compose --profile ferramentas build

# ---------------------------------------------------------------------
# 4. Migrations, com conferência do que realmente rodou
#
# O `migrate.sh` imprime, no fim, quantos arquivos existem na imagem.
# Comparamos com o que existe no disco: se a imagem estiver velha, os
# números divergem e paramos ANTES de subir a API nova.
# ---------------------------------------------------------------------
azul "==> 4/5  aplicando migrations"
no_disco="$(find packages/db/sql -maxdepth 1 -name '[0-8]*.sql' | wc -l | tr -d ' ')"
saida="$(docker compose run --rm migrate 2>&1)"
echo "${saida}"

na_imagem="$(printf '%s' "${saida}" | sed -n 's/.*arquivos de migration: \([0-9]*\).*/\1/p' | tail -1)"

if [ -n "${na_imagem}" ] && [ "${na_imagem}" != "${no_disco}" ]; then
  vermelho ""
  vermelho "PAREI AQUI. A imagem de migration está desatualizada."
  vermelho "  no disco: ${no_disco} arquivos    na imagem: ${na_imagem}"
  vermelho ""
  vermelho "A API nova NÃO foi subida — o banco antigo continua servindo o"
  vermelho "sistema antigo, que é o estado seguro. Rode:"
  vermelho "  docker compose --profile ferramentas build --no-cache migrate"
  vermelho "e execute este script de novo."
  exit 1
fi

# ---------------------------------------------------------------------
# 5. Subir
# ---------------------------------------------------------------------
azul "==> 5/5  subindo"
docker compose up -d

printf 'esperando os serviços responderem'
for _ in $(seq 1 20); do
  if docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | grep -q '^api healthy'; then
    printf '\n'
    break
  fi
  printf '.'
  sleep 2
done
printf '\n'

echo
docker compose ps
echo

# ---------------------------------------------------------------------
# Conferência final
#
# O endereço sai do .env, e não escrito à mão: já aconteceu de eu conferir
# um domínio que não era o do cliente e reportar uma falha que não
# existia.
# ---------------------------------------------------------------------
dominio="$(grep -E '^ENDERECO_CADDY=' .env | cut -d= -f2- | tr -d '"' | sed 's|^https\?://||' | cut -d/ -f1)"
if [ -z "${dominio}" ] || [ "${dominio}" = ":80" ]; then
  dominio="$(grep -E '^CORS_ORIGINS=' .env | cut -d= -f2- | tr -d '"' | cut -d, -f1 | sed 's|^https\?://||')"
fi

if [ -n "${dominio}" ]; then
  codigo="$(curl -sS -o /dev/null -w '%{http_code}' "https://${dominio}/" || echo '000')"
  if [ "${codigo}" = "200" ]; then
    verde "==> https://${dominio} respondeu ${codigo}"
  else
    amarelo "==> https://${dominio} respondeu ${codigo} — confira o log: docker compose logs -f proxy api"
  fi
fi

echo
azul "==> os outros sistemas da VPS (nenhum deveria ter mudado)"
docker ps --format '{{.Names}}\t{{.Status}}' | sort | grep -v '^stabilize_sistema' || true

echo
verde "atualização concluída."
