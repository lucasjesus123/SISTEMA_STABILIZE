-- =====================================================================
-- MEDIDAS CORPORAIS
--
-- A ficha de avaliação física que toda academia tem em papel: peso,
-- busto, braços, abdômen, cintura, quadril, culote, coxas, panturrilhas
-- e altura, medidos de novo a cada reavaliação para comparar com o
-- começo.
--
-- UMA LINHA POR AVALIAÇÃO, e não colunas "1ª, 2ª, 3ª" como no papel. O
-- formulário impresso tem doze colunas porque a folha é finita e a
-- décima terceira reavaliação não cabe; num banco, doze colunas fixas
-- seriam doze vezes o mesmo campo, vazias na maioria das linhas, e a
-- décima terceira exigiria uma migration. Uma linha por data responde
-- "quanto ele perdeu de cintura em seis meses?" com um SELECT, o que
-- doze colunas não fazem.
--
-- TUDO EM INTEIRO, NUNCA EM `float`. Peso em GRAMAS e circunferência em
-- MILÍMETROS. É a mesma regra do dinheiro neste sistema: `0.1 + 0.2`
-- não dá `0.3` em ponto flutuante, e uma diferença de medida calculada
-- assim mostra "-0.30000000000000004 cm" na tela do aluno. Inteiro
-- soma, subtrai e compara sem surpresa; a tela divide por 10 na hora de
-- exibir.
--
-- NÃO FICA EM `anamneses`. A anamnese é o retrato inicial — queixa,
-- histórico, contraindicação — e é escrita uma vez. A medida é uma série
-- temporal, e misturar as duas obrigaria a criar uma anamnese nova a
-- cada fita métrica passada, poluindo o prontuário com dezenas de
-- anamneses idênticas.
-- =====================================================================

CREATE TABLE IF NOT EXISTS body_measurements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  -- Quem mediu. SET NULL porque a medida continua válida depois que o
  -- profissional sai da academia — ao contrário da prescrição, que sem
  -- autor não vale como prescrição.
  professional_id   uuid REFERENCES users(id) ON DELETE SET NULL,

  measured_on       date NOT NULL DEFAULT CURRENT_DATE,

  -- Peso em gramas, altura em centímetros (a altura não muda o
  -- suficiente para justificar o milímetro).
  weight_g          integer CHECK (weight_g IS NULL OR weight_g BETWEEN 1000 AND 500000),
  height_cm         integer CHECK (height_cm IS NULL OR height_cm BETWEEN 50 AND 260),

  -- Circunferências em MILÍMETROS. Os limites são generosos de
  -- propósito: recusar uma medida real por ser incomum é pior que
  -- aceitar um erro de digitação, que o profissional vê e corrige.
  busto_mm          integer CHECK (busto_mm          IS NULL OR busto_mm          BETWEEN 100 AND 3000),
  peito_mm          integer CHECK (peito_mm          IS NULL OR peito_mm          BETWEEN 100 AND 3000),
  ombro_mm          integer CHECK (ombro_mm          IS NULL OR ombro_mm          BETWEEN 100 AND 3000),
  braco_esq_mm      integer CHECK (braco_esq_mm      IS NULL OR braco_esq_mm      BETWEEN 100 AND 1500),
  braco_dir_mm      integer CHECK (braco_dir_mm      IS NULL OR braco_dir_mm      BETWEEN 100 AND 1500),
  antebraco_esq_mm  integer CHECK (antebraco_esq_mm  IS NULL OR antebraco_esq_mm  BETWEEN 100 AND 1500),
  antebraco_dir_mm  integer CHECK (antebraco_dir_mm  IS NULL OR antebraco_dir_mm  BETWEEN 100 AND 1500),
  abdomen_mm        integer CHECK (abdomen_mm        IS NULL OR abdomen_mm        BETWEEN 100 AND 3000),
  cintura_mm        integer CHECK (cintura_mm        IS NULL OR cintura_mm        BETWEEN 100 AND 3000),
  quadril_mm        integer CHECK (quadril_mm        IS NULL OR quadril_mm        BETWEEN 100 AND 3000),
  culote_mm         integer CHECK (culote_mm         IS NULL OR culote_mm         BETWEEN 100 AND 3000),
  coxa_esq_mm       integer CHECK (coxa_esq_mm       IS NULL OR coxa_esq_mm       BETWEEN 100 AND 2000),
  coxa_dir_mm       integer CHECK (coxa_dir_mm       IS NULL OR coxa_dir_mm       BETWEEN 100 AND 2000),
  panturrilha_esq_mm integer CHECK (panturrilha_esq_mm IS NULL OR panturrilha_esq_mm BETWEEN 100 AND 1200),
  panturrilha_dir_mm integer CHECK (panturrilha_dir_mm IS NULL OR panturrilha_dir_mm BETWEEN 100 AND 1200),

  -- Percentual de gordura em DÉCIMOS de ponto (185 = 18,5%). Mesmo
  -- motivo do resto: inteiro, não float.
  gordura_pct_x10   smallint CHECK (gordura_pct_x10 IS NULL OR gordura_pct_x10 BETWEEN 10 AND 700),

  -- O campo "Relatório" da ficha de papel.
  notes             text CHECK (notes IS NULL OR length(notes) <= 4000),

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Uma avaliação por aluno por data. Medir duas vezes no mesmo dia é
-- sempre correção da primeira, não uma segunda avaliação — e a correção
-- deve sobrescrever, não duplicar a coluna no comparativo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_medidas_unica
  ON body_measurements (tenant_id, student_id, measured_on);

