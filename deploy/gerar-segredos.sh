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
    EXTRA_INTERNO=""
    RESUMO_REDE="modo BORDA — ocupa 80/443, emite TLS para $DOMINIO"
    ;;
  2)
    # Lista o que já está escutando: numa VPS com vários sistemas, a
    # 8080 costuma já ser de alguém, e escolher uma porta ocupada faz o
    # contêiner morrer com "address already in use" na subida.
    em_uso=""
    if command -v ss >/dev/null 2>&1; then
      em_uso=$(ss -tlnH 2>/dev/null | awk '{split($4,a,":"); print a[length(a)]}' | sort -un | tr '\n' ' ')
      echo
      echo "   Portas já escutando nesta VPS: $em_uso"
    fi

    echo
    echo "   >>> APERTE ENTER para usar a 8090. Esta pergunta é a PORTA,"
    echo "       não o modo — não repita o número que você respondeu antes."
    read -rp "Porta local para o proxy encaminhar (enter = 8090): " PORTA_LOCAL
    PORTA_LOCAL="${PORTA_LOCAL:-8090}"
    case "$PORTA_LOCAL" in
      ''|*[!0-9]*) echo "ERRO: '$PORTA_LOCAL' não é um número de porta."; exit 1 ;;
    esac

    # FAIXA, e não só "é número".
    #
    # Faltava esta checagem e o resultado apareceu no primeiro uso real:
    # a resposta anterior era "2" (o modo), a pessoa repetiu "2" aqui, e
    # o script aceitou — o sistema foi configurado na porta 2. Ela é
    # reservada a serviço de sistema; o Docker rodando como root até
    # conseguiria ocupá-la, e o erro só apareceria muito depois.
    # Validar "é dígito" nunca foi o mesmo que validar "é uma porta".
    if [ "$PORTA_LOCAL" -lt 1024 ] || [ "$PORTA_LOCAL" -gt 65534 ]; then
      echo "ERRO: porta $PORTA_LOCAL fora da faixa permitida (1024–65534)."
      if [ "$PORTA_LOCAL" -lt 1024 ]; then
        echo "       Abaixo de 1024 é território de serviço de sistema"
        echo "       (22 = SSH, 80 = HTTP, 443 = HTTPS...)."
      fi
      echo "       O limite é 65534 porque a porta seguinte também é usada."
      echo "       Sugestão: 8090."
      exit 1
    fi
    if [ -n "$em_uso" ]; then
      for p in $PORTA_LOCAL $((PORTA_LOCAL + 1)); do
        case " $em_uso " in
          *" $p "*)
            echo "ERRO: a porta $p já está em uso nesta VPS."
            echo "       Subir por cima dela quebraria o sistema que já está lá."
            echo "       Escolha outra (a 443 interna usa porta+1)."
            exit 1
            ;;
        esac
      done
    fi
    # NÃO pode ficar vazio: o Caddy recebe `email` sem argumento e falha
    # no parse. Aqui não há emissão de certificado (quem faz é o proxy da
    # frente), então o valor é um marcador explícito em domínio .invalid.
    EMAIL_TLS="tls-nao-usado-no-modo-interno@exemplo.invalid"
    # ':80' faz o Caddy servir HTTP puro. Pedir certificado sem a porta
    # 80 pública põe o ACME em laço de falha.
    ENDERECO_CADDY=":80"

    # O ENDEREÇO PELO QUAL UM CONTÊINER ENXERGA O HOST.
    #
    # Se o proxy da frente roda em contêiner — quase sempre roda — ele
    # NÃO alcança o Stabilize por 127.0.0.1: para ele, 127.0.0.1 é ele
    # mesmo. O gateway da bridge do Docker (docker0, normalmente
    # 172.17.0.1) é o caminho de volta para o host.
    # O `|| true` não é enfeite: com `set -e` e `pipefail`, uma máquina
    # sem o comando `ip` (ou sem docker0) faria o script MORRER EM
    # SILÊNCIO aqui, no meio da geração, sem escrever o .env e sem dizer
    # por quê. Aconteceu no primeiro teste.
    IP_BRIDGE=$(ip -4 addr show docker0 2>/dev/null \
                | awk '/inet /{split($2, a, "/"); print a[1]; exit}' || true)
    IP_BRIDGE="${IP_BRIDGE:-172.17.0.1}"
    echo "   Gateway da bridge (como um contêiner alcança o host): $IP_BRIDGE"

    # As portas do arquivo base não são usadas neste modo — quem manda é
    # o docker-compose.interno.yml, que publica em 127.0.0.1 E na bridge.
    PORTA_HTTP="127.0.0.1:${PORTA_LOCAL}"
    PORTA_HTTPS="127.0.0.1:$((PORTA_LOCAL + 1))"
    RESUMO_REDE="modo INTERNO — escuta em 127.0.0.1:${PORTA_LOCAL} e ${IP_BRIDGE}:${PORTA_LOCAL}; quem termina TLS é o seu proxy"

    # COMPOSE_FILE é lido pelo próprio docker compose a partir do .env.
    # É o que faz `docker compose up -d`, sem nenhum -f na linha de
    # comando, já subir no modo interno. Um comando esquecido aqui
    # publicaria o Stabilize na porta 80 da máquina.
    EXTRA_INTERNO="COMPOSE_FILE=docker-compose.yml:docker-compose.interno.yml
PORTA_LOCAL=${PORTA_LOCAL}
IP_BRIDGE=${IP_BRIDGE}"
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
${EXTRA_INTERNO}

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
  $DOMINIO para o Stabilize.

  QUAL ENDEREÇO USAR — e errar aqui é o engano mais comum:

    proxy no HOST (nginx instalado na máquina)  ->  127.0.0.1:${PORTA_LOCAL}
    proxy em CONTÊINER (Caddy/Traefik/nginx)    ->  ${IP_BRIDGE}:${PORTA_LOCAL}

  Para um contêiner, 127.0.0.1 é ELE MESMO, não o host: com esse
  endereço o proxy procuraria a porta dentro de si e daria 502.

  nginx (no host):
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
