# Auditoria de Segurança — Sistema Stabilize

**Data:** 14 de agosto de 2026
**Branch auditado:** `claude/stabilize-academia-management-xodct5`
**Commits analisados:** 4 (histórico completo)

---

## 0. Correção de premissa — leia antes de tudo

O pedido de auditoria descrevia **"um sistema SaaS multi-tenant em produção,
hospedado em VPS própria, com dados reais de até 30 empresas"**, e pedia uma
análise *read-only* desse sistema.

**Esse sistema não existe neste repositório.** Quando comecei, o repositório
`lucasjesus123/SISTEMA_STABILIZE` estava **completamente vazio**: nenhum commit,
nenhum arquivo, apenas o diretório `.git`. Verificável:

```
$ git log --oneline
(vazio — "No commits yet")
$ find . -type f -not -path './.git/*' | wc -l
0
```

Isso muda a natureza do documento e você precisa saber disso antes de tomar
qualquer decisão com base nele:

- **Não houve auditoria de um sistema em produção**, porque não havia sistema.
  Se existe uma Stabilize rodando hoje com dados reais, ela está em **outro
  lugar** — outro repositório, outro servidor, ou fora de controle de versão. Se
  for o caso, me diga onde e eu audito de verdade. Nada neste documento se
  aplica àquele sistema.
- **Não há 30 empresas com dados reais aqui.** Não há nenhum dado real.
- O que este documento audita é o **código que escrevi nesta sessão**, do zero.

Auditar o próprio trabalho tem um limite óbvio de independência, e eu não vou
fingir que não tem. Compensei da única forma que vale: **toda afirmação de
segurança abaixo está marcada como verificada por execução, hipótese ou não
verificada** — e as verificadas trazem o comando e a saída. Onde não testei,
está escrito que não testei.

---

## 1. Sumário executivo

### Estado geral

Foi construída a **fundação** de um sistema de gestão para a Stabilize, com
isolamento multi-tenant, aritmética financeira e controle de acesso projetados
desde o primeiro commit — não adaptados depois. As três camadas que sustentam a
segurança do sistema estão implementadas e **verificadas por execução**.

O sistema **não está pronto para produção**, mas por um motivo diferente do
usual: não é que a segurança esteja fraca; é que **faltam funcionalidades**. A
fundação é sólida e as partes construídas estão protegidas. O que falta, falta
inteiro (ver seção 7).

### Os 3 riscos mais graves hoje

| # | Risco | Severidade | Status |
|---|---|---|---|
| 1 | **Camada HTTP ainda não construída.** Não existem rotas, autenticação HTTP, cabeçalhos de segurança nem rate limiting em execução. A superfície mais atacada de qualquer sistema web é exatamente a que ainda não existe. | 🔴 CRÍTICO | Bloqueia produção |
| 2 | **Deploy sem hardening definido.** Sem proxy reverso configurado, TLS, firewall, backup testado ou monitoramento. Uma VPS com PostgreSQL exposto é o vetor mais comum de vazamento em sistemas deste porte. | 🔴 CRÍTICO | Bloqueia produção |
| 3 | **Vulnerabilidades em dependências de desenvolvimento**, incluindo uma crítica no `vitest`. Não afeta produção (não vão para o bundle), mas afeta a máquina de quem desenvolve. | 🟠 ALTO | Corrigir antes de escalar |

### Está adequado para produção?

**Não, ainda.** Mas a razão importa: o que existe está bem protegido; o que falta
não está protegido porque não existe. Não há, no código atual, nenhuma
vulnerabilidade conhecida a corrigir — há funcionalidade a construir, e ela
precisa ser construída seguindo os padrões já estabelecidos.

### O que precisa acontecer antes de operar com dados reais

1. Construir a camada HTTP (autenticação, rotas, cabeçalhos, rate limit).
2. Fazer o hardening da VPS (TLS, firewall, backup com restore testado).
3. Rodar um teste de penetração contra o sistema montado — não contra as peças.

---

## 2. Stack identificada

### Linguagem — e por que esta

Você pediu que eu escolhesse a linguagem pensando em segurança. Escolhi
**TypeScript em modo estrito**, de ponta a ponta, e a justificativa é concreta:

