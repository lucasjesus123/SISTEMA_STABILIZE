-- =====================================================================
-- Stabilize — esquema inicial
--
-- Três decisões estruturais que valem para o arquivo inteiro:
--
-- 1. ISOLAMENTO NO BANCO, NÃO NO CÓDIGO.
--    Toda tabela com dado de empresa tem `tenant_id` e Row-Level Security
--    ligada com FORCE. Se um dia alguém escrever uma query sem WHERE
--    tenant_id — e num sistema com muitas telas alguém vai — o banco
--    devolve zero linhas em vez de devolver os dados de outra empresa.
--    A aplicação conecta com um papel SEM BYPASSRLS, de propósito.
--
-- 2. DINHEIRO É BIGINT EM CENTAVOS.
--    Nunca NUMERIC com casas decimais implícitas, nunca FLOAT.
--    Ver packages/shared/src/money.ts para o porquê aritmético.
--
-- 3. REGRA DE NEGÓCIO CRÍTICA VIRA RESTRIÇÃO, NÃO VALIDAÇÃO.
--    Dupla-marcação de agenda é impedida por EXCLUSION CONSTRAINT.
--    Validar em código é uma corrida: dois requests simultâneos passam
--    os dois pelo "está livre?" e gravam os dois. O banco não perde
--    essa corrida.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- exclusão combinando = e &&
CREATE EXTENSION IF NOT EXISTS "citext";     -- e-mail case-insensitive

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
-- CREATE TYPE NÃO ACEITA `IF NOT EXISTS` — é uma lacuna do PostgreSQL,
-- não um esquecimento aqui. Sem o bloco abaixo, reexecutar a migration
-- morre em `ERROR: type "user_role" already exists`, e reexecutar é
-- exatamente o que toda ATUALIZAÇÃO faz. O DEPLOY.md chegou a afirmar
-- que as migrations eram idempotentes; para as tabelas era verdade
-- (todas usam IF NOT EXISTS), para os tipos não era.
DO $tipos$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN', 'PROFESSIONAL', 'RECEPTION', 'STUDENT');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'student_status') THEN
    CREATE TYPE student_status AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'LEAD');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointment_status') THEN
    CREATE TYPE appointment_status AS ENUM ('SCHEDULED', 'CONFIRMED', 'ATTENDED', 'NO_SHOW', 'CANCELLED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_cycle') THEN
    CREATE TYPE billing_cycle AS ENUM ('SESSION', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entry_status') THEN
    CREATE TYPE entry_status AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method') THEN
    CREATE TYPE payment_method AS ENUM ('PIX', 'CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'BANK_TRANSFER', 'BOLETO', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'commission_status') THEN
    CREATE TYPE commission_status AS ENUM ('PENDING', 'APPROVED', 'SETTLED', 'CANCELLED');
  END IF;
END
$tipos$;

-- ---------------------------------------------------------------------
-- Contexto de tenant
--
-- A aplicação faz `SET LOCAL app.tenant_id = '<uuid>'` no início de cada
-- transação, a partir do TOKEN — nunca a partir de parâmetro do cliente.
-- current_tenant_id() lê esse contexto; toda policy pendura nele.
--
-- STABLE (e não IMMUTABLE) porque o valor muda entre transações;
-- marcar como IMMUTABLE permitiria ao planner cachear entre contextos,
-- o que seria exatamente o vazamento que estamos evitando.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Sem contexto definido, isto devolve NULL e toda policy falha fechada:
-- `tenant_id = NULL` é NULL, que não é TRUE, então nenhuma linha passa.
-- Falhar fechado é a propriedade que queremos de uma configuração ausente.

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Gatilho de updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =====================================================================
-- TENANTS
-- =====================================================================
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  slug          citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  document      text,                       -- CNPJ, sem máscara
  timezone      text NOT NULL DEFAULT 'America/Sao_Paulo',
  is_active     boolean NOT NULL DEFAULT true,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A própria tabela de tenants é isolada: uma empresa só enxerga a si mesma.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- =====================================================================
-- USUÁRIOS
-- =====================================================================
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email                 citext NOT NULL,
  password_hash         text NOT NULL,
  full_name             text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 160),
  role                  user_role NOT NULL,
  phone                 text,
  avatar_path           text,
  is_active             boolean NOT NULL DEFAULT true,

  -- Defesa contra força bruta, avaliada no banco para sobreviver a
  -- reinício de processo e a múltiplas instâncias da API.
  failed_login_count    integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  must_change_password  boolean NOT NULL DEFAULT false,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- E-mail é único DENTRO da empresa. Duas academias podem ter o mesmo
  -- e-mail de contato sem colidir; o login resolve tenant + e-mail.
  CONSTRAINT users_email_per_tenant UNIQUE (tenant_id, email)
);
CREATE INDEX idx_users_tenant_role ON users (tenant_id, role) WHERE is_active;
CREATE INDEX idx_users_email_lookup ON users (email);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant ON users
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Sessões (refresh tokens)
--
-- Guardamos o HASH do refresh token, não o token. Se o banco vazar, os
-- tokens gravados não são reutilizáveis. Mesma lógica de senha.
-- ---------------------------------------------------------------------
CREATE TABLE user_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  family_id       uuid NOT NULL,          -- rotação: detecta reuso de token
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  ip              inet,
  user_agent      text,
  CONSTRAINT sessions_expiry_after_issue CHECK (expires_at > issued_at)
);
CREATE INDEX idx_sessions_user ON user_sessions (tenant_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_family ON user_sessions (family_id);
CREATE INDEX idx_sessions_expiry ON user_sessions (expires_at) WHERE revoked_at IS NULL;

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_tenant ON user_sessions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =====================================================================
-- SALAS E ESPAÇOS
-- =====================================================================
CREATE TABLE rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text,
  capacity    integer NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  color       text CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rooms_name_per_tenant UNIQUE (tenant_id, name)
);
CREATE TRIGGER trg_rooms_updated BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY rooms_tenant ON rooms
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =====================================================================
-- ALUNOS
-- =====================================================================
CREATE TABLE students (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Conta de acesso ao app do aluno. Opcional: existe aluno cadastrado
  -- que ainda não ativou o app.
  user_id               uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,

  full_name             text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 160),
  email                 citext,
  phone                 text,
  whatsapp              text,               -- E.164, ex.: +5511987654321
  birth_date            date,
  document              text,               -- CPF, sem máscara
  gender                text,
  photo_path            text,

  address_zip           text,
  address_street        text,
  address_number        text,
  address_complement    text,
  address_district      text,
  address_city          text,
  address_state         char(2),

  emergency_contact     text,
  emergency_phone       text,

  status                student_status NOT NULL DEFAULT 'ACTIVE',
  notes                 text,
  started_at            date,
  ended_at              date,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT students_period_valid CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CONSTRAINT students_whatsapp_e164 CHECK (whatsapp IS NULL OR whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT students_birth_sane CHECK (birth_date IS NULL OR birth_date > '1900-01-01')
);

