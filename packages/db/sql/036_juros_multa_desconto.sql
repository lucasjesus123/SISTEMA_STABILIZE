-- =====================================================================
-- 036 — Juros, multa e desconto na baixa
--
-- O PROBLEMA QUE ISTO RESOLVE
--
-- Até aqui, a academia que cobra multa por atraso ou dá desconto de
-- pontualidade só tinha um caminho: EDITAR O VALOR DA CONTA. Isso
-- funciona uma vez e destrói a informação — depois de editada, ninguém
-- sabe mais quanto era mensalidade e quanto era multa. O relatório do
-- mês soma tudo como receita de mensalidade, a comissão do professor
-- incide sobre a multa (que não é dele), e o aluno que pedir a segunda
-- via recebe um valor que não bate com o contrato.
--
-- O DESENHO: TRÊS NÚMEROS QUE RESPONDEM PERGUNTAS DIFERENTES
--
--   amount_cents     — o DINHEIRO que entrou no caixa.
--   acrescimo_cents  — quanto desse dinheiro é juros/multa.
--   desconto_cents   — quanto foi PERDOADO (não entrou, mas abate).
--
-- Duas contas saem daí, e é por elas que o modelo se sustenta:
--
--   Caixa do dia      = amount_cents
--   Dívida abatida    = amount_cents - acrescimo_cents + desconto_cents
--
-- Conferindo nos dois casos reais:
--
--   Mensalidade de R$ 100, atraso, aluno paga R$ 105:
--     amount=10500  acrescimo=500  desconto=0
--     caixa   = 105,00   ✓ (entrou isso mesmo)
--     abatido = 105 - 5 + 0 = 100,00 ✓ (a conta fica quitada, não sobra)
--
--   Mensalidade de R$ 100, desconto de R$ 10, aluno paga R$ 90:
--     amount=9000  acrescimo=0  desconto=1000
--     caixa   = 90,00 ✓
--     abatido = 90 - 0 + 10 = 100,00 ✓ (quita, e não fica devendo 10)
--
-- POR QUE NÃO GUARDAR SÓ "VALOR PAGO"
--
-- Porque as duas perguntas têm respostas diferentes e as duas são
-- feitas. "Quanto entrou no caixa em agosto?" é o extrato. "Esta
-- mensalidade está quitada?" é a cobrança. Um número só faz uma das
-- duas mentir: se guardasse 105, a conta ficaria com saldo negativo; se
-- guardasse 100, o caixa perderia os 5 que entraram de verdade.
--
-- E É POR ISSO QUE `recalc_entry_paid` MUDA. Ela somava
-- `amount_cents` puro para decidir se a conta está paga — com desconto,
-- a conta ficaria eternamente PARTIALLY_PAID; com juros, estouraria o
-- CHECK `entry_not_overpaid`. A soma passa a ser da DÍVIDA ABATIDA.
-- =====================================================================

ALTER TABLE finance_payments
  ADD COLUMN IF NOT EXISTS acrescimo_cents bigint NOT NULL DEFAULT 0
    CHECK (acrescimo_cents >= 0),
  ADD COLUMN IF NOT EXISTS desconto_cents bigint NOT NULL DEFAULT 0
    CHECK (desconto_cents >= 0);

COMMENT ON COLUMN finance_payments.acrescimo_cents IS
  'Quanto do valor recebido é juros/multa. Entra no caixa e NÃO abate a dívida original.';
COMMENT ON COLUMN finance_payments.desconto_cents IS
  'Quanto foi perdoado. NÃO entra no caixa e abate a dívida como se tivesse entrado.';

/* O ACRÉSCIMO NÃO PODE SER MAIOR QUE O QUE ENTROU.
   Juros de R$ 5 num pagamento de R$ 3 significaria dívida abatida
   negativa — a conta ficaria mais devedora depois de receber dinheiro. */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagamento_acrescimo_cabe') THEN
    ALTER TABLE finance_payments
      ADD CONSTRAINT pagamento_acrescimo_cabe CHECK (acrescimo_cents <= amount_cents);
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- A soma que decide se a conta está paga
--
-- Mesma função de antes, com uma linha diferente: soma a DÍVIDA
-- ABATIDA, e não o dinheiro. Tudo o mais — status derivado, vencido,
-- cancelado — continua igual, de propósito: esta migração muda o que se
-- soma, não como se decide.
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

  /* `amount_cents - acrescimo_cents + desconto_cents` é a dívida
     abatida. Ver o cabeçalho deste arquivo para as duas conferências. */
  SELECT COALESCE(SUM(amount_cents - acrescimo_cents + desconto_cents), 0)
    INTO v_total
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

GRANT SELECT, INSERT, UPDATE, DELETE ON finance_payments TO stabilize_app;