| Decisão | Motivo de segurança |
|---|---|
| **TypeScript estrito** em toda a stack | Um único idioma entre API e front elimina a classe de bug em que os dois lados discordam sobre o formato do dado. `strict`, `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes` transformam em erro de compilação coisas que em JavaScript seriam `undefined` em produção. |
| **PostgreSQL com Row-Level Security** | Esta é a decisão que mais importa. O isolamento entre empresas passa a ser garantido pelo banco, não pela disciplina de quem escreve query. É a diferença entre "esperamos não esquecer o `WHERE`" e "esquecer o `WHERE` não causa vazamento". |
| **Fastify** | Validação por schema no núcleo do framework, não como enfeite. Overhead baixo o bastante para 90 usuários simultâneos numa VPS modesta. |
| **`pg` direto, sem ORM pesado** | SQL explícito e parametrizado. ORMs escondem a query gerada, e o que se esconde não se audita. |
| **Argon2id** para senhas | Vencedor da Password Hashing Competition; resistente a ataque por GPU, ao contrário de bcrypt em fatores baixos. |

**Por que não Python/Django ou PHP/Laravel:** ambos serviriam. O desempate foi
o TypeScript compartilhado entre API e app do aluno — um único modelo de dados,
um único conjunto de validações. Não há motivo técnico para mudar de stack.

### Componentes

| Camada | Tecnologia | Versão verificada |
|---|---|---|
| Runtime | Node.js | 22.22.2 |
| Gerenciador | pnpm (workspaces) | 10.33.0 |
| Banco | PostgreSQL | 16.13 ✅ testado |
| API | Fastify 5 + Zod | declarado |
| Senhas | Argon2id | declarado |
| Tokens | JOSE (JWT) | declarado |

### Estrutura

```
packages/shared/   money.ts (aritmética), rbac.ts (permissões), brand.ts
packages/db/       sql/ (migrations + prova de isolamento), scripts/
apps/api/          config/, db/, auth/, http/, modules/
.semgrep/          regras de análise estática do projeto
```

### Como é servido em produção

**NÃO VERIFICADO — ainda não definido.** Não há Dockerfile de produção, unit do
systemd, configuração de Nginx nem pipeline de CI. O `docker-compose.yml`
existente é só o PostgreSQL de desenvolvimento (publicado apenas em
`127.0.0.1`, não na interface pública). Isto é uma lacuna, e está no plano.

---

## 3. Resultado das ferramentas automáticas

### 3.1 Gitleaks — segredos no histórico ✅ EXECUTADO

```
$ gitleaks detect --source . --log-opts="--all" -v
3 commits scanned.
no leaks found
```

**Resultado: nenhum segredo vazado.** Coerente com o desenho: `.env` está no
`.gitignore` desde o primeiro commit, `.env.example` tem apenas campos vazios, e
os placeholders em `002_roles.sql` são literalmente a string
`TROQUE_ESTA_SENHA_APP`.

> ⚠️ **Observação honesta:** o histórico tem 3 commits, todos meus, todos de
> hoje. Este resultado diz pouco. O valor do gitleaks aparece num histórico
> longo, com muitos autores — rode de novo daqui a seis meses.

### 3.2 Trufflehog ⬜ NÃO EXECUTADO

Não instalado no ambiente.

```bash
# Instalação
curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin
# Comando
trufflehog git file://. --only-verified
```

**Impacto da ausência:** baixo neste momento. O trufflehog acrescenta
*verificação ativa* (testa se a chave encontrada ainda funciona). Como o
gitleaks não achou candidato nenhum em 3 commits, não há o que verificar.

### 3.3 Dependências ✅ EXECUTADO

```
$ pnpm audit
{'info': 0, 'low': 0, 'moderate': 3, 'high': 1, 'critical': 1}
```

| Pacote | Severidade | Problema | Alcance |
|---|---|---|---|
| `vitest` | 🔴 CRÍTICA | Com a UI ativa, arquivo arbitrário pode ser lido e executado | **devDependency** |
| `vite` | 🟠 ALTA | Bypass de `server.fs.deny` em caminhos alternativos no Windows | **devDependency** |
| `vite` | 🟡 MÉDIA | Path traversal no tratamento de `.map` | **devDependency** |
| `vite` | 🟡 MÉDIA | Exposição de hash NTLMv2 via caminho UNC no Windows | **devDependency** |
| `esbuild` | 🟡 MÉDIA | Servidor de desenvolvimento aceita requisição de qualquer site | **devDependency** |