-- Índices compostos começando por tenant_id: é assim que toda query chega,
-- por causa da RLS. Um índice que não começa por tenant_id é pouco útil aqui.
CREATE INDEX idx_students_tenant_status ON students (tenant_id, status);
CREATE INDEX idx_students_tenant_name ON students (tenant_id, full_name);
CREATE INDEX idx_students_tenant_created ON students (tenant_id, created_at DESC);
-- Aniversariantes do dia: índice sobre (mês, dia) para a rotina de WhatsApp
-- não varrer a tabela inteira todo dia.
CREATE INDEX idx_students_birthday ON students (
  tenant_id,
  (EXTRACT(MONTH FROM birth_date)),
  (EXTRACT(DAY FROM birth_date))
) WHERE birth_date IS NOT NULL AND status = 'ACTIVE';
CREATE UNIQUE INDEX idx_students_document ON students (tenant_id, document) WHERE document IS NOT NULL;

CREATE TRIGGER trg_students_updated BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE students FORCE ROW LEVEL SECURITY;
CREATE POLICY students_tenant ON students
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Vínculo aluno ↔ profissional
--
-- Esta tabela é o que dá sentido ao escopo OWN_PROFESSIONAL do RBAC.
-- É a resposta a "quais alunos são deste professor".
-- ---------------------------------------------------------------------
CREATE TABLE student_professionals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary      boolean NOT NULL DEFAULT true,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  unassigned_at   timestamptz,
  CONSTRAINT sp_unique UNIQUE (tenant_id, student_id, professional_id)
);
CREATE INDEX idx_sp_professional ON student_professionals (tenant_id, professional_id) WHERE unassigned_at IS NULL;
CREATE INDEX idx_sp_student ON student_professionals (tenant_id, student_id) WHERE unassigned_at IS NULL;

