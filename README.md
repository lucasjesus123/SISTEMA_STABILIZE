<div align="center">

# Stabilize

**Clínica do Músculo — sistema de gestão**

Teal `#4BC1C8` · Menta `#85CEBD` · Grafite `#686969`

</div>

---

## O que é

Sistema de gestão para a academia de alta performance Stabilize: cadastro e
prontuário de alunos, agenda integrada com salas, financeiro completo com
comissões por profissional, controle de presença e aplicativo do aluno.

Construído em três camadas de acesso — administração, profissional e aluno —
com isolamento entre empresas garantido pelo banco de dados, não pela
disciplina de quem escreve as queries.

## Estado atual — leia antes de usar

As três etapas estão construídas. Sendo direto sobre o que está verificado por
execução e o que não está:

| Camada | Estado |
|---|---|
| Aritmética financeira (centavos, comissões, rateio) | ✅ Pronta e testada — 18 testes do cálculo |
| Matriz de permissões (5 papéis, escopo por profissional) | ✅ Pronta e testada |
| Schema do banco com Row-Level Security | ✅ Pronto e verificado — 9 garantias provadas em SQL |
| Camada de dados da API (contexto de tenant, escopo) | ✅ Pronta e testada — 11 testes de isolamento |
| Autenticação, sessão e cabeçalhos de segurança | ✅ Pronta e testada — 27 testes ponta a ponta |
| Alunos: cadastro, edição e ficha | ✅ Pronto e testado |
| Prontuário: anamnese versionada e evolução | ✅ Pronto e testado — 16 testes |
| Anexos (exames, laudos) | ✅ Pronto e testado — 16 testes |
| Agenda, disponibilidade e presença | ✅ Pronta e testada — 35 testes do motor de horários |
| Prescrição de treino | ✅ Pronta e testada — 15 testes |
| Financeiro (lançamentos, baixas, resumo) | ✅ Pronto e testado — 14 testes |
| Relatórios em PDF | ✅ Prontos e testados — 10 testes, PDF conferido página a página |
| Integração WhatsApp (uazapi) | ✅ Pronta e testada — token cifrado, envio idempotente |
| Interface web (administração e profissional) | ✅ Pronta, conferida no navegador |
| Aplicativo do aluno (instalável, offline) | ✅ Pronto — 14 testes, conferido em viewport de celular |

**187 testes passando.** Todo teste de segurança foi validado por mutação:
quebra-se a proteção e confirma-se que o teste falha.

**O que ainda falta para produção**, e é preparo de servidor, não de código:
TLS, firewall, e o backup com **restore testado** — o script existe
(`deploy/backup.sh`, que restaura cada dump num banco descartável e conta os
tenants antes de aceitá-lo), mas nunca rodou num servidor real. `docker build`
também não foi executado aqui: a saída de rede para o registro do Docker é
bloqueada neste ambiente. Ver [`AUDITORIA_SEGURANCA.md`](AUDITORIA_SEGURANCA.md)
para o parecer completo, separando fato, hipótese e não verificado.

## Stack

| Camada | Tecnologia | Por quê |
|---|---|---|
| Linguagem | **TypeScript** estrito, ponta a ponta | Um idioma entre API e front elimina a divergência de contrato entre os dois lados |
| Banco | **PostgreSQL 16** com Row-Level Security | Isolamento entre empresas garantido pelo banco: esquecer um `WHERE` vira resultado vazio, não vazamento |
| API | **Fastify 5** + Zod | Validação por schema no núcleo do framework |
| Senhas | **Argon2id** | Resistente a ataque por GPU |
| Monorepo | **pnpm workspaces** | Código compartilhado sem publicar pacote |

## As três decisões que definem este sistema

### 1. Dinheiro é inteiro de centavos, nunca float

```
0.1 + 0.2 === 0.30000000000000004
1.005 * 100 === 100.49999999999999   // arredonda para 100, não 101
```

Somando mensalidades ao longo de um mês, esse erro acumula e o extrato do aluno
deixa de fechar. Todo valor é `BIGINT` de centavos, e o único ponto que
arredonda está isolado em duas funções auditadas.

O parser **recusa entrada ambígua** em vez de adivinhar: `"1,234"` pode ser
R$ 1.234,00 ou R$ 1,23, e chutar errado é um erro de mil vezes.

`allocate()` divide sem perder centavo — R$ 100,00 em 3 parcelas nunca vira
R$ 99,99.

