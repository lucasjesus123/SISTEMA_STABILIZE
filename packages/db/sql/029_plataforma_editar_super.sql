-- ---------------------------------------------------------------------
-- Editar o usuário de uma academia, e excluir uma academia.
--
-- `_super` no nome, e não por enfeite: o migrador aplica este arquivo
-- com a credencial de SUPERUSUÁRIO e a CADA atualização (ver
-- packages/db/scripts/migrate.sh). É o que permite o ALTER FUNCTION ...
-- OWNER TO stabilize_plataforma no fim — o migrador comum não pode
-- assumir aquele papel — e é o mesmo tratamento de 014, que criou o
-- resto das funções deste painel. Tudo aqui é idempotente por
-- construção: reexecutar conserta um banco que ficou para trás.
--
-- O painel já sabia CRIAR (academia, gestor), SUSPENDER e REDEFINIR
-- SENHA. Faltava o meio-termo, que é o que mais acontece na vida real:
-- o e-mail do responsável mudou, quem era administrador virou
-- proprietário, o cliente foi embora de vez.
--
-- Estas duas funções fecham esse buraco. Elas continuam presas ao
-- recorte do painel: OWNER e ADMIN, e nada mais. Profissional, recepção
-- e aluno são assunto de quem administra a academia, e o operador do
-- serviço não tem por que mexer neles.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Editar gestor
--
-- Nome, e-mail e papel numa chamada só, porque é assim que chegam: a
-- pessoa saiu da empresa e a conta passou para outra, ou o sócio que
-- estava como administrador virou dono.
--
-- DUAS TRAVAS, e as duas existem por consequência e não por gosto:
--
--   1. NÃO SE DEIXA UMA ACADEMIA SEM DONO. Rebaixar o último OWNER a
--      ADMIN cria uma academia onde ninguém pode nomear outro dono, e a
--      única saída passa a ser o painel — quer dizer, um chamado. A
--      função recusa e diz o motivo.
--
--   2. TROCAR O E-MAIL DERRUBA AS SESSÕES DAQUELA CONTA. O e-mail é a
--      identidade de login, e trocá-lo quase sempre significa "esta
--      conta agora é de outra pessoa". Deixar a sessão anterior viva
--      seria deixar a pessoa antiga dentro do sistema por até quatorze
--      dias. Trocar só o nome não derruba nada: mudar "Joao" para "João
--      Carlos" não é troca de dono.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION plataforma_editar_usuario(
  p_user uuid, p_nome text, p_email citext, p_papel text
) RETURNS TABLE (ok boolean, motivo text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_atual   record;
  v_donos   integer;
BEGIN
  IF p_papel NOT IN ('OWNER', 'ADMIN') THEN
    RETURN QUERY SELECT false, 'papel_invalido';
    RETURN;
  END IF;

  SELECT u.id, u.tenant_id, u.email, u.role::text AS papel
    INTO v_atual
    FROM users u
   WHERE u.id = p_user AND u.role IN ('OWNER', 'ADMIN');

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'nao_encontrado';
    RETURN;
  END IF;

  IF v_atual.papel = 'OWNER' AND p_papel <> 'OWNER' THEN
    SELECT count(*) INTO v_donos
      FROM users u
     WHERE u.tenant_id = v_atual.tenant_id AND u.role = 'OWNER' AND u.is_active;

    IF v_donos <= 1 THEN
      RETURN QUERY SELECT false, 'ultimo_dono';
      RETURN;
    END IF;
  END IF;

  UPDATE users
     SET full_name = p_nome,
         email     = p_email,
         role      = p_papel::user_role
   WHERE id = p_user;

  IF v_atual.email IS DISTINCT FROM p_email THEN
    UPDATE user_sessions SET revoked_at = now()
     WHERE user_id = p_user AND revoked_at IS NULL;
  END IF;

  RETURN QUERY SELECT true, NULL::text;
END
$$;

-- ---------------------------------------------------------------------
-- Excluir academia
--
-- É a única ação do sistema que destrói dado de cliente, e ela apaga
-- TUDO: alunos, prontuário, anamnese, financeiro, treino, anexo. As
-- chaves estrangeiras são todas ON DELETE CASCADE, então uma linha some
-- e vinte e sete tabelas esvaziam junto. Não existe desfazer, e o backup
-- da noite anterior é a única volta.
--
-- POR ISSO A EXCLUSÃO EXIGE QUE A ACADEMIA JÁ ESTEJA SUSPENSA. Suspender
-- é instantâneo, reversível e visível: o cliente perde o acesso e liga.
-- Quem passou por essa etapa e ainda quer excluir já esperou o telefone
-- não tocar. Excluir de primeira seria transformar um clique errado na
-- lista em perda total — e a lista é ordenada por nome, com academias de
-- nome parecido vizinhas.
--
-- O `p_slug` é a segunda tranca: quem chama tem de repetir o
-- identificador da academia. Confirmar com "sim" é reflexo; digitar
-- `stabilize-centro` é leitura.
--
-- O QUE NÃO É APAGADO: `audit_log` e `platform_audit` guardam
-- `tenant_id` sem chave estrangeira, de propósito. O registro de que a
-- academia existiu, e de quem a excluiu, sobrevive a ela.
-- ---------------------------------------------------------------------
/* O 014 deu a `stabilize_plataforma` exatamente INSERT, SELECT e UPDATE
   em `tenants` — o mínimo do que o painel fazia, e nada além. Excluir
   precisa de DELETE, e é um privilégio novo: sem ele a função levanta
   "permission denied for table tenants" já dentro do DELETE, depois de
   as duas travas terem passado.

   BYPASSRLS não substitui isto: ele contorna a política de linha, não a
   permissão de tabela. E as tabelas filhas não precisam de concessão
   nenhuma — a cascata de chave estrangeira é executada pelo sistema, sem
   checar privilégio de quem disparou o DELETE. */
GRANT DELETE ON tenants TO stabilize_plataforma;

CREATE OR REPLACE FUNCTION plataforma_excluir_empresa(p_id uuid, p_slug text)
RETURNS TABLE (ok boolean, motivo text, nome text, alunos bigint, usuarios bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_t       record;
  v_alunos  bigint;
  v_users   bigint;
BEGIN
  SELECT t.id, t.name, t.slug, t.is_active INTO v_t FROM tenants t WHERE t.id = p_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'nao_encontrado', NULL::text, 0::bigint, 0::bigint;
    RETURN;
  END IF;

  IF v_t.slug <> p_slug THEN
    RETURN QUERY SELECT false, 'confirmacao_errada', v_t.name, 0::bigint, 0::bigint;
    RETURN;
  END IF;

  IF v_t.is_active THEN
    RETURN QUERY SELECT false, 'precisa_suspender', v_t.name, 0::bigint, 0::bigint;
    RETURN;
  END IF;

  SELECT count(*) INTO v_alunos FROM students s WHERE s.tenant_id = p_id;
  SELECT count(*) INTO v_users  FROM users   u WHERE u.tenant_id = p_id;

  DELETE FROM tenants WHERE id = p_id;

  RETURN QUERY SELECT true, NULL::text, v_t.name, v_alunos, v_users;
END
$$;

-- ---------------------------------------------------------------------
-- Dono e permissão das funções novas.
--
-- Mesmo tratamento de 014: SECURITY DEFINER só funciona se o dono for
-- `stabilize_plataforma`, que tem BYPASSRLS. Uma função destas
-- pertencente a papel sem BYPASSRLS, sob FORCE RLS, devolve zero linhas
-- para todo mundo — foi o defeito que impediu qualquer login na
-- primeira instalação.
--
-- SÓ AS DUAS DE AGORA, e não todas as `plataforma_*`. O laço de 014
-- varria o prefixo inteiro e funcionava porque naquele momento a
-- migração acabara de criar todas elas e ainda era a dona. Repetir a
-- varredura aqui é pedir para o migrador mexer em função que já pertence
-- a `stabilize_plataforma` — e o Postgres recusa com "permission denied
-- for function", derrubando a migração inteira na primeira função
-- antiga que o laço encontra.
-- ---------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOR f IN
    SELECT format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('plataforma_editar_usuario', 'plataforma_excluir_empresa')
  LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO stabilize_plataforma', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO stabilize_app', f);
  END LOOP;
END $$;
