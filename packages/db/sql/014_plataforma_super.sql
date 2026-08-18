-- =====================================================================
-- O BURACO CONTROLADO DA PLATAFORMA
--
-- Roda como SUPERUSUÁRIO e sempre (sufixo `_super.sql`), porque cria
-- papel e troca dono de função — coisas que o migrator não pode fazer.
--
-- O PADRÃO É O MESMO DO LOGIN. `stabilize_app` não tem BYPASSRLS e não
-- alcança `tenants` de outra empresa; a única forma de a API operar o
-- SaaS é por funções SECURITY DEFINER cujo DONO ignora a RLS. O dono é
-- `stabilize_plataforma`: NOLOGIN — ninguém conecta como ele — e dono de
-- nada além destas funções.
--
-- O TAMANHO DO BURACO É O TAMANHO DO PROBLEMA. Releia a lista abaixo:
-- nenhuma função devolve linha de `students`, `anamneses`, `evolutions`,
-- `attachments`, `appointments` ou `finance_entries`. As contagens
-- devolvem NÚMEROS — o que o faturamento precisa e o que não identifica
-- ninguém. Quem obtiver execução como `stabilize_app` ganha o poder de
-- administrar contas, não o de ler prontuário.
--
-- `SET search_path = public, pg_temp` em todas: sem isso, quem
-- controlasse o search_path da sessão poderia plantar uma tabela
-- `tenants` num schema próprio e fazer a função privilegiada operar
-- sobre ela.
-- =====================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stabilize_plataforma') THEN
    CREATE ROLE stabilize_plataforma;
  END IF;
END $$;

ALTER ROLE stabilize_plataforma NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

/* USAGE no schema, sem o qual nada disto funciona. O 000_roles.sql faz
   `REVOKE ALL ON SCHEMA public FROM PUBLIC`, então um papel recém-criado
   não enxerga tabela nenhuma — nem sendo dono de função SECURITY
   DEFINER. O sintoma é uma mensagem que não parece ter relação com
   permissão: `relation "tenants" does not exist`, dentro da função, para
   uma tabela que existe. */
GRANT USAGE ON SCHEMA public TO stabilize_plataforma;

-- ---------------------------------------------------------------------
-- A CONFIGURAÇÃO DA PLATAFORMA
--
-- Criada AQUI, e não numa migration numerada, por uma razão de ordem:
-- este arquivo tem sufixo `_super` e roda SEMPRE, a cada deploy. Um
-- arquivo que roda sempre não pode depender de tabela criada por um
-- arquivo numerado POSTERIOR — numa instalação nova ele executa antes, e
-- o deploy morre em `relation "platform_settings" does not exist`.
-- Aconteceu numa VPS real, no meio de uma atualização.
--
-- Um arquivo que roda sempre precisa ser autossuficiente. Daí o
-- `IF NOT EXISTS`: ele cria na primeira vez e não faz nada nas outras.
--
-- UMA LINHA SÓ, garantida pelo banco com `id boolean PRIMARY KEY CHECK
-- (id)`. A alternativa — tabela livre e a aplicação lembrando de ler a
-- primeira linha — produz o dia em que existem duas e ninguém sabe qual
-- vale.
--
-- O token administrativo da uazapi é guardado CIFRADO pela API
-- (AES-256-GCM). Quem o tem fala em nome de qualquer academia do
-- sistema; em claro no banco, um dump o entrega inteiro.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  uazapi_base_url        text,
  uazapi_admin_encrypted text,
  atualizado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_por         uuid REFERENCES platform_admins(id) ON DELETE SET NULL
);
/* O DONO PRECISA SER O MIGRATOR, e não o superusuário que executa este
   arquivo. O `002_roles.sql` roda sempre e faz `GRANT ... ON ALL TABLES
   IN SCHEMA public TO stabilize_app` — e o PostgreSQL só deixa conceder
   privilégio em tabela que se possui. Com a tabela pertencendo a
   `postgres`, o 002 morre com `permission denied for table
   platform_settings` no segundo deploy, quando a tabela já existe.

   Foi o segundo erro em cadeia deste mesmo bloco, e só apareceu quando
   testei a SEGUNDA passada num banco limpo — a primeira passava. As
   outras tabelas de plataforma nascem no 013, aplicado pelo migrator, e
   por isso nunca tiveram este problema; esta precisava alcançar o mesmo
   estado por outro caminho.

   O grant que o 002 dá ao `stabilize_app` é revogado logo abaixo, neste
   mesmo arquivo, que roda depois dele. */
INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE platform_settings OWNER TO stabilize_migrator;
REVOKE ALL ON platform_settings FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_admins   TO stabilize_plataforma;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_sessions TO stabilize_plataforma;
GRANT SELECT, INSERT                  ON platform_audit   TO stabilize_plataforma;
GRANT SELECT, UPDATE                  ON platform_settings TO stabilize_plataforma;
GRANT USAGE, SELECT ON SEQUENCE platform_audit_id_seq     TO stabilize_plataforma;
GRANT SELECT, INSERT, UPDATE          ON tenants          TO stabilize_plataforma;
GRANT SELECT, INSERT, UPDATE          ON users            TO stabilize_plataforma;
-- Só para CONTAR. Nenhuma função abaixo devolve linha destas tabelas.
GRANT SELECT ON students TO stabilize_plataforma;
GRANT SELECT ON appointments        TO stabilize_plataforma;
GRANT SELECT ON whatsapp_messages   TO stabilize_plataforma;
GRANT SELECT, INSERT ON audit_log   TO stabilize_plataforma;
/* `audit_log.id` é bigserial, e INSERT numa coluna serial precisa de
   USAGE na SEQUÊNCIA além do privilégio na tabela. Sem esta linha o
   registro do acesso de suporte falhava com `permission denied for
   sequence audit_log_id_seq` — que o tratador de erros traduz para 404,
   e a rota inteira respondia "Recurso não encontrado" sem nenhuma pista
   de que o problema era um GRANT. */
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO stabilize_plataforma;
/* Suspender a empresa derruba as sessões dela — daí o UPDATE. */
GRANT SELECT, UPDATE ON user_sessions    TO stabilize_plataforma;
GRANT SELECT, INSERT ON exercises        TO stabilize_plataforma;
GRANT SELECT         ON exercise_catalog TO stabilize_plataforma;

/* ---------------------------------------------------------------------
   E A API NÃO ALCANÇA ESTAS TABELAS DIRETO.

   O `ALTER DEFAULT PRIVILEGES` do 000_roles.sql concede automaticamente
   SELECT/INSERT/UPDATE/DELETE a `stabilize_app` em TODA tabela nova
   criada pelo migrator — o que é ótimo para as tabelas do domínio e
   errado para estas três. Sem o REVOKE abaixo, quem obtivesse execução
   dentro do contêiner da API leria a tabela de operadores da plataforma
   e o diário de auditoria dela.

   O `REVOKE ... FROM PUBLIC` do 013 não cobre isso: o privilégio de
   `stabilize_app` é NOMINAL, concedido a ele, não herdado de PUBLIC.
   Conferido: antes deste REVOKE, `SELECT count(*) FROM platform_admins`
   como `stabilize_app` respondia 0 em vez de recusar.
   --------------------------------------------------------------------- */
REVOKE ALL ON platform_admins   FROM stabilize_app;
REVOKE ALL ON platform_sessions FROM stabilize_app;
REVOKE ALL ON platform_audit    FROM stabilize_app;
REVOKE ALL ON platform_settings FROM stabilize_app;

