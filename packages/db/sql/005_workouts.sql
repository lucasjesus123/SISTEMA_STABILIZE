-- =====================================================================
-- PRESCRIÇÃO DE TREINO
--
-- A BIBLIOTECA É POR EMPRESA, e isso é deliberado.
--
-- O caminho "óbvio" seria um catálogo global compartilhado — exercícios
-- com tenant_id NULL, visíveis a todos — e cada empresa acrescentando os
-- seus. Economizaria umas centenas de linhas duplicadas. O custo, que
-- não vale a pena, é abrir uma exceção na policy:
--
--     USING (tenant_id IS NULL OR tenant_id = current_tenant_id())
--
-- Esse `IS NULL` é uma porta. Enquanto vive só aqui é inofensiva; o
-- problema é que ela vira o modelo que alguém copia para a próxima
-- tabela — e um dia está numa que guarda dado de aluno. Toda tabela do
-- sistema tem a MESMA policy, sem ramo, e a isolação continua sendo uma
-- frase só: "tenant_id = current_tenant_id()". Trinta cópias de cem
-- exercícios são trinta mil linhas. O banco não sente; o modelo mental,
-- sim.
--
-- Como efeito colateral bem-vindo, cada academia pode renomear, ajustar
-- a instrução e desativar um exercício sem afetar ninguém.
-- =====================================================================

-- Grupo muscular principal. Enum e não texto livre: é o filtro que o
-- profissional usa para montar treino, e "Peitoral"/"peito"/"Peito"
-- transformariam o filtro em três resultados parciais.
DO $$ BEGIN
  CREATE TYPE muscle_group AS ENUM (
    'PEITO', 'COSTAS', 'OMBRO', 'BICEPS', 'TRICEPS', 'ANTEBRACO',
    'ABDOMEN', 'LOMBAR', 'GLUTEO', 'QUADRICEPS', 'POSTERIOR',
    'PANTURRILHA', 'CORPO_INTEIRO', 'MOBILIDADE', 'CARDIO'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS exercises (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  muscle_group  muscle_group NOT NULL,
  equipment     text,
  instructions  text,

  -- Vídeo de referência. Guardado como texto e NUNCA renderizado como
  -- iframe pela aplicação: um endereço vindo do usuário virando embed é
  -- injeção de conteúdo de terceiro dentro da sessão de quem abriu.
  video_url     text CHECK (video_url IS NULL OR video_url ~ '^https://'),

  -- Desativar em vez de apagar: exercício removido continua referenciado
  -- por prescrições antigas, e prontuário não se reescreve.
  is_active     boolean NOT NULL DEFAULT true,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Dois exercícios com o mesmo nome na mesma empresa é sempre erro de
  -- digitação, e o estrago aparece semanas depois, quando metade das
  -- prescrições aponta para um e metade para o outro.
  CONSTRAINT exercises_nome_unico UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_exercises_busca
  ON exercises (tenant_id, muscle_group, name)
  WHERE is_active;

DROP TRIGGER IF EXISTS trg_exercises_updated ON exercises;
CREATE TRIGGER trg_exercises_updated BEFORE UPDATE ON exercises
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE exercises ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercises FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exercises_tenant ON exercises;
CREATE POLICY exercises_tenant ON exercises
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Prescrição
-- ---------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE workout_status AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS workout_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  -- RESTRICT, não SET NULL: uma prescrição sem autor não vale como
  -- prescrição. Profissional que sai da academia é desativado, não
  -- removido.
  professional_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  goal            text,
  status          workout_status NOT NULL DEFAULT 'DRAFT',

  starts_on       date NOT NULL DEFAULT CURRENT_DATE,
  ends_on         date,
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workout_periodo CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

-- UM treino ativo por aluno. Sem isto, dois planos "vigentes" convivem e
-- ninguém no balcão sabe qual seguir — o erro aparece na sala, com o
-- aluno esperando. Índice parcial porque rascunho e arquivado podem ser
-- vários.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_um_ativo
  ON workout_plans (tenant_id, student_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_workout_student
  ON workout_plans (tenant_id, student_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_workout_plans_updated ON workout_plans;
CREATE TRIGGER trg_workout_plans_updated BEFORE UPDATE ON workout_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workout_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workout_plans_tenant ON workout_plans;
CREATE POLICY workout_plans_tenant ON workout_plans
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Itens do treino
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workout_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id       uuid NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,

  -- RESTRICT porque desativar é o caminho previsto para tirar um
  -- exercício de circulação. Apagar quebraria treinos em andamento.
  exercise_id   uuid NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,

  -- "A", "B", "Segunda", "Superiores" — a divisão é decisão do
  -- profissional, não do sistema.
  day_label     text NOT NULL DEFAULT 'A' CHECK (length(btrim(day_label)) BETWEEN 1 AND 40),
  position      integer NOT NULL DEFAULT 0,

  sets          smallint CHECK (sets IS NULL OR sets BETWEEN 1 AND 20),

  -- TEXTO, e não número: prescrição real diz "8-12", "até a falha",
  -- "30 s". Um inteiro obrigaria o profissional a mentir para o campo.
  reps          text CHECK (reps IS NULL OR length(btrim(reps)) BETWEEN 1 AND 40),

  -- Carga em GRAMAS, inteiro, como todo número do sistema que precisa
  -- somar sem erro. Nulo quando é peso corporal ou elástico.
  load_g        integer CHECK (load_g IS NULL OR load_g BETWEEN 0 AND 1000000),
  rest_seconds  smallint CHECK (rest_seconds IS NULL OR rest_seconds BETWEEN 0 AND 900),
  notes         text,

  created_at    timestamptz NOT NULL DEFAULT now()
);

/* A ordenação NÃO tem unicidade em (plan_id, day_label, position) de
   propósito. Com ela, arrastar um exercício da 5ª para a 2ª posição
   exigiria renumerar tudo entre as duas dentro da mesma transação, e é
   assim que se escreve um deadlock. Sem ela, a ordem é uma dica: quem
   lê ordena por position e desempata pela criação. */
CREATE INDEX IF NOT EXISTS idx_workout_items_plano
  ON workout_items (tenant_id, plan_id, day_label, position);

ALTER TABLE workout_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workout_items_tenant ON workout_items;
CREATE POLICY workout_items_tenant ON workout_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------
-- Privilégios
--
-- O papel da API recebe DML, nunca DDL. A separação é o que faz uma
-- eventual injeção de SQL não conseguir desligar RLS nem derrubar
-- tabela.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON exercises, workout_plans, workout_items
  TO stabilize_app;
