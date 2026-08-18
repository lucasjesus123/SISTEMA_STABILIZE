-- =====================================================================
-- COBRANÇA RECORRENTE A PARTIR DO CONTRATO
--
-- O contrato do aluno diz quanto ele paga e a partir de quando. Faltava
-- o que transforma isso em cobrança: sem esta peça, `student_contracts`
-- é uma anotação e o financeiro só tem o que alguém lançou à mão.
--
-- O QUE ESTE ARQUIVO ACRESCENTA é apenas a garantia de unicidade. A
-- geração em si é uma tarefa da API (`gerarCobrancasDoMes`), porque
-- precisa do fuso de cada academia para saber que mês é "este mês" — e
-- fuso é coisa que se resolve uma vez, na aplicação, não espalhado por
-- gatilhos.
--
-- POR QUE A UNICIDADE É O CORAÇÃO DISTO. A tarefa roda de hora em hora.
-- Se ela puder inserir duas vezes a mensalidade de agosto do mesmo
-- aluno, o aluno passa a dever o dobro, o relatório mente e alguém
-- recebe uma cobrança que não devia. Um índice único sobre
-- (contrato, competência) torna a repetição inofensiva: a segunda
-- tentativa esbarra na restrição e não faz nada.
--
-- É a mesma ideia do índice que já existe para `recurrence_id`; este
-- cobre o caminho do contrato, que é o que a academia usa.
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_contract_competence
  ON finance_entries (contract_id, competence_date)
  WHERE contract_id IS NOT NULL AND cancelled_at IS NULL;

COMMENT ON INDEX idx_entries_contract_competence IS
  'Uma cobrança por contrato por competência. É o que torna a tarefa de geração segura para rodar quantas vezes for.';

-- Cancelada não conta para a unicidade (o índice é parcial), de
-- propósito: cancelar a mensalidade de agosto e gerar outra no lugar é
-- uma correção legítima, e o índice não pode impedi-la.
