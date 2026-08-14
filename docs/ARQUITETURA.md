# Arquitetura — como as abas se conversam

Você descreveu o diferencial do sistema assim: *"todas as abas se comunicam,
uma libera comando para a outra"*. Este documento é o mapa disso — o desenho
que faz um agendamento virar presença, comissão e cobrança sem ninguém digitar
a mesma coisa duas vezes.

O princípio: **cada dado é digitado uma vez, num lugar só, e todo o resto
deriva dele.** Redigitar é onde nasce divergência — a agenda diz uma coisa, o
financeiro diz outra, e ninguém sabe qual está certo.

---

## O fluxo central: um atendimento

Este é o caminho que atravessa o sistema inteiro. Tudo parte daqui.

```
┌─────────────────┐
│  CADASTRO DO    │  Aluno entra uma vez. Nome, WhatsApp, aniversário,
│     ALUNO       │  contrato (mensalista ou avulso), profissional.
└────────┬────────┘
         │
         │ vincula ──────────────────────────────┐
         ▼                                       │
┌─────────────────┐                              ▼
│    CONTRATO     │                    ┌──────────────────┐
│  plano, valor,  │                    │ student_         │
│  % de comissão  │                    │ professionals    │
└────────┬────────┘                    │                  │
         │                             │ É esta tabela    │
         │                             │ que responde     │
         ▼                             │ "quais alunos    │
┌─────────────────┐                    │ são deste        │
│     AGENDA      │◄───────────────────│ professor"       │
│                 │  disponibilidade   └──────────────────┘
│  aluno escolhe: │  do profissional            │
│  dia · horário  │                             │ define o ESCOPO
│  profissional   │                             │ de tudo que o
└────────┬────────┘                             │ professor vê
         │                                      ▼
         │ ao confirmar, o BANCO recusa se o profissional,
         │ a sala ou o aluno já estiverem ocupados naquele horário
         │
         ├──────────────┬──────────────┬──────────────┐
         ▼              ▼              ▼              ▼
┌──────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│   PRESENÇA   │ │  EVOLUÇÃO  │ │ FINANCEIRO │ │   SALA     │
│              │ │            │ │            │ │            │
│ compareceu?  │ │ profissio- │ │ avulso →   │ │ fica       │
│ faltou?      │ │ nal regis- │ │ gera conta │ │ ocupada na │
│              │ │ tra a      │ │ a receber  │ │ agenda da  │
│ alimenta o   │ │ sessão no  │ │            │ │ academia   │
│ contador do  │ │ prontuário │ │ mensalista │ │            │
│ mês          │ │            │ │ → já está  │ │ ninguém    │
└──────────────┘ └────────────┘ │ na recor-  │ │ marca em   │
                                │ rência     │ │ cima       │
                                └─────┬──────┘ └────────────┘
                                      │
                                      ▼
                            ┌────────────────────┐
                            │     COMISSÃO       │
                            │                    │
                            │ % do contrato      │
                            │ aplicado sobre o   │
                            │ que foi recebido   │
                            │                    │
                            │ o professor vê a   │
                            │ memória de cálculo │
                            │ linha a linha      │
                            └────────────────────┘
```

### O que isso significa na prática

Quando o aluno marca um horário pelo aplicativo:

1. **A agenda** só oferece horários que o profissional declarou como
   disponíveis, descontando o que já está ocupado.
2. **O banco recusa** a marcação se houver choque — de profissional, de sala ou
   do próprio aluno. Não é validação em código, é restrição: dois cliques
   simultâneos não conseguem furar.
3. **A sala fica bloqueada** na agenda da academia no mesmo instante.
4. **Se o aluno é mensalista**, nem aparece valor — já está no contrato.
   **Se é avulso**, o valor da sessão vem do contrato e a cobrança é gerada.
5. **Ao comparecer**, a presença alimenta o contador do mês.
6. **O profissional registra a evolução**, que fica no prontuário.
7. **No fechamento**, a comissão sai do que foi efetivamente recebido — não do
   que foi cobrado.

Ninguém digita o valor duas vezes. Ninguém marca dois alunos na mesma sala.
Ninguém precisa lembrar de dar baixa em três lugares.

---

## Quem vê o quê

O mesmo dado aparece diferente conforme quem olha. Isto não é filtro de tela —
é recorte aplicado no servidor, a partir do token.

