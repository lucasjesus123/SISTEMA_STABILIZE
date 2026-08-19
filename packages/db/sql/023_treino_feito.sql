-- =====================================================================
-- O ALUNO MARCA QUE TREINOU
--
-- A tabela `workout_logs` existe desde o schema original e NENHUMA LINHA
-- DE CÓDIGO ESCREVE NELA. O aplicativo mostra o treino e não deixa o
-- aluno dizer que fez — o que transforma o app num PDF com login.
--
-- O QUE ISSO CUSTA, e é mais do que parece:
--
--   O ALUNO não tem histórico. Abrir o app na terça e não conseguir
--   lembrar se fez o treino B na segunda é o motivo mais banal de alguém
--   parar de usar um aplicativo de treino.
--
--   O PROFESSOR não recebe retorno. Ele prescreve doze semanas e
--   descobre no dia da reavaliação que o aluno fez seis. Com o registro,
--   o desequilíbrio aparece na terceira semana, que é quando ainda dá
--   para corrigir.
--
--   O RELATÓRIO DE PROGRESSO conta só as sessões agendadas. Para quem
--   faz musculação — a maior parte de qualquer academia — isso é zero.
--
-- ESTA MIGRAÇÃO NÃO CRIA A TABELA: ela já existe. O que faltava era o
-- que impede o registro duplicado e o que torna a consulta do histórico
-- barata.
-- =====================================================================

/* UM REGISTRO POR DIA E POR TREINO.
   O botão "marquei que fiz" fica num aplicativo de celular, onde o toque
   duplo é a regra e não a exceção — dedo em tela pequena, conexão lenta,
   a pessoa não vê resposta e toca de novo. Sem o índice, dois toques
   viram dois treinos feitos, e a partir daí a contagem de frequência do
   aluno está errada para sempre.

   A CHAVE INCLUI `day_label` de propósito: quem faz A de manhã e B à
   noite fez dois treinos no mesmo dia, e isso é verdade. O que não pode
   é o mesmo A duas vezes. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_treino_feito_unico
  ON workout_logs (student_id, done_on, day_label);

/* O histórico do aluno, do mais recente para trás — que é a única ordem
   em que alguém lê isto. */
CREATE INDEX IF NOT EXISTS idx_treino_feito_aluno
  ON workout_logs (tenant_id, student_id, done_on DESC);

/* O ESFORÇO JÁ TINHA ESCALA, e ela é de 1 a 5 — está no schema original,
   em `workout_logs_effort_check`. A primeira versão desta migração
   acrescentou um segundo CHECK de 1 a 10, achando que a escala era a de
   Borg. Os dois conviveram em silêncio e o mais restrito venceu: toda
   marcação com esforço 6 ou mais era recusada com "os dados não atendem
   às regras do sistema", sem dizer qual regra.

   Duas restrições sobre a mesma coluna dizendo coisas diferentes é pior
   do que qualquer uma das duas sozinha. Fica a original, e a escala do
   sistema inteiro é 1 a 5 — que também cabe melhor num celular: cinco
   botões grandes cabem lado a lado, dez não. */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workout_logs_esforco_sano') THEN
    ALTER TABLE workout_logs DROP CONSTRAINT workout_logs_esforco_sano;
  END IF;
END
$$;

/* NÃO SE REGISTRA TREINO NO FUTURO. É a diferença entre um diário e uma
   lista de intenções: quem marca a semana inteira na segunda-feira não
   está registrando nada, e o histórico deixa de significar o que diz
   significar. */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workout_logs_sem_futuro') THEN
    ALTER TABLE workout_logs
      ADD CONSTRAINT workout_logs_sem_futuro
      CHECK (done_on <= (CURRENT_DATE + 1));
  END IF;
END
$$;

COMMENT ON TABLE workout_logs IS
  'O aluno marcando que fez o treino do dia, pelo aplicativo. Um por dia e por letra.';
COMMENT ON COLUMN workout_logs.effort IS
  'Esforço percebido de 1 a 5. NULL quando o aluno não quis responder.';

-- ---------------------------------------------------------------------
-- RLS
--
-- A tabela é antiga e pode ter nascido antes da política. Reafirmar é
-- barato e cobre o banco que foi montado à mão em algum momento —
-- situação em que a ausência da política significa que um aluno enxerga
-- o treino de outra academia.
-- ---------------------------------------------------------------------
ALTER TABLE workout_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_logs FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'workout_logs' AND policyname = 'workout_logs_tenant') THEN
    CREATE POLICY workout_logs_tenant ON workout_logs
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id());
  END IF;
END
$$;
