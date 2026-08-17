# =====================================================================
# As imagens do Stabilize — API, front e migrations.
#
# Quatro estágios, e a divisão é por SUPERFÍCIE antes de tamanho: a
# imagem da API não tem compilador C++, nem toolchain de build, nem o
# código do front, nem cliente de banco. O que não está instalado não
# pode ser usado por quem consegue execução dentro do contêiner.
#
#   build     compila tudo (é jogado fora)
#   seed      build + tsx             → popula dados de demonstração
#   podado    build sem as ferramentas de desenvolvimento
#   migrate   psql + os .sql          → roda uma vez e sai
#   web       Caddy + o front pronto  → o proxy
#   runtime   só a API                → o que fica no ar
#
# Escolher o alvo em `docker compose`: cada serviço aponta o seu com
# `build.target`.
#
# A ÁRVORE INTEIRA É COPIADA de um estágio para o outro, em vez de
# selecionar diretórios. Não é preguiça: o pnpm monta node_modules com
# links simbólicos para um armazém em `.pnpm`, e copiar pastas escolhidas
# a dedo quebra esses links de um jeito que só aparece em tempo de
# execução, na VPS, com o sistema fora do ar. Copiar tudo, depois do
# `install --prod`, preserva a estrutura como ela é.
#
# Roda como usuário SEM privilégio: um processo root que escape do
# isolamento do contêiner é root no host.
# =====================================================================

# --- estágio 1: build ----------------------------------------------
FROM node:22-bookworm-slim AS build

# argon2 é módulo nativo e precisa de toolchain — só aqui.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifestos primeiro: o cache de camadas só invalida quando uma
# dependência muda, não a cada linha de código alterada.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @stabilize/shared build \
 && pnpm --filter @stabilize/api build \
 && pnpm --filter @stabilize/web build

# --- estágio 2: dados de demonstração -------------------------------
#
# Branca do `build` ANTES da poda, porque o seed roda com tsx, que é
# dependência de desenvolvimento. Depois da poda ela não existe mais.
#
# É uma imagem de FERRAMENTA: sobe, popula, sai. Nunca fica no ar, e o
# serviço correspondente no compose tem `profiles` para não subir junto.
FROM build AS seed
WORKDIR /app
ENTRYPOINT ["pnpm", "--filter", "@stabilize/db", "seed"]

# --- estágio 3: a árvore podada, só com produção ---------------------
#
# Estágio separado, e não mais um `RUN` no `build`, justamente para o
# `seed` acima poder ramificar de um ponto em que as ferramentas de
# desenvolvimento ainda existem.
FROM build AS podado

# Reescreve node_modules só com produção. Precisa vir DEPOIS do build,
# porque o build usa typescript e vite, que são de desenvolvimento.
#
# `--config.confirmModulesPurge=false` NÃO é preciosismo. Trocar a
# instalação de "dev + prod" para "só prod" faz o pnpm querer apagar e
# refazer o node_modules do workspace inteiro, e antes disso ele PERGUNTA
# se pode. Dentro do `docker build` não há terminal para responder, e a
# resposta dele a isso é desistir:
#
#   ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
#
# O build morria neste ponto — depois de compilar tudo, que é o pior
# lugar possível para falhar. Só aparece em workspace com mais de um
# pacote, que é justamente o nosso caso e não o de um projeto simples.
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false \
 && rm -rf apps/api/src apps/web/src apps/web/node_modules packages/shared/src \
 && rm -rf /root/.cache /pnpm/store

# --- estágio 4: migrations ------------------------------------------
#
# Imagem separada, e não um comando dentro da imagem da API.
#
# `migrate.sh` roda `psql`, e a imagem da API é `node:22-slim`, que não
# tem cliente PostgreSQL. O passo documentado
# (`docker compose run --rm api ./packages/db/scripts/migrate.sh`)
# morria em `psql: not found` — no meio da instalação, com o banco de pé
# e nenhuma tabela criada.
#
# Instalar `postgresql-client` na imagem da API resolveria e seria pior:
# a API fica no ar 24 horas por dia, e a regra desta imagem é que o que
# não está instalado não pode ser usado por quem conseguir execução lá
# dentro. Um cliente de banco na mão de quem já invadiu o processo que
# fala com o banco é exatamente o que não se quer.
#
# A base é `postgres:16-bookworm`, a MESMA do serviço de banco: as
# camadas já estão na VPS, então isto não baixa nada de novo.
FROM postgres:16-bookworm AS migrate
WORKDIR /db
# migrate.sh resolve o diretório de SQL como ../sql a partir de si mesmo.
COPY packages/db/sql ./sql
COPY packages/db/scripts ./scripts
ENTRYPOINT ["/db/scripts/migrate.sh"]

# --- estágio 5: o front, dentro do proxy ----------------------------
#
# O front é ESTÁTICO e vai junto com o Caddy, em vez de ser montado do
# disco da VPS.
#
# A versão anterior montava `./apps/web/dist:/srv:ro` — um bind mount do
# repositório clonado. Só que `dist/` está no .gitignore e a build do
# front acontece AQUI DENTRO, no estágio acima: num `git clone` novo,
# aquele diretório não existe. O Docker então cria um diretório vazio no
# lugar, o Caddy sobe sem erro nenhum e serve 404 para todas as páginas.
# O sintoma é o pior possível: banco de pé, API respondendo, TLS
# emitido, `docker compose ps` todo "healthy" — e site em branco.
#
# Assado na imagem, o front que sobe é exatamente o que foi construído a
# partir daquele commit. Não existe estado no host para divergir.
FROM caddy:2-alpine AS web
COPY --from=podado /app/apps/web/dist /srv

# --- estágio 6: runtime da API --------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini como PID 1. Sem ele o Node vira PID 1 e não trata SIGTERM como
# sinal de parada: todo deploy espera o timeout de 10 s e corta conexões
# em andamento em vez de encerrá-las.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=podado --chown=node:node /app /app

# Diretório de anexos. Criado aqui só para existir com o dono certo
# antes de o volume ser montado por cima.
RUN mkdir -p /app/storage && chown node:node /app/storage

USER node
EXPOSE 3333

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