| | Proprietário | Admin | Profissional | Recepção | Aluno |
|---|---|---|---|---|---|
| Alunos | todos | todos | **só os seus** | todos | **só ele** |
| Prontuário / anamnese | ✅ | leitura | **só os seus** | ❌ | ❌ |
| Agenda | todas | todas | própria + ocupação | todas | própria |
| Financeiro da empresa | ✅ | ✅ | ❌ | ❌ | ❌ |
| Comissões | todas | todas | **só as suas** | ❌ | ❌ |
| Preços | ✅ | ✅ | ❌ | leitura | ❌ |
| Auditoria | ✅ | ✅ | ❌ | ❌ | ❌ |

Três recortes merecem explicação:

**O profissional vê a ocupação dos colegas, mas não os alunos deles.** Ele
precisa saber que a Sala 2 está ocupada às 9h para não marcar em cima — mas não
precisa saber quem está lá. A agenda devolve blocos anonimizados.

**A recepção não lê prontuário.** Ela agenda, cadastra e registra presença.
Anamnese e evolução são dado de saúde e não fazem parte do trabalho dela.

**O aluno não vê valor se for mensalista.** A tela não mostra preço porque não
há preço por sessão no contrato dele — e mostrar zero seria confuso.

---

## Por que o financeiro é uma tabela só

`finance_entries` guarda contas a pagar e a receber juntas, distinguidas por
`direction`. A alternativa — duas tabelas simétricas — parece mais organizada e
é pior:

- Fluxo de caixa, conciliação e busca por vencimento operam sobre os **dois**
  lados. Com duas tabelas, toda consulta vira `UNION`.
- Toda regra precisaria ser escrita duas vezes, e um dia as duas divergem.

O que **não** fica na mesma tabela é o pagamento. `finance_payments` é separada
porque um lançamento pode receber várias baixas (parcial hoje, resto semana que
vem). O total pago e o status são **derivados** dos pagamentos por gatilho —
nunca escritos pela aplicação, para o extrato não poder divergir dos recibos.

---

## Por que a comissão sai do recebido, não do cobrado

Se a comissão saísse do valor **cobrado**, o professor receberia sobre
mensalidade que o aluno nunca pagou, e a academia pagaria comissão de
inadimplência do próprio bolso.

Por isso `commissions` guarda `base_cents` (a base de cálculo), `rate_bp` (a
alíquota) e `amount_cents` (o resultado) — os três, e não só o resultado.
Guardar apenas o valor final tornaria impossível conferir a conta seis meses
depois, quando a tabela de preços já mudou.

`commission_items` guarda a memória de cálculo linha a linha, para o
profissional ver de onde veio cada centavo.

---

## Onde o histórico é preservado

Uma regra que atravessa o sistema: **mudar uma configuração hoje não pode
reescrever o passado.**

| Tabela | O que guarda | Por quê |
|---|---|---|
| `student_contracts` | `amount_cents` e `commission_bp` próprios | Aumentar a tabela de preços amanhã não pode alterar o que já foi cobrado |
| `finance_entries` | `amount_cents` do lançamento | O valor é o daquele mês, não o atual |
| `commissions` | base, alíquota e resultado | A conta precisa ser conferível depois |
| `appointments` | `price_cents` da sessão | O preço praticado naquele dia |

---

## Aniversário no WhatsApp

O `birth_date` do cadastro alimenta um índice parcial sobre `(mês, dia)`, para
a rotina diária não varrer a tabela inteira.

A mensagem tem `idempotency_key` única por tenant: se o cron rodar duas vezes —
por reinício, por deploy, por falha e retry — o aluno recebe **uma** felicitação,
não duas. Idempotência aqui não é refinamento; é a diferença entre parecer
atencioso e parecer defeituoso.

---

## O que ainda não existe

Sendo explícito, para o mapa acima não ser confundido com o estado atual:

| Peça | Estado |
|---|---|
| Schema completo do fluxo acima | ✅ Construído e verificado |
| Isolamento e recortes de acesso | ✅ Construídos e testados |
| Aritmética de comissão e rateio | ✅ Construída e testada |
| Rotas HTTP que ligam as peças | ⬜ Não construídas |
| Telas | ⬜ Não construídas |
| Disparo de WhatsApp | ⬜ Schema pronto, integração não construída |
| Relatórios em PDF | ⬜ Não construídos |

O desenho está fechado e o banco já o sustenta. O que falta é a camada que
expõe isso — e ela precisa ser construída seguindo os padrões descritos em
[`../README.md`](../README.md#convenções-para-quem-for-continuar).