ALTER TABLE student_professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_professionals FORCE ROW LEVEL SECURITY;
CREATE POLICY sp_tenant ON student_professionals
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =====================================================================
-- PRONTUÁRIO CLÍNICO
-- Dado de saúde. Trata-se de categoria sensível na LGPD (art. 5º, II),
-- o que justifica auditoria de leitura, não só de escrita.
-- =====================================================================
CREATE TABLE anamneses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  professional_id   uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Conteúdo estruturado da anamnese. jsonb porque o formulário evolui
  -- com a prática clínica; a estrutura é validada por schema Zod na API.
  answers           jsonb NOT NULL DEFAULT '{}'::jsonb,

  chief_complaint   text,
  clinical_history  text,
  medications       text,
  surgeries         text,
  injuries          text,
  goals             text,
  contraindications text,

  height_cm         integer CHECK (height_cm IS NULL OR height_cm BETWEEN 50 AND 260),
  weight_g          integer CHECK (weight_g IS NULL OR weight_g BETWEEN 1000 AND 500000),

  performed_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_anamneses_student ON anamneses (tenant_id, student_id, performed_at DESC);
CREATE TRIGGER trg_anamneses_updated BEFORE UPDATE ON anamneses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE anamneses ENABLE ROW LEVEL SECURITY;
ALTER TABLE anamneses FORCE ROW LEVEL SECURITY;
CREATE POLICY anamneses_tenant ON anamneses
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE TABLE evolutions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  appointment_id  uuid,                    -- FK adicionada após appointments

  session_date    date NOT NULL,
  content         text NOT NULL CHECK (length(btrim(content)) > 0),
  pain_scale      smallint CHECK (pain_scale IS NULL OR pain_scale BETWEEN 0 AND 10),
  measurements    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_evolutions_student ON evolutions (tenant_id, student_id, session_date DESC);
CREATE INDEX idx_evolutions_professional ON evolutions (tenant_id, professional_id, session_date DESC);
CREATE TRIGGER trg_evolutions_updated BEFORE UPDATE ON evolutions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE evolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY evolutions_tenant ON evolutions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Anexos (exames, laudos, fotos)
--
-- `storage_key` é uma chave opaca gerada pelo servidor, nunca o nome do
-- arquivo enviado pelo usuário. Nome original vai em coluna separada e
-- só é usado como rótulo de exibição e no Content-Disposition — nunca
-- para compor caminho em disco, que é como nasce path traversal.
-- ---------------------------------------------------------------------
CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  storage_key     text NOT NULL UNIQUE,
  original_name   text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 text NOT NULL,
  category        text,
  description     text,

  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX idx_attachments_student ON attachments (tenant_id, student_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_tenant ON attachments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =====================================================================
-- DISPONIBILIDADE E AGENDA
-- =====================================================================

-- Janela recorrente que o profissional declara ("segundas, 6h às 12h").
CREATE TABLE availability_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = domingo
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  room_id         uuid REFERENCES rooms(id) ON DELETE SET NULL,
  slot_minutes    integer NOT NULL DEFAULT 60 CHECK (slot_minutes BETWEEN 15 AND 480),
  valid_from      date NOT NULL DEFAULT CURRENT_DATE,
  valid_until     date,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_time_order CHECK (end_time > start_time),
  CONSTRAINT availability_validity CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX idx_availability_professional ON availability_rules (tenant_id, professional_id, weekday)
  WHERE is_active;
CREATE TRIGGER trg_availability_updated BEFORE UPDATE ON availability_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE availability_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY availability_tenant ON availability_rules
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Bloqueio pontual: férias, feriado, compromisso, manutenção de sala.
CREATE TABLE availability_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid REFERENCES users(id) ON DELETE CASCADE,
  room_id         uuid REFERENCES rooms(id) ON DELETE CASCADE,
  period          tstzrange NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Um bloqueio precisa dizer o que bloqueia: um profissional, uma sala,
  -- ou ambos. Bloqueio que não bloqueia nada é dado sem sentido.
  CONSTRAINT block_targets_something CHECK (professional_id IS NOT NULL OR room_id IS NOT NULL),
  CONSTRAINT block_period_valid CHECK (NOT isempty(period) AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL)
);
CREATE INDEX idx_blocks_period ON availability_blocks USING gist (tenant_id, period);

