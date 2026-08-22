# Plano de teste — Identidade da Academia

## Sensores computacionais (rodam sozinhos)

| Sensor | Comando | Cobre |
|---|---|---|
| Testes da API | `pnpm --filter @stabilize/api exec vitest run` | AC-01…14, 19, 20, 22 |
| Testes do PDF | idem, arquivo `timbre.test.ts` | AC-15…18, 21 |
| Typecheck | `pnpm -r exec tsc --noEmit` | NFR-02 |
| Suíte completa antes/depois | contagem de testes | NFR-03 |
| Prova de isolamento | `900_isolation_test.sql` + `AC-12` | SEC-001 |

## Verificação no navegador (Chromium real)

AC-23 a AC-30. Roteiro: entrar como admin → abrir Academia → subir um
PNG → conferir a pré-visualização → salvar → abrir a carteirinha de um
aluno → emitir um relatório → medir a largura impressa.

## O teste que decide o item

**AC-17 — a marca d'água não pode comer o texto.** É o defeito que
passa despercebido: o PDF abre, parece bonito, e o texto está atrás de
uma imagem. Um humano folheando não nota; quem tenta copiar um valor
nota.

Método: gerar o mesmo relatório **com** e **sem** logo, extrair o texto
dos dois e exigir igualdade. Se a marca estiver por cima, o extrator
ainda acha o texto — então este teste sozinho não basta, e é honesto
dizer: ele prova que o texto não sumiu, não que está visível. A prova
visual é um screenshot da página renderizada, conferido a olho, uma vez.

## Massa de teste

- Academia **com** logo, telefone e endereço → caminho feliz.
- Academia **sem** nada disso → AC-19, AC-20 (nenhum relatório pode quebrar).
- Duas academias com logos diferentes → AC-12, o teste de isolamento.
- Relatório longo (30+ alunos) → AC-21, marca d'água em todas as páginas.

## Pontos cegos assumidos

- **Não testo qualidade de impressão em papel.** Só dimensão e presença.
- **Não testo todo formato de PNG** (entrelaçado, paleta, 16 bits). Testo
  o que o PDFKit aceita; se um PNG exótico falhar, aparece no upload e
  não no relatório — que é o desenho pretendido de D3.
- **Não meço consumo de disco a longo prazo.** AC-14 prova que trocar o
  logo não deixa órfão; não prova que nada mais acumula.
