-- ---------------------------------------------------------------------
-- A senha pode ser ESCOLHIDA por quem cadastra, e não só gerada.
--
-- O sistema sempre gerou uma senha provisória, mostrou uma vez e exigiu
-- a troca no primeiro acesso. A propriedade disso é boa e continua
-- valendo por padrão: ninguém — nem quem cadastrou — sabe a senha
-- definitiva de ninguém.
--
-- SÓ QUE ELA TEM UM CUSTO REAL, e ele apareceu na primeira entrega: uma
-- senha de quatorze caracteres aleatórios ditada por telefone é digitada
-- errada três vezes, e quem está do outro lado desiste. Quem opera
-- precisa poder combinar a senha com a pessoa e digitá-la ali mesmo.
--
-- A DIFERENÇA ENTRE OS DOIS CAMINHOS É A TROCA OBRIGATÓRIA:
--
--   · GERADA  → `must_change_password = true`. A senha viajou por um
--     canal qualquer (telefone, WhatsApp, papel) e quem cadastrou a
--     conhece; ela não pode continuar valendo.
--   · ESCOLHIDA → `must_change_password = false`. A pessoa combinou a
--     senha com quem vai usá-la; exigir a troca seria transformar uma
--     decisão em obstáculo.
--
-- O parâmetro é o ÚLTIMO e tem valor padrão `true`: uma chamada antiga,
-- que não o passe, continua se comportando exatamente como antes. É o
-- que permite aplicar esta migração antes de subir a API nova sem uma
-- janela em que as duas discordam.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION plataforma_criar_empresa(
  p_nome text, p_slug citext, p_documento text, p_timezone text, p_plano text,
  p_contato_nome text, p_contato_email citext, p_contato_whatsapp text,
  p_teste_ate date,
  p_dono_nome text, p_dono_email citext, p_dono_hash text,
  p_trocar_senha boolean DEFAULT true
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
  VALUES (v_tenant, p_dono_email, p_dono_hash, p_dono_nome, 'OWNER', coalesce(p_trocar_senha, true))
  RETURNING id INTO v_dono;

  /* A biblioteca de exercícios vem junto, do CATÁLOGO — não copiada de
     outra empresa. Sem isto a academia nasce sem um único exercício e a
     aba de treino responde "nenhum encontrado" para toda busca; foi
     exatamente o que aconteceu com a primeira empresa real. */
  INSERT INTO exercises (tenant_id, name, muscle_group, equipment, instructions)
  SELECT v_tenant, c.nome, c.grupo, c.equipamento, c.instrucoes
    FROM exercise_catalog c
  ON CONFLICT (tenant_id, name) DO NOTHING;

  RETURN QUERY SELECT v_tenant, v_dono;
END
$$;

CREATE OR REPLACE FUNCTION plataforma_criar_gestor(
  p_tenant uuid, p_nome text, p_email citext, p_hash text, p_papel text,
  p_trocar_senha boolean DEFAULT true
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
  VALUES (p_tenant, p_email, p_hash, p_nome, p_papel::user_role, coalesce(p_trocar_senha, true))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

/* Redefinir senha: as sessões abertas caem nos DOIS casos.
   É o cenário em que se redefine uma senha — quem tinha o token
   continuaria entrando por horas depois do corte. */
CREATE OR REPLACE FUNCTION plataforma_redefinir_senha_gestor(
  p_user uuid, p_hash text, p_trocar_senha boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE afetadas integer;
BEGIN
  UPDATE users
     SET password_hash = p_hash, password_changed_at = now(),
         must_change_password = coalesce(p_trocar_senha, true),
         failed_login_count = 0, locked_until = NULL
   WHERE id = p_user AND role IN ('OWNER', 'ADMIN');
  GET DIAGNOSTICS afetadas = ROW_COUNT;

  IF afetadas > 0 THEN
    UPDATE user_sessions SET revoked_at = now()
     WHERE user_id = p_user AND revoked_at IS NULL;
  END IF;
  RETURN afetadas > 0;
END
$$;

-- ---------------------------------------------------------------------
-- Dono e permissão. Ver o comentário de 014.
--
-- AS ASSINATURAS MUDARAM — um parâmetro a mais —, então as versões
-- ANTIGAS continuam existindo lado a lado no Postgres, que resolve
-- sobrecarga por aridade. Deixá-las seria manter no banco funções que
-- ninguém chama e que não têm a trava do operador; o `DROP` explícito
-- abaixo tira cada uma pela assinatura exata.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS plataforma_criar_empresa(
  text, citext, text, text, text, text, citext, text, date, text, citext, text
);
DROP FUNCTION IF EXISTS plataforma_criar_gestor(uuid, text, citext, text, text);
DROP FUNCTION IF EXISTS plataforma_redefinir_senha_gestor(uuid, text);

DO $$
DECLARE f text;
BEGIN
  FOR f IN
    SELECT format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'plataforma_criar_empresa',
         'plataforma_criar_gestor',
         'plataforma_redefinir_senha_gestor'
       )
  LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO stabilize_plataforma', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO stabilize_app', f);
  END LOOP;
END $$;
