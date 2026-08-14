-- =====================================================================
-- Papéis de banco
--
-- Este arquivo é o que faz a Row-Level Security valer alguma coisa.
--
-- RLS NÃO SE APLICA a superusuários nem a papéis com BYPASSRLS. Também
-- não se aplica ao DONO da tabela, a menos que a tabela esteja com
-- FORCE ROW LEVEL SECURITY — e o schema liga FORCE em todas.
--
-- Ainda assim, a aplicação NÃO deve conectar como dono nem como
-- superusuário. Se a API conecta como `postgres`, todas as policies do
-- arquivo anterior viram enfeite, e um único `WHERE` esquecido devolve
-- os dados de outra empresa.
--
-- Portanto: dois papéis, com propósitos distintos.
--   stabilize_migrator — dono do schema, roda migrations, NÃO usado em runtime
--   stabilize_app      — usado pela API, sem DDL, sem BYPASSRLS
-- =====================================================================

-- ATENÇÃO: troque as senhas abaixo. Elas são placeholders de instalação;
-- as senhas reais devem vir do gerenciador de segredos da VPS e nunca
-- entrar no repositório.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stabilize_app') THEN
    CREATE ROLE stabilize_app LOGIN PASSWORD 'TROQUE_ESTA_SENHA_APP';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stabilize_migrator') THEN
    CREATE ROLE stabilize_migrator LOGIN PASSWORD 'TROQUE_ESTA_SENHA_MIGRATOR';
  END IF;
END
$$;

-- Nenhum dos dois pode ignorar RLS nem criar bancos/papéis.
ALTER ROLE stabilize_app        NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE stabilize_migrator   NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- ---------------------------------------------------------------------
-- Permissões de runtime: o mínimo necessário para operar.
-- Sem CREATE, sem DROP, sem ALTER. A API não faz DDL em produção.
-- ---------------------------------------------------------------------
-- `GRANT CONNECT ON DATABASE` exige o nome literal do banco, que varia
-- entre ambientes; SQL dinâmico resolve sem hardcode.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO stabilize_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO stabilize_migrator', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO stabilize_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stabilize_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stabilize_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO stabilize_app;

-- Tabelas criadas em migrations futuras herdam as mesmas permissões,
-- para que ninguém precise lembrar de rodar o GRANT depois.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stabilize_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stabilize_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO stabilize_app;

-- ---------------------------------------------------------------------
-- O log de auditoria é append-only também no nível de privilégio.
-- A policy já nega UPDATE/DELETE; revogar o privilégio é a segunda
-- tranca, para o caso de alguém adicionar uma policy permissiva sem
-- perceber a consequência.
-- ---------------------------------------------------------------------
REVOKE UPDATE, DELETE ON audit_log FROM stabilize_app;

-- ---------------------------------------------------------------------
-- O público não tem nada. Por padrão o PostgreSQL concede CREATE no
-- schema public para PUBLIC em versões antigas; revogar é higiene.
-- ---------------------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO stabilize_app, stabilize_migrator;
