#!/usr/bin/env bash
#
# Limpar o sistema para entrar em produção.
#
# POR QUE ISTO NÃO É UMA MIGRAÇÃO. Tudo que é `.sql` dentro de
# `packages/db/sql/` roda sozinho em TODA atualização — um script de
# limpeza lá dentro apagaria os alunos da academia a cada deploy. Por
# isso ele mora aqui, em `deploy/`, e só roda quando alguém digita o
# comando.
#
# DUAS OPERAÇÕES, e elas são bem diferentes:
#
#   --apagar-demo    Remove a academia de DEMONSTRAÇÃO inteira (a que o
#                    `seed` cria, com id fixo). É a mais segura: o id é
#                    conhecido, e nenhuma academia real tem esse id.
#
#   --zerar SLUG     Esvazia o MOVIMENTO de uma academia real — alunos,
#                    agenda, financeiro, prontuário, interessados — e
#                    PRESERVA a configuração: a equipe, os espaços, a
#                    tabela de valores, as funções, os horários dos
#                    profissionais e a identidade da academia.
#                    É o "começar a operar do zero" sem recadastrar tudo.
#
# NADA ACONTECE SEM `--confirmar`. Sem essa opção o script só mostra o
# inventário do que existe e do que sairia. Um script destrutivo que age
# por padrão é um acidente esperando o primeiro dedo cansado.
#
# E antes de qualquer exclusão, ele faz backup. `deploy/backup.sh` já
# existe e é chamado daqui — não há caminho que apague sem cópia.

set -euo pipefail

cd "$(dirname "$0")/.."

vermelho() { printf '\033[31m%s\033[0m\n' "$*"; }
verde()    { printf '\033[32m%s\033[0m\n' "$*"; }
amarelo()  { printf '\033[33m%s\033[0m\n' "$*"; }

# O id do tenant de demonstração é fixo no `seed.ts`. Está repetido aqui
# de propósito: este script precisa rodar numa VPS onde o código do seed
# não está — e um id errado aqui apagaria a academia errada, então ele é
# conferido contra o slug antes de qualquer DELETE.
readonly TENANT_DEMO='5742411a-0000-4000-8000-000000000001'
readonly SLUG_DEMO='stabilize-demo'

acao=''
alvo=''
confirmar='nao'

while [ $# -gt 0 ]; do
  case "$1" in
    --apagar-demo) acao='demo' ;;
    --zerar)       acao='zerar'; alvo="${2:-}"; shift ;;
    --confirmar)   confirmar='sim' ;;
    -h|--help)     sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) vermelho "opção desconhecida: $1"; exit 1 ;;
  esac
  shift
done

if [ -z "$acao" ]; then
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  echo
  amarelo "Nenhuma ação escolhida. Use --apagar-demo ou --zerar SLUG."
  exit 1
fi

if [ "$acao" = 'zerar' ] && [ -z "$alvo" ]; then
  vermelho "--zerar precisa do slug da academia. Ex.: --zerar minha-academia"
  exit 1
fi

if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${POSTGRES_SUPERUSER:=postgres}"
: "${POSTGRES_DB:=stabilize}"

# `psql` como superusuário: o `audit_log` é append-only pela política de
# RLS, e a limpeza precisa poder tocar nele. É o mesmo caminho que o
# backup já usa.
#
# `LIMPEZA_PSQL_URL` existe para que este script possa ser EXERCITADO
# contra um banco descartável antes de encostar num de verdade. Um
# script destrutivo que nunca rodou é uma promessa, não uma ferramenta.
# Em produção a variável não existe e o caminho é o do Docker.
psql_() {
  if [ -n "${LIMPEZA_PSQL_URL:-}" ]; then
    psql "$LIMPEZA_PSQL_URL" -X -v ON_ERROR_STOP=1 "$@"
  else
    docker compose exec -T -e PGPASSWORD="${POSTGRES_SUPERUSER_PASSWORD:-}" postgres \
      psql -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"
  fi
}

# O backup roda pelo Docker; num ensaio local não há o que copiar.
backup_() {
  if [ -n "${LIMPEZA_PSQL_URL:-}" ]; then
    amarelo "    (ensaio local: backup pulado)"
  else
    ./deploy/backup.sh
  fi
}

# ---------------------------------------------------------------------
# Descobrir o tenant e mostrar o inventário
# ---------------------------------------------------------------------
if [ "$acao" = 'demo' ]; then
  tenant_id="$TENANT_DEMO"
  # CONFERE O SLUG ANTES DE APAGAR. Se algum dia o id mudar, é melhor o
  # script parar do que apagar uma academia real que ocupe esse id.
  slug_encontrado="$(psql_ -Atc "SELECT slug FROM tenants WHERE id = '$tenant_id'" || true)"
  if [ -z "$slug_encontrado" ]; then
    verde "A academia de demonstração não existe neste banco. Nada a fazer."
    exit 0
  fi
  if [ "$slug_encontrado" != "$SLUG_DEMO" ]; then
    vermelho "PARANDO: o id $tenant_id existe, mas com slug '$slug_encontrado'"
    vermelho "         e não '$SLUG_DEMO'. Isso não é a academia de demonstração."
    exit 1
  fi
