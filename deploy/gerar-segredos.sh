#!/usr/bin/env bash
#
# Gera o .env de produção com segredos aleatórios.
#
# POR QUE UM SCRIPT E NÃO UM ARQUIVO DE EXEMPLO PARA COPIAR: porque
# arquivo de exemplo é copiado com os valores de exemplo dentro. Já
# aconteceu com todo mundo. Aqui não há valor a copiar — só saída de
# `openssl rand`.
#
# Rode UMA vez, na VPS. O arquivo gerado nunca entra no repositório.
set -euo pipefail

DESTINO="${1:-.env}"

if [ -e "$DESTINO" ]; then
  echo "ERRO: $DESTINO já existe."
  echo "Sobrescrever trocaria os segredos e derrubaria todas as sessões"
  echo "e o acesso ao banco. Se é isso mesmo, mova o atual antes."
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERRO: openssl não encontrado — ele é quem gera os segredos."
  exit 1
fi

read -rp "Domínio (ex.: sistema.stabilize.com.br): " DOMINIO
read -rp "E-mail para avisos de certificado: " EMAIL_TLS

[ -n "$DOMINIO" ] || { echo "ERRO: domínio é obrigatório."; exit 1; }
[ -n "$EMAIL_TLS" ] || { echo "ERRO: e-mail é obrigatório."; exit 1; }

# `openssl rand -base64` pode conter '/', '+' e '=' — inofensivos como
# segredo, mas '/' e '@' quebram a URL de conexão do Postgres. Para as
# SENHAS DE BANCO usamos hex, que é seguro em qualquer posição da URL.
senha_banco() { openssl rand -hex 24; }
segredo()     { openssl rand -base64 48 | tr -d '\n'; }

PG_SUPER=$(senha_banco)
PG_APP=$(senha_banco)
PG_MIG=$(senha_banco)

umask 077   # o arquivo nasce 600, antes de ter conteúdo dentro
cat > "$DESTINO" <<EOF
# Gerado por deploy/gerar-segredos.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ)
# NUNCA versione este arquivo.

DOMINIO=$DOMINIO
EMAIL_TLS=$EMAIL_TLS
CORS_ORIGINS=https://$DOMINIO

POSTGRES_DB=stabilize
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=$PG_SUPER

# Papéis da aplicação. O 002_roles.sql se recusa a rodar sem estes.
STABILIZE_APP_PASSWORD=$PG_APP
STABILIZE_MIGRATOR_PASSWORD=$PG_MIG

# Runtime da API: papel sem DDL e sem BYPASSRLS.
DATABASE_URL=postgresql://stabilize_app:$PG_APP@postgres:5432/stabilize
# Migrations: papel dono do schema. Não é usado em runtime.
DATABASE_MIGRATION_URL=postgresql://stabilize_migrator:$PG_MIG@postgres:5432/stabilize

JWT_ACCESS_SECRET=$(segredo)
JWT_REFRESH_SECRET=$(segredo)
ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')

LOG_LEVEL=info

# WhatsApp (uazapi). Opcional: o sistema opera sem.
UAZAPI_BASE_URL=
UAZAPI_ADMIN_TOKEN=
EOF

chmod 600 "$DESTINO"

echo
echo "$DESTINO criado (permissão 600)."
echo
echo "GUARDE UMA CÓPIA FORA DA VPS, num gerenciador de senhas."
echo "Perder este arquivo com o disco significa perder o acesso ao"
echo "banco: as senhas não estão em lugar nenhum além dele."