-- A consulta quente é "as avaliações deste aluno, da mais nova para a
-- mais velha", que é como o comparativo é montado.
CREATE INDEX IF NOT EXISTS idx_medidas_aluno
  ON body_measurements (tenant_id, student_id, measured_on DESC);

DROP TRIGGER IF EXISTS trg_medidas_updated ON body_measurements;
CREATE TRIGGER trg_medidas_updated BEFORE UPDATE ON body_measurements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE body_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE body_measurements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS body_measurements_tenant ON body_measurements;
CREATE POLICY body_measurements_tenant ON body_measurements
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON body_measurements TO stabilize_app;

COMMENT ON TABLE body_measurements IS
  'Avaliação física: uma linha por data. Peso em gramas, circunferências em milímetros, gordura em décimos de ponto — nunca float. Ver o cabeçalho de 012_medidas.sql.';

-- ---------------------------------------------------------------------
-- O ANEXO PASSA A SABER DE ONDE VEIO
--
-- `attachments` já tinha categoria, descrição e data de criação — o que
-- faltava era a DATA DO DOCUMENTO, que quase nunca é a data do upload.
-- Um exame de março anexado em agosto aparecia como "agosto" na lista, e
-- a ordem cronológica do prontuário ficava errada exatamente na
-- informação que importa: quando o exame foi feito.
-- ---------------------------------------------------------------------
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS document_date date;

-- O índice ordena pelos DOIS campos em vez de por um COALESCE: o cast
-- `timestamptz -> date` depende do fuso da sessão e por isso é STABLE,
-- não IMMUTABLE — o PostgreSQL recusa indexar a expressão ("functions
-- in index expression must be marked IMMUTABLE"). Com as duas colunas,
-- quem consulta ordena por `document_date DESC NULLS LAST, created_at
-- DESC` e o índice serve a ordenação inteira.
CREATE INDEX IF NOT EXISTS idx_attachments_data
  ON attachments (tenant_id, student_id, document_date DESC NULLS LAST, created_at DESC);

COMMENT ON COLUMN attachments.document_date IS
  'Data do documento em si (a data do exame), não a do upload. Nulo quando não informada; a lista cai para created_at.';
