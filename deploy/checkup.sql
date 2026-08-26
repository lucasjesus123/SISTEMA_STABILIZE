-- =====================================================================
-- VERIFICADOR DE REGRESSÃO — "algo está voltando sozinho?"
--
-- Responde com evidência a pergunta que mais tira o sono de quem tem
-- sistema em produção: o usuário jura que algo sumiu ou voltou, e
-- ninguém consegue provar o contrário. Sem prova, a suspeita cai sobre
-- o sistema, a confiança se desfaz, e a equipe passa a conferir tudo na
-- mão.
--
-- SÓ LEITURA. Todas as consultas são SELECT. Nunca altera, cria ou
-- apaga — é o que permite rodar em produção, com o sistema no ar, a
-- qualquer hora.
--
-- O QUE ESTE VERIFICADOR PODE E NÃO PODE AFIRMAR
--
-- A trilha (`audit_log`) é escrita pela APLICAÇÃO, e não por gatilho de
-- banco. Isso muda o que dá para afirmar, e a diferença precisa estar
-- dita em vez de escondida:
--
--   · O que passa pelo sistema fica registrado, com autor e horário.
--   · O que for feito por SQL direto no banco NÃO fica. Um `UPDATE`
--     rodado no terminal é invisível para a trilha.
--
-- Por isso metade das conferências abaixo NÃO depende da trilha: são
-- checagens de INTEGRIDADE, que leem o dado atual e perguntam se ele é
-- coerente consigo mesmo. Essas valem sempre, inclusive contra mudanças
-- feitas por fora — e são as que pegam perda de dinheiro.
-- =====================================================================

\pset pager off
\set ON_ERROR_STOP on

\echo ''
\echo '======================================================================'
\echo ' CHECKUP DE REGRESSÃO — Stabilize'
\echo '======================================================================'
\echo ''

-- ---------------------------------------------------------------------
-- COBERTURA E PERÍODO
--
-- Um OK sem estas duas informações é um OK sem valor: o leitor não sabe
-- sobre o quê nem desde quando. Se a reclamação for de antes do
-- primeiro registro, a resposta correta é "não tenho como saber" — não
-- "está tudo bem".
-- ---------------------------------------------------------------------
\echo '--- COBERTURA DA TRILHA ---'
SELECT
  count(*)                                      AS eventos,
  count(DISTINCT action)                        AS tipos_de_acao,
  count(DISTINCT tenant_id)                     AS academias,
  to_char(min(created_at), 'DD/MM/YYYY')        AS desde,
  to_char(max(created_at), 'DD/MM/YYYY')        AS ate
FROM audit_log;

\echo ''
\echo 'Gatilhos de auditoria no banco (lidos de pg_trigger, nao da documentacao):'
SELECT coalesce(string_agg(DISTINCT c.relname, ', '), 'NENHUM — a trilha e escrita pela aplicacao') AS tabelas_com_gatilho
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND t.tgname ILIKE '%audit%';

\echo ''
\echo '======================================================================'
\echo ' PLACAR'
\echo '======================================================================'

WITH

-- =====================================================================
-- 1. DINHEIRO: a soma das baixas bate com o valor pago?
--
-- NÃO DEPENDE DA TRILHA — lê o dado atual. É a conferência mais
-- importante do arquivo: se `paid_cents` divergir da soma real dos
-- pagamentos, o extrato mente sobre quanto entrou, e a diferença
-- aparece no fechamento do mês sem ninguém saber de onde veio.
-- =====================================================================
pago_bate AS (
  SELECT count(*) AS n
  FROM finance_entries e
  /* A MESMA FÓRMULA DO GATILHO, e não `sum(amount_cents)` puro.
     Desde a migração 036, `paid_cents` guarda a DÍVIDA ABATIDA:
     dinheiro que entrou, menos juros/multa, mais desconto perdoado.
     Este verificador ficou com a fórmula antiga por uma rodada e
     acusou como defeito toda baixa com juros ou desconto — ele mesmo
     pegou a divergência, que é o que se espera dele. */
  WHERE e.paid_cents <> (
    SELECT coalesce(sum(p.amount_cents - p.acrescimo_cents + p.desconto_cents), 0)
      FROM finance_payments p
     WHERE p.entry_id = e.id
  )
),

-- =====================================================================
-- 2. DINHEIRO: alguma conta recebeu mais do que vale?
--
-- O banco tem trava para isso. Esta conferência existe para o caso de a
-- trava ter sido contornada por SQL direto — que é exatamente o caminho
-- que a trilha não enxerga.
-- =====================================================================
super_pago AS (
  SELECT count(*) AS n
  FROM finance_entries
  WHERE paid_cents > amount_cents
),