### 2. Isolamento no banco, não no código

Toda tabela com dado de empresa tem RLS com `FORCE`, e a API conecta com um
papel **sem `BYPASSRLS`**. Sem contexto de tenant definido, o banco devolve
zero linhas — configuração ausente falha fechada.

Verificado por execução: a Empresa A não lê o aluno da Empresa B **nem sabendo
o UUID exato**.

### 3. Regra crítica é restrição, não validação

Dupla marcação de agenda é impedida por `EXCLUSION CONSTRAINT` no PostgreSQL.
Checar "está livre?" em código é uma corrida que dois requests simultâneos
vencem — o banco não perde essa corrida.

Intervalo semiaberto: 9h-10h e 10h-11h convivem; 9h-10h e 9h30-10h30 não.

## Rodando localmente

```bash
# 1. Dependências
pnpm install

# 2. Configuração
cp .env.example .env      # preencha os segredos; nenhum tem valor padrão
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET (precisa ser diferente)
openssl rand -base64 32   # ENCRYPTION_KEY

# 3. Banco
docker compose up -d postgres
pnpm db:migrate
pnpm --filter @stabilize/db seed   # academia de demonstração, reexecutável

# 4. Testes
pnpm test

# 5. Subir
pnpm --filter @stabilize/api dev    # :3333
pnpm --filter @stabilize/web dev    # :5173, com proxy para a API
```

O seed imprime as contas criadas. A do aplicativo é `ana@aluno.demo` — entrar
com ela leva direto ao aplicativo do aluno, não ao sistema.

### Vendo o aplicativo como aplicativo

O service worker é ligado apenas na versão publicada (em desenvolvimento ele
serviria arquivo velho por cima do que você acabou de editar). Para exercitar a
instalação e o modo offline:

```bash
pnpm --filter @stabilize/web build
pnpm --filter @stabilize/web preview   # :4173, com o mesmo proxy
```

Abra no celular, ou no navegador em modo dispositivo, e use "adicionar à tela de
início".

### Verificando a segurança

```bash
# Prova de isolamento no banco (recusa credencial privilegiada)
pnpm --filter @stabilize/db test

# Isolamento na camada de dados, contra PostgreSQL real
TEST_DATABASE_URL=... pnpm --filter @stabilize/api test

# Análise estática com as regras do projeto
semgrep --config .semgrep/stabilize.yml --metrics=off .

# Segredos no histórico
gitleaks detect --source . --log-opts="--all" -v
```

## Estrutura

```
packages/shared/     money.ts · rbac.ts · brand.ts
packages/db/
  sql/001_schema.sql        22 tabelas, RLS, restrições de agenda
  sql/002_roles.sql         papel da app sem BYPASSRLS
  sql/003_auth.sql          funções de login (SECURITY DEFINER estreitas)
  sql/900_isolation_test.sql  prova executável das garantias
apps/api/
  config/env.ts        recusa subir com configuração fraca
  db/pool.ts           withTenant() — único caminho para dado de empresa
  auth/scope.ts        escopo que o TypeScript obriga a tratar
  http/errors.ts       404 para recurso alheio, nunca 403
  modules/portal/      o aluno vendo os próprios dados — sem id na URL
apps/web/
  App.tsx              o sistema (administração e profissional)
  Aplicativo.tsx       o aplicativo do aluno, incluindo o modo sessão
  app-aluno.css        folha separada: o aplicativo tem outra gramática
  public/sw.js         casca offline — e nada de /api no cache
  src/fontes.css       gerado por brand/fontes.mjs; fonte servida por nós
brand/
  extrair.py           LOGO.pdf → SVG e geometria, por cor lida do PDF
  icones.mjs           ícones do aplicativo, renderizados pelo Chromium
  fontes.mjs           baixa e deduplica as fontes variáveis
.semgrep/            regras que vigiam os invariantes do projeto
```

## Convenções para quem for continuar

1. Todo acesso a dado de empresa passa por `withTenant()`.
2. Todo repositório recebe `AccessScope` obrigatório — sem valor padrão.
3. Recurso fora do escopo responde **404**, nunca 403.
4. Dinheiro em centavos inteiros; taxa em basis points.
5. Todo módulo novo ganha teste de isolamento.
6. Regra crítica vira restrição no banco quando possível.

As regras em `.semgrep/stabilize.yml` vigiam os itens 1, 2 e 4 automaticamente.
