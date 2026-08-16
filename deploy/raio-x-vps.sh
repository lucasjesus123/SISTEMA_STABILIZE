#!/usr/bin/env bash
#
# RAIO-X DA VPS — só leitura.
#
# Rode ANTES de instalar qualquer coisa numa VPS que já hospeda outros
# sistemas. Ele não instala, não para serviço, não apaga e não edita
# nada: só olha e descreve.
#
# A pergunta que ele responde, e que decide a instalação inteira:
# QUEM JÁ ESTÁ NAS PORTAS 80 E 443?
#
#   - ninguém        → o Stabilize pode ficar na borda e emitir o
#                      próprio certificado (modo BORDA)
#   - alguém já está → o Stabilize entra atrás desse proxy, publicando
#                      só no loopback (modo INTERNO)
#
# Instalar sem essa resposta é como o vizinho descobre que o site dele
# saiu do ar: no próximo reboot, quando dois serviços disputam a mesma
# porta e o Docker chega primeiro.
#
# Uso:  sudo bash raio-x-vps.sh
#
set -uo pipefail

titulo() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
nota()   { printf '   %s\n' "$1"; }

echo "======================================================================"
echo " RAIO-X DA VPS — $(date '+%d/%m/%Y %H:%M') — $(hostname)"
echo " Só leitura. Nada é instalado, parado ou alterado."
echo "======================================================================"

titulo "Sistema"
if [ -r /etc/os-release ]; then . /etc/os-release; nota "${PRETTY_NAME:-desconhecido}"; fi
nota "kernel   $(uname -r)"
nota "uptime   $(uptime -p 2>/dev/null || uptime)"
nota "CPU      $(nproc) núcleo(s)"
nota "memória  $(free -h 2>/dev/null | awk '/^Mem:/{print $2" total, "$7" disponível"}')"

titulo "Disco"
df -h / 2>/dev/null | sed "s/^/   /"

titulo "QUEM ESTÁ NAS PORTAS 80 E 443  <<< decide o modo de instalação"

# TRÊS CAMINHOS para a mesma pergunta, e não é excesso: esta é a única
# resposta que, se sair errada, derruba um sistema que não é o nosso.
# `ss` some em imagem enxuta, `netstat` saiu do net-tools padrão de várias
# distros — /proc/net/tcp existe em qualquer Linux e não depende de nada.
portas_ocupadas() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlpnH 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print "   " $4 "  " $6}'
    return
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -tlpn 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print "   " $4 "  " $7}'
    return
  fi
  # As portas em /proc/net/tcp são hexadecimais: 80 = 0050, 443 = 01BB.
  # st=0A é LISTEN.
  awk '$4 == "0A" {split($2, a, ":"); p = strtonum("0x" a[2]);
       if (p == 80 || p == 443) print "   porta " p " ocupada (via /proc/net/tcp)"}' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u
}

ocupadas=$(portas_ocupadas)
if [ -z "$ocupadas" ]; then
  nota "LIVRES — nada escutando em 80 nem 443."
  nota ""
  nota ">>> modo BORDA: o Stabilize pode ficar na frente e emitir TLS."
else
  echo "$ocupadas"
  nota ""
  nota ">>> modo INTERNO: já tem serviço nessas portas. O Stabilize"
  nota "    entra ATRÁS dele, publicando só em 127.0.0.1."
fi

titulo "Todas as portas escutando (para não escolher uma já usada)"
if command -v ss >/dev/null 2>&1; then
  ss -tulpnH 2>/dev/null | awk '{print $1, $5, $7}' | sort -u | sed 's/^/   /' | head -40
fi

titulo "Servidores web instalados no host (fora do Docker)"
for s in nginx apache2 httpd caddy traefik lighttpd; do
  if command -v "$s" >/dev/null 2>&1 || systemctl list-unit-files 2>/dev/null | grep -q "^${s}\."; then
    estado=$(systemctl is-active "$s" 2>/dev/null || echo "não-systemd")
    nota "$s — $estado"
  fi
done
nota "(vazio acima = nenhum servidor web no host)"

titulo "Docker"
if command -v docker >/dev/null 2>&1; then
  nota "$(docker --version)"
  nota "$(docker compose version 2>/dev/null || echo 'plugin compose AUSENTE — precisa instalar')"

  echo
  nota "Projetos compose já existentes (as 'gavetas' de hoje):"
  docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
    | grep -v '^$' | sort -u | sed 's/^/     · /' || true
  docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -qv '^$' \
    || nota "     (nenhum)"

  echo
  nota "Contêineres:"
  docker ps -a --format '     {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | head -30

  echo
  nota "Volumes (dados que NÃO podem ser apagados por engano):"
  docker volume ls --format '     {{.Name}}' 2>/dev/null | head -30

  echo
  nota "Espaço ocupado pelo Docker:"
  docker system df 2>/dev/null | sed 's/^/     /'
else
  nota "Docker NÃO instalado."
fi

titulo "Onde os sistemas moram hoje"
for d in /opt /srv /var/www /home; do
  [ -d "$d" ] || continue
  conteudo=$(ls -1 "$d" 2>/dev/null | head -15)
  [ -z "$conteudo" ] && continue
  nota "$d/"
  echo "$conteudo" | sed 's/^/     · /'
done

titulo "Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw status verbose 2>/dev/null | sed 's/^/   /'
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --list-all 2>/dev/null | sed 's/^/   /'
else
  nota "ufw/firewalld não instalados."
  nota "Regras iptables (contagem por cadeia):"
  iptables -S 2>/dev/null | wc -l | sed 's/^/     regras: /'
fi

titulo "Acesso SSH (o que mais importa depois das portas)"
if [ -r /etc/ssh/sshd_config ]; then
  grep -Ei '^\s*(PermitRootLogin|PasswordAuthentication|Port|PubkeyAuthentication)' \
    /etc/ssh/sshd_config 2>/dev/null | sed 's/^/   /' || nota "(usando os padrões)"
  nota ""
  nota "Chaves autorizadas para root: $(wc -l < /root/.ssh/authorized_keys 2>/dev/null || echo 0)"
fi

titulo "Atualizações de segurança pendentes"
if command -v apt-get >/dev/null 2>&1; then
  # `grep -c` imprime 0 e sai com 1 quando não acha; um `|| echo 0` aqui
  # concatenaria um segundo zero e o número sairia "0\n0".
  pend=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep -c '^Inst')
  nota "${pend:-0} pacote(s) a atualizar"
  seg=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst' | grep -ci security)
  nota "${seg:-0} deles são de SEGURANÇA"
fi

titulo "Tarefas agendadas (backup de outros sistemas mora aqui)"
crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' | sed 's/^/   /' || nota "(nenhuma no crontab do root)"
ls -1 /etc/cron.d 2>/dev/null | sed 's/^/   \/etc\/cron.d\/: /' | head -10

echo
echo "======================================================================"
echo " FIM. Nada foi alterado."
echo " Mande esta saída inteira para decidir o modo de instalação."
echo "======================================================================"
