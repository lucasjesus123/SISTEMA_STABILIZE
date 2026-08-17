-- =====================================================================
-- O DONO DAS FUNÇÕES DE AUTENTICAÇÃO  (roda como SUPERUSUÁRIO)
--
-- O PROBLEMA QUE ESTE ARQUIVO RESOLVE, e ele derrubou o login na
-- primeira instalação real:
--
--   Usuário existia no banco. Senha conferia (verificada com argon2).
--   Conta ativa, sem bloqueio, zero tentativas falhas. E o login
--   respondia "E-mail ou senha incorretos" sem sequer registrar a
--   tentativa — porque `auth_lookup_user` devolvia ZERO LINHAS.
--
-- Por quê: essas funções são SECURITY DEFINER, ou seja, rodam com os
-- privilégios do DONO delas. O dono passou a ser `stabilize_migrator`,
-- que cria o schema. E `stabilize_migrator`:
--
--   · é DONO das tabelas
--   · NÃO tem BYPASSRLS (de propósito — ver 000_roles.sql)
--
-- Normalmente o dono da tabela escapa da RLS. Aqui não: o schema liga
-- FORCE ROW LEVEL SECURITY em todas, e FORCE existe exatamente para
-- alcançar o dono também. Como no login ainda NÃO EXISTE contexto de
-- empresa — descobrir a empresa é justamente o que o login faz —
-- `current_tenant_id()` é NULL, a policy `tenant_id = current_tenant_id()`
-- não casa com nada, e a consulta volta vazia.
--
-- O ovo-e-galinha que o SECURITY DEFINER deveria resolver só se resolve
-- se o dono da função ignorar a RLS. Em desenvolvimento isso passou
-- despercebido porque lá as funções pertenciam ao `postgres`, que é
-- superusuário e ignora RLS por definição.
--
-- A SOLUÇÃO, e por que não é a mais óbvia:
--
--   Dar BYPASSRLS ao `stabilize_migrator` resolveria numa linha — e
--   destruiria a garantia. Ele roda DDL, e um papel que ignora RLS é
--   exatamente o que a prova de isolamento existe para impedir.
--
--   Apontar as funções para o `postgres` também resolveria, e daria a
--   elas poder de superusuário para tudo — muito além do necessário.
--
--   Então: um papel dedicado, `stabilize_auth`, que existe SÓ para ser
--   dono destas funções. NOLOGIN (ninguém se conecta com ele),
--   BYPASSRLS (é o buraco controlado, e é o motivo dele existir), e
--   privilégio de tabela concedido ao mínimo — cada função só alcança o
--   que precisa. O buraco tem o tamanho da fechadura.
-- =====================================================================

DO $auth$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stabilize_auth') THEN
    CREATE ROLE stabilize_auth NOLOGIN;
  END IF;
END
$auth$;

-- NOLOGIN é tão importante quanto o BYPASSRLS: este papel enxerga todas
-- as empresas, então ninguém pode se conectar com ele. Sem senha, sem
-- login, ele só existe para emprestar privilégio a seis funções.
ALTER ROLE stabilize_auth NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO stabilize_auth;

-- O MÍNIMO que cada função precisa, e nada além:
--   auth_lookup_user             SELECT em users, tenants
--   auth_register_login_attempt  UPDATE em users
--   auth_lookup_session          SELECT em user_sessions, users, tenants
--   auth_revoke_token_family     UPDATE em user_sessions
--   auth_purge_expired_sessions  DELETE em user_sessions
--   jobs_tenants_ativos          SELECT em tenants
GRANT SELECT, UPDATE                 ON users         TO stabilize_auth;
GRANT SELECT                         ON tenants       TO stabilize_auth;
GRANT SELECT, UPDATE, DELETE         ON user_sessions TO stabilize_auth;

-- Nada de INSERT em users nem em tenants: criar empresa ou usuário não é
-- assunto de autenticação, e o papel não deve poder fazê-lo nem por
-- engano.

ALTER FUNCTION auth_lookup_user(citext, citext)                                  OWNER TO stabilize_auth;
ALTER FUNCTION auth_register_login_attempt(uuid, boolean, integer, integer)      OWNER TO stabilize_auth;
ALTER FUNCTION auth_lookup_session(text)                                         OWNER TO stabilize_auth;
ALTER FUNCTION auth_revoke_token_family(uuid, text)                              OWNER TO stabilize_auth;
ALTER FUNCTION auth_purge_expired_sessions()                                     OWNER TO stabilize_auth;
ALTER FUNCTION jobs_tenants_ativos()                                             OWNER TO stabilize_auth;

-- Trocar o dono NÃO recria os GRANTs de execução, que continuam como
-- estavam (003_auth.sql e 006_jobs.sql revogam de PUBLIC e concedem a
-- stabilize_app). Reafirmados aqui porque este arquivo roda sempre, e é
-- barato garantir que um deles não se perca numa migration futura.
REVOKE ALL ON FUNCTION auth_lookup_user(citext, citext)                             FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_register_login_attempt(uuid, boolean, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_session(text)                                    FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_token_family(uuid, text)                         FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_purge_expired_sessions()                                FROM PUBLIC;
REVOKE ALL ON FUNCTION jobs_tenants_ativos()                                        FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_lookup_user(citext, citext)                             TO stabilize_app;
GRANT EXECUTE ON FUNCTION auth_register_login_attempt(uuid, boolean, integer, integer) TO stabilize_app;
GRANT EXECUTE ON FUNCTION auth_lookup_session(text)                                    TO stabilize_app;
GRANT EXECUTE ON FUNCTION auth_revoke_token_family(uuid, text)                         TO stabilize_app;
GRANT EXECUTE ON FUNCTION auth_purge_expired_sessions()                                TO stabilize_app;
GRANT EXECUTE ON FUNCTION jobs_tenants_ativos()                                        TO stabilize_app;
