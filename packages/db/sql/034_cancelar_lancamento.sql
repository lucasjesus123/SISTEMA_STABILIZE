-- ---------------------------------------------------------------------
-- Cancelar um lançamento passa a mudar o STATUS dele.
--
-- O BURACO. `finance_entries.status` é derivado — ninguém o escreve à
-- mão — e quem o mantinha era `trg_recalc_entry_paid`, um gatilho sobre
-- `finance_payments`. A função dele já sabia que um lançamento cancelado
-- é `CANCELLED`:
--
--     WHEN cancelled_at IS NOT NULL THEN 'CANCELLED'
--
-- só que ela só roda quando um PAGAMENTO é inserido, alterado ou
-- apagado. Carimbar `cancelled_at` num lançamento sem pagamento nenhum
-- não disparava nada: a linha ficava com `cancelled_at` preenchido e
-- `status = 'OPEN'`.
--
-- POR QUE ISSO NUNCA APARECEU: até agora nada no sistema cancelava um
-- lançamento. A coluna existia desde o primeiro esquema e não tinha
-- escritor. Reabrir o fechamento de um profissional foi o primeiro
-- caminho a usá-la, e o teste pegou na primeira execução.
--
-- POR QUE A CORREÇÃO É AQUI E NÃO NO `UPDATE` DA APLICAÇÃO. Escrever
-- `SET cancelled_at = now(), status = 'CANCELLED'` no lugar que cancela
-- resolveria este caso e deixaria a armadilha armada para o próximo: o
-- status é derivado, e derivado mantido em dois lugares diverge. Aqui a
-- regra vale para qualquer caminho — inclusive um `UPDATE` de manutenção
-- feito à mão no banco.
--
-- O CAMINHO DE VOLTA TAMBÉM É TRATADO. Nada hoje "descancela" um
-- lançamento, mas se um dia alguém limpar `cancelled_at`, deixar o
-- status em CANCELLED seria exatamente o mesmo bug ao contrário — e mais
-- difícil de achar, porque a linha pareceria ativa em toda consulta que
-- olha `cancelled_at` e apagada em toda consulta que olha `status`.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION aplicar_cancelamento_do_lancamento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cancelled_at IS NOT NULL THEN
    NEW.status := 'CANCELLED'::entry_status;
    RETURN NEW;
  END IF;

  /* Saiu do cancelamento: recalcula pelo mesmo critério do gatilho de
     pagamentos, para os dois nunca discordarem. */
  IF TG_OP = 'UPDATE' AND OLD.cancelled_at IS NOT NULL THEN
    NEW.status := CASE
      WHEN NEW.paid_cents >= NEW.amount_cents THEN 'PAID'::entry_status
      WHEN NEW.paid_cents > 0                 THEN 'PARTIALLY_PAID'::entry_status
      WHEN NEW.due_date < CURRENT_DATE        THEN 'OVERDUE'::entry_status
      ELSE 'OPEN'::entry_status
    END;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_entries_cancelamento ON finance_entries;
CREATE TRIGGER trg_entries_cancelamento
  BEFORE INSERT OR UPDATE OF cancelled_at ON finance_entries
  FOR EACH ROW EXECUTE FUNCTION aplicar_cancelamento_do_lancamento();

-- As linhas que já estavam com a incoerência, se houver alguma.
UPDATE finance_entries
   SET status = 'CANCELLED'
 WHERE cancelled_at IS NOT NULL
   AND status <> 'CANCELLED';