-- ---------------------------------------------------------------------
-- Apaga as versões anteriores antes de recriar.
--
-- `CREATE OR REPLACE FUNCTION` NÃO consegue mudar o nome nem o tipo dos
-- parâmetros de saída: responde `cannot change return type of existing
-- function` e a migration morre. Como este arquivo roda SEMPRE (é
-- `_super.sql`), qualquer ajuste na assinatura de uma função quebraria
-- todo deploy seguinte — e o erro aparece na VPS, no meio da
-- atualização.
--
-- Apagar antes resolve de uma vez. Os GRANTs somem junto com a função e
-- são refeitos no bloco do fim deste mesmo arquivo, então não há janela
-- em que a API fique sem permissão depois de um deploy completo.
-- ---------------------------------------------------------------------
DO $apagar$
DECLARE f text;
BEGIN
  FOR f IN
    SELECT format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'plataforma\_%'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS public.%s', f);
  END LOOP;
END
$apagar$;

-- ---------------------------------------------------------------------
-- Autenticação do operador
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION plataforma_lookup_admin(p_email citext)
RETURNS TABLE (
  id uuid, password_hash text, full_name text,
  is_active boolean, locked_until timestamptz, must_change_password boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.password_hash, a.full_name, a.is_active, a.locked_until, a.must_change_password
    FROM platform_admins a
   WHERE a.email = p_email
$$;

/* Mesma coisa, buscando por id: usada quando o operador troca a própria
   senha e já está autenticado — o token traz o id, não o e-mail. */
CREATE OR REPLACE FUNCTION plataforma_lookup_admin_por_id(p_id uuid)
RETURNS TABLE (
  id uuid, password_hash text, full_name text,
  is_active boolean, locked_until timestamptz, must_change_password boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.password_hash, a.full_name, a.is_active, a.locked_until, a.must_change_password
    FROM platform_admins a
   WHERE a.id = p_id
$$;

CREATE OR REPLACE FUNCTION plataforma_registrar_tentativa(p_id uuid, p_sucesso boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_sucesso THEN
    UPDATE platform_admins
       SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
     WHERE id = p_id;
  ELSE
    /* Trava progressiva a partir da quinta tentativa. O bloqueio é
       gravado no banco de propósito: em memória, ele se perderia num
       restart e bastaria derrubar o processo para zerar o contador. */
    UPDATE platform_admins
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= 5
             THEN now() + (least(failed_login_count + 1 - 4, 12) * interval '5 minutes')
             ELSE locked_until
           END
     WHERE id = p_id;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION plataforma_criar_sessao(
  p_admin uuid, p_hash text, p_familia uuid, p_expira timestamptz,
  p_agente text, p_ip inet
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO platform_sessions (admin_id, token_hash, family_id, expires_at, user_agent, ip)
  VALUES (p_admin, p_hash, p_familia, p_expira, p_agente, p_ip)
$$;

CREATE OR REPLACE FUNCTION plataforma_lookup_sessao(p_hash text)
RETURNS TABLE (id uuid, admin_id uuid, family_id uuid, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.admin_id, s.family_id, s.expires_at, s.revoked_at
    FROM platform_sessions s
   WHERE s.token_hash = p_hash
$$;

/* Revoga a FAMÍLIA inteira, não a sessão. Reapresentar um refresh já
   usado é sinal de token roubado: quem tem a cópia e quem tem o original
   passam a competir, e derrubar os dois é a única resposta segura. */
CREATE OR REPLACE FUNCTION plataforma_revogar_familia(p_familia uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE platform_sessions SET revoked_at = now()
   WHERE family_id = p_familia AND revoked_at IS NULL
$$;

CREATE OR REPLACE FUNCTION plataforma_trocar_senha(p_id uuid, p_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE platform_admins
     SET password_hash = p_hash, password_changed_at = now(), must_change_password = false
   WHERE id = p_id;
  UPDATE platform_sessions SET revoked_at = now()
   WHERE admin_id = p_id AND revoked_at IS NULL;
$$;

-- ---------------------------------------------------------------------
-- Empresas
-- ---------------------------------------------------------------------

/* A lista devolve NÚMEROS sobre cada empresa, nunca linhas dela. É a
   diferença entre "esta academia tem 214 alunos" — que o faturamento
   precisa — e "estes são os 214 alunos", que o operador não tem por que
   ver. */
CREATE OR REPLACE FUNCTION plataforma_listar_empresas()
RETURNS TABLE (
  id uuid, nome text, slug citext, documento text, timezone text,
  ativa boolean, plano text, contato_nome text, contato_email citext,
  contato_whatsapp text, observacoes text, teste_ate date,
  suspensa_em timestamptz, suspensa_motivo text, criada_em timestamptz,
  alunos bigint, alunos_ativos bigint, usuarios bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.name, t.slug, t.document, t.timezone,
         t.is_active, t.plano, t.contato_nome, t.contato_email,
         t.contato_whatsapp, t.observacoes, t.teste_ate,
         t.suspensa_em, t.suspensa_motivo, t.created_at,
         (SELECT count(*) FROM students s WHERE s.tenant_id = t.id),
         (SELECT count(*) FROM students s WHERE s.tenant_id = t.id AND s.status = 'ACTIVE'),
         (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active)
    FROM tenants t
   ORDER BY t.name
$$;

/* Cria a empresa E o primeiro dono numa transação só. Separar em duas
   chamadas deixaria empresa sem ninguém que consiga entrar nela — e
   quem a criou já foi embora da tela. */
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

CREATE OR REPLACE FUNCTION plataforma_atualizar_empresa(
  p_id uuid, p_nome text, p_documento text, p_timezone text, p_plano text,
  p_contato_nome text, p_contato_email citext, p_contato_whatsapp text,
  p_observacoes text, p_teste_ate date
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE afetadas integer;
BEGIN
  /* O SLUG NÃO É EDITÁVEL, de propósito: ele aparece em endereço,
     integração e registro de auditoria, e trocá-lo quebra referência que
     ninguém lembra que existe. Renomear a empresa muda o `name`. */
  UPDATE tenants SET
    name             = p_nome,
    document         = nullif(btrim(p_documento), ''),
    timezone         = coalesce(nullif(p_timezone, ''), timezone),
    plano            = nullif(btrim(p_plano), ''),
    contato_nome     = nullif(btrim(p_contato_nome), ''),
    contato_email    = p_contato_email,
    contato_whatsapp = nullif(btrim(p_contato_whatsapp), ''),
    observacoes      = nullif(btrim(p_observacoes), ''),
    teste_ate        = p_teste_ate
  WHERE id = p_id;
  GET DIAGNOSTICS afetadas = ROW_COUNT;
  RETURN afetadas > 0;
END
$$;

/* Suspender NÃO apaga nada. A empresa some do ar e os dados ficam
   inteiros: cliente que atrasa a mensalidade volta, e voltar não pode
   significar recadastrar trezentos alunos. */
CREATE OR REPLACE FUNCTION plataforma_definir_ativa(p_id uuid, p_ativa boolean, p_motivo text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE afetadas integer;
BEGIN
  UPDATE tenants SET
    is_active       = p_ativa,
    suspensa_em     = CASE WHEN p_ativa THEN NULL ELSE now() END,
    suspensa_motivo = CASE WHEN p_ativa THEN NULL ELSE nullif(btrim(p_motivo), '') END
  WHERE id = p_id;
  GET DIAGNOSTICS afetadas = ROW_COUNT;

  /* Suspender a empresa derruba as sessões abertas dela. Sem isto, quem
     já estava logado continua usando o sistema até o refresh expirar —
     até quatorze dias depois do corte. */
  IF NOT p_ativa THEN
    UPDATE user_sessions SET revoked_at = now()
     WHERE tenant_id = p_id AND revoked_at IS NULL;
  END IF;

  RETURN afetadas > 0;
END
$$;

-- ---------------------------------------------------------------------
-- Gestores de cada empresa
--
-- Só OWNER e ADMIN. Profissional, recepção e aluno não são assunto da
-- plataforma, e listá-los seria devolver a equipe inteira de cada
-- cliente para um painel que não precisa dela.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION plataforma_listar_gestores(p_tenant uuid)
RETURNS TABLE (id uuid, nome text, email citext, papel text, ativo boolean, ultimo_acesso timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.full_name, u.email, u.role::text, u.is_active, u.last_login_at
    FROM users u
   WHERE u.tenant_id = p_tenant AND u.role IN ('OWNER', 'ADMIN')
   ORDER BY u.role, u.full_name
$$;

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
  INSERT INTO users (tenant_id, email, password_hash, full_name, role, must_change_password)
  VALUES (p_tenant, p_email, p_hash, p_nome, p_papel::user_role, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

/* Redefinir senha de gestor: a nova é provisória e a troca é obrigatória
   no primeiro acesso. O operador nunca fica sabendo a senha definitiva
   de ninguém. */
CREATE OR REPLACE FUNCTION plataforma_redefinir_senha_gestor(p_user uuid, p_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE afetadas integer;
BEGIN
  UPDATE users
     SET password_hash = p_hash, password_changed_at = now(),
         must_change_password = true, failed_login_count = 0, locked_until = NULL
   WHERE id = p_user AND role IN ('OWNER', 'ADMIN');
  GET DIAGNOSTICS afetadas = ROW_COUNT;

  IF afetadas > 0 THEN
    UPDATE user_sessions SET revoked_at = now()
     WHERE user_id = p_user AND revoked_at IS NULL;
  END IF;
  RETURN afetadas > 0;
END
$$;

CREATE OR REPLACE FUNCTION plataforma_ativar_gestor(p_user uuid, p_ativo boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE afetadas integer;
BEGIN
  UPDATE users SET is_active = p_ativo
   WHERE id = p_user AND role IN ('OWNER', 'ADMIN');
  GET DIAGNOSTICS afetadas = ROW_COUNT;
  IF afetadas > 0 AND NOT p_ativo THEN
    UPDATE user_sessions SET revoked_at = now()
     WHERE user_id = p_user AND revoked_at IS NULL;
  END IF;
  RETURN afetadas > 0;
END
$$;

CREATE OR REPLACE FUNCTION plataforma_registrar(
  p_admin uuid, p_acao text, p_tenant uuid, p_alvo text, p_ip inet, p_meta jsonb
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO platform_audit (admin_id, acao, tenant_id, alvo, ip, metadata)
  VALUES (p_admin, p_acao, p_tenant, p_alvo, p_ip, coalesce(p_meta, '{}'::jsonb))
$$;

CREATE OR REPLACE FUNCTION plataforma_historico(p_limite integer)
RETURNS TABLE (quando timestamptz, quem text, acao text, empresa text, alvo text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p.created_at, coalesce(a.full_name, '—'), p.acao, coalesce(t.name, '—'), p.alvo
    FROM platform_audit p
    LEFT JOIN platform_admins a ON a.id = p.admin_id
    LEFT JOIN tenants t ON t.id = p.tenant_id
   ORDER BY p.created_at DESC
   LIMIT least(coalesce(p_limite, 100), 500)
$$;


-- ---------------------------------------------------------------------
-- Configuração da integração de WhatsApp
--
-- O endereço e o token administrativo da uazapi saíram do .env da VPS e
-- vieram para o painel: ligar a integração deixou de exigir SSH, editar
-- arquivo e reiniciar contêiner.
--
-- O TOKEN ENTRA E SAI CIFRADO destas funções. A cifra e a decifra
-- acontecem na API (AES-256-GCM, `segredo.ts`), não aqui — o banco nunca
-- vê o token em claro, e um dump não o entrega. É o mesmo tratamento do
-- token de instância de cada academia.
--
-- `plataforma_ler_config` é a única destas funções que a API chama fora
-- do painel: ela precisa do endereço e do token a cada envio de
-- mensagem. Devolve o texto CIFRADO; sem a ENCRYPTION_KEY, que vive na
-- variável de ambiente e não no banco, ele não serve para nada.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION plataforma_ler_config()
RETURNS TABLE (uazapi_base_url text, uazapi_admin_encrypted text, atualizado_em timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.uazapi_base_url, s.uazapi_admin_encrypted, s.atualizado_em
    FROM platform_settings s WHERE s.id
$$;

CREATE OR REPLACE FUNCTION plataforma_gravar_config(
  p_url text, p_token_cifrado text, p_admin uuid
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE platform_settings SET
    /* Endereço vazio vira NULL: string em branco passaria pela
       verificação de "está configurado?" e falharia só na hora do envio,
       com um erro de URL inválida que não explica nada. */
    uazapi_base_url = nullif(btrim(p_url), ''),
    /* Token nulo MANTÉM o que está lá. O painel reexibe a configuração
       sem o token — ele nunca volta para a tela —, então salvar o
       formulário sem redigitá-lo não pode apagar a integração. */
    uazapi_admin_encrypted = coalesce(p_token_cifrado, uazapi_admin_encrypted),
    atualizado_em = now(),
    atualizado_por = p_admin
  WHERE id;
$$;

CREATE OR REPLACE FUNCTION plataforma_limpar_token(p_admin uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE platform_settings
     SET uazapi_admin_encrypted = NULL, atualizado_em = now(), atualizado_por = p_admin
   WHERE id;
$$;


-- ---------------------------------------------------------------------
-- ENTRAR NA CONTA DE UM USUÁRIO
--
-- O dono do sistema precisa conseguir olhar o que o cliente está vendo
-- para dar suporte — "não consigo lançar o pagamento" é impossível de
-- resolver às cegas.
--
-- E ISSO É PODEROSO DEMAIS PARA SER SILENCIOSO. Um operador que entra na
-- conta de alguém alcança o prontuário daquela academia inteira. O que
-- torna aceitável não é limitar o poder — é o rastro: cada entrada grava
-- em `platform_audit` E no `audit_log` DA PRÓPRIA ACADEMIA, onde o dono
-- dela enxerga. Acesso a dado de saúde que ninguém consegue perceber é o
-- que uma auditoria chama de problema; acesso registrado dos dois lados
-- é suporte.
--
-- A função devolve só o necessário para emitir um token normal de
-- usuário. Ela NÃO devolve senha, e não existe caminho daqui para
-- descobrir a senha de ninguém.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION plataforma_usuario_para_acesso(p_user uuid)
RETURNS TABLE (user_id uuid, tenant_id uuid, papel text, nome text, email citext,
               empresa text, aluno_id uuid, ativo boolean, empresa_ativa boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.role::text, u.full_name, u.email,
         t.name, s.id, u.is_active, t.is_active
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN students s ON s.user_id = u.id
   WHERE u.id = p_user
$$;

/* Grava no audit_log DA ACADEMIA que o operador entrou na conta de
   alguém dela.
   
   Precisa ser função privilegiada: a policy de `audit_log` só aceita
   INSERT com `tenant_id = current_tenant_id()`, e o painel roda SEM
   contexto de empresa. Um INSERT direto dali responde 42501, que o
   tratador de erros traduz para 404 — o acesso de suporte funcionava
   pela metade e a rota inteira falhava com "Recurso não encontrado".
   
   É de propósito que o registro na academia seja obrigatório e não
   "melhor esforço": se ele falhar, a rota falha e o acesso não acontece.
   Acesso a prontuário sem rastro do lado de quem foi acessado é
   exatamente o que esta funcionalidade não pode produzir. */
CREATE OR REPLACE FUNCTION plataforma_registrar_acesso_suporte(
  p_tenant uuid, p_user uuid, p_papel text, p_ip inet, p_operador uuid
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  /* AÇÃO PRÓPRIA, e não 'auth.login' com um campo de metadados dizendo
     que foi suporte. O dono da academia tem direito de ver que alguém de
     fora entrou na conta dele, e isso não pode depender de ele abrir o
     JSON de metadados de um evento que, na listagem, parece uma entrada
     comum do próprio usuário. Um acesso de suporte que se lê como login
     normal é, na prática, um acesso sem rastro. */
  INSERT INTO audit_log (tenant_id, actor_id, actor_role, action, resource_type,
                         resource_id, outcome, ip, metadata)
  VALUES (p_tenant, p_user, p_papel::user_role, 'auth.support_access', 'user',
          p_user::text, 'SUCCESS', p_ip,
          jsonb_build_object('suporte', true, 'operador', p_operador))
$$;

/* A lista completa de usuários de uma empresa — não só os gestores.
   Serve à tela de suporte, onde o operador escolhe em nome de quem
   entrar. Devolve nome, e-mail e papel; nenhum dado de aluno. */
CREATE OR REPLACE FUNCTION plataforma_listar_usuarios(p_tenant uuid)
RETURNS TABLE (id uuid, nome text, email citext, papel text, ativo boolean,
               ultimo_acesso timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.full_name, u.email, u.role::text, u.is_active, u.last_login_at
    FROM users u
   WHERE u.tenant_id = p_tenant
   ORDER BY
     CASE u.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1
                 WHEN 'PROFESSIONAL' THEN 2 WHEN 'RECEPTION' THEN 3 ELSE 4 END,
     u.full_name
$$;

/* Métricas do serviço, para o painel de quem opera. NÚMEROS apenas. */
CREATE OR REPLACE FUNCTION plataforma_metricas()
RETURNS TABLE (
  empresas bigint, empresas_ativas bigint, empresas_suspensas bigint,
  usuarios bigint, alunos bigint, alunos_ativos bigint,
  agendamentos_30d bigint, mensagens_pendentes bigint, mensagens_falhas bigint,
  logins_24h bigint, logins_falhos_24h bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM tenants),
    (SELECT count(*) FROM tenants WHERE is_active),
    (SELECT count(*) FROM tenants WHERE NOT is_active),
    (SELECT count(*) FROM users WHERE is_active),
    (SELECT count(*) FROM students),
    (SELECT count(*) FROM students WHERE status = 'ACTIVE'),
    (SELECT count(*) FROM appointments WHERE created_at > now() - interval '30 days'),
    (SELECT count(*) FROM whatsapp_messages WHERE status = 'PENDING'),
    (SELECT count(*) FROM whatsapp_messages WHERE status = 'FAILED'),
    (SELECT count(*) FROM audit_log WHERE action = 'auth.login'        AND created_at > now() - interval '24 hours'),
    (SELECT count(*) FROM audit_log WHERE action = 'auth.login_failed' AND created_at > now() - interval '24 hours')
$$;

/* Os erros recentes de TODAS as academias, para o operador enxergar
   problema antes de o cliente ligar. Só o que o audit_log registra como
   negado ou com erro; nenhum conteúdo de prontuário. */
CREATE OR REPLACE FUNCTION plataforma_erros_recentes(p_limite integer)
RETURNS TABLE (quando timestamptz, empresa text, acao text, recurso text, resultado text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.created_at, coalesce(t.name, '—'), a.action, a.resource_type, a.outcome
    FROM audit_log a
    LEFT JOIN tenants t ON t.id = a.tenant_id
   WHERE a.outcome IN ('DENIED', 'ERROR')
   ORDER BY a.created_at DESC
   LIMIT least(coalesce(p_limite, 50), 200)
$$;

-- ---------------------------------------------------------------------
-- Dono das funções e quem pode chamá-las
--
-- O dono é `stabilize_plataforma` (BYPASSRLS) — é isso que faz o
-- SECURITY DEFINER funcionar. Ver 007_auth_super.sql: uma função
-- SECURITY DEFINER pertencente a papel SEM BYPASSRLS, sob FORCE RLS,
-- devolve zero linhas para todo mundo. Foi o defeito que impediu
-- qualquer login na primeira instalação.
-- ---------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOR f IN
    SELECT format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'plataforma\_%'
  LOOP
    EXECUTE format('ALTER FUNCTION public.%s OWNER TO stabilize_plataforma', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO stabilize_app', f);
  END LOOP;
END $$;
