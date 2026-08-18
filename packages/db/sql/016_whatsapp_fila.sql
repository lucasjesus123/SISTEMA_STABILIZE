-- =====================================================================
-- WHATSAPP: CONFIGURAÇÃO NA PLATAFORMA E FILA COM HORA DE ENVIO
--
-- Duas mudanças que respondem à mesma frase: "o token fica no painel do
-- super admin, e a academia só lê o QR Code".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A CONFIGURAÇÃO DA UAZAPI MORA EM `platform_settings`
--
-- A tabela NÃO é criada aqui, e sim em `014_plataforma_super.sql`. A
-- primeira versão a criava neste arquivo e quebrou a atualização de uma
-- VPS real:
--
--     --> 014_plataforma_super.sql  (superusuário, sempre)
--     ERROR:  relation "platform_settings" does not exist
--
-- O 014 tem sufixo `_super` e por isso roda SEMPRE, a cada deploy. O 016
-- é numerado e roda UMA vez. Numa instalação que ainda não tinha
-- nenhum dos dois, o 014 executava primeiro e concedia permissão numa
-- tabela que só nasceria dois arquivos depois.
--
-- A REGRA QUE FICA: um arquivo que roda sempre não pode depender de
-- nada criado por um arquivo numerado posterior. Ele tem que ser
-- autossuficiente — e é por isso que o 014 agora cria a própria tabela,
-- com `IF NOT EXISTS`.
--
-- O meu teste de banco limpo passou porque foi feito ANTES de o 016
-- existir; depois disso só reexecutei o caminho incremental, onde a
-- tabela já estava lá. Testar do zero só no fim não pega isto.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 2. A FILA DE ENVIO
--
-- O aluno agenda pelo aplicativo e recebe a confirmação em segundos; a
-- véspera da aula ele recebe o lembrete. São a MESMA coisa vista de dois
-- momentos, e por isso são uma mecânica só: uma mensagem com hora de
-- envio. A confirmação nasce com `enviar_apos = agora`, o lembrete com
-- `enviar_apos = início da aula menos N horas`.
--
-- POR QUE UMA FILA NO BANCO, e não um `setTimeout` no processo: o
-- setTimeout morre com o restart, e restart acontece em todo deploy. Um
-- lembrete marcado para daqui a três dias precisa sobreviver a isso. A
-- fila também dá o que um temporizador não dá — saber quantas falharam,
-- por quê, e poder tentar de novo.
--
-- `tentativas` e `ultima_tentativa_em` existem para que uma mensagem que
-- falha não fique tentando para sempre nem desapareça em silêncio: o
-- worker desiste depois de algumas e a linha continua no banco, com o
-- erro, para alguém ver.
-- ---------------------------------------------------------------------
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS enviar_apos timestamptz NOT NULL DEFAULT now();
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS tentativas integer NOT NULL DEFAULT 0;
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS ultima_tentativa_em timestamptz;
-- De qual agendamento veio. Cancelar a aula precisa cancelar o lembrete
-- que ainda não saiu — sem esta coluna, o aluno recebe "sua aula é
-- amanhã às 7h" depois de ter desmarcado, que é pior que não avisar.
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE;

/* O índice do worker. Parcial, só sobre o que está pendente: a tabela
   cresce para sempre e a fila é sempre curta, então varrer o histórico
   inteiro a cada minuto seria desperdício crescente. */
CREATE INDEX IF NOT EXISTS idx_wa_fila
  ON whatsapp_messages (enviar_apos)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_wa_agendamento
  ON whatsapp_messages (appointment_id)
  WHERE appointment_id IS NOT NULL AND status = 'PENDING';

-- ---------------------------------------------------------------------
-- Preferências de envio, por academia
--
-- Quantas horas antes o lembrete sai, e se a confirmação imediata está
-- ligada. Fica em `tenants` porque é decisão de cada academia: uma que
-- atende por hora marcada quer lembrete de véspera; uma de treino livre
-- talvez não queira nenhum.
-- ---------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS wa_confirmar_agendamento boolean NOT NULL DEFAULT true;
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS wa_lembrete_horas integer NOT NULL DEFAULT 3
  CHECK (wa_lembrete_horas BETWEEN 0 AND 168);

COMMENT ON COLUMN tenants.wa_lembrete_horas IS
  'Quantas horas antes da aula o lembrete é enviado. 0 desliga o lembrete.';
COMMENT ON COLUMN whatsapp_messages.enviar_apos IS
  'A partir de quando esta mensagem pode sair. Confirmação nasce com now(); lembrete com o início da aula menos wa_lembrete_horas.';