ALTER TABLE availability_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY blocks_tenant ON availability_blocks
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- AGENDAMENTOS
--
-- `period` é a fonte da verdade do horário (tstzrange, semiaberto
-- [início, fim) — encostar não é sobrepor: 9-10h e 10-11h convivem).
--
-- As duas EXCLUSION CONSTRAINTS abaixo são o coração da agenda:
-- o banco recusa fisicamente marcar dois atendimentos no mesmo
-- profissional ou na mesma sala em horários que se cruzam. Isso vale
-- inclusive sob concorrência, que é onde a validação em código falha.
-- ---------------------------------------------------------------------
CREATE TABLE appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  professional_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  room_id           uuid REFERENCES rooms(id) ON DELETE SET NULL,

  period            tstzrange NOT NULL,
  status            appointment_status NOT NULL DEFAULT 'SCHEDULED',

  notes             text,
  student_note      text,                   -- observação que o aluno deixa ao agendar
  price_cents       bigint CHECK (price_cents IS NULL OR price_cents >= 0),
  is_included_in_plan boolean NOT NULL DEFAULT false,

  cancelled_at      timestamptz,
  cancelled_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  cancellation_reason text,

  checked_in_at     timestamptz,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT appt_period_valid CHECK (
    NOT isempty(period) AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL
  ),
  -- Coerência de estado: cancelado precisa ter data de cancelamento, e
  -- não-cancelado não pode ter. Evita o registro meio-cancelado que
  -- confunde relatório e contagem de presença.
  CONSTRAINT appt_cancel_coherent CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL)
  ),
  -- Aula do plano não tem preço avulso; aula avulsa precisa de preço.
  CONSTRAINT appt_pricing_coherent CHECK (
    (is_included_in_plan AND price_cents IS NULL)
    OR (NOT is_included_in_plan)
  ),

  -- Um profissional não pode estar em dois lugares ao mesmo tempo.
  CONSTRAINT appt_no_professional_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    professional_id WITH =,
    period WITH &&
  ) WHERE (status <> 'CANCELLED'),

  -- Uma sala não pode receber dois atendimentos simultâneos.
  -- (capacity > 1 é atendido por salas separadas ou por turma; ver ROADMAP.)
  CONSTRAINT appt_no_room_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    room_id WITH =,
    period WITH &&
  ) WHERE (status <> 'CANCELLED' AND room_id IS NOT NULL),

  -- E o aluno também não pode estar em dois atendimentos ao mesmo tempo.
  CONSTRAINT appt_no_student_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    student_id WITH =,
    period WITH &&
  ) WHERE (status <> 'CANCELLED')
);

CREATE INDEX idx_appt_tenant_period ON appointments USING gist (tenant_id, period);
CREATE INDEX idx_appt_professional_period ON appointments (tenant_id, professional_id, lower(period) DESC);
CREATE INDEX idx_appt_student_period ON appointments (tenant_id, student_id, lower(period) DESC);
CREATE INDEX idx_appt_status ON appointments (tenant_id, status, lower(period));
CREATE TRIGGER trg_appt_updated BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant ON appointments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Agora que appointments existe, fecha a FK de evolutions.
ALTER TABLE evolutions
  ADD CONSTRAINT evolutions_appointment_fk
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;

-- =====================================================================
-- FINANCEIRO
-- Todo valor em BIGINT de centavos. Todo percentual em basis points.
-- =====================================================================

