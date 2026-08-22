# Critérios de aceite — Identidade da Academia

Cada critério é verificável por execução. "Passou" exige evidência —
saída de teste, status HTTP, texto extraído do PDF ou medição no
navegador. Nenhum item é marcado por leitura de código.

---

## Identidade (BUS-001)

| ID | Critério | Como se prova |
|---|---|---|
| `AC-01` | `GET /api/academia` devolve nome, CNPJ, telefone e endereço do tenant do token | teste e2e |
| `AC-02` | `PUT /api/academia` grava telefone em E.164 e endereço estruturado | teste e2e |
| `AC-03` | Telefone fora de E.164 é recusado com **422** e a mensagem diz o formato | teste e2e |
| `AC-04` | UF com 3 letras é recusada com 422 | teste e2e |
| `AC-05` | Perfil sem `user:write` (ex.: `PROFESSIONAL`) recebe **403** no `PUT` | teste e2e |

## Logo (BUS-001, SEC-001)

| ID | Critério | Como se prova |
|---|---|---|
| `AC-06` | `POST /api/academia/logo` aceita PNG e grava a chave em `tenants.logo_chave` | teste e2e |
| `AC-07` | `POST` com **WebP** é recusado com 422 e a mensagem nomeia PNG e JPEG | teste e2e |
| `AC-08` | `POST` com **SVG** é recusado com 422 | teste e2e |
| `AC-09` | Arquivo que **declara** `image/png` mas tem bytes de outra coisa é recusado | teste e2e |
| `AC-10` | Acima de 2 MB é recusado sem gravar nada em disco | teste e2e |
| `AC-11` | `GET /api/academia/logo` devolve a imagem do **próprio** tenant | teste e2e |
| `AC-12` | **A academia B, autenticada, não alcança o logo da academia A** — nem trocando id na URL, porque a chave nunca vem do request | teste e2e de isolamento |
| `AC-13` | `DELETE /api/academia/logo` apaga o arquivo do disco e zera a coluna | teste e2e |
| `AC-14` | Trocar o logo apaga o anterior — não deixa órfão acumulando disco | teste e2e |

## Papel timbrado (BUS-002, BUS-003, BUS-004)

| ID | Critério | Como se prova |
|---|---|---|
| `AC-15` | Os **5** relatórios saem com o logo no cabeçalho | teste que gera os 5 PDFs |
| `AC-16` | Cada página traz a marca d'água ao centro | contagem de XObjects de imagem por página |
| `AC-17` | **A marca d'água não encobre o texto**: o texto extraído do PDF com marca é idêntico ao sem marca | extração de texto, comparação |
| `AC-18` | O rodapé traz telefone e endereço da academia | extração de texto do PDF |
| `AC-19` | Academia **sem logo** emite os 5 relatórios normalmente, sem marca d'água e sem erro | teste e2e |
| `AC-20` | Academia sem endereço emite com o rodapé que existe hoje | teste e2e |
| `AC-21` | Relatório de 3+ páginas tem marca d'água em **todas** | teste com massa que force paginação |
| `AC-22` | O logo é decifrado **uma vez** por documento, não uma por página | espião na função de leitura |

## Carteirinha (BUS-005)

| ID | Critério | Como se prova |
|---|---|---|
| `AC-23` | A carteirinha usa o logo da academia quando existe | navegador |
| `AC-24` | Sem logo, cai para o nome da academia — sem espaço vazio nem imagem quebrada | navegador |
| `AC-25` | A largura impressa continua **85,6 mm** | medição sob `emulateMedia({media:'print'})` |

## Tela (UI-001)

| ID | Critério | Como se prova |
|---|---|---|
| `AC-26` | O admin edita nome, telefone e endereço numa tela só | navegador |
| `AC-27` | Digitar o CEP preenche logradouro, bairro, cidade e UF | navegador |
| `AC-28` | CEP indisponível mostra a mensagem certa e **não** trava o cadastro | navegador |
| `AC-29` | O logo tem pré-visualização antes de salvar | navegador |
| `AC-30` | Quem não pode editar não vê a tela | navegador |

## Não-funcionais

| ID | Critério | Como se prova |
|---|---|---|
| `NFR-01` | Gerar relatório com timbre não fica **mais de 2×** mais lento que sem | medição antes/depois |
| `NFR-02` | Typecheck limpo nos dois apps | `tsc --noEmit` |
| `NFR-03` | A suíte inteira continua verde — nenhum teste enfraquecido ou removido | contagem antes/depois |
