-- =====================================================================
-- Papéis de banco — PARTE 2: concessões sobre o schema.
--
-- Roda como `stabilize_migrator`, DEPOIS do 001_schema.sql.
--
-- A criação dos papéis está no 000_roles.sql, que roda antes do schema
-- e com credencial de superusuário; o porquê da divisão está explicado
-- lá em cima.
--
-- O que sobrou aqui é exatamente o que DEPENDE DAS TABELAS EXISTIREM, e
-- que por isso não podia ficar junto da criação dos papéis: o REVOKE do
-- final é sobre `audit_log`, que nasce no 001.
--
-- O migrator é o DONO dessas tabelas, então concede sobre elas sem
-- precisar de superusuário.
--
-- Note que NÃO há `ALTER DEFAULT PRIVILEGES` aqui. Ele está no 000, com
-- `FOR ROLE stabilize_migrator`, e vale para tudo que o migrator criar
-- daqui em diante — inclusive as tabelas dos arquivos 003 a 006. Repetir
-- neste arquivo não faria mal, mas duas fontes para a mesma regra é
-- como uma delas fica para trás.
-- =====================================================================

-- As tabelas que já existem neste ponto (as do 001).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stabilize_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stabilize_app;

-- NÃO existe aqui um `GRANT EXECUTE ON ALL FUNCTIONS`, e a ausência é
-- deliberada — ele era redundante e barulhento:
--
-- · redundante porque o PostgreSQL já concede EXECUTE a PUBLIC em toda
--   função nova. As únicas que fogem disso são as seis de 003_auth.sql e
--   006_jobs.sql, que revogam de PUBLIC de propósito — e cada uma traz o
--   seu próprio GRANT para stabilize_app, na linha seguinte. Além disso
--   este arquivo roda ANTES do 003, então nem alcançaria aquelas.
--
-- · barulhento porque "ALL FUNCTIONS" inclui as centenas de funções das
--   extensões (pgcrypto, btree_gist, citext), que o migrator não possui.
--   Cada uma virava um `WARNING: no privileges were granted for ...`:
--   250 linhas de aviso inofensivo a cada migration, exatamente o tipo
--   de ruído em que uma mensagem importante se perde.

-- ---------------------------------------------------------------------
-- O log de auditoria é append-only também no nível de privilégio.
-- A policy já nega UPDATE/DELETE; revogar o privilégio é a segunda
-- tranca, para o caso de alguém adicionar uma policy permissiva sem
-- perceber a consequência.
-- ---------------------------------------------------------------------
REVOKE UPDATE, DELETE ON audit_log FROM stabilize_app;

-- ---------------------------------------------------------------------
-- O controle de migrations não é assunto da aplicação.
--
-- O REVOKE precisa estar AQUI, e não onde a tabela é criada, por causa
-- da ordem: o migrate.sh cria `schema_migrations` antes de tudo e já a
-- revoga, mas o `GRANT ... ON ALL TABLES` algumas linhas acima roda
-- depois e a devolve para a aplicação — "ALL TABLES" é literal e não
-- tem como excluir uma. Revogar por último é o que faz valer.
--
-- Verificado inspecionando o ACL: sem esta linha, a tabela terminava
-- com `stabilize_app=arwd`, isto é, a API podendo reescrever o registro
-- de quais migrations rodaram.
-- ---------------------------------------------------------------------
DO $migr$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations') THEN
    REVOKE ALL ON schema_migrations FROM stabilize_app;
  END IF;
END
$migr$;
