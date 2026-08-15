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

-- AS SENHAS VÊM DE FORA, e o script se recusa a rodar sem elas.
--
-- A versão anterior trazia 'TROQUE_ESTA_SENHA_APP' embutido. O problema
-- de um placeholder não é ele existir — é que FUNCIONA: o banco sobe, a
-- aplicação conecta, ninguém vê erro, e a senha padrão fica em produção
-- até o dia em que alguém a encontra no repositório. Um segredo que só
-- um comentário protege não está protegido.
--
-- Uso:
--   psql -v app_password="$X" -v migrator_password="$Y" -f 002_roles.sql
--
-- CUIDADO COM DOLLAR-QUOTING: o psql NÃO substitui `:'variavel'` dentro
-- de $$...$$. A primeira versão deste arquivo lia as senhas dentro do
-- bloco DO e o texto `:'app_password'` chegava LITERAL ao servidor —
-- falhava sempre, inclusive no caminho feliz. Por isso as senhas entram
-- por `set_config` aqui fora, onde a substituição acontece, e o bloco
-- as lê com `current_setting`.
\if :{?app_password}
\else
  \echo 'ERRO: falta -v app_password=... (senha do papel de runtime)'
  \quit
\endif

\if :{?migrator_password}
\else
  \echo 'ERRO: falta -v migrator_password=... (senha do papel de migração)'
  \quit
\endif

SELECT set_config('stabilize.app_password', :'app_password', false);
SELECT set_config('stabilize.migrator_password', :'migrator_password', false);

DO $$
DECLARE
  senha_app text := current_setting('stabilize.app_password');
  senha_mig text := current_setting('stabilize.migrator_password');
BEGIN
  /* Recusa os placeholders que já circularam neste repositório. Um
     placeholder conhecido é pior que senha fraca: está escrito,
     versionado, e é o primeiro palpite de quem procura. */
  IF senha_app LIKE 'TROQUE%' OR senha_mig LIKE 'TROQUE%'
     OR length(senha_app) < 16 OR length(senha_mig) < 16 THEN
    RAISE EXCEPTION
      'senha de banco inválida: use segredos gerados (>= 16 caracteres), nunca os placeholders';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stabilize_app') THEN
    EXECUTE format('CREATE ROLE stabilize_app LOGIN PASSWORD %L', senha_app);
  ELSE
    -- Reexecutar a migration atualiza a senha: é assim que se faz rotação.
    EXECUTE format('ALTER ROLE stabilize_app PASSWORD %L', senha_app);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stabilize_migrator') THEN
    EXECUTE format('CREATE ROLE stabilize_migrator LOGIN PASSWORD %L', senha_mig);
  ELSE
    EXECUTE format('ALTER ROLE stabilize_migrator PASSWORD %L', senha_mig);
  END IF;
END
$$;

-- Tira as senhas da sessão assim que os papéis existem.
SELECT set_config('stabilize.app_password', '', false);
SELECT set_config('stabilize.migrator_password', '', false);

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
