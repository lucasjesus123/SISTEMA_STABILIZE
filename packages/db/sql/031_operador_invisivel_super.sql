-- ---------------------------------------------------------------------
-- O dono do serviço não aparece dentro de academia nenhuma.
--
-- O QUE ESTAVA ACONTECENDO. O operador da plataforma vive em
-- `platform_admins`, tabela separada de `users`, e nunca apareceu na
-- lista de usuários de empresa alguma — isso sempre esteve certo. Mas
-- nada impedia que o MESMO E-MAIL fosse usado para criar uma conta de
-- academia, e foi o que aconteceu: `contato@conexaomkt.com.br` figurava
-- como PROPRIETÁRIO da academia do cliente, na lista que o cliente
-- enxerga.
--
-- E A CONTA NEM FUNCIONAVA. O login é um só para as duas portas e tenta
-- a plataforma PRIMEIRO (ver `auth.routes.ts`): um e-mail que é de
-- operador abre o painel e nunca chega na academia. Aquela linha era uma
-- conta morta — inalcançável por quem a criou, visível para quem não
-- devia vê-la, e com papel de dono no cadastro do cliente.
--
-- A CORREÇÃO É NA ORIGEM, e não na tela. Esconder a linha da listagem
-- seria pior do que deixá-la: uma conta com acesso total ao dado da
-- academia, invisível na lista de contas dessa academia, é exatamente a
-- forma de um porta dos fundos. Aqui a conta deixa de PODER EXISTIR.
--
-- Para dar suporte continua havendo o "Entrar como", que emite token de
-- um usuário que já existe e grava no `audit_log` DA ACADEMIA — onde o
-- dono dela enxerga. Acesso que deixa rastro, e não acesso escondido.
-- ---------------------------------------------------------------------

/* Um e-mail é de operador quando existe em `platform_admins`. Inclui os
   inativos de propósito: um operador desligado ontem não deve virar
   dono de academia hoje pelo mesmo endereço. */
CREATE OR REPLACE FUNCTION plataforma_email_e_de_operador(p_email citext)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admins a WHERE a.email = p_email)
$$;

