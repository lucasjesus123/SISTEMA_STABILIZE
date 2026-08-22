# Relatório de avaliação — Identidade da Academia

## O que mudou

| Camada | Arquivo | O quê |
|---|---|---|
| Banco | `026_identidade_da_academia.sql` | logo, telefone, endereço em `tenants` + 6 restrições |
| API | `modules/academia/` | fonte única: `GET/PUT /api/academia`, `POST/GET/DELETE /api/academia/logo` |
| PDF | `reports/documento.ts` | logo no cabeçalho, marca d'água por página, contato no rodapé |
| PDF | `reports/timbre.ts` | a costura entre identidade e documento — o único ponto onde se encontram |
| PDF | `reports/*.routes.ts` | os 5 relatórios passaram a ler o nome da fonte |
| Auditoria | `audit/audit.ts` | `academia.update`, `academia.logo` |

## O defeito que já estava em produção

`academia: 'Stabilize — Clínica do Músculo'` estava **escrito à mão** em
quatro dos cinco relatórios. Toda academia que emitisse qualquer PDF
recebia o nome da primeira no cabeçalho e no campo Autor do arquivo.
Não era risco futuro: estava no ar. Coberto agora por um teste que falha
se a string voltar.

## Sensores executados

| Comando | Resultado |
|---|---|
| `tsc --noEmit` (api) | limpo |
| `vitest run src/modules/academia` | **15/15** |
| `vitest run` (suíte inteira) | **332 passaram**, 18 puladas — eram 317 antes, +15 novos, 0 regressão |
| Restrições do banco, por execução | 7 recusas corretas, 2 aceites corretos |
| Render real do PDF (pymupdf, 100 dpi) | 2 páginas, marca d'água em ambas, centrada em (415,582) contra centro (413,584) |
| Diff de texto com/sem timbre | só o contato acrescentado; nenhuma linha de conteúdo perdida |

## Erros meus neste item, e o que os pegou

1. **Falso-positivo nas restrições.** Rodei os `UPDATE` de teste sem
   contexto de tenant; a RLS `FORCE` barrou antes da restrição ser
   avaliada e voltou `UPDATE 0` em tudo — zero linha tocada, zero
   restrição exercitada, e o resultado parecia aprovação total. Pego por
   desconfiar do "passou em tudo". Refeito com `set app.tenant_id` e uma
   linha de sanidade exigindo `UPDATE 1` antes de concluir qualquer
   coisa.

2. **`RETURNING` com subquery para descobrir a chave antiga do logo.**
   Parecia elegante e dependia de qual snapshot o PostgreSQL usa dentro
   do `RETURNING` — sutileza demais para o valor que decide **apagar um
   arquivo**. Errar apagaria o logo recém-enviado. Trocado por duas
   instruções na mesma transação.

3. **Substituição por substring quebrou a indentação e duplicou linhas.**
   O padrão de 6 espaços casou dentro do de 8. Pego pelo `grep -c`
   (7 inserções para 4 relatórios). Revertido e refeito casando a linha
   inteira com âncora.

## Pontos cegos assumidos

- **A qualidade em papel não foi testada** — só dimensão, presença e
  legibilidade na tela. Ninguém imprimiu.
- **PNG exótico** (entrelaçado, 16 bits) não foi exercitado. O código
  cai para "sem marca" em vez de quebrar, mas o caminho não tem teste.
- **AC-23 a AC-30 (carteirinha e tela) ainda não existem** — próxima
  fatia deste mesmo item.
- `NFR-01` (custo do timbre) **não foi medido**.

## Follow-ups registrados

1. `tenantDe` está duplicado em três arquivos. Extrair — fora do escopo
   deste item, não vira mudança silenciosa.
2. Migrar as configurações espalhadas (`checkin/config`,
   `triagem/perguntas`, WhatsApp) para o módulo `academia`.
