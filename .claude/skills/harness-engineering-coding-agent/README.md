# Harness Engineering Coding Agent

**Da intenção de produto ao impacto em produção com agentes de IA.**

Este repositório reúne uma skill operacional portátil para agentes de coding trabalharem com método, rastreabilidade, validação e responsabilidade. Ela foi pensada para qualquer agente capaz de ler arquivos, alterar código, executar comandos e registrar progresso: Claude Code, Codex, Cursor, Windsurf, Gemini CLI, OpenCode, agentes locais ou agentes internos de empresas.

A tese é simples: **modelo bom não basta**. Aplicações reais não nascem apenas de prompts bons. Elas nascem de um ambiente de trabalho bem desenhado: contexto certo, especificação clara, contrato semântico quando necessário, ferramentas seguras, sensores objetivos, logs, critérios de aceite, controle de escopo, revisão e aprendizado pós-lançamento.

Essa tese não parte apenas de experiência prática. Ela dialoga com uma linha recente de pesquisa que mostra que agentes e modelos de linguagem, quando colocados em tarefas reais de engenharia de software, precisam lidar com contexto longo, múltiplos arquivos, ambiente de execução, verificação, segurança, manutenção e coordenação humano-IA.[^swebench] [^se-agents] Revisões sistemáticas sobre IA em IDEs também apontam ganhos de produtividade, mas alertam para **sobrecarga de verificação, risco de dependência excessiva, problemas de correção, manutenção e segurança**.[^hax-ide] Por isso, esta skill trata o agente como parte de um sistema de trabalho, não como uma caixa mágica de geração de código.

> **Código não é software.** Software inclui requisitos, arquitetura, dados, fluxos de usuário, segurança, testes, deployment, observabilidade, manutenção e o processo que mantém tudo coerente ao longo do tempo.

## O que este pacote entrega

| Caminho | Função |
|---|---|
| `SKILL.md` | Skill principal, com frontmatter, gatilhos de uso, workflow, gates e regras não negociáveis. |
| `references/` | Módulos operacionais lidos sob demanda: descoberta de produto, PRD/spec, design semântico, verificação de versão, release/medição e squad mode. |
| `templates/` | Templates reutilizáveis para `AGENTS.md`, contrato, especificação semântica, critérios de aceite, plano de testes, estado, avaliação e handoff, incluindo `STATE.md` com campos explícitos de continuidade e `HANDOFF.md` com detalhes operacionais para retomada por outra sessão ou agente. |
| `checklists/` | Checklist de execução para uso em revisão ou antes de encerrar uma tarefa. |
| `examples/` | Exemplo mínimo de aplicação da skill em uma tarefa real. |
| `docs/` | Guia conceitual consolidado para humanos entenderem e adaptarem o método. |
| `docs/academic-foundations.md` | Fundamentos acadêmicos e técnicos que dão lastro ao método: agentes LLM, benchmarks de software engineering, BDD, rastreabilidade, verificação, DevSecOps, SRE, colaboração humano-IA e **Code as Agent Harness**. |

## Por que isso existe

A criação de software com IA mudou de fase. Na primeira fase, a pergunta era: “a IA consegue gerar código?”. Hoje a resposta já é óbvia: consegue.

A pergunta relevante agora é outra: **a IA consegue ajudar a construir software que pode ser mantido, testado, lançado, observado e evoluído com segurança?**

A resposta depende menos do modelo e mais do harness ao redor dele.

Sem harness, um agente tende a trabalhar como um dev novato largado numa base de código sem onboarding: ele pode ser rápido, mas não conhece contexto, histórico, arquitetura, riscos, critérios de aceite nem consequências. Com harness, o agente opera dentro de um canteiro: sabe o que construir, onde mexer, o que não tocar, como validar, quando pedir aprovação e como deixar rastros para a próxima sessão.

## Base acadêmica e técnica

A skill se apoia em oito pilares de literatura e prática técnica. O primeiro é a constatação, reforçada por benchmarks como **SWE-bench**, de que resolver issues reais de GitHub exige muito mais do que completar uma função isolada: exige compreender codebases, coordenar mudanças em múltiplos arquivos e interagir com ambientes de execução.[^swebench] O segundo é a pesquisa sobre agentes LLM para engenharia de software, que descreve o uso de planejamento, memória, ferramentas, execução iterativa e feedback como componentes essenciais para autonomia prática.[^se-agents] [^react]