-- Tabela de preços (sessão avulsa, mensalidade, pacote).
CREATE TABLE price_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  cycle                 billing_cycle NOT NULL,
  amount_cents          bigint NOT NULL CHECK (amount_cents >= 0),
  sessions_included     integer CHECK (sessions_included IS NULL OR sessions_included >= 0),
  commission_bp         integer NOT NULL DEFAULT 0 CHECK (commission_bp BETWEEN 0 AND 10000),
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_plan_name_per_tenant UNIQUE (tenant_id, name)
);
CREATE TRIGGER trg_price_plans_updated BEFORE UPDATE ON price_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE price_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY price_plans_tenant ON price_plans
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Contrato do aluno: qual plano ele tem e por quanto.
CREATE TABLE student_contracts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  price_plan_id     uuid REFERENCES price_plans(id) ON DELETE SET NULL,
  professional_id   uuid REFERENCES users(id) ON DELETE SET NULL,

  cycle             billing_cycle NOT NULL,
  -- Valor negociado, que pode divergir da tabela. Guardar aqui (e não só
  -- referenciar o plano) preserva o histórico: mudar a tabela de preços
  -- amanhã não pode reescrever o que já foi cobrado.
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  commission_bp     integer NOT NULL DEFAULT 0 CHECK (commission_bp BETWEEN 0 AND 10000),
  sessions_included integer CHECK (sessions_included IS NULL OR sessions_included >= 0),

  billing_day       smallint CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 28),
  starts_on         date NOT NULL,
  ends_on           date,
  is_active         boolean NOT NULL DEFAULT true,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_period_valid CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX idx_contracts_student ON student_contracts (tenant_id, student_id) WHERE is_active;
CREATE INDEX idx_contracts_professional ON student_contracts (tenant_id, professional_id) WHERE is_active;
CREATE TRIGGER trg_contracts_updated BEFORE UPDATE ON student_contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE student_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY contracts_tenant ON student_contracts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Lançamentos financeiros
--
-- Uma única tabela para receber e pagar, distinguida por `direction`.
-- O motivo é que relatório de fluxo de caixa, conciliação e busca por
-- vencimento operam sobre os dois lados; duas tabelas simétricas
-- dobrariam a lógica e as chances de divergirem.
-- ---------------------------------------------------------------------
-- Mesmo motivo do bloco de tipos lá em cima: CREATE TYPE não tem
-- `IF NOT EXISTS`, e sem isto a reexecução falha.
DO $direcao$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entry_direction') THEN
    CREATE TYPE entry_direction AS ENUM ('RECEIVABLE', 'PAYABLE');
  END IF;
END
$direcao$;

CREATE TABLE finance_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction         entry_direction NOT NULL,

  description       text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  category          text,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  due_date          date NOT NULL,
  competence_date   date,                   -- regime de competência

  status            entry_status NOT NULL DEFAULT 'OPEN',
  -- Cache do total já pago. Mantido por gatilho a partir de finance_payments,
  -- nunca escrito pela aplicação — ver trg_recalc_entry_paid abaixo.
  paid_cents        bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),

  student_id        uuid REFERENCES students(id) ON DELETE SET NULL,
  contract_id       uuid REFERENCES student_contracts(id) ON DELETE SET NULL,
  professional_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  appointment_id    uuid REFERENCES appointments(id) ON DELETE SET NULL,
  supplier_name     text,

  recurrence_id     uuid,                   -- FK adicionada após a tabela
  installment_no    integer CHECK (installment_no IS NULL OR installment_no >= 1),
  installment_total integer CHECK (installment_total IS NULL OR installment_total >= 1),

  notes             text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,

  -- Nunca receber mais do que o devido: protege o extrato contra
  -- pagamento duplicado lançado por engano.
  CONSTRAINT entry_not_overpaid CHECK (paid_cents <= amount_cents),
  CONSTRAINT entry_installment_coherent CHECK (
    (installment_no IS NULL AND installment_total IS NULL)
    OR (installment_no IS NOT NULL AND installment_total IS NOT NULL AND installment_no <= installment_total)
  ),
  -- Conta a receber precisa dizer de quem; conta a pagar, para quem.
  CONSTRAINT entry_counterparty CHECK (
    (direction = 'RECEIVABLE' AND (student_id IS NOT NULL OR supplier_name IS NOT NULL))
    OR (direction = 'PAYABLE')
  )
);

CREATE INDEX idx_entries_tenant_due ON finance_entries (tenant_id, direction, due_date);
CREATE INDEX idx_entries_open ON finance_entries (tenant_id, direction, due_date)
  WHERE status IN ('OPEN', 'PARTIALLY_PAID', 'OVERDUE');
