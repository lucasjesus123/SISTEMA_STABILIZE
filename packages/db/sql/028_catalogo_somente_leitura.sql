-- =====================================================================
-- O catálogo de exercícios volta a ser somente leitura para a API.
--
-- O QUE ESTAVA ERRADO, e por que passou despercebido
--
-- `exercise_catalog` é a ÚNICA tabela do sistema sem tenant_id e sem
-- RLS, e isso é de propósito: é conteúdo do produto, igual para todas as
-- academias, copiado para a tabela `exercises` de cada uma no momento em
-- que a academia nasce. A academia edita a cópia dela; o catálogo é
-- semente.
--
-- A migração 011 escreveu a intenção sem meias palavras:
--
--     REVOKE ALL ON exercise_catalog FROM PUBLIC;
--     GRANT SELECT ON exercise_catalog TO stabilize_app;
--
-- Só que o banco vivo mostrava outra coisa:
--
--     stabilize_app: DELETE, INSERT, SELECT, UPDATE
--
-- O motivo é sutil e vale registrar. O `ALTER DEFAULT PRIVILEGES` do
-- 000_roles.sql concede DML ao `stabilize_app` em toda tabela nova, no
-- instante do CREATE TABLE. O `REVOKE ... FROM PUBLIC` que veio a
-- seguir não desfaz isso: PUBLIC e um papel nomeado são concessões
-- diferentes, e tirar de um não tira do outro. O GRANT de SELECT logo
-- abaixo parecia fechar a questão — mas SELECT foi somado ao que já
-- estava lá, não colocado no lugar.
--
-- QUAL É O RISCO DE VERDADE
--
-- Hoje, nenhum: nenhuma rota da API escreve nesta tabela — o catálogo é
-- populado pela própria 011, rodando como migrator. O problema é o que
-- isso deixa em aberto num sistema multi-empresa: esta é a única tabela
-- que TODAS as academias leem, e a conexão da aplicação podia
-- escrever nela. Uma rota futura escrita sem atenção, ou qualquer falha
-- que alcance esse papel, deixaria uma academia alterar a biblioteca
-- que todas as outras enxergam. Permissão que ninguém usa é permissão
-- que ninguém percebe estar usando errado.
--
-- Isolamento não se sustenta em "nenhum código faz isso hoje". Se a
-- aplicação não precisa escrever, ela não pode poder.
-- =====================================================================

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON exercise_catalog FROM stabilize_app;

-- E o mesmo cuidado para o que vier depois: sem isto, a próxima tabela
-- de conteúdo do produto nasce com o mesmo excesso e o mesmo silêncio.
-- Deixado como comentário deliberado, e não como comando: mexer no
-- ALTER DEFAULT PRIVILEGES aqui mudaria o padrão de TODAS as tabelas,
-- inclusive as que precisam de DML. O lugar disso é o 000_roles.sql, com
-- a lista explícita — e é decisão de quem for escrever a próxima tabela
-- global, não desta migração.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_name = 'exercise_catalog'
       AND grantee    = 'stabilize_app'
       AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'stabilize_app ainda escreve em exercise_catalog';
  END IF;
END $$;
