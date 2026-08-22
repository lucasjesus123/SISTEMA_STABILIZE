# Contrato — Identidade da Academia

**Item 1 de 5 do plano de evolução.** Classificação: `feature` + `security-data`
(upload de arquivo, dado de empresa, isolamento multi-tenant).
Modo: `solo` com sensores determinísticos no lugar do par revisor.

---

## 1. Problema

O relatório em PDF sai sem marca. O cabeçalho é uma linha de texto e o
rodapé diz apenas `nome · emitido em · página`. Não há logo, marca
d'água, telefone nem endereço. Um relatório de avaliação física entregue
ao aluno — ou um financeiro entregue ao contador — não parece documento
da academia; parece saída de sistema.

A causa não é o gerador de PDF. É que **a academia não tem identidade
registrada**: a tabela `tenants` guarda `name`, `slug`, `document`
(CNPJ) e `timezone`. Não existe logo, endereço nem telefone em lugar
nenhum do sistema.

## 2. Por que agora

É pré-requisito de tudo que vem depois. Papel timbrado, carteirinha com
a marca certa, termo do PAR-Q e mensagem de WhatsApp assinada pela
academia — os quatro leem a mesma fonte. Construir o timbre antes da
fonte seria escrever o logo da Stabilize dentro do gerador, e no dia em
que a segunda academia entrar, o relatório dela sai com a marca da
primeira. Num sistema multi-empresa isso não é um defeito estético: é
vazamento de identidade entre clientes.

## 3. Achado que muda o desenho

**As configurações do tenant estão espalhadas e não têm dono.** Hoje:

| Configuração | Onde mora |
|---|---|
| `bloquear_entrada_apos_dias` | `PUT /api/checkin/config` |
| `triagem_perguntas`, `termo_texto`, `triagem_validade_dias` | `PUT /api/students/triagem/perguntas` |
| `wa_confirmar_agendamento`, `wa_lembrete_horas` | módulo de WhatsApp |
| `parar_cobranca_apos_vencidas` | nenhuma tela |

Cada uma nasceu dentro do módulo que precisava dela. Acrescentar logo,
endereço e telefone como um quarto lugar disperso agravaria o problema.

**Decisão D1:** criar o módulo `academia` como **fonte única** da
identidade da empresa. As configurações antigas ficam onde estão (fora
de escopo agora), mas nenhuma nova nasce fora daqui.

## 4. Escopo

### Entra

- `BUS-001` A academia registra **logo, telefone e endereço**.
- `BUS-002` O logo aparece no **cabeçalho** dos 5 relatórios em PDF.
- `BUS-003` O logo aparece como **marca d'água** ao centro de cada página.
- `BUS-004` O **rodapé** passa a trazer telefone e endereço.
- `BUS-005` A **carteirinha** usa o logo e o nome da academia.
- `UI-001` Tela para o admin editar isso, com o CEP preenchendo o endereço.
- `SEC-001` O logo de uma academia nunca é servido a outra.

### Não entra agora

- Migrar as configurações espalhadas para o módulo novo (item próprio).
- Marca no termo do PAR-Q e no WhatsApp — dependem deste item, vêm depois.
- Cor/tema por academia. Só marca, não identidade visual completa.

## 5. Modelo de dados

Colunas novas em `tenants` (já sob RLS `FORCE`, política `tenant_self`):

| Coluna | Tipo | Nota |
|---|---|---|
| `logo_chave` | `uuid` | chave opaca no armazenamento; `NULL` = sem logo |
| `logo_mime` | `text` | `image/png` ou `image/jpeg`, e só |
| `telefone` | `text` | E.164, mesmo CHECK dos demais telefones |
| `cep` | `text` | 8 dígitos |
| `logradouro`, `numero`, `complemento`, `bairro`, `cidade` | `text` | |
| `uf` | `char(2)` | |

Endereço **estruturado**, não linha única: é o formato que a busca de
CEP já devolve (`useBuscaDeCep`), então a tela de cadastro da academia
ganha o autopreenchimento de graça. Integração, não campo novo.

## 6. Decisões técnicas

**D2 — O logo reusa `attachments/storage.ts`.** Não escrevo um segundo
caminho de gravação. O módulo existente já resolve o que erra em upload:
o nome enviado nunca toca um caminho (chave opaca em UUID), a assinatura
dos bytes é conferida contra o MIME declarado, o diretório é por tenant,
e o conteúdo é cifrado em repouso. Cifrar um logo público não traz
segurança, mas duplicar a lógica de caminho traria risco — e o custo é
irrelevante para um arquivo de ~50 KB.

**D3 — Logo aceita PNG e JPEG. Não aceita WebP nem SVG.** Duas razões
distintas, e as duas são bloqueantes:

- **WebP:** o PDFKit embute apenas JPEG e PNG. Um logo em WebP passaria
  na tela e **quebraria o relatório** — o defeito apareceria longe do
  upload, com o admin sem entender por quê.
- **SVG:** é XML, executa script, e viraria XSS servido do nosso
  domínio.

O `storage.ts` genérico continua aceitando WebP para exames. É a rota do
logo que estreita.

**D4 — A marca d'água é desenhada quando a página nasce, não no
fechamento.** O `fecharDocumento` percorre as páginas no fim para
numerá-las, e é a tentação óbvia desenhar a marca ali. Estaria errado: o
PDFKit pinta na ordem em que se chama, então a marca cairia **por cima**
do texto. A marca vai num `pageAdded`, antes de qualquer conteúdo; o
rodapé continua no fechamento, porque só lá se sabe o total de páginas.

**D5 — O logo é lido uma vez por documento.** Decifrar e decodificar a
cada página multiplicaria o custo pelo número de folhas. Um `Buffer`
carregado no início serve o cabeçalho e todas as marcas d'água.

**D6 — Academia sem logo continua emitindo relatório.** Sem marca
d'água, cabeçalho só com o nome. Um documento que se recusa a sair
porque falta um enfeite é pior que um documento sem enfeite.

## 7. Fora de dúvida — o que NÃO muda

- Nenhum relatório existente muda de conteúdo. Só ganha moldura.
- Nenhuma permissão é afrouxada. Editar a identidade exige `user:write`
  (só `OWNER` e `ADMIN`), o mesmo que conectar o WhatsApp.
- Ler o logo exige apenas estar autenticado no tenant — ele aparece na
  carteirinha do próprio aluno.

## 8. Riscos

| Risco | Mitigação |
|---|---|
| Logo de uma academia vazar para outra | `ler(tenantId, chave)` recebe o tenant do token, nunca do request. Teste de isolamento obrigatório. |
| Logo enorme estourando o PDF | Teto de 2 MB e conferência de dimensão. |
| WebP quebrando o relatório longe do upload | Recusado **no upload**, com mensagem que diz o formato aceito. |
| Marca d'água encobrindo o texto | Desenhada em `pageAdded`; teste que extrai o texto do PDF gerado. |