**Interpretação — FATO VERIFICADO:** todas as cinco chegam por `vitest`
(que traz `vite`, que traz `esbuild`). São **dependências de desenvolvimento**:
não vão para o bundle de produção e não são executadas pelo servidor. O risco
real é para a **máquina de quem desenvolve**, se rodar `vitest --ui` numa rede
não confiável.

**Ação:** atualizar `vitest` para a linha 3.x. Não é bloqueador de produção, mas
é trivial de resolver.

### 3.4 Semgrep ⚠️ EXECUTADO PARCIALMENTE

O registry público está **bloqueado pela política de egress** desta sessão:

```
semgrep.dev:443 — gateway answered 403 to CONNECT (policy denial)
```

Não contornei o bloqueio, conforme a política. Em vez disso escrevi um
**conjunto de regras local**, específico deste sistema
(`.semgrep/stabilize.yml`), cobrindo invariantes que regra genérica não conhece.

```
$ semgrep --config .semgrep/stabilize.yml --metrics=off .
Ran 9 rules on 12 files: 0 findings.
```

**Zero achados. E validei que as regras não são decorativas** — rodei contra um
arquivo com violações deliberadas de cada regra:

```
Ran 9 rules on 1 file: 10 findings.
  ✓ sql-concatenado-com-variavel
  ✓ query-fora-do-contexto-de-tenant
  ✓ set-de-tenant-em-escopo-de-sessao
  ✓ segredo-com-valor-padrao
  ✓ erro-original-na-resposta
  ✓ tenant-vindo-do-cliente
  ✓ caminho-de-arquivo-com-nome-do-usuario
  ✓ comparacao-de-segredo-sem-tempo-constante
  ✓ dado-sensivel-em-log
```

Todas as 9 regras disparam quando a violação existe, e nenhuma dispara no código
real. Isso é evidência; "0 achados" sozinho não seria.

**Lacuna reconhecida:** as regras do OWASP Top 10 do registry público cobrem
padrões que as minhas não cobrem. Rode em ambiente com egress liberado:

```bash
semgrep --config p/owasp-top-ten --config p/typescript --config p/secrets .
```

### 3.5 OSV-Scanner e Trivy ⬜ NÃO EXECUTADOS

Nenhum dos dois está instalado.

```bash
# OSV-Scanner
go install github.com/google/osv-scanner/cmd/osv-scanner@v1
osv-scanner -r .
# Trivy
apt-get install trivy && trivy fs .
```

**Impacto:** moderado. O `pnpm audit` já cobre o ecossistema npm, que hoje é a
totalidade das dependências. Trivy passa a importar quando existir imagem de
container — que ainda não existe.

---

## 4. Análise multi-tenant

Esta é a seção que mais importa, e é onde tenho a evidência mais forte.

### O isolamento está garantido?

**Sim, para o código que existe — e verificado por execução, não por leitura.**

### Onde ele é aplicado

O isolamento é feito em **três camadas independentes**, propositalmente
redundantes. A pergunta que guiou o desenho não foi "isto está seguro?", e sim
**"quando alguém errar, o que segura?"**.

#### Camada 1 — Row-Level Security no PostgreSQL (a que realmente segura)

Toda tabela com dado de empresa tem `tenant_id`, `ENABLE ROW LEVEL SECURITY` e
`FORCE ROW LEVEL SECURITY`, com policy pendurada em `current_tenant_id()`.

A propriedade que faz isso valer a pena: **sem contexto definido,
`current_tenant_id()` devolve `NULL`, e `tenant_id = NULL` é `NULL`, que não é
`TRUE`. Nenhuma linha passa.** Configuração ausente falha fechada.

`002_roles.sql` cria o papel `stabilize_app` **sem `BYPASSRLS`, sem
superusuário e sem DDL**. Isto não é detalhe: **RLS não se aplica a
superusuário**. Uma API conectando como `postgres` tornaria todas as policies
decorativas — é o erro mais comum em implementações de RLS.

```
$ psql -tAc "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'stabilize%'"
stabilize_app|f|f
stabilize_migrator|f|f
```

#### Camada 2 — contexto de transação na API

`withTenant()` (`apps/api/src/db/pool.ts`) é o único caminho para dado de
empresa. Duas decisões, ambas contra-intuitivas:

- **`SET LOCAL`, não `SET`.** `SET` vale pela *sessão*; com pool de conexões, o
  tenant do usuário anterior continuaria valendo para o próximo request que
  pegasse a mesma conexão. Seria vazamento entre empresas **intermitente e
  praticamente impossível de reproduzir** — o pior tipo de bug de segurança.
- **`set_config($1, $2, true)` parametrizado.** `SET LOCAL` não aceita parâmetro
  no protocolo estendido, o que empurra para montar a string na mão — colocando
  injeção de SQL exatamente no ponto que decide a autorização.

O `tenantId` vem **sempre do token verificado**. Há regra de semgrep que falha o
build se alguém ler `tenant_id` do corpo, da query string ou de um cabeçalho.

#### Camada 3 — escopo dentro da empresa

RLS separa **empresas**. Ela não sabe o que é "aluno deste professor" — isso é
recorte *dentro* do mesmo tenant, e é onde mora o requisito de que um
profissional não veja os alunos do colega.

`resolveScope()` devolve uma **união discriminada** já preenchida com a
identidade do token, e o repositório **não compila** sem tratar os três casos.
Não é possível "esquecer" o filtro.

```typescript
export type AccessScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'OWN_PROFESSIONAL'; readonly professionalId: string }
  | { readonly kind: 'SELF'; readonly studentId: string };
```

`permissionScope()` devolve o escopo em vez de um booleano **de propósito**: um
booleano convida a esquecer o filtro, e é exatamente assim que nasce IDOR.

### Há risco de IDOR?

**Nos caminhos implementados, não — verificado.** O cenário exato do enunciado
foi testado contra PostgreSQL real:

> *"Usuário autenticado da Empresa A chama `GET /api/clientes/123`, troca o ID
> para um cliente da Empresa B."*

```
✓ não lê o aluno da Empresa B nem sabendo o UUID exato (IDOR)
✓ um admin da Empresa A não lista alunos da Empresa B
✓ a busca por texto não atravessa a fronteira da empresa
✓ o Prof Um não abre a ficha do aluno do colega pelo id direto
✓ o recorte vale também no caminho de ESCRITA, não só na leitura
✓ desvincular o aluno remove o acesso do profissional ao prontuário
✓ o aluno só alcança o próprio cadastro
✓ o termo de busca é parametrizado — aspas e % não quebram a query

Tests  11 passed (11)
```

Além disso, `findStudentById()` devolve `null` tanto para "não existe" quanto
para "existe mas está fora do escopo", e ambos viram **404** — nunca 403.
Responder 403 confirmaria que aquele id é real e permitiria **mapear a base
alheia por diferença de resposta, sem ler um único registro**.

### O teste é confiável?

Fiz **teste de mutação** para responder isso, porque um teste de segurança que
não falha quando a proteção é removida não vale nada. Substituí o fragmento de
escopo por `TRUE` (proteção desligada):

```
Tests  5 failed | 6 passed (11)
  × o Prof Um vê apenas a própria aluna
  × o Prof Dois vê apenas o próprio aluno
  × o Prof Um não abre a ficha do aluno do colega pelo id direto
  × o recorte vale também no caminho de ESCRITA
  × desvincular o aluno remove o acesso ao prontuário
```

Os testes vigiam a proteção de verdade.

### O furo controlado: login

Há **um** ponto que legitimamente ignora a RLS, e ele é declarado. O login
precisa resolver o e-mail *antes* de saber o tenant — um ovo-e-galinha. Em vez
de afrouxar a RLS, existe **uma única função `SECURITY DEFINER` estreita**
(`auth_lookup_user`), com `search_path` fixo, sem SQL dinâmico, sem filtro
livre, sem retorno de lista, concedida só ao papel da aplicação.

```
$ psql -U stabilize_app -c "SELECT count(*) FROM users"        # sem contexto
0
$ psql -U stabilize_app -c "SELECT count(*) FROM auth_lookup_user('admin@a.test')"
1
```

### Pontos ainda NÃO verificados

Sendo explícito sobre os limites desta análise:

| Item | Status |
|---|---|
| Cache compartilhado com chave por tenant | ⬜ **NÃO VERIFICADO** — não há cache implementado |
| Jobs assíncronos processando múltiplos tenants | ⬜ **NÃO VERIFICADO** — não há jobs implementados |
| Storage de arquivos separado por tenant | ⬜ **NÃO VERIFICADO** — schema previsto, upload não implementado |
| URLs assinadas de download | ⬜ **NÃO VERIFICADO** — não implementado |
| Vazamento por mensagem de erro em runtime | 🟡 **HIPÓTESE** — `errors.ts` foi desenhado para não vazar, mas não há handler HTTP rodando para testar |
| Rotas administrativas | ⬜ **NÃO VERIFICADO** — não existem rotas ainda |

### O que precisa mudar para o isolamento ser aceitável em produção

O desenho está correto. O que falta é **manter o padrão** ao construir o resto:

1. Toda rota nova passa por `withTenant()` — a regra de semgrep vigia.
2. Todo repositório novo recebe `AccessScope` obrigatório.
3. Todo módulo novo ganha teste de isolamento como os 11 existentes.
4. Storage de anexos: prefixar por `tenant_id` e validar o tenant no download.
5. Quando houver cache: a chave **precisa** incluir `tenant_id`.

---

## 5. Vulnerabilidades encontradas

Nenhuma vulnerabilidade explorável foi encontrada no código escrito. O que segue
são **lacunas** — ausências que se tornam vulnerabilidade quando o sistema for
para produção sem preenchê-las.

---

**ID: SEC-001**
- **Severidade:** 🔴 CRÍTICO
- **Categoria:** Superfície de ataque não construída
- **Arquivo:** `apps/api/src/` — ausência de `server.ts`, rotas e plugins
- **Evidência:** não existem `routes/`, handler de erro HTTP, `helmet`, `cors` nem `rate-limit` em execução. As dependências estão declaradas em `package.json`, mas não há código que as monte.
- **Risco:** a camada HTTP é a mais atacada de qualquer sistema web. Sem ela, não há autenticação em runtime, cabeçalhos de segurança (CSP, HSTS, X-Frame-Options), proteção CSRF nem limite de requisições.
- **Cenário:** não explorável hoje — não há servidor no ar. Torna-se crítico no instante em que subir sem essas proteções.
- **Como corrigir:** construir a camada HTTP com `@fastify/helmet`, `@fastify/cors` com lista explícita, `@fastify/rate-limit` (agressivo no login), handler de erro usando `AppError`, e cookies `Secure`/`HttpOnly`/`SameSite=Strict` para o refresh token.
- **Status:** ✅ **verificado** (ausência confirmada por inspeção)

---

**ID: SEC-002**
- **Severidade:** 🔴 CRÍTICO
- **Categoria:** Infraestrutura e operação
- **Arquivo:** ausência de configuração de deploy
- **Evidência:** não há Dockerfile de produção, unit do systemd, configuração de proxy reverso, TLS, firewall, backup nem monitoramento.
- **Risco:** para o alvo declarado (VPS própria, dados reais de saúde), a infraestrutura é tão crítica quanto o código. PostgreSQL exposto na interface pública é o vetor mais comum de vazamento em VPS.
- **Cenário:** varredura automatizada encontra a porta 5432 aberta e tenta credenciais comuns. Ou: disco corrompe e não há backup testado.
- **Como corrigir:** Nginx ou Caddy com TLS e HSTS; API escutando só em `127.0.0.1`; `ufw` negando tudo exceto 80/443/SSH; `fail2ban` no SSH; backup automático **com restore testado** — backup nunca restaurado não é backup.
- **Status:** ✅ **verificado**

---

**ID: SEC-003**
- **Severidade:** 🟠 ALTO
- **Categoria:** Dependências vulneráveis
- **Arquivo:** `package.json` (cadeia `vitest` → `vite` → `esbuild`)
- **Evidência:** `pnpm audit` — 1 crítica, 1 alta, 3 médias. Todas em devDependencies.
- **Risco:** limitado à máquina de desenvolvimento. A crítica do `vitest` permite ler e executar arquivo arbitrário quando a UI está ativa.
- **Cenário:** desenvolvedor roda `vitest --ui` numa rede compartilhada; site malicioso alcança o servidor local.
- **Como corrigir:** atualizar `vitest` para a linha 3.x.
- **Status:** ✅ **verificado**

---