O terceiro pilar vem da engenharia de requisitos e da rastreabilidade: especificações, contratos, critérios de aceite e vínculos entre requisitos, implementação e testes reduzem ambiguidade e melhoram manutenção.[^traceability] O quarto pilar vem de BDD e especificação por comportamento, que sustentam a ideia de traduzir intenção de negócio em cenários verificáveis antes da implementação.[^bdd] O quinto pilar é verificação em tempo de execução e observabilidade, especialmente quando o comportamento não pode ser validado apenas por inspeção estática.[^runtime-verification] [^sre]

O sexto pilar é DevSecOps: segurança precisa entrar no ciclo de desenvolvimento, operação, ferramentas e métricas, e não aparecer apenas como revisão tardia.[^devsecops] O sétimo é a pesquisa sobre colaboração humano-IA em IDEs, que recomenda transparência, explicabilidade, controle humano e auditoria de código gerado por IA para reduzir dependência excessiva e riscos de qualidade.[^hax-ide] O oitavo é o princípio **Code as Agent Harness**, segundo o qual o código também pode funcionar como infraestrutura operacional do agente: memória, ferramentas, ambiente, verificação, artefatos compartilhados, telemetria e ciclo de melhoria versionável.[^code-as-harness]

| Pilar | Como aparece na skill |
|---|---|
| Benchmarks de software engineering real | O agente precisa tratar tarefas como mudanças em codebase, não como geração de snippet. |
| Agentes LLM iterativos | O fluxo exige planejamento, execução, sensores, revisão e handoff. |
| Engenharia de requisitos e rastreabilidade | `CONTRACT.md`, critérios de aceite, PRD e handoff conectam intenção, implementação e validação. |
| BDD e comportamento verificável | `ACCEPTANCE_CRITERIA.md` e `SEMANTIC_SPEC.md` transformam intenção em comportamento observável. |
| Runtime verification, SRE e observabilidade | Release, rollback, logs, métricas, replay e evidências operacionais entram como parte do pronto. |
| DevSecOps | Mudanças com dados, autenticação, permissões, segredos e produção sobem o nível de rigor. |
| Human-AI Experience | A skill preserva controle humano, transparência, revisão e auditoria do trabalho do agente. |
| Code as Agent Harness | O agente trata o próprio workflow como harness operacional versionável, com telemetria, sensores, continuidade de estado e melhoria sem regressão. |

Para uma leitura consolidada das fontes, veja [`docs/academic-foundations.md`](docs/academic-foundations.md).

A skill também incorpora uma adaptação do padrão minimalista [`grill-me`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md): entrevistar criticamente o plano até alcançar entendimento compartilhado. A adaptação aqui é mais operacional: o agente deve primeiro buscar respostas no codebase e nos documentos existentes; só depois deve perguntar ao usuário, uma decisão bloqueante por vez, sempre oferecendo uma resposta recomendada.

## Como usar rapidamente

Copie `SKILL.md` para o local de skills, rules, memories ou instruções do seu agente.

```text
.skills/harness-engineering-coding-agent/SKILL.md
.agent-skills/harness-engineering-coding-agent/SKILL.md
.claude/skills/harness-engineering-coding-agent/SKILL.md
.codex/skills/harness-engineering-coding-agent/SKILL.md
.cursor/rules/harness-engineering-coding-agent.md
.windsurf/rules/harness-engineering-coding-agent.md
```

Depois, copie as pastas `references/` e `templates/` junto com o `SKILL.md`, para que o agente consiga consultar os módulos e criar os artefatos quando necessário.

## Fluxo principal

```text
Product Intent
→ Product Engineering Discovery
→ PRD / Spec / Contract
→ Semantic Behavior Spec, when needed
→ Task Breakdown
→ Implementation Harness
→ Evaluation Gates
→ Release Harness
→ Measurement Loop
→ Harness Telemetry & Learning Loop
→ Learning / Handoff
```

A etapa de **Harness Telemetry & Learning Loop** registra qual contexto foi usado, quais gates foram acionados, quais sensores funcionaram, quais pontos cegos permaneceram e quais melhorias futuras podem ser propostas sem alterar a skill silenciosamente. Essa camada transforma avaliação e handoff em sinais reutilizáveis para evolução do harness, mantendo consentimento humano e rastreabilidade.

## Modos de execução