-- ---------------------------------------------------------------------
-- Cadastrar academia: o responsável não pode ser o dono do serviço
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION plataforma_criar_empresa(
  p_nome text, p_slug citext, p_documento text, p_timezone text, p_plano text,
  p_contato_nome text, p_contato_email citext, p_contato_whatsapp text,
  p_teste_ate date,
  p_dono_nome text, p_dono_email citext, p_dono_hash text
) RETURNS TABLE (empresa_id uuid, dono_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_dono   uuid;
BEGIN
  IF plataforma_email_e_de_operador(p_dono_email) THEN
    RAISE EXCEPTION 'operador_nao_vira_usuario'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO tenants (name, slug, document, timezone, plano,
                       contato_nome, contato_email, contato_whatsapp, teste_ate)
  VALUES (p_nome, p_slug, nullif(btrim(p_documento), ''), coalesce(nullif(p_timezone,''), 'America/Sao_Paulo'),
          nullif(btrim(p_plano), ''), nullif(btrim(p_contato_nome), ''), p_contato_email,
          nullif(btrim(p_contato_whatsapp), ''), p_teste_ate)
  RETURNING id INTO v_tenant;

  INSERT INTO users (tenant_id, email, password_hash, full_name, role, must_change_password)
  VALUES (v_tenant, p_dono_email, p_dono_hash, p_dono_nome, 'OWNER', true)
  RETURNING id INTO v_dono;

  /* A biblioteca de exercícios vem junto, do CATÁLOGO — não copiada de
     outra empresa. Sem isto a academia nasce sem um único exercício e a
     aba de treino responde "nenhum encontrado" para toda busca; foi
     exatamente o que aconteceu com a primeira empresa real. A migration
     011 conserta o histórico, esta linha impede que se repita. */
  INSERT INTO exercises (tenant_id, name, muscle_group, equipment, instructions)
  SELECT v_tenant, c.nome, c.grupo, c.equipamento, c.instrucoes
    FROM exercise_catalog c
  ON CONFLICT (tenant_id, name) DO NOTHING;

  RETURN QUERY SELECT v_tenant, v_dono;
END
$$;

-- ---------------------------------------------------------------------
-- Nomear gestor: mesma trava
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION plataforma_criar_gestor(
  p_tenant uuid, p_nome text, p_email citext, p_hash text, p_papel text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_papel NOT IN ('OWNER', 'ADMIN') THEN
    RAISE EXCEPTION 'papel inválido para gestor: %', p_papel;
  END IF;
  IF plataforma_email_e_de_operador(p_email) THEN
    RAISE EXCEPTION 'operador_nao_vira_usuario'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO users (tenant_id, email, password_hash, full_name, role, must_change_password)
  VALUES (p_tenant, p_email, p_hash, p_nome, p_papel::user_role, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- ---------------------------------------------------------------------
-- Editar usuário: e não se entra por renomeação
--
-- Sem esta linha a trava seria contornável sem má intenção: cria-se o
-- gestor com um e-mail qualquer e depois troca-se para o do operador na
-- janela de edição.
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

  IF v_atual.email IS DISTINCT FROM p_email
     AND plataforma_email_e_de_operador(p_email) THEN
    RETURN QUERY SELECT false, 'operador_nao_vira_usuario';
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
-- Remover a conta de um gestor
--
-- Existe por causa das contas que a trava acima passou a impedir e que
-- já estavam criadas: desativar deixa a linha na lista da academia, e o
-- que se quer é que ela suma de lá.
--
-- QUEM DEIXOU RASTRO CLÍNICO NÃO SAI, e não é este arquivo que decide
-- isso — são as chaves estrangeiras. `evolutions.professional_id`,
-- `workout_plans.professional_id`, `appointments.professional_id` e
-- `commissions.professional_id` são ON DELETE RESTRICT: um documento
-- assinado por alguém não pode ficar sem autor. O banco recusa, a
-- exceção é traduzida e a tela manda desativar em vez de apagar — que é
-- a resposta certa para quem atendeu aluno.
--
-- O que sai limpo é a conta que nunca fez nada: exatamente o caso da
-- conta morta do dono do serviço.
-- ---------------------------------------------------------------------
/* O 014 deu a `stabilize_plataforma` INSERT, SELECT e UPDATE em `users` —
   o mínimo do que o painel fazia. Remover precisa de DELETE, e BYPASSRLS
   não substitui: ele contorna a política de linha, não a permissão de
   tabela.

   E A FALTA DESTE GRANT NÃO GRITA. `42501` é traduzido para 404 lá em
   `errors.ts`, de propósito: no caminho das academias ele é quase sempre
   a RLS barrando leitura de outra empresa, e responder "não existe" é a
   resposta certa — confirmar que o recurso existe já é informação. O
   efeito colateral é que uma permissão faltando aparece como "Usuário
   não encontrado", que manda procurar no lugar errado. O `pgCode: 42501`
   no log do processo é onde a verdade fica. */
GRANT DELETE ON users TO stabilize_plataforma;

CREATE OR REPLACE FUNCTION plataforma_remover_usuario(p_user uuid)
RETURNS TABLE (ok boolean, motivo text, nome text, email citext)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_u     record;
  v_donos integer;
BEGIN
  SELECT u.id, u.tenant_id, u.full_name, u.email, u.role::text AS papel, u.is_active
    INTO v_u
    FROM users u
   WHERE u.id = p_user AND u.role IN ('OWNER', 'ADMIN');

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'nao_encontrado', NULL::text, NULL::citext;
    RETURN;
  END IF;

  /* A academia não pode ficar sem dono, pelo mesmo motivo do rebaixar:
     proprietário é quem nomeia outro proprietário. */
  IF v_u.papel = 'OWNER' THEN
    SELECT count(*) INTO v_donos
      FROM users u
     WHERE u.tenant_id = v_u.tenant_id AND u.role = 'OWNER' AND u.is_active AND u.id <> p_user;

    IF v_donos = 0 THEN
      RETURN QUERY SELECT false, 'ultimo_dono', v_u.full_name, v_u.email;
      RETURN;
    END IF;
  END IF;

  BEGIN
    DELETE FROM users WHERE id = p_user;
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN QUERY SELECT false, 'tem_historico', v_u.full_name, v_u.email;
    RETURN;
  END;

  RETURN QUERY SELECT true, NULL::text, v_u.full_name, v_u.email;
END
$$;

-- ---------------------------------------------------------------------
-- Dono e permissão das funções tocadas aqui. Mesmo tratamento de 014,
-- 029 e 030 — ver o comentário de lá.
--
-- `CREATE OR REPLACE` de função que já pertence a `stabilize_plataforma`
-- PRESERVA o dono, então as três reescritas acima continuam com o dono
-- certo; o laço existe pelas duas novas e por um banco que porventura
-- tenha ficado para trás.
-- ---------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOR f IN
    SELECT format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'plataforma_email_e_de_operador',
         'plataforma_remover_usuario',
         'plataforma_criar_empresa',
         'plataforma_criar_gestor',
         'plataforma_editar_usuario'
       )
  LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO stabilize_plataforma', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO stabilize_app', f);
  END LOOP;
END $$;
