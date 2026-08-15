-- =====================================================================
-- Correção de índice, guiada por medição
--
-- O índice de aniversariantes criado em 001 NUNCA era usado. Verificado
-- com 6.000 alunos em 30 empresas: mesmo desligando seqscan e
-- bitmapscan, o planner recusava `idx_students_birthday` e caía em outro
-- índice, filtrando 199 de 200 linhas na mão. `pg_stat_user_indexes`
-- confirmava: idx_scan = 0.
--
-- A causa é a expressão. Em PostgreSQL 14+, `EXTRACT(MONTH FROM data)`
-- devolve `numeric`, e a forma como o parser normaliza a expressão no
-- índice não casa com a da query — o planner não reconhece as duas como
-- equivalentes e o índice fica inalcançável.
--
-- Um índice que nunca é usado é pior do que nenhum: ocupa espaço (504 kB
-- aqui), precisa ser atualizado em todo INSERT e UPDATE de aluno, e — o
-- que mais importa — dá a impressão de que a consulta está otimizada
-- quando ela está varrendo a tabela.
--
-- A solução é tirar a expressão da query e materializá-la numa COLUNA
-- GERADA. O valor passa a ser um smallint simples (MMDD), o índice é um
-- b-tree comum, e não há expressão para o planner ter que reconhecer.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Coluna gerada: 15 de março → 315 ; 25 de dezembro → 1225
--
-- STORED e não VIRTUAL porque precisamos indexá-la. O PostgreSQL só
-- aceita colunas geradas STORED, e a expressão precisa ser IMMUTABLE —
-- EXTRACT sobre `date` é, ao contrário de EXTRACT sobre `timestamptz`,
-- que depende do fuso da sessão.
-- ---------------------------------------------------------------------
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS birth_month_day smallint
  GENERATED ALWAYS AS (
    CASE
      WHEN birth_date IS NULL THEN NULL
      ELSE (EXTRACT(MONTH FROM birth_date) * 100 + EXTRACT(DAY FROM birth_date))::smallint
    END
  ) STORED;

-- O índice morto sai. Manter os dois seria pagar escrita duas vezes.
DROP INDEX IF EXISTS idx_students_birthday;

-- ---------------------------------------------------------------------
-- Índice novo.
--
-- Parcial em `status = 'ACTIVE'`: a rotina de felicitação só interessa
-- por aluno ativo, e restringir aqui deixa o índice menor e mais denso.
--
-- A ordem das colunas é (birth_month_day, tenant_id), invertendo a
-- convenção do resto do schema. O motivo é o padrão de acesso: a rotina
-- diária pergunta "quem faz aniversário HOJE, em qualquer empresa?" e
-- depois separa por empresa. Com tenant_id na frente, seriam 30 buscas
-- independentes; com a data na frente, é uma só.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_students_birthday_md
  ON students (birth_month_day, tenant_id)
  WHERE birth_month_day IS NOT NULL AND status = 'ACTIVE';

-- ---------------------------------------------------------------------
-- Índices que a medição mostrou faltar
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Busca por nome: índice DELIBERADAMENTE NÃO CRIADO
--
-- A tentação era um índice GIN com pg_trgm, que é o que permite indexar
-- ILIKE '%termo%' (b-tree só serve para prefixo). Foi testado e
-- DESCARTADO, por medição.
--
-- No alvo real — 30 empresas, algumas centenas de alunos cada — a RLS já
-- reduz a busca a ~200 linhas antes do filtro de texto. Descartar 189 de
-- 200 linhas custa 0,3 ms. O planner testou o GIN e preferiu não usá-lo,
-- corretamente: manter o índice seria pagar escrita em todo cadastro e
-- edição de aluno para economizar décimos de milissegundo que ninguém
-- percebe.
--
-- Criar um índice que o planner ignora é o mesmo erro que este arquivo
-- veio corrigir. Fica registrado para que a ideia não seja "redescoberta"
-- depois sem medição.
--
-- QUANDO REVISITAR: se algum tenant passar de ~50 mil alunos, ou se a
-- busca deixar de ser por tenant único. Aí o GIN passa a valer, e a
-- decisão muda com a evidência.

-- Contas a receber em aberto ordenadas por vencimento: o índice parcial
-- de 001 existia, mas sem `direction` na frente o planner preferia
-- outro. Com as duas colunas na ordem em que a query filtra, ele passa
-- a usar — e o ORDER BY sai de graça.
CREATE INDEX IF NOT EXISTS idx_entries_abertas
  ON finance_entries (direction, due_date, tenant_id)
  WHERE status IN ('OPEN', 'PARTIALLY_PAID', 'OVERDUE') AND cancelled_at IS NULL;

-- ---------------------------------------------------------------------
-- Estatísticas atualizadas para o planner enxergar os índices novos.
-- ---------------------------------------------------------------------
ANALYZE students;
ANALYZE finance_entries;
