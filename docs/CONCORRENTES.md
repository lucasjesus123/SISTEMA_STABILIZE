# O que os grandes sistemas fazem — e o que vale trazer

Levantamento dos sistemas de gestão de academia mais usados no Brasil,
com o que cada um faz bem, o que já temos, e o que vale construir.

**Fonte:** documentação pública de API, páginas de produto e as telas
enviadas pelo cliente (Pacto, Evo/Body Edge, Cloud Gym, Fiti).
**Data:** agosto de 2026.

Uma ressalva que atravessa o documento: nenhum sistema foi contratado
nem testado por dentro. O que está aqui vem de documentação pública e
das capturas de tela — é bom para decidir o que construir, e não serve
como afirmação sobre como cada concorrente funciona internamente.

---

## 1. O quadro

| | Evo (ABC) | Tecnofit | Next Fit | Pacto | **Stabilize hoje** |
|---|---|---|---|---|---|
| Financeiro completo | ✅ | ✅ | ✅ | ✅ | ✅ |
| Agenda e aulas | ✅ | ✅ | ✅ | ✅ | ✅ |
| Indicadores de gestão | ✅ | ✅ | ✅ | ✅ | ✅ |
| Comissão por profissional | ✅ | ✅ | ✅ | ✅ | ✅ |
| Prontuário / anamnese | parcial | parcial | ✅ | parcial | schema pronto |
| **Prescrição de treino** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **App do aluno** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Catraca / controle de acesso** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **CRM / funil de vendas** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Cobrança recorrente automática** | ✅ | ✅ | ✅ | ✅ | parcial |
| **API pública + webhooks** | ✅ | — | — | — | ❌ |
| Isolamento multi-tenant provado | ? | ? | ? | ? | ✅ |
| Auditoria de leitura de prontuário | ? | ? | ? | ? | ✅ |

As duas últimas linhas não são vaidade: nenhum concorrente publica como
garante isolamento entre empresas, e nós temos prova executável. É a
coisa mais defensável que o sistema tem hoje.

---

## 2. O que cada um faz bem

### Evo (ABC Fitness) — a API

O único com **API pública documentada**, e é aí que está a lição. A
organização dos recursos é a de quem já operou o problema:

```
/receivables    obter, marcar como pago, centros de custo
/sales          obter, criar venda, itens da venda
/services       serviços oferecidos
/vouchers       vales e cortesias
/workouts       listar treinos, associar treino a cliente
/webhooks       criar, listar, remover
```

Três decisões que vale copiar:

**Webhooks como recurso de primeira classe**, com CRUD próprio. Não é
detalhe de integração — é o que permite a academia plugar o sistema em
qualquer outra ferramenta sem pedir nada ao fornecedor. Quem tem webhook
não precisa que o fornecedor construa cada integração.

**Paginação explícita com `take`/`skip`**, 50 por padrão e teto de 100.
Teto no servidor, exatamente como já fazemos — a diferença é que eles
documentam o limite, e documentar é o que evita o cliente construir em
cima de uma suposição errada.

**"Marcar como pago" é endpoint próprio**, não um `PATCH` genérico no
lançamento. Baixa de pagamento é uma operação de negócio com regras
próprias, e tratá-la como edição de campo convida a burlar essas regras.
Nós já separamos assim (`POST /lancamentos/:id/pagamentos`).

### Cloud Gym — o painel de BI

A tela enviada mostra o vocabulário completo de gestão de academia:

> Active Customers · New Customers · Active Contracts · Finished ·
> Cancellations · Churn · Renewal · Retained · Migrated · Future
> contracts · Base retention · Average customer lifespan · Prospect ·
> Conversion % · Average ticket · Average cost per customer · LTV ·
> Pending payment · Average frequency per day · Average check-ins per
> day · **Risk of abandonment**

Já temos: ativos, novos, churn, tempo médio de vida, ticket médio, LTV,
inadimplência, frequência e **risco de abandono**.

Faltam, em ordem de valor:
1. **Taxa de renovação** — quantos renovam ao fim do plano. Mais
   acionável que churn, porque tem data marcada: dá para agir antes.
2. **Contratos futuros** — receita já contratada. É o que responde
   "posso contratar mais um professor?".
3. **Conversão de leads** — depende do CRM, que ainda não existe.
4. **Custo médio por aluno** — exige rateio de despesa, que o schema
   já suporta por categoria.

### Next Fit — treino e acesso

- **Biblioteca de exercícios pré-cadastrada.** O diferencial não é a
  prescrição; é não obrigar o professor a digitar "Supino reto" pela
  milésima vez. Sem biblioteca, o módulo de treino não é usado.
- **Avaliação física integrada ao app**, com o aluno vendo a própria
  evolução. Nosso schema de anamnese e evolução já guarda isso; falta
  a tela e o app.
- **Acesso por QR Code e reconhecimento facial.**
- **Funil de vendas** — lead vira aluno com etapas rastreadas.

### Tecnofit — integração física

