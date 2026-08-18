-- =====================================================================
-- O TREINO NA SEMANA, E O DIA QUE O ALUNO FEZ
--
-- O modelo já sabia agrupar exercício por dia: `workout_items.day_label`
-- guarda "A", "B", "Segunda", "Superiores" — a divisão é decisão do
-- profissional, e continua sendo. O que faltava era o outro lado: o
-- aluno abrir o aplicativo, tocar no dia e dizer "fiz".
--
-- POR QUE UMA TABELA, E NÃO UM `feito boolean` EM `workout_items`:
--
-- Um booleano responde "está feito?" e nada mais. A pergunta que a
-- academia faz é outra — "ele treinou quantas vezes este mês?", "faz
-- quanto tempo que não aparece?", "ele pula sempre o mesmo dia?" — e
-- nenhuma delas cabe num campo que é sobrescrito toda semana. Um
-- registro por sessão responde às quatro, e ainda deixa o histórico
-- intacto quando o profissional troca a prescrição.
--
-- O ÍNDICE ÚNICO É O CONTROLE DE DUPLICATA. Botão de celular recebe
-- toque duplo o tempo todo — dedo trêmulo, rede lenta, a tela que não
-- respondeu na primeira. Sem a unicidade, "fiz hoje" tocado duas vezes
-- viraria dois treinos no relatório de frequência. Com ela, a segunda
-- gravação encontra a primeira e não faz nada.
--
-- NÃO REFERENCIA `workout_plans`. A tentação é ligar a sessão ao plano
-- vigente, e o custo aparece na primeira troca de prescrição: o plano
-- antigo é arquivado, e ou o histórico vai junto (perdendo a frequência
-- do aluno) ou a chave estrangeira impede arquivar. O que aconteceu foi
-- "este aluno treinou o dia Segunda em 14/08" — isso continua verdade
-- depois de qualquer mudança de treino.
-- =====================================================================

CREATE TABLE IF NOT EXISTS workout_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  -- O rótulo do dia, copiado como TEXTO no momento em que foi feito.
  -- Não é chave estrangeira: se o profissional renomear "A" para
  -- "Superiores" amanhã, o que o aluno fez ontem continua tendo sido o
  -- "A" — reescrever o passado para casar com o presente é como se
  -- perde a confiança num histórico.
  day_label   text NOT NULL CHECK (length(btrim(day_label)) BETWEEN 1 AND 40),

  done_on     date NOT NULL DEFAULT CURRENT_DATE,

  -- Como o aluno se sentiu. Opcional, uma pergunta só: um formulário
  -- depois do treino é um formulário que ninguém responde.
  effort      smallint CHECK (effort IS NULL OR effort BETWEEN 1 AND 5),
  notes       text CHECK (notes IS NULL OR length(notes) <= 500),

  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Um registro por aluno, por dia de treino, por data. Ver o cabeçalho:
-- é isto que faz o toque duplo não virar dois treinos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_logs_unico
  ON workout_logs (tenant_id, student_id, day_label, done_on);

-- A consulta quente é "as últimas semanas deste aluno", para desenhar a
-- faixa da semana e contar a sequência. Começa por tenant_id porque é
-- assim que toda consulta chega, por causa da RLS.
CREATE INDEX IF NOT EXISTS idx_workout_logs_aluno
  ON workout_logs (tenant_id, student_id, done_on DESC);

ALTER TABLE workout_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workout_logs_tenant ON workout_logs;
CREATE POLICY workout_logs_tenant ON workout_logs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON workout_logs TO stabilize_app;

-- ---------------------------------------------------------------------
-- A ORDEM DOS DIAS NA TELA
--
-- `day_label` é texto livre, e ordenar texto livre põe "Quarta" antes de
-- "Segunda" — alfabético, e sem sentido nenhum para quem lê. A tela
-- precisa de uma ordem que respeite a semana e, ao mesmo tempo, não
-- quebre com os rótulos que já existem no banco ("A", "B", "Superiores").
--
-- A função devolve 0 a 6 para os dias da semana e 90 para qualquer outro
-- rótulo, que assim vai para o fim mantendo a ordem alfabética entre si.
-- Fica no banco, e não no código da tela, porque três lugares diferentes
-- precisam da mesma ordem: a aba do profissional, o aplicativo do aluno
-- e o PDF do treino.
-- ---------------------------------------------------------------------
-- Remove acento sem depender da extensão `unaccent`, que exige
-- superusuário para ser instalada e não está garantida em toda
-- hospedagem. São seis letras em português; um translate resolve.
CREATE OR REPLACE FUNCTION unaccent_simples(texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT translate(
    COALESCE(texto, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'
  )
$$;

CREATE OR REPLACE FUNCTION ordem_do_dia(rotulo text)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE lower(btrim(unaccent_simples(rotulo)))
    WHEN 'segunda' THEN 0
    WHEN 'terca'   THEN 1
    WHEN 'quarta'  THEN 2
    WHEN 'quinta'  THEN 3
    WHEN 'sexta'   THEN 4
    WHEN 'sabado'  THEN 5
    WHEN 'domingo' THEN 6
    ELSE 90
  END::smallint
$$;

GRANT EXECUTE ON FUNCTION ordem_do_dia(text) TO stabilize_app;
GRANT EXECUTE ON FUNCTION unaccent_simples(text) TO stabilize_app;

COMMENT ON TABLE workout_logs IS
  'Um registro por dia de treino efetivamente realizado pelo aluno. Ver o cabeçalho de 010_treino_semana.sql.';