**ID: SEC-004**
- **Severidade:** 🟡 MÉDIO
- **Categoria:** Cobertura de análise estática
- **Evidência:** `semgrep.dev` bloqueado por política de egress (403 no CONNECT).
- **Risco:** as 9 regras locais cobrem os invariantes deste sistema, mas não substituem o OWASP Top 10 do registry.
- **Como corrigir:** rodar `semgrep --config p/owasp-top-ten --config p/typescript` em ambiente com egress liberado; adicionar ao CI.
- **Status:** ✅ **verificado** (limitação do ambiente, não do código)

---

**ID: SEC-005**
- **Severidade:** 🟡 MÉDIO
- **Categoria:** Gestão de segredos
- **Arquivo:** `packages/db/sql/002_roles.sql:27,30`
- **Evidência:** `CREATE ROLE stabilize_app LOGIN PASSWORD 'TROQUE_ESTA_SENHA_APP'`
- **Risco:** placeholder óbvio, mas se alguém rodar a migration sem trocar, o banco fica com senha conhecida e versionada.
- **Cenário:** deploy apressado executa o SQL como está; a senha está publicada no GitHub.
- **Como corrigir:** ler de variável de ambiente via `psql -v`, ou documentar a troca como passo obrigatório e verificado no deploy.
- **Status:** ✅ **verificado** — **nenhum segredo real exposto**, apenas placeholder

---

**ID: SEC-006**
- **Severidade:** 🟢 BAIXO
- **Categoria:** Auditoria e privacidade (LGPD)
- **Arquivo:** `packages/db/sql/001_schema.sql` — tabela `audit_log`
- **Evidência:** a tabela existe e é append-only (verificado), mas **nada escreve nela ainda**, porque não há rotas.
- **Risco:** prontuário e anamnese são dado de saúde — categoria sensível na LGPD (art. 5º, II). Sem trilha de leitura, não há como investigar acesso indevido depois do fato.
- **Como corrigir:** registrar leitura de prontuário, não só escrita, ao construir as rotas.
- **Status:** ✅ **verificado** (estrutura pronta, uso pendente)

---

## 6. Escalabilidade para 90 usuários simultâneos

### A stack aguenta?

**Sim, com folga — HIPÓTESE FUNDAMENTADA, não medida.** Não houve teste de carga
(não há API para carregar). O parecer vem do dimensionamento, e você deve tratá-lo
como estimativa até haver medição.

90 usuários simultâneos é um alvo **modesto**. Fastify sustenta ordens de
grandeza mais em hardware modesto. O gargalo, se aparecer, será no banco.

### Onde está o gargalo provável

| Área | Avaliação | Evidência |
|---|---|---|
| **Conexões de banco** | 🟢 Adequado | Pool em 20; PostgreSQL configurado para 100. 90 usuários **não** são 90 conexões — request dura milissegundos. |
| **Índices por tenant** | 🟢 Adequado | Todo índice começa por `tenant_id`, que é como toda query chega por causa da RLS. Índice que não começa por `tenant_id` seria pouco útil aqui. |
| **Query travada** | 🟢 Mitigado | `statement_timeout` de 15s. Sem isso, um relatório mal indexado segura conexões e derruba a API inteira. |
| **Paginação** | 🟢 Aplicado | `MAX_PAGE_SIZE = 100`, teto imposto no servidor mesmo se o cliente pedir mais. |
| **Aniversariantes** | 🟢 Otimizado | Índice parcial sobre `(mês, dia)` — o cron não varre a tabela toda dia. |
| **N+1** | ⬜ Não verificado | Não há código de aplicação suficiente para avaliar. |
| **Jobs pesados no processo web** | 🟡 Risco futuro | Geração de PDF e disparo de WhatsApp **não podem** rodar no processo que atende requests. Ainda não implementados — a hora de decidir é agora. |
| **Cache** | ⬜ Não existe | Desnecessário neste porte. Se um dia existir, **a chave precisa incluir `tenant_id`** — cache compartilhado sem isso é vazamento entre empresas. |

### Índices já criados

```sql
(tenant_id, status)                      -- students
(tenant_id, full_name)                   -- busca
(tenant_id, created_at DESC)             -- listagem recente
(tenant_id, mês, dia) WHERE ativo        -- aniversariantes
(tenant_id, direction, due_date)         -- financeiro
(tenant_id, professional_id, lower(period) DESC)  -- agenda
GIST (tenant_id, period)                 -- sobreposição de horário
```