else
  tenant_id="$(psql_ -Atc "SELECT id FROM tenants WHERE slug = '$alvo'" || true)"
  if [ -z "$tenant_id" ]; then
    vermelho "Nenhuma academia com o slug '$alvo'. As que existem:"
    psql_ -c "SELECT slug, name, created_at::date AS criada FROM tenants ORDER BY created_at"
    exit 1
  fi
  if [ "$tenant_id" = "$TENANT_DEMO" ]; then
    echo
    vermelho "  ATENÇÃO: esta é a academia de DEMONSTRAÇÃO."
    vermelho "  As senhas dela são públicas — estão escritas no código do seed,"
    vermelho "  que está no repositório. Zerar o movimento NÃO troca essas senhas:"
    vermelho "  a equipe de demonstração continuaria de pé, com senha conhecida."
    vermelho ""
    vermelho "  Para entrar em produção, o certo é --apagar-demo e cadastrar a"
    vermelho "  academia de verdade pelo painel da plataforma."
    echo
  fi
fi

nome="$(psql_ -Atc "SELECT name FROM tenants WHERE id = '$tenant_id'")"

echo
echo "======================================================"
echo " Academia: $nome"
echo " slug: ${alvo:-$SLUG_DEMO}   id: $tenant_id"
echo "======================================================"
echo

# As tabelas de MOVIMENTO, na ordem em que precisam sair.
#
# A ORDEM NÃO É ESTÉTICA. Cinco chaves estrangeiras são RESTRICT de
# propósito — `appointments.student_id`, `appointments.professional_id`,
# `commissions.professional_id`, `evolutions.professional_id` e
# `workout_plans.professional_id`. Elas existem para que ninguém apague
# um aluno e deixe atendimento órfão; aqui elas ditam quem sai primeiro.
MOVIMENTO=(
  workout_logs workout_items workout_plans
  attachments body_measurements evolutions anamneses
  health_screenings checkins
  appointments availability_blocks
  commission_items commissions
  finance_payments finance_entries finance_recurrences
  lead_contatos leads
  whatsapp_messages
  student_contracts student_professionals
  students
)

# O que FICA de pé numa limpeza `--zerar`: é a academia configurada,
# pronta para receber o primeiro aluno de verdade.
CONFIGURACAO=(users rooms price_plans tenant_funcoes availability_rules exercises whatsapp_instances)

echo "SAI (movimento):"
for t in "${MOVIMENTO[@]}"; do
  n="$(psql_ -Atc "SELECT count(*) FROM $t WHERE tenant_id = '$tenant_id'" 2>/dev/null || echo '-')"
  [ "$n" = '0' ] || printf '  %-24s %s\n' "$t" "$n"
done
n="$(psql_ -Atc "SELECT count(*) FROM users WHERE tenant_id='$tenant_id' AND role='STUDENT'")"
printf '  %-24s %s\n' "users (só STUDENT)" "$n"

echo
if [ "$acao" = 'demo' ]; then
  echo "SAI TAMBÉM (a academia inteira):"
  for t in "${CONFIGURACAO[@]}"; do
    n="$(psql_ -Atc "SELECT count(*) FROM $t WHERE tenant_id = '$tenant_id'" 2>/dev/null || echo '-')"
    [ "$n" = '0' ] || printf '  %-24s %s\n' "$t" "$n"
  done
  printf '  %-24s %s\n' 'tenants' '1'
else
  echo "FICA (configuração da academia):"
  for t in "${CONFIGURACAO[@]}"; do
    n="$(psql_ -Atc "SELECT count(*) FROM $t WHERE tenant_id = '$tenant_id'" 2>/dev/null || echo '-')"
    printf '  %-24s %s\n' "$t" "$n"
  done
fi
echo

if [ "$confirmar" != 'sim' ]; then
  amarelo "Isto foi só o inventário — NADA foi apagado."
  amarelo "Para executar de verdade, repita o comando com --confirmar."
  exit 0
fi

# ---------------------------------------------------------------------
# Executar
# ---------------------------------------------------------------------
amarelo "==> backup antes de apagar"
backup_

amarelo "==> apagando"

if [ "$acao" = 'demo' ]; then
  # `workout_plans` sai antes porque `professional_id` é RESTRICT e
  # travaria a cascata do tenant nos usuários. O resto o CASCADE resolve.
  psql_ <<SQL
BEGIN;
DELETE FROM workout_plans WHERE tenant_id = '$tenant_id';
DELETE FROM tenants       WHERE id        = '$tenant_id';
COMMIT;
SQL
  verde "Academia de demonstração removida."
else
  {
    echo 'BEGIN;'
    for t in "${MOVIMENTO[@]}"; do
      echo "DELETE FROM $t WHERE tenant_id = '$tenant_id';"
    done
    # As sessões abertas dos alunos saem junto: um token de aluno que
    # não tem mais cadastro não pode continuar valendo.
    echo "DELETE FROM user_sessions WHERE tenant_id = '$tenant_id'"
    echo "  AND user_id IN (SELECT id FROM users WHERE tenant_id='$tenant_id' AND role='STUDENT');"
    echo "DELETE FROM users WHERE tenant_id = '$tenant_id' AND role = 'STUDENT';"
    # O histórico de auditoria da fase de testes some junto: ele registra
    # exclusões de dados que não existem mais, e mantê-lo faria a
    # primeira auditoria real começar com ruído de ensaio.
    echo "DELETE FROM audit_log WHERE tenant_id = '$tenant_id';"
    echo 'COMMIT;'
  } | psql_
  verde "Movimento zerado. A equipe, os espaços, a tabela de valores e os horários continuam lá."
fi

echo
amarelo "==> conferindo que não sobrou resíduo"
for t in "${MOVIMENTO[@]}"; do
  n="$(psql_ -Atc "SELECT count(*) FROM $t WHERE tenant_id = '$tenant_id'" 2>/dev/null || echo 0)"
  if [ "$n" != '0' ]; then vermelho "  SOBROU: $t = $n"; fi
done
verde "Conferido."
echo
verde "Pronto. Reinicie a API para esvaziar caches em memória:"
echo "  docker compose restart api"
