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
[ -n "$DOMINIO" ] || { echo "ERRO: domínio é obrigatório."; exit 1; }

# ---------------------------------------------------------------------
# MODO DE REDE — a pergunta que evita derrubar os outros sistemas da VPS.
#
# Fixar as portas 80/443 significa tomá-las da máquina inteira. Numa VPS
# que hospeda mais coisas, ou este sistema não sobe, ou sobe e derruba o
# vizinho no próximo reboot.
#
# O padrão sugerido vem do que está escutando AGORA, e não de um chute.
# ---------------------------------------------------------------------
ocupadas=""
if command -v ss >/dev/null 2>&1; then
  ocupadas=$(ss -tlpnH 2>/dev/null | awk '$4 ~ /:(80|443)$/')
elif command -v netstat >/dev/null 2>&1; then
  ocupadas=$(netstat -tlpn 2>/dev/null | awk '$4 ~ /:(80|443)$/')
fi

echo
if [ -n "$ocupadas" ]; then
  echo "Detectado: JÁ EXISTE serviço nas portas 80/443 desta VPS."
  echo "$ocupadas" | sed 's/^/   /'
  echo "Sugestão: modo INTERNO (2)."
  PADRAO=2
else
  echo "Detectado: portas 80 e 443 LIVRES."
  echo "Sugestão: modo BORDA (1)."
  PADRAO=1
fi

cat <<'EXPLICACAO'

  1) BORDA    — o Stabilize ocupa 80/443 e emite o próprio certificado.
                Use quando nenhum outro site mora nesta VPS.

  2) INTERNO  — o Stabilize publica só em 127.0.0.1, numa porta alta, e
                o proxy que você já tem encaminha para ele. Nada nosso
                aparece direto na internet, e as portas 80/443 continuam
                de quem já estava lá.

EXPLICACAO

read -rp "Modo [1/2] (enter = $PADRAO): " MODO
MODO="${MODO:-$PADRAO}"

case "$MODO" in
  1)
    read -rp "E-mail para avisos de certificado: " EMAIL_TLS
    [ -n "$EMAIL_TLS" ] || { echo "ERRO: no modo borda o e-mail é obrigatório."; exit 1; }
    ENDERECO_CADDY="$DOMINIO"
    PORTA_HTTP=80
    PORTA_HTTPS=443
    RESUMO_REDE="modo BORDA — ocupa 80/443, emite TLS para $DOMINIO"
    ;;
  2)
    read -rp "Porta local para o proxy encaminhar (enter = 8080): " PORTA_LOCAL
    PORTA_LOCAL="${PORTA_LOCAL:-8080}"
    case "$PORTA_LOCAL" in
      ''|*[!0-9]*) echo "ERRO: porta inválida."; exit 1 ;;
    esac
    EMAIL_TLS=""
    # ':80' faz o Caddy servir HTTP puro. Pedir certificado sem a porta
    # 80 pública põe o ACME em laço de falha.
    ENDERECO_CADDY=":80"
    # Só no loopback: mesmo que o firewall falhe, não há como chegar
    # nesta porta de fora da máquina.
    PORTA_HTTP="127.0.0.1:${PORTA_LOCAL}"
    # A 443 não é usada neste modo; fica no loopback numa porta alta só
    # para o compose ter um mapeamento válido.
    PORTA_HTTPS="127.0.0.1:$((PORTA_LOCAL + 1))"
    RESUMO_REDE="modo INTERNO — escuta em 127.0.0.1:${PORTA_LOCAL}; quem termina TLS é o seu proxy"
    ;;
  *)
    echo "ERRO: escolha 1 ou 2."
    exit 1
    ;;
esac

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

# Rede: $RESUMO_REDE
DOMINIO=$DOMINIO
ENDERECO_CADDY=$ENDERECO_CADDY
EMAIL_TLS=$EMAIL_TLS
PORTA_HTTP=$PORTA_HTTP
PORTA_HTTPS=$PORTA_HTTPS

# Origem permitida no CORS. É sempre o endereço PÚBLICO pelo qual o
# navegador chega — no modo interno, quem responde nele é o seu proxy,
# não este contêiner, mas o cabeçalho Origin que chega aqui é o mesmo.
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
echo "Rede: $RESUMO_REDE"
if [ "$MODO" = "2" ]; then
  cat <<AVISO

  FALTA UM PASSO, e ele é no SEU proxy, não aqui: encaminhar
  $DOMINIO para http://127.0.0.1:${PORTA_LOCAL}.

  nginx:
      server {
          server_name $DOMINIO;
          location / {
              proxy_pass http://127.0.0.1:${PORTA_LOCAL};
              proxy_set_header Host              \$host;
              proxy_set_header X-Real-IP         \$remote_addr;
              # SUBSTITUI, não acrescenta: assim o cliente não consegue
              # forjar o próprio IP e escapar do limite de tentativas de
              # login. A API confia em um salto só.
              proxy_set_header X-Forwarded-For   \$remote_addr;
              proxy_set_header X-Forwarded-Proto \$scheme;
          }
      }

  Caddy:
      $DOMINIO {
          reverse_proxy 127.0.0.1:${PORTA_LOCAL} {
              header_up X-Forwarded-For {remote_host}
          }
      }
AVISO
fi
echo
echo "GUARDE UMA CÓPIA FORA DA VPS, num gerenciador de senhas."
echo "Perder este arquivo com o disco significa perder o acesso ao"
echo "banco: as senhas não estão em lugar nenhum além dele."
