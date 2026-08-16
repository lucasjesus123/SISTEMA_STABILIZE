#!/usr/bin/env bash
#
# =====================================================================
# INSTALAÇÃO DO STABILIZE NUMA VPS COMPARTILHADA
#
# Este script instala o sistema DENTRO DE UMA GAVETA e não encosta em
# nada que já esteja na máquina. O que ele garante, explicitamente:
#
#   · escreve em UM diretório só: /opt/STABILIZE_SISTEMA
#   · todo contêiner, volume e rede nasce com o prefixo
#     `stabilize_sistema` (é o `name:` do compose)
#   · NÃO instala nginx, NÃO mexe em firewall, NÃO altera sshd,
#     NÃO para serviço de ninguém, NÃO apaga imagem ou volume alheio
#   · se as portas 80/443 já estiverem ocupadas, ele NÃO as disputa —
#     entra em modo interno, no loopback
#
# É reexecutável: rodar de novo atualiza o código e sobe de novo, sem
# recriar segredos nem tocar nos dados.
#
# Uso:
#     sudo bash instalar.sh
#     sudo bash instalar.sh --atualizar    # só puxa código novo e sobe
# =====================================================================
set -euo pipefail

# A VPS já tem uma convenção: as gavetas moram em /opt/gavetas/ (é onde
# está a MINHAMECANICA, conforme o cron de backup dela). Seguir o padrão
# da casa vale mais do que impor o meu.
GAVETA="/opt/gavetas/STABILIZE_SISTEMA"
REPO="https://github.com/lucasjesus123/SISTEMA_STABILIZE.git"
RAMO="claude/stabilize-academia-management-xodct5"
PROJETO="stabilize_sistema"

APENAS_ATUALIZAR=0
[ "${1:-}" = "--atualizar" ] && APENAS_ATUALIZAR=1

vermelho() { printf '\033[31m%s\033[0m\n' "$1"; }
verde()    { printf '\033[32m%s\033[0m\n' "$1"; }
passo()    { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
erro()     { vermelho "ERRO: $1"; exit 1; }

[ "$(id -u)" -eq 0 ] || erro "rode com sudo."

echo "======================================================================"
echo " STABILIZE — instalação na gaveta $GAVETA"
echo " Nada fora desta gaveta é alterado."
echo "======================================================================"

# ---------------------------------------------------------------------
passo "1/8  Conferindo o que já existe (sem alterar nada)"

command -v git >/dev/null 2>&1 || erro "git não instalado. Rode: apt-get install -y git"

if ! command -v docker >/dev/null 2>&1; then
  erro "Docker não instalado.
       Instale com o script oficial e rode este de novo:
         curl -fsSL https://get.docker.com | sh"
fi
docker compose version >/dev/null 2>&1 || erro "plugin 'docker compose' ausente (v2+ necessário)."
verde "   docker: $(docker --version)"
verde "   compose: $(docker compose version --short 2>/dev/null)"

# As gavetas que já existem. Só para registro — nenhuma é tocada.
outras=$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
         | grep -v '^$' | grep -v "^${PROJETO}$" | sort -u || true)
if [ -n "$outras" ]; then
  echo "   Outros sistemas nesta VPS (NÃO serão tocados):"
  echo "$outras" | sed 's/^/     · /'
fi

# ---------------------------------------------------------------------
passo "2/8  Preparando a gaveta"

mkdir -p "$GAVETA"
cd "$GAVETA"

if [ -d "$GAVETA/.git" ]; then
  echo "   Gaveta já existe — atualizando o código."
  git -C "$GAVETA" fetch origin "$RAMO" --depth 1
  git -C "$GAVETA" checkout -B "$RAMO" "origin/$RAMO"
else
  echo "   Clonando o repositório."
  # --depth 1: a VPS não precisa do histórico, só do estado atual.
  git clone --depth 1 --branch "$RAMO" "$REPO" "$GAVETA" 2>/dev/null || erro \
    "não consegui clonar $REPO.
       Se o repositório for PRIVADO, use um token de leitura:
         git clone --depth 1 --branch $RAMO \\
           https://SEU_TOKEN@github.com/lucasjesus123/SISTEMA_STABILIZE.git $GAVETA
       e depois rode este script de novo."
