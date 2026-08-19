-- =====================================================================
-- CHECK-IN NA RECEPÇÃO
--
-- O BURACO MAIS ÓBVIO DE UM SISTEMA DE ACADEMIA, e ele estava aberto:
-- não havia como registrar que o aluno ENTROU.
--
-- O que existia era presença em AGENDAMENTO — o professor marca que o
-- aluno compareceu à sessão marcada. Isso serve para personal e para
-- pilates, onde tudo é agendado. Não serve para musculação, que é a
-- maior parte de qualquer academia: o aluno simplesmente aparece, passa
-- na recepção e treina. Sem agendamento não havia registro de nada, e
-- portanto:
--
--   - a frequência do aluno só contava as sessões marcadas
--   - ninguém sabia quantas pessoas estavam na academia agora
--   - o inadimplente entrava sem que nada avisasse
--
-- A TABELA É SEPARADA DE `appointments` de propósito. Um check-in não
-- tem profissional, não tem sala, não tem horário marcado e não tem
-- duração — forçá-lo dentro de `appointments` encheria a agenda de
-- eventos fantasma que nunca foram agendados por ninguém.
-- =====================================================================

CREATE TABLE IF NOT EXISTS checkins (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  entrou_em    timestamptz NOT NULL DEFAULT now(),
  saiu_em      timestamptz,

  /* A SITUAÇÃO NO MOMENTO DA ENTRADA, congelada.
     Guardar só o id do aluno faria a conferência de amanhã mostrar a
     situação de amanhã: um aluno que estava devendo em março e pagou em
     abril apareceria como "em dia" no relatório de março. O que se
     registra é o que a recepção viu na tela quando abriu a porta. */
  situacao     text NOT NULL CHECK (situacao IN ('EM_DIA', 'DEVENDO', 'SEM_CONTRATO', 'INATIVO')),
  devendo_centavos bigint NOT NULL DEFAULT 0 CHECK (devendo_centavos >= 0),

  /* Quem liberou apesar do aviso. NULL quando não houve aviso. */
  liberado_por uuid REFERENCES users(id) ON DELETE SET NULL,
  observacao   text,

  registrado_por uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

/* Um aluno não entra duas vezes sem ter saído. O índice parcial deixa
   o histórico livre e prende só a entrada aberta — sem ele, dois
   toques no botão criariam duas entradas e a contagem de quem está na
   academia agora ficaria errada para sempre. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_aberto
  ON checkins (student_id) WHERE saiu_em IS NULL;

CREATE INDEX IF NOT EXISTS idx_checkin_dia
  ON checkins (tenant_id, entrou_em DESC);

CREATE INDEX IF NOT EXISTS idx_checkin_aluno
  ON checkins (tenant_id, student_id, entrou_em DESC);

ALTER TABLE checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'checkins' AND policyname = 'checkins_tenant') THEN
    CREATE POLICY checkins_tenant ON checkins
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id());
  END IF;
END
$$;

COMMENT ON TABLE checkins IS
  'Entrada do aluno na academia, sem agendamento. Separado de appointments porque não tem profissional, sala nem horário marcado.';

/* -------------------------------------------------------------------
   Quantos dias de atraso a academia tolera na porta.

   NA EMPRESA e não no código: academia de bairro deixa entrar quem
   deve há uma semana, rede grande corta no dia seguinte. Zero significa
   "avisa mas nunca impede" — que é o padrão, porque barrar aluno na
   porta é decisão de negócio, não de software.
   ------------------------------------------------------------------- */
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS bloquear_entrada_apos_dias smallint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_bloqueio_sano') THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_bloqueio_sano
      CHECK (bloquear_entrada_apos_dias BETWEEN 0 AND 365);
  END IF;
END
$$;

COMMENT ON COLUMN tenants.bloquear_entrada_apos_dias IS
  'Dias de atraso a partir dos quais a recepção precisa liberar manualmente. 0 = só avisa, nunca impede.';
