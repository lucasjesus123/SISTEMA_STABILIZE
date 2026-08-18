-- =====================================================================
-- WHATSAPP: CONFIGURAÇÃO NA PLATAFORMA E FILA COM HORA DE ENVIO
--
-- Duas mudanças que respondem à mesma frase: "o token fica no painel do
-- super admin, e a academia só lê o QR Code".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A CONFIGURAÇÃO SAI DA VARIÁVEL DE AMBIENTE E VEM PARA O BANCO
--
-- Hoje o endereço e o token administrativo da uazapi vivem em
-- `UAZAPI_BASE_URL` e `UAZAPI_ADMIN_TOKEN`, no .env da VPS. O sintoma
-- disso apareceu na tela: "Falta o token administrativo da uazapi neste
-- servidor" — e a única forma de resolver era entrar por SSH, editar um
-- arquivo e reiniciar o contêiner. Quem opera o SaaS não deveria
-- precisar de terminal para ligar uma integração.
--
-- UMA LINHA SÓ, sempre. `id boolean PRIMARY KEY DEFAULT true` com CHECK
-- é o jeito de o banco garantir que não existe uma segunda configuração
-- — a alternativa (uma tabela livre e a aplicação lembrando de sempre
-- ler a primeira linha) produz o dia em que existem duas e ninguém sabe
-- qual vale.
--
-- O TOKEN É GUARDADO CIFRADO, com a mesma AES-256-GCM dos tokens de
-- instância. Ele é o token ADMINISTRATIVO: quem o tem cria instância e
-- fala em nome de qualquer academia do sistema. Em claro no banco, um
-- dump o entrega inteiro.
--
-- SEM RLS, porque não pertence a tenant nenhum — é configuração da
-- plataforma. A proteção é por GRANT: `stabilize_app` não alcança a
-- tabela, só as funções do painel e a função de leitura abaixo.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  uazapi_base_url        text,
  uazapi_admin_encrypted text,
  atualizado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_por         uuid REFERENCES platform_admins(id) ON DELETE SET NULL
);

INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON platform_settings FROM PUBLIC;
REVOKE ALL ON platform_settings FROM stabilize_app;

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
