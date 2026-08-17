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
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO stabilize_app;

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