- **Catracas**: Henry, TopData, ControlID, Trix, Tecnibra, Proveu. É
  commodity no mercado brasileiro — academia com catraca não compra
  sistema que não integra.
- **Pix** para recebimento instantâneo.
- **App do aluno com check-in, ficha de treino e pagamento.**

### Pacto — a ficha do cliente

A tela mostra o perfil como **centro de gravidade** do sistema, não uma
lista de campos: identidade e etiquetas de situação no topo (Ativo,
Normal, Gympass), e o resto em blocos — dados pessoais, plano,
pagamento, vínculos. Com ações contextuais ali mesmo: caixa em aberto,
vendas, atualizar.

A lição de desenho: **quem atende abre a ficha do aluno e resolve tudo
dali**. Nossa listagem de alunos ainda não tem essa tela, e é a de maior
retorno imediato.

### Fiti — o app

Estética escura com acento vivo, cartões de aula com vagas
(`1/15`), agenda por dia, treinos por grupo muscular, histórico,
biometria facial com instruções passo a passo, e uma barra de
progresso do pacote (`3/10 sessões`) que responde sozinha a
"quanto ainda tenho?".

---

## 3. O que trazer, em ordem

### Agora — o que falta para o sistema ser usável no balcão

**1. Ficha do aluno (tela de perfil).** O padrão Pacto: identidade e
situação no topo, blocos de dados pessoais / plano / pagamento /
vínculos, com ações no lugar. É onde a recepção passa o dia. Todo o
schema já existe.

**2. Cadastro e edição de aluno.** Hoje só listamos e lemos. Sem
escrita, o sistema não substitui a planilha.

**3. Prontuário na tela** — anamnese, evolução e anexos. Schema pronto,
inclusive auditoria de leitura, que nenhum concorrente anuncia ter.

**4. Saldo de pacote de sessões.** O `3/10 sessões` do Fiti responde a
pergunta que mais chega no balcão. `student_contracts.sessions_included`
já existe; falta descontar as presenças e mostrar.

### Antes de vender para outra academia

**5. Prescrição de treino com biblioteca de exercícios.** Sem biblioteca
o módulo não é usado — a biblioteca é o produto, não a prescrição.

**6. Taxa de renovação e contratos futuros.** Mais acionáveis que churn:
têm data marcada, então dá para agir antes.

**7. App do aluno (PWA).** Agenda, check-in, treino, evolução e
financeiro. PWA e não nativo: um só código para celular, tablet e
desktop, sem loja de aplicativos no caminho.

**8. Cobrança recorrente automática com Pix.** Já temos recorrência
idempotente no banco; falta o gateway.

### Quando houver mais de uma unidade

**9. API pública com webhooks**, no formato do Evo. É o que permite
plugar em qualquer ferramenta sem depender de nós.

**10. Integração com catraca.** Commodity no mercado brasileiro.

**11. CRM com funil de vendas.**

### Deliberadamente fora

**Reconhecimento facial.** Biometria é dado sensível na LGPD (art. 5º,
II) e exige base legal própria, consentimento específico e um
encarregado de dados. Não é um recurso a mais na tela: é uma mudança no
nível de responsabilidade legal da academia. Vale construir quando for
uma decisão de negócio consciente, com apoio jurídico — não porque o
concorrente tem.

**Prescrição de treino "com IA".** Todos anunciam. Antes disso é preciso
ter a biblioteca de exercícios e o histórico de evolução; sem essa base,
sugestão automática é chute com um nome bonito.

---

## 4. Onde já estamos à frente

Não por acaso, e vale defender:

- **Isolamento entre empresas provado por execução**, com prova
  executável que roda no CI. Nenhum concorrente publica como garante
  isso.
- **Auditoria de LEITURA de prontuário.** Prontuário é dado de saúde;
  saber quem alterou não ajuda a investigar o caso mais provável, que é
  alguém ter olhado o que não devia.
- **Dupla marcação impossível por restrição do banco**, não por
  validação em código — que é uma corrida que dois cliques simultâneos
  vencem.
- **Aritmética financeira em centavos inteiros**, com invariante testada
  de que a soma das partes é igual ao total.
- **Indicadores com numerador e denominador**, não só percentual.

---

*Levantado a partir de documentação pública e das telas enviadas.
Nenhum sistema foi contratado ou testado por dentro — serve para
priorizar, não como afirmação sobre o funcionamento interno de cada um.*

**Fontes:** [EVO API](https://api.abcevo.com/) ·
[Evo — integração](https://evohelp.w12app.com.br/pt-BR/articles/11830973-integracao-evo-api) ·
[Next Fit](https://nextfit.com.br/sistema-para-academia/) ·
[Tecnofit](https://www.tecnofit.com.br/produtos/tecnofit-gym/) ·
[Next Fit — catracas](https://blog.nextfit.com.br/sistema-academia-com-catraca/) ·
[Pacto — KPIs](https://blog.sistemapacto.com.br/indicadores-da-academia-kpis/)
