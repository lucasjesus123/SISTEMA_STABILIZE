-- Prova de que o verificador ENXERGA. Cada defeito é plantado de
-- propósito e a conferência correspondente precisa acusar.
-- Tudo dentro de uma transação que termina em ROLLBACK: nada persiste.
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

DO $$
DECLARE
  t uuid := gen_random_uuid();
  aluno uuid;
  prof uuid;
  e1 uuid; e2 uuid;
BEGIN
  INSERT INTO tenants (id, name, slug) VALUES (t, 'Academia Injetada', 'inj-' || substr(t::text, 1, 8));
  PERFORM set_config('app.tenant_id', t::text, true);

  INSERT INTO users (tenant_id, email, password_hash, full_name, role)
  VALUES (t, 'p-' || substr(t::text,1,8) || '@inj.test', 'x', 'Prof Injetado', 'PROFESSIONAL')
  RETURNING id INTO prof;

  INSERT INTO students (tenant_id, full_name) VALUES (t, 'Aluno Injetado') RETURNING id INTO aluno;

  -- DEFEITO 1: pago gravado sem pagamento nenhum
  INSERT INTO finance_entries (tenant_id, direction, description, amount_cents, due_date, student_id, paid_cents)
  VALUES (t, 'RECEIVABLE', 'Defeito 1', 10000, current_date, aluno, 10000);

  -- DEFEITO 5: duas cobrancas identicas
  INSERT INTO finance_entries (tenant_id, direction, description, amount_cents, due_date, student_id)
  VALUES (t, 'RECEIVABLE', 'Defeito 5a', 7700, current_date + 10, aluno),
         (t, 'RECEIVABLE', 'Defeito 5b', 7700, current_date + 10, aluno);

  -- DEFEITOS 2, 3 e 4 sao travados por gatilho/CHECK do banco.
  -- Desligar os gatilhos aqui é o unico jeito de plantar o defeito — e o
  -- fato de precisar disso ja e a prova de que a trava funciona.
  SET session_replication_role = replica;
  /* O CHECK `entry_not_overpaid` recusa o defeito 2 mesmo com os
     gatilhos desligados — desligar gatilho nao desliga CHECK. Derrubo a
     restricao DENTRO da transacao (que termina em ROLLBACK) so para
     provar que o verificador enxerga o defeito. O fato de precisar
     disto ja e a prova de que a trava e mais forte que um gatilho. */
  ALTER TABLE finance_entries DROP CONSTRAINT IF EXISTS entry_not_overpaid;
  /* Idem para a sobreposicao de agenda: e um EXCLUDE, tambem imune ao
     desligamento de gatilhos. */
  ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appt_no_professional_overlap;
  ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appt_no_student_overlap;

  INSERT INTO finance_entries (tenant_id, direction, description, amount_cents, due_date, student_id, paid_cents, status)
  VALUES (t, 'RECEIVABLE', 'Defeito 2', 5000, current_date, aluno, 9000, 'PAID')     -- pago acima do valor
  RETURNING id INTO e1;

  INSERT INTO finance_entries (tenant_id, direction, description, amount_cents, due_date, student_id, paid_cents, status)
  VALUES (t, 'RECEIVABLE', 'Defeito 3', 5000, current_date, aluno, 0, 'PAID')        -- PAID sem ter pago
  RETURNING id INTO e2;

  INSERT INTO finance_entries (tenant_id, direction, description, amount_cents, due_date, student_id, cancelled_at, status)
  VALUES (t, 'RECEIVABLE', 'Defeito 4', 5000, current_date, aluno, now(), 'OPEN');   -- cancelado e OPEN

  -- DEFEITO 6: dois atendimentos sobrepostos do mesmo profissional
  INSERT INTO appointments (tenant_id, student_id, professional_id, period, status)
  VALUES (t, aluno, prof, tstzrange(now() + interval '2 days', now() + interval '2 days 1 hour', '[)'), 'SCHEDULED'),
         (t, aluno, prof, tstzrange(now() + interval '2 days 30 minutes', now() + interval '2 days 90 minutes', '[)'), 'SCHEDULED');

  SET session_replication_role = origin;

  -- DEFEITO 7: fechamento reaberto SEM autor
  INSERT INTO audit_log (tenant_id, actor_id, action, resource_type, resource_id)
  VALUES (t, NULL, 'commission.reopen', 'commission', prof::text);

  -- DEFEITO 8: estorno sem autor
  INSERT INTO audit_log (tenant_id, actor_id, action, resource_type, resource_id)
  VALUES (t, NULL, 'finance.payment.delete', 'payment', e1::text);

  RAISE NOTICE 'defeitos plantados na academia %', t;
END
$$;

\echo ''
\echo '=== O QUE O VERIFICADOR ACUSA COM OS DEFEITOS PLANTADOS ==='
SELECT 'D1 pago sem pagamento'   AS defeito,
       (SELECT count(*) FROM finance_entries e
         WHERE e.paid_cents <> (SELECT coalesce(sum(p.amount_cents),0) FROM finance_payments p WHERE p.entry_id = e.id)
           AND e.description LIKE 'Defeito%') AS acusou
UNION ALL SELECT 'D2 pago acima do valor',
       (SELECT count(*) FROM finance_entries WHERE paid_cents > amount_cents AND description LIKE 'Defeito%')
UNION ALL SELECT 'D3 status incoerente',
       (SELECT count(*) FROM finance_entries WHERE cancelled_at IS NULL AND description LIKE 'Defeito%'
          AND ((status='PAID' AND paid_cents < amount_cents) OR (status<>'PAID' AND paid_cents >= amount_cents AND amount_cents > 0)))
UNION ALL SELECT 'D4 cancelamento pela metade',
       (SELECT count(*) FROM finance_entries WHERE (cancelled_at IS NOT NULL) <> (status='CANCELLED') AND description LIKE 'Defeito%')
UNION ALL SELECT 'D5 duplicata',
       (SELECT count(*) FROM (SELECT student_id, amount_cents, due_date, direction FROM finance_entries
          WHERE cancelled_at IS NULL AND student_id IS NOT NULL AND description LIKE 'Defeito%'
          GROUP BY 1,2,3,4 HAVING count(*) > 1) x)
UNION ALL SELECT 'D6 agenda sobreposta',
       (SELECT count(*) FROM appointments a JOIN appointments b
          ON b.professional_id=a.professional_id AND b.id<>a.id AND b.period && a.period
        WHERE a.status<>'CANCELLED' AND b.status<>'CANCELLED'
          AND a.professional_id IN (SELECT id FROM users WHERE full_name='Prof Injetado'))
UNION ALL SELECT 'D7 reabertura sem autor',
       (SELECT count(*) FROM audit_log WHERE action='commission.reopen' AND actor_id IS NULL)
UNION ALL SELECT 'D8 estorno sem autor',
       (SELECT count(*) FROM audit_log WHERE action='finance.payment.delete' AND actor_id IS NULL);

ROLLBACK;

\echo ''
\echo '(ROLLBACK — nada foi gravado)'