-- =====================================================================
-- 3. DINHEIRO: o status combina com o que foi pago?
--
-- Uma conta PAGA com saldo em aberto, ou uma conta ABERTA já quitada,
-- some dos filtros de cobrança. O aluno deixa de ser cobrado, ou é
-- cobrado de novo depois de ter pago.
-- =====================================================================
status_incoerente AS (
  SELECT count(*) AS n
  FROM finance_entries
  WHERE cancelled_at IS NULL
    AND (
      (status = 'PAID'   AND paid_cents < amount_cents) OR
      (status <> 'PAID'  AND paid_cents >= amount_cents AND amount_cents > 0)
    )
),

-- =====================================================================
-- 4. CANCELAMENTO PELA METADE
--
-- `cancelled_at` preenchido e status diferente de CANCELLED (ou o
-- contrário) é a linha que soma no total e não aparece na lista, ou
-- aparece na lista e não soma. Foi um defeito real deste sistema, hoje
-- travado por gatilho — a conferência fica para provar que continua.
-- =====================================================================
meio_cancelado AS (
  SELECT count(*) AS n
  FROM finance_entries
  WHERE (cancelled_at IS NOT NULL) <> (status = 'CANCELLED')
),

-- =====================================================================
-- 5. COBRANÇA DUPLICADA
--
-- Mesmo aluno, mesmo valor, mesmo vencimento, nenhuma cancelada. Quase
-- sempre é a mensalidade gerada duas vezes — e o aluno recebe duas
-- cobranças do mesmo mês.
--
-- ARMADILHA 3 DA INVESTIGAÇÃO: "voltou" pode ser um registro NOVO. Aqui
-- não se procura o MESMO id ressuscitado, e sim a ENTIDADE equivalente
-- recriada. São diagnósticos opostos: um é restauração indevida, o
-- outro é alguém refazendo à mão.
-- =====================================================================
duplicatas AS (
  SELECT count(*) AS n FROM (
    SELECT student_id, amount_cents, due_date, direction
      FROM finance_entries
     WHERE cancelled_at IS NULL AND student_id IS NOT NULL
     GROUP BY student_id, amount_cents, due_date, direction
    HAVING count(*) > 1
  ) x
),

-- =====================================================================
-- 6. AGENDA: dois atendimentos no mesmo profissional na mesma hora
--
-- O banco tem restrição de exclusão para isso. Vale a mesma observação
-- do item 2: a conferência existe para o caso de terem passado por
-- fora.
-- =====================================================================
agenda_sobreposta AS (
  SELECT count(*) AS n
  FROM appointments a
  JOIN appointments b
    ON b.professional_id = a.professional_id
   AND b.id <> a.id
   AND b.period && a.period
  WHERE a.status <> 'CANCELLED' AND b.status <> 'CANCELLED'
),

-- =====================================================================
-- 7. FECHAMENTO DE MÊS REABERTO
--
-- Depende da trilha, e é o caso clássico de "desfizeram sozinho". Toda
-- reabertura é legítima em si — o que não pode é reabertura SEM
-- ninguém por trás.
--
-- ARMADILHA 1: "sem autor" NÃO significa "foi uma rotina". Aqui
-- significa que o evento chegou sem `actor_id`, e a única leitura
-- honesta é "não dá para saber quem foi" — que é diferente de acusar.
-- =====================================================================
reaberturas AS (
  SELECT
    count(*)                                  AS n,
    count(*) FILTER (WHERE actor_id IS NULL)  AS sem_autor
  FROM audit_log
  WHERE action = 'commission.reopen'
),

-- =====================================================================
-- 8. PAGAMENTO ESTORNADO
--
-- Estornar é uma operação normal. O que este número serve para
-- responder é "quantos, e todos com autor?" — a pergunta que aparece
-- quando alguém diz que uma baixa sumiu.
-- =====================================================================
estornos AS (
  SELECT
    count(*)                                  AS n,
    count(*) FILTER (WHERE actor_id IS NULL)  AS sem_autor
  FROM audit_log
  WHERE action = 'finance.payment.delete'
),

-- =====================================================================
-- 9. ACESSO NEGADO
--
-- Não é regressão, é vizinhança: uma sequência de negativas para o
-- mesmo usuário costuma ser alguém tentando alcançar o que não é dele —
-- ou uma permissão mal recortada que está atrapalhando o trabalho.
-- =====================================================================
negados AS (
  SELECT count(*) AS n
  FROM audit_log
  WHERE outcome = 'DENIED' AND created_at > now() - interval '30 days'
)

