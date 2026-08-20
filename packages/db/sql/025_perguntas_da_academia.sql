-- =====================================================================
-- A ACADEMIA EDITA AS PRÓPRIAS PERGUNTAS DA TRIAGEM
--
-- O questionário nasceu fixo no código: as sete perguntas do PAR-Q,
-- iguais para todo mundo. Funciona como piso e não serve como teto —
-- cada academia tem algo a mais para perguntar (já treinou antes? faz
-- acompanhamento com nutricionista? tem prótese ou pino?), e algumas
-- precisam ajustar a redação para a linguagem de quem atende ali.
--
-- O QUE NÃO PODE SE PERDER NO CAMINHO
--
-- A regra "um SIM exige liberação médica" era uma coluna GERADA que
-- listava as sete chaves do PAR-Q à mão. Ela é o que dá consequência ao
-- questionário — sem ela o formulário é um monte de perguntas sem efeito
-- nenhum. Com perguntas editáveis, uma lista fixa de chaves deixa de
-- funcionar: a pergunta nova da academia não estaria nela, e um "sim"
-- numa pergunta sobre prótese não exigiria nada.
--
-- A COLUNA GERADA VIRA GATILHO, e não cálculo na aplicação. O motivo é o
-- mesmo de antes: a regra tem que valer para QUALQUER caminho que grave
-- uma triagem, inclusive um script de importação. Um gatilho consegue o
-- que uma coluna gerada não consegue — percorrer um jsonb com função que
-- retorna conjunto — e continua morando no banco.
--
-- AS PERGUNTAS SÃO CONGELADAS NA ASSINATURA, pelo mesmo motivo que o
-- texto do termo já era: se a academia reescrever a pergunta 3 ano que
-- vem, a assinatura do ano passado precisa continuar mostrando o que a
-- pessoa REALMENTE leu e respondeu. Sem isso, um "sim" antigo passa a
-- responder a uma pergunta que nunca foi feita.
-- =====================================================================

/* O questionário da academia. NULL significa "use o padrão do sistema"
   — que é o PAR-Q. Guardar NULL em vez de copiar as sete perguntas para
   dentro de cada empresa faz a correção de uma vírgula no texto padrão
   chegar a todo mundo que nunca editou. */
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS triagem_perguntas jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_perguntas_lista') THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_perguntas_lista
      CHECK (triagem_perguntas IS NULL OR jsonb_typeof(triagem_perguntas) = 'array');
  END IF;
END
$$;

COMMENT ON COLUMN tenants.triagem_perguntas IS
  'Questionário da academia. NULL = usa o PAR-Q padrão do sistema. Cada item: {chave, texto, exigeLiberacao, origem}.';

/* A cópia congelada, ao lado do texto do termo que já era congelado. */
ALTER TABLE health_screenings
  ADD COLUMN IF NOT EXISTS perguntas jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN health_screenings.perguntas IS
  'As perguntas como estavam no dia da assinatura. Sem isto, um "sim" antigo passaria a responder a uma pergunta que nunca foi feita.';

-- ---------------------------------------------------------------------
-- A regra sai da coluna gerada e vai para um gatilho
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION triagem_calcular_liberacao()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  /* As sete chaves do PAR-Q, para as linhas ANTIGAS — as que foram
     gravadas antes desta migração e têm `perguntas` vazio. Sem esta
     lista, recalcular uma triagem antiga zeraria a exigência de atestado
     dela. */
  chaves_parq text[] := ARRAY[
    'coracao', 'dor_no_peito', 'tontura', 'osso_articulacao',
    'remedio_pressao', 'outra_razao', 'gravidez'
  ];
BEGIN
  IF jsonb_array_length(COALESCE(NEW.perguntas, '[]'::jsonb)) = 0 THEN
    NEW.precisa_liberacao_medica := EXISTS (
      SELECT 1 FROM unnest(chaves_parq) AS c
       WHERE NEW.respostas @> jsonb_build_object(c, true)
    );
  ELSE
    /* CADA PERGUNTA DIZ SE ELA PRÓPRIA EXIGE LIBERAÇÃO. É o que permite
       a academia acrescentar "já treinou antes?" sem que um "sim" ali
       passe a pedir atestado. */
    NEW.precisa_liberacao_medica := EXISTS (
      SELECT 1
        FROM jsonb_array_elements(NEW.perguntas) AS q
       WHERE COALESCE((q ->> 'exigeLiberacao')::boolean, false)
         AND NEW.respostas @> jsonb_build_object(q ->> 'chave', true)
    );
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  /* A coluna era GERADA. Trocá-la exige recriá-la: gerada não aceita
     escrita, nem de gatilho. O valor antigo é preservado numa coluna
     temporária antes da troca — a exigência de atestado de uma triagem
     já assinada é registro, não cache. */
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'health_screenings'
       AND column_name = 'precisa_liberacao_medica'
       AND is_generated = 'ALWAYS'
  ) THEN
    ALTER TABLE health_screenings ADD COLUMN _liberacao_antiga boolean;
    UPDATE health_screenings SET _liberacao_antiga = precisa_liberacao_medica;

    ALTER TABLE health_screenings DROP COLUMN precisa_liberacao_medica;
    ALTER TABLE health_screenings
      ADD COLUMN precisa_liberacao_medica boolean NOT NULL DEFAULT false;

    UPDATE health_screenings SET precisa_liberacao_medica = COALESCE(_liberacao_antiga, false);
    ALTER TABLE health_screenings DROP COLUMN _liberacao_antiga;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS trg_triagem_liberacao ON health_screenings;
CREATE TRIGGER trg_triagem_liberacao
  BEFORE INSERT OR UPDATE OF respostas, perguntas ON health_screenings
  FOR EACH ROW EXECUTE FUNCTION triagem_calcular_liberacao();

COMMENT ON FUNCTION triagem_calcular_liberacao() IS
  'Um SIM em pergunta marcada como exigeLiberacao obriga atestado. Mora no banco para valer em qualquer caminho de escrita, inclusive importação.';