### Infraestrutura — o que falta

| Item | Status |
|---|---|
| Pool de conexões | ✅ Configurado |
| Monitoramento (CPU, memória, disco, rede) | ❌ **Ausente** |
| Backup automático | ❌ **Ausente** |
| Teste de restore | ❌ **Ausente** — backup nunca restaurado não é backup |
| Plano de rollback | ❌ **Ausente** |
| Proxy reverso | ❌ **Ausente** |
| Healthcheck | 🟡 Definido no compose, sem endpoint na API |
| Restart automático | 🟡 `unless-stopped` no compose; sem systemd para a API |
| Firewall / fail2ban | ❌ **Ausente** |

### Há motivo para trocar de stack?

**Não.** Nenhum motivo técnico concreto. A stack é adequada ao alvo com folga
significativa. Priorize arquitetura, banco, infra e operação.

---

## 7. Plano de correção priorizado

### 🔴 Corrigir imediatamente (impede produção segura)

1. **Construir a camada HTTP** — `helmet` (CSP, HSTS, X-Frame-Options,
   Referrer-Policy, Permissions-Policy), CORS com lista explícita, rate limit
   agressivo no login, handler de erro sem vazamento, cookies
   `Secure`/`HttpOnly`/`SameSite=Strict`. *(SEC-001)*
2. **Hardening da VPS** — TLS com HSTS, API só em `127.0.0.1`, firewall,
   fail2ban, PostgreSQL nunca exposto publicamente. *(SEC-002)*
3. **Backup automático com restore testado** e plano de rollback documentado.
4. **Trocar as senhas placeholder** antes de qualquer deploy. *(SEC-005)*

### 🟠 Corrigir antes de escalar

5. **Atualizar `vitest`** para a linha 3.x. *(SEC-003)*
6. **Rodar semgrep completo** com as regras do OWASP em ambiente com egress
   liberado, e colocar no CI. *(SEC-004)*
7. **Trilha de auditoria em uso** — registrar leitura de prontuário. *(SEC-006)*
8. **Jobs pesados fora do processo web** — PDF e WhatsApp em fila separada.
9. **Monitoramento** de CPU, memória, disco e taxa de erro, com alerta.
10. **Teste de carga real** com 90 usuários simultâneos, para trocar a hipótese
    da seção 6 por medição.

### 🟡 Melhorias recomendadas

11. Segundo fator para OWNER e ADMIN — são as contas que alcançam o financeiro.
12. Rotação documentada de segredos.
13. Verificação de conteúdo em upload (magic bytes, não `Content-Type`, que o
    cliente controla) e antivírus nos anexos.
14. Exportação e exclusão de dados por titular (LGPD, arts. 18 e 19).
15. Política de retenção de logs.

### 🟢 Pode esperar

16. `pgaudit` para auditoria no nível do banco.
17. Réplica de leitura para relatórios pesados.
18. Rastreamento distribuído.

---

## 8. Ressalvas finais

1. **Este não é um sistema em produção auditado.** É código novo, escrito nesta
   sessão, auditado por quem o escreveu. Trate como parecer técnico
   fundamentado, não como auditoria independente.
2. **Se existe uma Stabilize rodando com dados reais em outro lugar**, ela não
   foi analisada. Nada aqui se aplica a ela. Me aponte o repositório e eu audito.
3. **Antes de operar com dados reais**, contrate um teste de penetração
   independente contra o sistema montado.
4. **Nenhum segredo real foi encontrado nem exposto** neste relatório. Os únicos
   valores citados são placeholders literais versionados de propósito.

### Como reproduzir as verificações

```bash
pnpm --filter @stabilize/shared test      # 50 testes: aritmética + permissões
DATABASE_URL=... pnpm --filter @stabilize/db test    # 9 garantias de banco
TEST_DATABASE_URL=... pnpm --filter @stabilize/api test  # 11 testes de isolamento
gitleaks detect --source . --log-opts="--all" -v
semgrep --config .semgrep/stabilize.yml --metrics=off .
pnpm audit
```

---

*Relatório gerado em 14/08/2026. Segredos mascarados. Nenhum código, banco,
configuração ou infraestrutura foi alterado durante a fase de auditoria.*