SELECT * FROM (
  SELECT 1 AS ord, 'Baixas x valor pago' AS verificacao, (SELECT n FROM pago_bate) AS achados,
         CASE WHEN (SELECT n FROM pago_bate) = 0 THEN 'OK  - todo pagamento esta somado'
              ELSE 'ATENCAO - o extrato mente sobre quanto entrou' END AS leitura
  UNION ALL SELECT 2, 'Conta paga acima do valor', (SELECT n FROM super_pago),
         CASE WHEN (SELECT n FROM super_pago) = 0 THEN 'OK  - nenhuma recebeu a mais'
              ELSE 'ATENCAO - trava do banco foi contornada' END
  UNION ALL SELECT 3, 'Status x valor pago', (SELECT n FROM status_incoerente),
         CASE WHEN (SELECT n FROM status_incoerente) = 0 THEN 'OK  - status coerente'
              ELSE 'ATENCAO - conta some da cobranca ou e cobrada de novo' END
  UNION ALL SELECT 4, 'Cancelamento pela metade', (SELECT n FROM meio_cancelado),
         CASE WHEN (SELECT n FROM meio_cancelado) = 0 THEN 'OK  - nenhuma linha em dois estados'
              ELSE 'ATENCAO - soma no total e nao aparece na lista' END
  UNION ALL SELECT 5, 'Cobrancas duplicadas', (SELECT n FROM duplicatas),
         CASE WHEN (SELECT n FROM duplicatas) = 0 THEN 'OK  - nenhuma repetida'
              ELSE 'ATENCAO - mesmo aluno, valor e vencimento' END
  UNION ALL SELECT 6, 'Agenda sobreposta', (SELECT n FROM agenda_sobreposta),
         CASE WHEN (SELECT n FROM agenda_sobreposta) = 0 THEN 'OK  - ninguem em dois lugares'
              ELSE 'ATENCAO - duas turmas na mesma porta' END
  UNION ALL SELECT 7, 'Fechamentos reabertos', (SELECT n FROM reaberturas),
         CASE WHEN (SELECT n FROM reaberturas) = 0 THEN 'OK  - nenhum'
              WHEN (SELECT sem_autor FROM reaberturas) = 0 THEN 'OK  - todos com autor humano'
              ELSE 'ATENCAO - ha reabertura sem autor registrado' END
  UNION ALL SELECT 8, 'Pagamentos estornados', (SELECT n FROM estornos),
         CASE WHEN (SELECT n FROM estornos) = 0 THEN 'OK  - nenhum'
              WHEN (SELECT sem_autor FROM estornos) = 0 THEN 'OK  - todos com autor humano'
              ELSE 'ATENCAO - ha estorno sem autor registrado' END
  UNION ALL SELECT 9, 'Acessos negados (30 dias)', (SELECT n FROM negados),
         CASE WHEN (SELECT n FROM negados) = 0 THEN 'OK  - nenhum'
              ELSE 'VER - pode ser permissao mal recortada' END
) placar ORDER BY ord;

\echo ''
\echo '--- DETALHE do que precisar de olho ---'

\echo ''
\echo 'Contas cujo pago nao bate com a soma das baixas:'
SELECT e.id, e.description AS descricao, e.amount_cents AS valor, e.paid_cents AS abatido_gravado,
       (SELECT coalesce(sum(p.amount_cents - p.acrescimo_cents + p.desconto_cents),0)
          FROM finance_payments p WHERE p.entry_id = e.id) AS abatido_real,
       (SELECT coalesce(sum(p.amount_cents),0)
          FROM finance_payments p WHERE p.entry_id = e.id) AS entrou_no_caixa
FROM finance_entries e
WHERE e.paid_cents <> (SELECT coalesce(sum(p.amount_cents - p.acrescimo_cents + p.desconto_cents),0)
                         FROM finance_payments p WHERE p.entry_id = e.id)
LIMIT 10;

\echo ''
\echo 'Cobrancas duplicadas (mesmo aluno, valor e vencimento):'
SELECT s.full_name AS aluno, e.amount_cents AS valor, e.due_date AS vencimento, count(*) AS vezes
FROM finance_entries e JOIN students s ON s.id = e.student_id
WHERE e.cancelled_at IS NULL
GROUP BY s.full_name, e.amount_cents, e.due_date
HAVING count(*) > 1
ORDER BY count(*) DESC
LIMIT 10;

\echo ''
\echo 'Fechamentos reabertos, com quem e quando:'
SELECT to_char(a.created_at, 'DD/MM/YYYY HH24:MI') AS quando,
       coalesce(u.full_name, '(sem autor registrado)') AS quem,
       a.resource_id AS profissional
FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
WHERE a.action = 'commission.reopen'
ORDER BY a.created_at DESC
LIMIT 10;

\echo ''
\echo '======================================================================'
\echo ' O QUE ESTE PLACAR NAO PROVA'
\echo ''
\echo ' A trilha e escrita pela aplicacao, nao por gatilho de banco.'
\echo ' Alteracao feita por SQL direto no servidor NAO aparece nela.'
\echo ' As verificacoes 1 a 6 nao dependem da trilha e valem sempre;'
\echo ' as 7 a 9 valem apenas dentro do periodo impresso la em cima.'
\echo ' Reclamacao anterior a esse periodo: a resposta honesta e'
\echo ' "nao tenho como saber", e nao "esta tudo bem".'
\echo '======================================================================'
\echo ''
