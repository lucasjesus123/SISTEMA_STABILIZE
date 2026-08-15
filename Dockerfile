# =====================================================================
# Imagem da API.
#
# Dois estágios, e a divisão é por SUPERFÍCIE antes de tamanho: a imagem
# final não tem compilador C++, nem toolchain de build, nem o código do
# front. O que não está instalado não pode ser usado por quem consegue
# execução dentro do contêiner.
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

# Reescreve node_modules só com produção. Precisa vir DEPOIS do build,
# porque o build usa typescript e vite, que são de desenvolvimento.
RUN pnpm install --frozen-lockfile --prod \
 && rm -rf apps/api/src apps/web/src apps/web/node_modules packages/shared/src \
 && rm -rf /root/.cache /pnpm/store

# --- estágio 2: runtime ---------------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini como PID 1. Sem ele o Node vira PID 1 e não trata SIGTERM como
# sinal de parada: todo deploy espera o timeout de 10 s e corta conexões
# em andamento em vez de encerrá-las.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app /app

# Diretório de anexos. Criado aqui só para existir com o dono certo
# antes de o volume ser montado por cima.
RUN mkdir -p /app/storage && chown node:node /app/storage

USER node
EXPOSE 3333

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