CREATE INDEX idx_entries_student ON finance_entries (tenant_id, student_id, due_date DESC)
  WHERE student_id IS NOT NULL;
CREATE INDEX idx_entries_professional ON finance_entries (tenant_id, professional_id, due_date DESC)
  WHERE professional_id IS NOT NULL;
CREATE INDEX idx_entries_competence ON finance_entries (tenant_id, competence_date);
CREATE TRIGGER trg_entries_updated BEFORE UPDATE ON finance_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE finance_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY entries_tenant ON finance_entries
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Recorrências (mensalistas, aluguel, folha)
-- Um molde a partir do qual os lançamentos concretos são gerados.
-- ---------------------------------------------------------------------
CREATE TABLE finance_recurrences (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction         entry_direction NOT NULL,
  description       text NOT NULL,
  category          text,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  cycle             billing_cycle NOT NULL,
  billing_day       smallint NOT NULL CHECK (billing_day BETWEEN 1 AND 28),

  student_id        uuid REFERENCES students(id) ON DELETE CASCADE,
  contract_id       uuid REFERENCES student_contracts(id) ON DELETE CASCADE,
  professional_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  supplier_name     text,

  starts_on         date NOT NULL,
  ends_on           date,
  last_generated_on date,
  is_active         boolean NOT NULL DEFAULT true,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurrence_period_valid CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX idx_recurrences_active ON finance_recurrences (tenant_id, direction, is_active, billing_day);
CREATE TRIGGER trg_recurrences_updated BEFORE UPDATE ON finance_recurrences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE finance_recurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_recurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY recurrences_tenant ON finance_recurrences
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE finance_entries
  ADD CONSTRAINT entries_recurrence_fk
  FOREIGN KEY (recurrence_id) REFERENCES finance_recurrences(id) ON DELETE SET NULL;

-- A geração de recorrência precisa ser idempotente: rodar o cron duas
-- vezes no mesmo dia não pode cobrar o aluno duas vezes. Este índice é
-- o que garante isso, no banco.
CREATE UNIQUE INDEX idx_entries_recurrence_competence
  ON finance_entries (recurrence_id, competence_date)
  WHERE recurrence_id IS NOT NULL AND cancelled_at IS NULL;

-- ---------------------------------------------------------------------
-- Pagamentos (baixas)
-- ---------------------------------------------------------------------
CREATE TABLE finance_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id        uuid NOT NULL REFERENCES finance_entries(id) ON DELETE CASCADE,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  method          payment_method NOT NULL,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  reference       text,
  notes           text,
  recorded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_entry ON finance_payments (tenant_id, entry_id);
CREATE INDEX idx_payments_date ON finance_payments (tenant_id, paid_at DESC);

ALTER TABLE finance_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_tenant ON finance_payments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- O total pago e o status do lançamento são DERIVADOS dos pagamentos,
-- recalculados por gatilho. Deixar a aplicação somar e escrever esse
-- total abriria espaço para o extrato divergir dos recibos sob
-- concorrência ou por um caminho de código esquecido.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recalc_entry_paid() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id uuid;
  v_total    bigint;
  v_amount   bigint;
  v_due      date;
BEGIN
  v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT COALESCE(SUM(amount_cents), 0) INTO v_total
    FROM finance_payments WHERE entry_id = v_entry_id;

  SELECT amount_cents, due_date INTO v_amount, v_due
    FROM finance_entries WHERE id = v_entry_id;

  UPDATE finance_entries SET
    paid_cents = v_total,
    status = CASE
      WHEN cancelled_at IS NOT NULL THEN 'CANCELLED'::entry_status
      WHEN v_total >= v_amount      THEN 'PAID'::entry_status
      WHEN v_total > 0              THEN 'PARTIALLY_PAID'::entry_status
      WHEN v_due < CURRENT_DATE     THEN 'OVERDUE'::entry_status
      ELSE 'OPEN'::entry_status
    END
  WHERE id = v_entry_id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_recalc_entry_paid
  AFTER INSERT OR UPDATE OR DELETE ON finance_payments
  FOR EACH ROW EXECUTE FUNCTION recalc_entry_paid();

-- ---------------------------------------------------------------------
-- Comissões
-- ---------------------------------------------------------------------
CREATE TABLE commissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  reference_month   date NOT NULL,          -- sempre dia 1 do mês de referência
  base_cents        bigint NOT NULL CHECK (base_cents >= 0),
  rate_bp           integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),

  status            commission_status NOT NULL DEFAULT 'PENDING',
  settled_entry_id  uuid REFERENCES finance_entries(id) ON DELETE SET NULL,
  settled_at        timestamptz,
  notes             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT commission_month_is_first_day CHECK (EXTRACT(DAY FROM reference_month) = 1),
  CONSTRAINT commission_unique_per_month UNIQUE (tenant_id, professional_id, reference_month)
);
CREATE INDEX idx_commissions_professional ON commissions (tenant_id, professional_id, reference_month DESC);
CREATE TRIGGER trg_commissions_updated BEFORE UPDATE ON commissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commissions FORCE ROW LEVEL SECURITY;
CREATE POLICY commissions_tenant ON commissions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Itens que compuseram a comissão — a memória de cálculo, para o
-- profissional poder conferir linha a linha de onde veio o valor.
CREATE TABLE commission_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  commission_id   uuid NOT NULL REFERENCES commissions(id) ON DELETE CASCADE,
  entry_id        uuid REFERENCES finance_entries(id) ON DELETE SET NULL,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  student_id      uuid REFERENCES students(id) ON DELETE SET NULL,
  description     text NOT NULL,
  base_cents      bigint NOT NULL CHECK (base_cents >= 0),
  rate_bp         integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_commission_items ON commission_items (tenant_id, commission_id);