fi
verde "   commit: $(git -C "$GAVETA" rev-parse --short HEAD)"

# ---------------------------------------------------------------------
passo "3/8  Segredos"

if [ -f "$GAVETA/.env" ]; then
  verde "   .env já existe — mantido. (Regerar trocaria as senhas do banco.)"
else
  [ "$APENAS_ATUALIZAR" -eq 1 ] && erro "--atualizar exige um .env já existente."
  echo "   Gerando. Ele vai perguntar o domínio e o modo de rede."
  echo
  bash "$GAVETA/deploy/gerar-segredos.sh" "$GAVETA/.env"
fi
chmod 600 "$GAVETA/.env"

# Lê só o que este script precisa; não exporta segredo para o ambiente.
DOMINIO=$(grep -E '^DOMINIO=' "$GAVETA/.env" | cut -d= -f2-)
PORTA_HTTP=$(grep -E '^PORTA_HTTP=' "$GAVETA/.env" | cut -d= -f2-)

# ---------------------------------------------------------------------
passo "4/8  Construindo as imagens"
echo "   (a primeira vez demora: compila a API e o front)"
docker compose --profile ferramentas build

# ---------------------------------------------------------------------
passo "5/8  Subindo o banco"
docker compose up -d postgres

echo -n "   esperando ficar saudável"
for _ in $(seq 1 60); do
  estado=$(docker compose ps --format '{{.Health}}' postgres 2>/dev/null | head -1)
  [ "$estado" = "healthy" ] && break
  echo -n "."
  sleep 2
done
echo
[ "$estado" = "healthy" ] || erro "o banco não ficou saudável. Veja: docker compose logs postgres"
verde "   banco saudável"

# ---------------------------------------------------------------------
passo "6/8  Migrations"
# Idempotentes (IF NOT EXISTS): reexecutar é seguro.
docker compose run --rm migrate
verde "   schema aplicado"

# ---------------------------------------------------------------------
passo "7/8  Subindo API e proxy"
docker compose up -d
sleep 6
docker compose ps

# ---------------------------------------------------------------------
passo "8/8  Conferindo de fora"

alvo="${PORTA_HTTP:-80}"
case "$alvo" in
  *:*) alvo_url="http://${alvo}" ;;
  *)   alvo_url="http://127.0.0.1:${alvo}" ;;
esac

if curl -fsS --max-time 10 "${alvo_url}/health" >/dev/null 2>&1; then
  verde "   /health respondeu em ${alvo_url}"
else
  vermelho "   /health não respondeu em ${alvo_url}"
  echo "   Isto não é necessariamente falha: no modo borda o Caddy só"
  echo "   responde pelo domínio. Confira com:"
  echo "     docker compose logs --tail 40 api"
  echo "     docker compose logs --tail 40 proxy"
fi

cat <<FIM

======================================================================
 INSTALADO NA GAVETA: $GAVETA
 Projeto Docker (prefixo de tudo): $PROJETO
======================================================================

 Comandos, sempre a partir de $GAVETA:

   docker compose ps                  estado
   docker compose logs -f api         log da API
   docker compose down                para SÓ este sistema
   sudo bash deploy/instalar.sh --atualizar    publica versão nova

 FALTA VOCÊ FAZER, e nesta ordem:

 1. Apontar o DNS de $DOMINIO para o IP desta VPS.
    Sem isso o certificado não sai (no modo borda) e ninguém acessa.

 2. Criar a primeira academia e o primeiro usuário — a seção
    "Criar a primeira academia" do DEPLOY.md.

 3. TESTAR O RESTORE AGORA, com o sistema recém-instalado:
       sudo bash deploy/backup.sh
       sudo bash deploy/restaurar.sh /var/backups/stabilize/<arquivo>.dump
    Quem restaura pela primeira vez às três da manhã descobre os
    problemas às três da manhã.

 4. Guardar uma cópia de $GAVETA/.env FORA da VPS.
    As senhas do banco não existem em nenhum outro lugar.

FIM
