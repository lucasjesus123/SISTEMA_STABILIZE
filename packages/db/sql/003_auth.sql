-- =====================================================================
-- Funções de autenticação
--
-- O login tem um problema de ordem: para definir `app.tenant_id` é
-- preciso saber a qual empresa o usuário pertence, e para saber isso é
-- preciso consultar `users` — que está protegida por RLS, justamente por
-- tenant. Um ovo-e-galinha.
--
-- A saída é UMA função SECURITY DEFINER, deliberadamente estreita, que
-- é o único ponto do sistema autorizado a olhar `users` sem contexto de
-- tenant. Ela devolve o mínimo para autenticar e nada além. Não aceita
-- filtro livre, não devolve lista, não expõe outras colunas.
--
-- SECURITY DEFINER é uma ferramenta afiada: a função roda com os
-- privilégios de quem a criou, ignorando a RLS. Por isso:
--   - search_path fixo, para impedir sequestro de resolução de nome;
--   - parâmetro tipado, sem SQL dinâmico;
--   - retorno restrito ao necessário;
--   - EXECUTE concedido apenas ao papel da aplicação.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Resolve o usuário para login.
--
-- `p_tenant_slug` é opcional. Sem ele, a função só devolve resultado se
-- o e-mail existir em EXATAMENTE uma empresa — o caso comum. Se o mesmo
-- e-mail existir em duas, devolve `ambiguous` e a API pede o
-- identificador da empresa, sem revelar quais são.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_user(
  p_email      citext,
  p_tenant_slug citext DEFAULT NULL
)
RETURNS TABLE (
  user_id            uuid,
  tenant_id          uuid,
  password_hash      text,
  role               user_role,
  full_name          text,
  is_active          boolean,
  tenant_is_active   boolean,
  locked_until       timestamptz,
  failed_login_count integer,
  must_change_password boolean,
  ambiguous          boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  IF p_email IS NULL OR length(btrim(p_email::text)) = 0 THEN
    RETURN;
  END IF;

  IF p_tenant_slug IS NULL THEN
    SELECT count(*) INTO v_count
      FROM users u
      JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = p_email;

    IF v_count > 1 THEN
      -- Sinaliza a ambiguidade sem revelar as empresas envolvidas.
      RETURN QUERY SELECT
        NULL::uuid, NULL::uuid, NULL::text, NULL::user_role, NULL::text,
        NULL::boolean, NULL::boolean, NULL::timestamptz, NULL::integer,
        NULL::boolean, true;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
    SELECT
      u.id, u.tenant_id, u.password_hash, u.role, u.full_name,
      u.is_active, t.is_active, u.locked_until, u.failed_login_count,
      u.must_change_password, false
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
   WHERE u.email = p_email
     AND (p_tenant_slug IS NULL OR t.slug = p_tenant_slug)
   LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION auth_lookup_user(citext, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user(citext, citext) TO stabilize_app;

-- ---------------------------------------------------------------------
-- Registra tentativa de login.
--
-- O contador vive no banco, e não em memória do processo, por dois
-- motivos: sobrevive a restart e é compartilhado entre instâncias da
-- API. Um contador em memória é zerado por um deploy, o que dá ao
-- atacante um jeito trivial de resetar o bloqueio.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_register_login_attempt(
  p_user_id       uuid,
  p_success       boolean,
  p_max_attempts  integer,
  p_lockout_minutes integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_success THEN
    UPDATE users
       SET failed_login_count = 0,
           locked_until = NULL,
           last_login_at = now()
     WHERE id = p_user_id;
  ELSE
    UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= p_max_attempts
               THEN now() + make_interval(mins => p_lockout_minutes)
             ELSE locked_until
           END
     WHERE id = p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION auth_register_login_attempt(uuid, boolean, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_register_login_attempt(uuid, boolean, integer, integer) TO stabilize_app;

-- ---------------------------------------------------------------------
-- Resolve a sessão a partir do hash do refresh token.
--
-- Mesmo problema de ordem do login, e pela mesma razão: para definir
-- `app.tenant_id` é preciso saber a empresa, e essa informação está em
-- `user_sessions`, que é protegida por RLS justamente por tenant.
--
-- Sem esta função, a consulta roda sem contexto, a RLS devolve zero
-- linhas e TODO refresh falha com 401 — o usuário é deslogado a cada 15
-- minutos, quando o access token expira. O sintoma parece bug de sessão;
-- a causa é a RLS funcionando exatamente como projetada.
--
-- Recebe o HASH, nunca o token: quem chama já calculou o SHA-256, então
-- o valor original não transita até o banco nem aparece em log de query.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_session(p_token_hash text)
RETURNS TABLE (
  session_id  uuid,
  user_id     uuid,
  tenant_id   uuid,
  family_id   uuid,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  role        user_role,
  is_active   boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.user_id, s.tenant_id, s.family_id, s.expires_at, s.revoked_at,
         u.role, (u.is_active AND t.is_active)
    FROM user_sessions s
    JOIN users u   ON u.id = s.user_id
    JOIN tenants t ON t.id = s.tenant_id
   WHERE s.token_hash = p_token_hash
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth_lookup_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_session(text) TO stabilize_app;

-- ---------------------------------------------------------------------
-- Rotação de refresh token com detecção de reuso.
--
-- Se um refresh token JÁ USADO for apresentado de novo, a leitura mais
-- provável é que ele foi roubado: o dono legítimo já rotacionou, então
-- quem está apresentando o antigo é outra pessoa. Nesse caso derrubamos
-- a FAMÍLIA inteira de tokens, não só aquele — porque o atacante pode
-- ter obtido o token atual também.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_revoke_token_family(
  p_family_id uuid,
  p_reason    text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE user_sessions
     SET revoked_at = now(),
         revoked_reason = p_reason
   WHERE family_id = p_family_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION auth_revoke_token_family(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_revoke_token_family(uuid, text) TO stabilize_app;

-- ---------------------------------------------------------------------
-- Higiene: remove sessões expiradas há mais de 30 dias.
-- Chamada por cron; não é caminho de request.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_purge_expired_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM user_sessions
   WHERE expires_at < now() - interval '30 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION auth_purge_expired_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_purge_expired_sessions() TO stabilize_app;