ALTER TABLE commission_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_items FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_items_tenant ON commission_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =====================================================================
-- WHATSAPP (uazapi)
-- =====================================================================
CREATE TABLE whatsapp_instances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_name   text NOT NULL,
  -- O token da instância é guardado CIFRADO (AES-256-GCM) pela aplicação.
  -- Esta coluna nunca contém o token em claro.
  token_encrypted text,
  phone_number    text,
  status          text NOT NULL DEFAULT 'DISCONNECTED',
  connected_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_instance_per_tenant UNIQUE (tenant_id, instance_name)
);
CREATE TRIGGER trg_wa_updated BEFORE UPDATE ON whatsapp_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE whatsapp_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY wa_tenant ON whatsapp_instances
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE TABLE whatsapp_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id      uuid REFERENCES students(id) ON DELETE SET NULL,
  to_number       text NOT NULL,
  body            text NOT NULL,
  kind            text NOT NULL,            -- BIRTHDAY, REMINDER, MANUAL...
  status          text NOT NULL DEFAULT 'PENDING',
  provider_id     text,
  error           text,
  -- Chave de idempotência: impede que o cron de aniversário dispare
  -- duas mensagens para o mesmo aluno no mesmo dia se rodar duas vezes.
  idempotency_key text NOT NULL,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_message_idempotent UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX idx_wa_messages_student ON whatsapp_messages (tenant_id, student_id, created_at DESC);

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY wa_messages_tenant ON whatsapp_messages
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =====================================================================
-- AUDITORIA
--
-- Sem trilha de auditoria não há como investigar acesso indevido depois
-- do fato. Registramos também LEITURA de prontuário, porque dado de
-- saúde exige saber quem olhou, não só quem alterou.
--
-- A política é deliberadamente assimétrica: INSERT é livre dentro do
-- tenant, UPDATE e DELETE não têm policy nenhuma — e sem policy
-- permissiva, a operação é negada. Log que pode ser reescrito não é log.
-- =====================================================================
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  actor_id      uuid,
  actor_role    user_role,
  action        text NOT NULL,             -- student.read, finance.entry.create...
  resource_type text NOT NULL,
  resource_id   text,
  outcome       text NOT NULL DEFAULT 'SUCCESS',  -- SUCCESS | DENIED | ERROR
  ip            inet,
  user_agent    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_log (tenant_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log (tenant_id, actor_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_log (tenant_id, resource_type, resource_id);
CREATE INDEX idx_audit_denied ON audit_log (tenant_id, created_at DESC) WHERE outcome = 'DENIED';

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (tenant_id = current_tenant_id());
-- Nenhuma policy para UPDATE/DELETE: append-only por construção.
