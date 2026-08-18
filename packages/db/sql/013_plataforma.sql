-- =====================================================================
-- PAINEL DA PLATAFORMA — quem opera o SaaS
--
-- Até aqui, criar uma academia exigia um INSERT à mão no banco. Este
-- arquivo cria o que falta para o sistema ser operado como serviço:
-- cadastrar empresa, editar, suspender e nomear o primeiro gestor de
-- cada uma.
--
-- =====================================================================
-- A DECISÃO CENTRAL, E ELA PRECISA ESTAR ESCRITA
-- =====================================================================
--
-- O administrador de plataforma administra CONTAS, não PRONTUÁRIOS.
--
-- Ele cria empresa, renomeia, suspende, nomeia o dono, vê quantos alunos
-- cada uma tem para faturar. Ele NÃO lê aluno, anamnese, evolução,
-- anexo, agenda nem financeiro de empresa nenhuma — e isso não é
-- limitação de implementação, é o desenho.
--
-- O motivo: se a conta da plataforma pudesse ler tudo, comprometer UMA
-- conta exporia o prontuário de todas as clínicas do sistema. E essa é
-- justamente a conta mais atacada, porque é a única que interessa a
-- quem quer tudo. Uma arquitetura inteira de RLS viraria decoração
-- protegendo os inquilinos uns dos outros enquanto a porta da frente
-- fica aberta.
--
-- QUANDO O OPERADOR PRECISAR MESMO VER OS DADOS DE UMA ACADEMIA, o
-- caminho existe e é honesto: ele cria para si um usuário DENTRO daquela
-- empresa. Esse acesso aparece na lista de usuários da academia, fica no
-- audit_log dela, e o dono enxerga que existe. Acesso a dado de saúde
-- que ninguém consegue perceber é o que uma auditoria chama de problema.
--
-- =====================================================================
-- COMO O BURACO É ABERTO
-- =====================================================================
--
-- Mesmo padrão do login (ver 003_auth.sql e 007_auth_super.sql): um
-- papel `stabilize_plataforma`, NOLOGIN e BYPASSRLS, dono de um punhado
-- de funções SECURITY DEFINER. Ninguém conecta como ele; o que a API
-- alcança é exatamente o que essas funções fazem, e nada além.
--
-- Nenhuma delas devolve linha de `students`, `anamneses`, `evolutions`,
-- `attachments`, `appointments` ou `finance_entries`. As contagens
-- devolvem NÚMEROS, que é o que o faturamento precisa e o que não
-- identifica ninguém.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Contas de plataforma
--
-- Tabela SEPARADA de `users`, e não um papel novo no enum. Um
-- `SUPER_ADMIN` dentro de `users` teria `tenant_id NOT NULL` — teria que
-- pertencer a uma empresa para existir, o que é falso — e passaria a
-- aparecer em toda consulta que lista usuários da academia. Pior: a
-- policy `users_tenant` decide o que ele enxerga, e afrouxá-la para
-- deixar um papel atravessar é abrir exceção na regra que protege todo
-- o resto.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_admins (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 citext NOT NULL UNIQUE,
  password_hash         text NOT NULL,
  full_name             text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 160),
  is_active             boolean NOT NULL DEFAULT true,

  -- As mesmas defesas de `users`: força bruta é avaliada no banco para
  -- sobreviver a reinício de processo e a várias instâncias da API.
  failed_login_count    integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  must_change_password  boolean NOT NULL DEFAULT false,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_platform_admins_updated ON platform_admins;
CREATE TRIGGER trg_platform_admins_updated BEFORE UPDATE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- SEM RLS, e a ausência é deliberada: não há tenant a que esta tabela
-- pertença. A proteção é por GRANT — `stabilize_app` não recebe
-- privilégio nenhum aqui, então a conexão da API não alcança a tabela
-- direto. Só as funções abaixo, que rodam como o dono.
REVOKE ALL ON platform_admins FROM PUBLIC;

-- ---------------------------------------------------------------------
-- Sessões da plataforma
--
-- Separadas de `user_sessions` pelo mesmo motivo da tabela acima: aquela
-- tem `tenant_id NOT NULL` e policy por empresa.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  -- O HASH do refresh token, nunca o token. Um dump de banco não
  -- devolve sessão reutilizável.
  token_hash       text NOT NULL UNIQUE,
  family_id        uuid NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  user_agent       text,
  ip               inet,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_admin
  ON platform_sessions (admin_id, expires_at DESC);
REVOKE ALL ON platform_sessions FROM PUBLIC;

-- ---------------------------------------------------------------------
-- O que uma empresa precisa saber de si como CLIENTE do SaaS
--
-- Separado do que ela precisa saber de si como academia (nome, fuso).
-- ---------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plano           text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contato_nome    text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contato_email   citext;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contato_whatsapp text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS observacoes     text;
-- Fim do período de teste. Nulo = sem prazo.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS teste_ate       date;
-- Quando e por quem a empresa foi suspensa. Suspender sem registrar o
-- motivo gera a pergunta "por que esta academia está fora?" seis meses
-- depois, sem resposta.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspensa_em     timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspensa_motivo text;

-- ---------------------------------------------------------------------
-- Registro do que a plataforma faz
--
-- `audit_log` é por empresa e tem `tenant_id NOT NULL`; criar empresa
-- acontece antes de existir empresa. Esta tabela é o diário do operador.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_audit (
  id          bigserial PRIMARY KEY,
  admin_id    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  acao        text NOT NULL,
  tenant_id   uuid,
  alvo        text,
  ip          inet,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_tempo
  ON platform_audit (created_at DESC);
REVOKE ALL ON platform_audit FROM PUBLIC;