A skill funciona em três modos. O modo `solo` é o padrão e serve para tarefas claras e de baixo ou médio risco. O modo `review-pair` separa implementação e avaliação, sendo adequado para autenticação, dados, segurança, lógica de negócio e mudanças sensíveis. O modo `squad` ativa papéis separados para produto, arquitetura, implementação, QA, release e medição quando a tarefa é longa, crítica ou ambígua.

| Modo | Quando usar | Custo de coordenação |
|---|---|---:|
| `solo` | Tarefa clara, local e de baixo risco. | Baixo |
| `review-pair` | Mudança com risco médio ou necessidade de validação independente. | Médio |
| `squad` | Produto, arquitetura, segurança, release e medição em jogo. | Alto |

Comece por `solo`. Suba para `review-pair` ou `squad` apenas quando houver ambiguidade, risco, tarefa longa, impacto em produção, dados sensíveis ou necessidade de medição real.

## Estrutura recomendada no projeto-alvo

A skill pode criar artefatos leves dentro do projeto em que o agente está trabalhando. Ela não exige todos os arquivos em toda tarefa; a matriz no `SKILL.md` define o mínimo por tipo de trabalho.

```text
AGENTS.md
.harness/STATE.md
.harness/CONTRACT.md
.harness/ACCEPTANCE_CRITERIA.md
.harness/TEST_PLAN.md
.harness/EVALUATION_REPORT.md
.harness/HANDOFF.md
.harness/OPEN_QUESTIONS.md
docs/product/PRODUCT_INTENT.md
docs/product/PRD.md
docs/product/METRICS_PLAN.md
docs/product/POST_LAUNCH_REVIEW.md
.harness/SEMANTIC_SPEC.md
docs/architecture/ARCHITECTURE.md
docs/decisions/DECISION_LOG.md
docs/release/RELEASE_PLAN.md
```

A continuidade entre sessões fica concentrada principalmente em `.harness/STATE.md` e `.harness/HANDOFF.md`. O `STATE.md` deve registrar escopo aprovado, invariante atual, último estado verificado, links de evidência, notas de coordenação e ações pendentes inseguras. O `HANDOFF.md` deve complementar esse estado com detalhes de continuidade suficientes para que outra pessoa, sessão ou agente retome o trabalho sem reconstruir contexto por memória implícita.

## Quando usar

Use esta skill quando a tarefa envolver construir uma aplicação com agentes de IA, transformar ideia em especificação, implementar feature com frontend, backend, auth, banco ou integração, corrigir bug com impacto relevante, mexer em arquitetura, segurança, permissões, dados ou produção, refatorar código que precisa continuar funcionando, lançar funcionalidade para usuários reais, medir adoção, impacto e aprendizado, ou definir comportamentos, garantias, constraints, eventos, replay, auditabilidade e observabilidade de sistemas AI-native.

## Quando não usar o fluxo completo

Não use o fluxo completo para pergunta simples, snippet descartável, prova de conceito sem compromisso de manutenção, exploração técnica rápida ou tarefa de baixo risco com um único arquivo e sem efeito externo.

Mesmo nesses casos, preserve Git, escopo e critérios básicos de pronto.

## Inspiração conceitual

