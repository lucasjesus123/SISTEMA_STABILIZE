#!/usr/bin/env bash
#
# =====================================================================
# ARRUMAR A VPS — por padrão, só OLHA e PROPÕE.
#
# Numa VPS com vários sistemas, "limpar" é a operação mais perigosa que
# existe, porque as ferramentas de limpeza do Docker não sabem de quem é
# cada coisa. Em especial:
#
#   `docker system prune -a --volumes`  APAGA O BANCO DE DADOS de
#   qualquer sistema que esteja parado naquele momento. Um volume de um
#   contêiner desligado é indistinguível de lixo para o prune. Já
#   destruiu produção de muita gente, e o comando não pergunta duas
#   vezes.
#
# Por isso este script tem dois níveis:
#
#   (padrão)         diagnostica e escreve o que PODERIA ser feito.
#                    Não apaga nada.
#
#   --limpar-seguro  apaga só o que não pode pertencer a ninguém:
#                    imagens órfãs (dangling) e cache de build.
#                    NUNCA volumes. NUNCA contêineres de outros.
#
# O que ele nunca faz, em nenhum nível: mexer em firewall, sshd,
# serviços do host, ou em qualquer coisa de outro sistema.
#
# Uso:
#     sudo bash arrumar-vps.sh
#     sudo bash arrumar-vps.sh --limpar-seguro
# =====================================================================
set -uo pipefail

LIMPAR=0
[ "${1:-}" = "--limpar-seguro" ] && LIMPAR=1

titulo() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
nota()   { printf '   %s\n' "$1"; }
alerta() { printf '\033[33m   ! %s\033[0m\n' "$1"; }
acao()   { printf '\033[36m   > %s\033[0m\n' "$1"; }

echo "======================================================================"
if [ "$LIMPAR" -eq 1 ]; then
  echo " ARRUMAÇÃO — modo LIMPAR (só imagens órfãs e cache de build)"
else
  echo " ARRUMAÇÃO — modo DIAGNÓSTICO (nada é apagado)"
fi
echo "======================================================================"

# ---------------------------------------------------------------------
titulo "Disco"
uso=$(df -h / | awk 'NR==2{print $5}' | tr -d '%')
df -h / | sed 's/^/   /'
if [ "${uso:-0}" -ge 85 ]; then
  alerta "Disco em ${uso}%. Acima de 90% o PostgreSQL para de aceitar escrita."
elif [ "${uso:-0}" -ge 70 ]; then
  alerta "Disco em ${uso}%. Vale acompanhar."
fi

titulo "Maiores consumidores de disco"
du -xh --max-depth=2 /var /opt 2>/dev/null | sort -rh | head -12 | sed 's/^/   /'

# ---------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  titulo "Docker"
  nota "não instalado — nada a arrumar aqui."
  exit 0
fi

titulo "Como o Docker está gastando espaço"
docker system df 2>/dev/null | sed 's/^/   /'

titulo "Gavetas (projetos compose) nesta VPS"
docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
  | grep -v '^$' | sort | uniq -c | sed 's/^/   /' || nota "(nenhuma)"

titulo "Contêineres parados"
parados=$(docker ps -a --filter status=exited --format '{{.Names}}  ({{.Status}})' 2>/dev/null)
if [ -z "$parados" ]; then
  nota "nenhum"
else
  echo "$parados" | sed 's/^/   /'
  alerta "NÃO remova sem saber de quem são: um contêiner parado pode ser"
  alerta "um sistema desligado de propósito, e o volume dele vem junto"
  alerta "num prune com --volumes."
fi

titulo "Imagens órfãs (dangling) — estas são lixo de verdade"
orfas=$(docker images -f dangling=true -q 2>/dev/null | wc -l)
nota "$orfas imagem(ns) sem tag e sem uso"

titulo "Volumes"
docker volume ls --format '   {{.Name}}' 2>/dev/null | head -30
alerta "Volume é DADO. Nenhum é apagado por este script, em nenhum modo."

# ---------------------------------------------------------------------
titulo "Rotação de log do Docker"
if [ -f /etc/docker/daemon.json ] && grep -q 'max-size' /etc/docker/daemon.json 2>/dev/null; then
  nota "já configurada:"
  sed 's/^/     /' /etc/docker/daemon.json
else
  alerta "SEM LIMITE. Este é o motivo mais comum de VPS com disco cheio:"
  alerta "o log JSON de um contêiner cresce sem teto até parar a máquina."
  echo
  acao "Isto afeta TODOS os sistemas da VPS, então não é aplicado"
  acao "automaticamente. Se quiser, rode você:"
  cat <<'SUGESTAO'

     cat > /etc/docker/daemon.json <<'JSON'
     {
       "log-driver": "json-file",
       "log-opts": { "max-size": "10m", "max-file": "3" }
     }
     JSON
     systemctl restart docker     # reinicia os contêineres de TODOS

SUGESTAO
fi

# ---------------------------------------------------------------------
titulo "Atualizações de segurança do sistema"
if command -v apt-get >/dev/null 2>&1; then
  # Sem `|| echo 0`: `grep -c` já imprime 0 quando não acha, MAS sai com
  # código 1 — o `||` disparava e concatenava um segundo zero, virando
  # "0\n0", que quebrava a comparação numérica logo abaixo.
  seg=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst' | grep -ci security)
  seg=${seg:-0}
  nota "$seg pacote(s) de segurança pendente(s)"
  [ "${seg:-0}" -gt 0 ] && acao "aplicar com: apt-get update && apt-get upgrade -y"
  if ! dpkg -l unattended-upgrades 2>/dev/null | grep -q '^ii'; then
    acao "considere: apt-get install -y unattended-upgrades"
  fi
fi

# ---------------------------------------------------------------------
if [ "$LIMPAR" -eq 1 ]; then
  titulo "LIMPANDO (só o que não pertence a ninguém)"

  echo "   imagens órfãs:"
  docker image prune -f 2>/dev/null | sed 's/^/     /'

  echo "   cache de build com mais de 7 dias:"
  # `until=168h` protege o cache das builds recentes dos outros sistemas:
  # apagá-lo não perde dado, mas faz o próximo deploy deles demorar.
  docker builder prune -f --filter until=168h 2>/dev/null | sed 's/^/     /'

  echo
  nota "Depois da limpeza:"
  docker system df 2>/dev/null | sed 's/^/     /'

  echo
  alerta "Volumes e contêineres de outros sistemas: intocados, de propósito."
else
  titulo "O que este script FARIA com --limpar-seguro"
  nota "· remover $orfas imagem(ns) órfã(s)"
  nota "· remover cache de build com mais de 7 dias"
  nota "· e MAIS NADA — nenhum volume, nenhum contêiner de outro sistema"
  echo
  acao "sudo bash arrumar-vps.sh --limpar-seguro"
fi

echo
echo "======================================================================"
echo " Fim."
echo "======================================================================"
