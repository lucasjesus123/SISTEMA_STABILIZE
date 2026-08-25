-- =====================================================================
-- Prova de isolamento e de integridade.
--
-- Este arquivo não é documentação: é executável, roda como o papel
-- `stabilize_app` (o mesmo da API, sem BYPASSRLS) e ABORTA se qualquer
-- garantia deixar de valer. Serve como teste de regressão do banco.
--
-- Uso: psql -U stabilize_app -d <db> -v ON_ERROR_STOP=1 -f 900_isolation_test.sql
-- =====================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  t_a uuid;
  t_b uuid;
  u_a uuid;
  u_b uuid;
  s_a uuid;
  s_b uuid;
  prof_a uuid;
  room_a uuid;
  visiveis int;
  ok boolean;
  sufixo text;
BEGIN
  -- =================================================================
  -- Preparação: duas empresas, cada uma com um usuário e um aluno.
  -- =================================================================
  t_a := gen_random_uuid();
  t_b := gen_random_uuid();
  /* Slug derivado do uuid do próprio run. Com valor fixo, uma segunda
     execução falharia na restrição de unicidade — e um teste que só
     roda uma vez deixa de ser teste de regressão. */
  sufixo := substr(replace(t_a::text, '-', ''), 1, 8);

  -- Cada INSERT precisa acontecer sob o contexto do próprio tenant,
  -- porque a policy WITH CHECK impede gravar para outro.
  PERFORM set_config('app.tenant_id', t_a::text, true);
  INSERT INTO tenants (id, name, slug) VALUES (t_a, 'Academia A', 'academia-a-' || sufixo);
  INSERT INTO users (tenant_id, email, password_hash, full_name, role)
    VALUES (t_a, 'admin@a.test', 'x', 'Admin A', 'OWNER') RETURNING id INTO u_a;
  INSERT INTO users (tenant_id, email, password_hash, full_name, role)
    VALUES (t_a, 'prof@a.test', 'x', 'Prof A', 'PROFESSIONAL') RETURNING id INTO prof_a;
  INSERT INTO students (tenant_id, full_name) VALUES (t_a, 'Aluno da A') RETURNING id INTO s_a;
  INSERT INTO rooms (tenant_id, name) VALUES (t_a, 'Sala 1') RETURNING id INTO room_a;

  PERFORM set_config('app.tenant_id', t_b::text, true);
  INSERT INTO tenants (id, name, slug) VALUES (t_b, 'Academia B', 'academia-b-' || sufixo);
  INSERT INTO users (tenant_id, email, password_hash, full_name, role)
    VALUES (t_b, 'admin@b.test', 'x', 'Admin B', 'OWNER') RETURNING id INTO u_b;
  INSERT INTO students (tenant_id, full_name) VALUES (t_b, 'Aluno da B') RETURNING id INTO s_b;

  RAISE NOTICE 'preparação concluída';

  -- =================================================================
  -- 1. LEITURA CRUZADA
  -- O cenário do enunciado: usuário da Empresa A tenta ler aluno da B.
  -- =================================================================
  PERFORM set_config('app.tenant_id', t_a::text, true);

  SELECT count(*) INTO visiveis FROM students;
  IF visiveis <> 1 THEN
    RAISE EXCEPTION 'FALHA 1a: A enxerga % alunos, esperado 1', visiveis;
  END IF;

  -- Mesmo sabendo o UUID exato do aluno da outra empresa — que é
  -- exatamente o que um atacante autenticado tentaria — não há retorno.
  SELECT count(*) INTO visiveis FROM students WHERE id = s_b;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'FALHA 1b: IDOR — A leu o aluno da B pelo id direto';
  END IF;

  SELECT count(*) INTO visiveis FROM users;
  IF visiveis <> 2 THEN
    RAISE EXCEPTION 'FALHA 1c: A enxerga % usuários, esperado 2', visiveis;
  END IF;

  -- Uma empresa não enxerga sequer a existência da outra.
  SELECT count(*) INTO visiveis FROM tenants;
  IF visiveis <> 1 THEN
    RAISE EXCEPTION 'FALHA 1d: A enxerga % tenants, esperado 1', visiveis;
  END IF;

  RAISE NOTICE 'OK 1 — leitura cruzada bloqueada (inclusive por id direto)';

  -- =================================================================
  -- 2. ESCRITA CRUZADA
  -- =================================================================
  BEGIN
    UPDATE students SET full_name = 'INVADIDO' WHERE id = s_b;
    IF FOUND THEN
      RAISE EXCEPTION 'FALHA 2a: A alterou o aluno da B';
    END IF;
  END;

  BEGIN
    DELETE FROM students WHERE id = s_b;
    IF FOUND THEN
      RAISE EXCEPTION 'FALHA 2b: A apagou o aluno da B';
    END IF;
  END;

  -- Tentar gravar um registro carimbado com o tenant da outra empresa.
  --
  -- O TESTE PROVA O RESULTADO, E NÃO O CÓDIGO DO ERRO. A versão
  -- anterior capturava `insufficient_privilege OR check_violation` — os
  -- dois jeitos de a RLS recusar — e ABORTAVA quando a recusa vinha por
  -- um terceiro caminho. Foi o que aconteceu: o gatilho
  -- `atribuir_codigo_aluno` (migração 009, escrita depois deste teste)
  -- dispara ANTES da política, não enxerga a empresa da outra academia,
  -- e levanta a própria exceção. A proteção ficou mais forte e o teste
  -- passou a falhar — e um teste de isolamento que aborta na metade
  -- prova metade.
  --
  -- Agora ele captura qualquer recusa e, em seguida, VAI CONFERIR do
  -- lado da B se a linha entrou. É o que realmente importa, e não
  -- quebra na próxima vez que alguém puser um gatilho no caminho.
  ok := false;
  BEGIN
    INSERT INTO students (tenant_id, full_name) VALUES (t_b, 'Plantado por A');
  EXCEPTION WHEN OTHERS THEN
    ok := true;
  END;

  -- A conferência é feita do CONTEXTO DA B: de dentro da A, a RLS
  -- esconderia a linha plantada e o teste diria "não entrou" mesmo se
  -- tivesse entrado — exatamente o falso negativo mais perigoso aqui.
  PERFORM set_config('app.tenant_id', t_b::text, true);
  SELECT count(*) INTO visiveis FROM students WHERE full_name = 'Plantado por A';
  PERFORM set_config('app.tenant_id', t_a::text, true);

  IF visiveis > 0 THEN
    RAISE EXCEPTION 'FALHA 2c: A gravou registro no tenant da B (% linha(s))', visiveis;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 2c: o INSERT cruzado não levantou erro nenhum';
  END IF;

  RAISE NOTICE 'OK 2 — escrita cruzada bloqueada (update, delete e insert)';

  -- =================================================================
  -- 3. CONTEXTO AUSENTE FALHA FECHADO
  -- Se a API esquecer de definir o tenant, o banco não pode devolver
  -- "tudo": tem que devolver "nada".
  -- =================================================================
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO visiveis FROM students;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'FALHA 3: sem contexto de tenant o banco devolveu % linhas', visiveis;
  END IF;
  RAISE NOTICE 'OK 3 — sem contexto de tenant, nenhuma linha é devolvida';

  -- =================================================================
  -- 4. AGENDA: dupla marcação é impossível
  -- =================================================================
  PERFORM set_config('app.tenant_id', t_a::text, true);

  INSERT INTO appointments (tenant_id, student_id, professional_id, room_id, period)
    VALUES (t_a, s_a, prof_a, room_a,
            tstzrange('2026-03-02 09:00+00', '2026-03-02 10:00+00', '[)'));

  -- 4a. Mesmo profissional, horário sobreposto.
  ok := false;
  BEGIN
    INSERT INTO appointments (tenant_id, student_id, professional_id, period)
      VALUES (t_a, s_a, prof_a,
              tstzrange('2026-03-02 09:30+00', '2026-03-02 10:30+00', '[)'));
  EXCEPTION WHEN exclusion_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 4a: profissional foi marcado duas vezes no mesmo horário';
  END IF;

  -- 4b. Encostar não é sobrepor: 10h-11h logo após 9h-10h deve passar.
  INSERT INTO appointments (tenant_id, student_id, professional_id, period)
    VALUES (t_a, s_a, prof_a,
            tstzrange('2026-03-02 10:00+00', '2026-03-02 11:00+00', '[)'));

  -- 4c. Mesma sala, horário sobreposto, profissional diferente.
  ok := false;
  BEGIN
    INSERT INTO appointments (tenant_id, student_id, professional_id, room_id, period)
      VALUES (t_a, s_a, u_a, room_a,
              tstzrange('2026-03-02 09:15+00', '2026-03-02 09:45+00', '[)'));
  EXCEPTION WHEN exclusion_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 4c: a sala foi ocupada duas vezes no mesmo horário';
  END IF;

  -- 4d. Cancelado libera o horário.
  UPDATE appointments SET status = 'CANCELLED', cancelled_at = now()
    WHERE professional_id = prof_a
      AND period && tstzrange('2026-03-02 09:00+00', '2026-03-02 10:00+00', '[)');
  INSERT INTO appointments (tenant_id, student_id, professional_id, room_id, period)
    VALUES (t_a, s_a, prof_a, room_a,
            tstzrange('2026-03-02 09:00+00', '2026-03-02 09:50+00', '[)'));

  RAISE NOTICE 'OK 4 — dupla marcação bloqueada pelo banco; cancelamento libera o horário';

  -- =================================================================
  -- 5. COERÊNCIA DE ESTADO DO AGENDAMENTO
  -- =================================================================
  ok := false;
  BEGIN
    INSERT INTO appointments (tenant_id, student_id, professional_id, period, status)
      VALUES (t_a, s_a, prof_a,
              tstzrange('2026-04-01 09:00+00', '2026-04-01 10:00+00', '[)'), 'CANCELLED');
  EXCEPTION WHEN check_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 5: agendamento cancelado sem data de cancelamento foi aceito';
  END IF;
  RAISE NOTICE 'OK 5 — estado meio-cancelado é recusado';

  -- =================================================================
  -- 6. FINANCEIRO: status e total pago são derivados, e não se paga a mais
  -- =================================================================
  DECLARE
    e_id uuid;
    v_status entry_status;
    v_paid bigint;
  BEGIN
    INSERT INTO finance_entries (tenant_id, direction, description, amount_cents, due_date, student_id)
      VALUES (t_a, 'RECEIVABLE', 'Mensalidade março', 29990, '2026-03-10', s_a)
      RETURNING id INTO e_id;

    -- Pagamento parcial
    INSERT INTO finance_payments (tenant_id, entry_id, amount_cents, method)
      VALUES (t_a, e_id, 10000, 'PIX');
    SELECT status, paid_cents INTO v_status, v_paid FROM finance_entries WHERE id = e_id;
    IF v_status <> 'PARTIALLY_PAID' OR v_paid <> 10000 THEN
      RAISE EXCEPTION 'FALHA 6a: parcial virou status=% pago=%', v_status, v_paid;
    END IF;

    -- Quitação
    INSERT INTO finance_payments (tenant_id, entry_id, amount_cents, method)
      VALUES (t_a, e_id, 19990, 'CASH');
    SELECT status, paid_cents INTO v_status, v_paid FROM finance_entries WHERE id = e_id;
    IF v_status <> 'PAID' OR v_paid <> 29990 THEN
      RAISE EXCEPTION 'FALHA 6b: quitação virou status=% pago=%', v_status, v_paid;
    END IF;

    -- Pagar acima do devido é recusado.
    ok := false;
    BEGIN
      INSERT INTO finance_payments (tenant_id, entry_id, amount_cents, method)
        VALUES (t_a, e_id, 100, 'PIX');
    EXCEPTION WHEN check_violation THEN
      ok := true;
    END;
    IF NOT ok THEN
      RAISE EXCEPTION 'FALHA 6c: aceitou pagamento acima do valor devido';
    END IF;

    -- Estorno recalcula para trás.
    DELETE FROM finance_payments WHERE entry_id = e_id AND method = 'CASH';
    SELECT status, paid_cents INTO v_status, v_paid FROM finance_entries WHERE id = e_id;
    IF v_status <> 'PARTIALLY_PAID' OR v_paid <> 10000 THEN
      RAISE EXCEPTION 'FALHA 6d: estorno deixou status=% pago=%', v_status, v_paid;
    END IF;
  END;
  RAISE NOTICE 'OK 6 — status e total pago derivam dos pagamentos; superpagamento recusado';

  -- =================================================================
  -- 7. RECORRÊNCIA É IDEMPOTENTE
  -- Rodar o cron duas vezes não pode cobrar o aluno duas vezes.
  -- =================================================================
  DECLARE
    r_id uuid;
  BEGIN
    INSERT INTO finance_recurrences
      (tenant_id, direction, description, amount_cents, cycle, billing_day, student_id, starts_on)
      VALUES (t_a, 'RECEIVABLE', 'Mensalidade', 29990, 'MONTHLY', 10, s_a, '2026-01-01')
      RETURNING id INTO r_id;

    INSERT INTO finance_entries
      (tenant_id, direction, description, amount_cents, due_date, competence_date, recurrence_id, student_id)
      VALUES (t_a, 'RECEIVABLE', 'Mensalidade março', 29990, '2026-03-10', '2026-03-01', r_id, s_a);

    ok := false;
    BEGIN
      INSERT INTO finance_entries
        (tenant_id, direction, description, amount_cents, due_date, competence_date, recurrence_id, student_id)
        VALUES (t_a, 'RECEIVABLE', 'Mensalidade março', 29990, '2026-03-10', '2026-03-01', r_id, s_a);
    EXCEPTION WHEN unique_violation THEN
      ok := true;
    END;
    IF NOT ok THEN
      RAISE EXCEPTION 'FALHA 7: a recorrência gerou cobrança duplicada no mesmo mês';
    END IF;
  END;
  RAISE NOTICE 'OK 7 — geração de recorrência é idempotente';

  -- =================================================================
  -- 8. AUDITORIA É APPEND-ONLY
  -- =================================================================
  INSERT INTO audit_log (tenant_id, actor_id, action, resource_type, resource_id)
    VALUES (t_a, u_a, 'student.read', 'student', s_a::text);

  ok := false;
  BEGIN
    UPDATE audit_log SET action = 'apagado' WHERE tenant_id = t_a;
    IF NOT FOUND THEN ok := true; END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 8a: o log de auditoria pôde ser reescrito';
  END IF;

  ok := false;
  BEGIN
    DELETE FROM audit_log WHERE tenant_id = t_a;
    IF NOT FOUND THEN ok := true; END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 8b: o log de auditoria pôde ser apagado';
  END IF;
  RAISE NOTICE 'OK 8 — log de auditoria é append-only';

  -- =================================================================
  -- 9. VALIDAÇÕES DE DOMÍNIO
  -- =================================================================
  ok := false;
  BEGIN
    INSERT INTO students (tenant_id, full_name, whatsapp)
      VALUES (t_a, 'Zé', '11987654321');   -- sem +55: fora do padrão E.164
  EXCEPTION WHEN check_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 9a: aceitou WhatsApp fora do padrão E.164';
  END IF;

  ok := false;
  BEGIN
    INSERT INTO finance_entries (tenant_id, direction, description, amount_cents, due_date, student_id)
      VALUES (t_a, 'RECEIVABLE', 'Valor negativo', -100, '2026-03-10', s_a);
  EXCEPTION WHEN check_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 9b: aceitou lançamento com valor negativo';
  END IF;

  ok := false;
  BEGIN
    INSERT INTO commissions (tenant_id, professional_id, reference_month, base_cents, rate_bp, amount_cents)
      VALUES (t_a, prof_a, '2026-03-15', 100000, 4000, 40000);  -- não é dia 1
  EXCEPTION WHEN check_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FALHA 9c: aceitou comissão com mês de referência fora do dia 1';
  END IF;
  RAISE NOTICE 'OK 9 — validações de domínio ativas';

  -- ==================================================================
  -- Limpeza: o teste não pode deixar rastro que impeça a próxima
  -- execução nem que polua consultas de quem for depurar o banco.
  -- ==================================================================
  PERFORM set_config('app.tenant_id', t_a::text, true);
  DELETE FROM tenants WHERE id = t_a;
  PERFORM set_config('app.tenant_id', t_b::text, true);
  DELETE FROM tenants WHERE id = t_b;

  RAISE NOTICE '';
  RAISE NOTICE '======================================';
  RAISE NOTICE ' TODAS AS GARANTIAS VERIFICADAS';
  RAISE NOTICE '======================================';
END
$$;
