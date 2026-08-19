-- =====================================================================
-- CICLO DE VIDA DO CONTRATO
--
-- Duas ideias vindas do estudo do modelo de assinatura do ERPNext
-- (GPL-3.0 — nenhuma linha de código foi copiada; o que se aproveita
-- aqui é o MODELO DE DOMÍNIO, que não tem dono):
--
--   1. CANCELAR NO FIM DO PERÍODO PAGO, e não na hora.
--      É o caso normal de academia: o aluno avisa no dia 15 que vai
--      sair, e já pagou o mês inteiro. Encerrar o contrato na hora
--      tira o acesso de quem pagou; encerrar em silêncio no fim do mês
--      exige alguém lembrar de voltar lá no dia 30. A intenção fica
--      registrada e a tarefa de fundo executa na data certa.
--
--   2. NÃO SEGUIR COBRANDO QUEM JÁ NÃO PAGA.
--      Sem isto, um aluno que sumiu em março acumula uma mensalidade
--      nova todo mês, para sempre. Em dezembro ele "deve" dez meses de
--      um serviço que não usou, o relatório de inadimplência vira
--      ficção e ninguém confia mais no número.
--
-- Nenhuma das duas muda cobrança já emitida: as duas decidem apenas se
-- a PRÓXIMA nasce.
-- =====================================================================

ALTER TABLE student_contracts
  ADD COLUMN IF NOT EXISTS encerrar_no_fim_do_periodo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cancelado_em timestamptz,
  ADD COLUMN IF NOT EXISTS cancelado_motivo text;

COMMENT ON COLUMN student_contracts.encerrar_no_fim_do_periodo IS
  'O aluno pediu para sair mas já pagou o período corrente. O contrato segue ativo até ends_on e não gera cobrança nova.';

/* Quantas mensalidades vencidas seguidas suspendem a geração.
   Fica na EMPRESA e não no código: academia de bairro segura três
   meses, estúdio de pilates corta no primeiro. */
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS parar_cobranca_apos_vencidas smallint NOT NULL DEFAULT 3;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_parar_cobranca_sano') THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_parar_cobranca_sano
      CHECK (parar_cobranca_apos_vencidas BETWEEN 1 AND 24);
  END IF;
END
$$;

COMMENT ON COLUMN tenants.parar_cobranca_apos_vencidas IS
  'Depois de N mensalidades vencidas do mesmo aluno, a geração automática para. Evita a dívida de fantasia de quem sumiu.';