A camada de especificação semântica foi reforçada após análise do artigo [VibeCoding State-of-the-Art-Driven Development](https://dev.to/fullagenticstack/vibecoding-state-of-the-art-driven-development-31ne). A ideia incorporada não foi a adoção literal de uma DSL, runtime ou stack hyper-polyglot, mas o princípio de que agentes de coding devem declarar comportamentos, garantias, constraints, eventos, estado, replay e observabilidade antes de espalhar implementação por múltiplas camadas.

Na prática, isso aparece em `.harness/SEMANTIC_SPEC.md` e `references/semantic-system-design.md`. Esses artefatos são opcionais e proporcionais ao risco; eles existem para tarefas arquiteturais, agentic workflows, automações e sistemas AI-native, não para transformar correções simples em burocracia.

## Validação local

Este repositório inclui um script simples de validação local. Para uma checagem mínima antes de publicar alterações, rode:

```bash
python scripts/validate_skill.py
```

A validação verifica a presença de frontmatter no `SKILL.md`, referências obrigatórias e templates essenciais.

Além dessa validação estrutural, a evolução da skill segue a regra de **regression-free harness improvement**: qualquer melhoria no próprio harness deve preservar a rastreabilidade já existente, manter sensores e critérios objetivos, não reduzir a qualidade de handoff, não remover salvaguardas de segurança ou consentimento e não substituir comportamento validado por uma simplificação sem evidência.

[^swebench]: Jimenez, C. E. et al. [SWE-bench: Can Language Models Resolve Real-World GitHub Issues?](https://arxiv.org/abs/2310.06770), ICLR 2024.
[^se-agents]: Liu, J. et al. [A Survey on Large Language Model based Autonomous Agents for Software Engineering](https://arxiv.org/abs/2409.02977), ACM Transactions on Software Engineering and Methodology, 2025.
[^react]: Yao, S. et al. [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629), 2022.
[^traceability]: Nair, S. et al. [A survey on requirements traceability](https://doi.org/10.1007/s00766-016-0252-5), Requirements Engineering, 2017.
[^bdd]: Binamungu, L. P., Embury, S. M. and Konstantinou, N. [Characterising the Quality of Behaviour Driven Development Specifications](https://pmc.ncbi.nlm.nih.gov/articles/PMC7251619/), 2020.
[^runtime-verification]: D'Angelo, B. et al. [A survey of challenges for runtime verification from advanced application domains](https://doi.org/10.1007/s10703-019-00337-w), Formal Methods in System Design, 2019.
[^sre]: Google. [Site Reliability Engineering](https://sre.google/sre-book/table-of-contents/), 2016.
[^devsecops]: Zhao, X., Clear, T., Lal, R. [Identifying the primary dimensions of DevSecOps: A multi-vocal literature review](https://www.sciencedirect.com/science/article/pii/S0164121224001080), Journal of Systems and Software, 2024.
[^hax-ide]: Sergeyuk, A. et al. [Human-AI Experience in Integrated Development Environments: A Systematic Literature Review](https://arxiv.org/abs/2503.06195), Empirical Software Engineering, 2026.
[^code-as-harness]: Ning et al. [Code as Agent Harness](https://arxiv.org/abs/2605.18747), arXiv, 2026.

## Autor

**André Almeida**

- Site: https://andrealmeidadc.com
- LinkedIn: https://linkedin.com/in/andrealmeidadc

## Licença

MIT. Consulte `LICENSE`.

## Verificação de versão com consentimento

A skill pode ser configurada para se autoverificar no início de uma tarefa relevante. Quando houver acesso à internet e ferramentas Git ou HTTP disponíveis, o agente deve consultar o repositório de origem, ler o `README.md` público, comparar a cópia local com a versão upstream e explicar ao usuário se encontrou mudanças relevantes.

Essa checagem não é autoatualização silenciosa. A regra é de **verificação com consentimento**: o agente resume o que mudou, explica o possível impacto na tarefa atual e pergunta se o usuário deseja atualizar a skill antes de prosseguir. O protocolo detalhado está em [`references/version-check.md`](references/version-check.md).

No `AGENTS.md` do projeto, adicione uma instrução curta:

```md
Quando a tarefa envolver descoberta de produto, PRD, alteração de código, feature, bugfix, refatoração, teste, release ou avaliação pós-lançamento, use a skill `harness-engineering-coding-agent`.
```

## Histórico de alterações

| Data | Hora | Motivo |
|---|---|---|
| 2026-05-28 | 13:05 GMT-3 | Reorganização para repositório público portátil, separando skill principal, referências, templates, documentação humana e validação local. |
| 2026-05-29 | 05:52 GMT-3 | Incorporação de camada de especificação semântica, referência a state-of-the-art review e template `SEMANTIC_SPEC.md` após análise de artigo sobre VibeCoding State-of-the-Art-Driven Development. |
| 2026-05-29 | 06:00 GMT-3 | Inclusão de base acadêmica e técnica no storytelling inicial, conectando a skill a pesquisas sobre agentes LLM, SWE-bench, BDD, rastreabilidade, verificação, DevSecOps, SRE e colaboração humano-IA. |
| 2026-05-29 | 06:05 GMT-3 | Inclusão de base acadêmica, documento `academic-foundations.md` e adaptação do padrão `grill-me` como `DECISION_GRILL.md`. |
| 2026-06-01 | 18:45 GMT-3 | Inclusão das regras leves de higiene de coding e do protocolo de verificação de versão com consentimento antes de atualizar a skill local. |
| 2026-06-04 | 12:26 GMT-3 | Atualização da documentação pública para refletir o fundamento **Code as Agent Harness**, a telemetria do harness, os campos aprimorados de continuidade em `STATE.md` e `HANDOFF.md` e a regra de melhoria sem regressão do harness. |
