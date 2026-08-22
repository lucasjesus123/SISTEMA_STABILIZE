-- =====================================================================
-- CRM — QUEM AINDA NÃO É ALUNO
--
-- O sistema começava no aluno já matriculado. Quem ligou perguntando
-- preço, quem veio conhecer e disse "depois eu te falo", quem fez uma
-- aula experimental e sumiu — nada disso existia em lugar nenhum. Ficava
-- no caderno da recepção, no WhatsApp de alguém, ou não ficava.
--
-- E é o pedaço mais caro de perder: custa muito mais achar um interessado
-- novo do que voltar em quem já demonstrou interesse.
--
-- POR QUE UMA TABELA SEPARADA, e não um `status = 'LEAD'` em `students`
--
-- Foi a primeira ideia e está errada. `students` tem CPF obrigatório para
-- o app, código sequencial por academia, contrato, prontuário, triagem de
-- saúde. Um interessado não tem nada disso — e ao dar a ele uma linha em
-- `students`, toda contagem do sistema passa a incluí-lo: "quantos
-- alunos temos" vira uma pergunta com asterisco, o relatório de presença
-- ganha gente que nunca treinou, e a régua de cobrança precisa aprender
-- a ignorar uma categoria nova.
--
-- Separado, o custo é uma conversão explícita — que é justamente o
-- momento que a academia quer medir.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_status') THEN
    -- O funil, e ele é curto de propósito. Um funil de oito etapas é um
    -- funil que ninguém atualiza, e dado de CRM desatualizado é pior que
    -- ausente: leva a decidir por um retrato que não existe mais.
    CREATE TYPE lead_status AS ENUM (
      'NOVO',        -- chegou, ninguém falou com ele ainda
      'CONTATADO',   -- alguém falou; a conversa está viva
      'VISITOU',     -- veio conhecer ou fez experimental
      'MATRICULOU',  -- virou aluno — terminal
      'PERDIDO'      -- disse não, ou sumiu — terminal
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_origem') THEN
    CREATE TYPE lead_origem AS ENUM (
      'INDICACAO', 'INSTAGRAM', 'GOOGLE', 'FACHADA', 'WHATSAPP', 'EVENTO', 'OUTRO'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  nome           text NOT NULL CHECK (length(btrim(nome)) BETWEEN 2 AND 120),
  -- WhatsApp é o único contato que importa de verdade aqui, e mesmo ele
  -- é opcional: quem passou na porta e deixou só o primeiro nome também
  -- é um registro válido. Um formulário que exige telefone é um
  -- formulário que a recepção não preenche no meio do atendimento.
  whatsapp       text CHECK (whatsapp IS NULL OR whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  email          citext,

  origem         lead_origem NOT NULL DEFAULT 'OUTRO',
  status         lead_status NOT NULL DEFAULT 'NOVO',
  interesse      text,
  observacoes    text,

  -- Quem está cuidando. Sem dono, todo interessado é responsabilidade de
  -- todos, que é o mesmo que de ninguém.
  responsavel_id uuid REFERENCES users(id) ON DELETE SET NULL,

  -- A DATA DO PRÓXIMO CONTATO É O CORAÇÃO DESTE MÓDULO. Um CRM sem ela é
  -- uma lista; com ela, é uma fila de trabalho. O que atrasa aparece.
  proximo_contato date,

  -- Preenchidos na conversão, e os dois juntos: `virou_aluno_id` diz em
  -- QUEM, `convertido_em` diz QUANDO. Sem o quando, não há como medir
  -- quanto tempo o funil leva.
  virou_aluno_id uuid REFERENCES students(id) ON DELETE SET NULL,
  convertido_em  timestamptz,
  perdido_motivo text,

  criado_por     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- COERÊNCIA ENTRE STATUS E OS CAMPOS TERMINAIS. Um lead 'MATRICULOU'
  -- sem aluno vinculado é um número de conversão que não se consegue
  -- auditar; um lead 'NOVO' com aluno vinculado é lixo que sobra de um
  -- fluxo interrompido. O banco recusa os dois.
  CONSTRAINT lead_conversao_coerente CHECK (
    (status = 'MATRICULOU' AND virou_aluno_id IS NOT NULL AND convertido_em IS NOT NULL)
    OR (status <> 'MATRICULOU' AND virou_aluno_id IS NULL AND convertido_em IS NULL)
  )
);

-- A FILA DE HOJE: o índice que serve a única consulta que roda o dia
-- inteiro — "o que eu tenho para fazer?". Parcial, porque lead fechado
-- não entra em fila nenhuma e não precisa ocupar o índice.
CREATE INDEX IF NOT EXISTS idx_lead_fila
  ON leads (tenant_id, proximo_contato NULLS LAST)
  WHERE status NOT IN ('MATRICULOU', 'PERDIDO');

CREATE INDEX IF NOT EXISTS idx_lead_responsavel
  ON leads (tenant_id, responsavel_id)
  WHERE status NOT IN ('MATRICULOU', 'PERDIDO');

-- Para o funil do painel: contagem por status num período.
CREATE INDEX IF NOT EXISTS idx_lead_status
  ON leads (tenant_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_leads_updated ON leads;
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_tenant ON leads;
CREATE POLICY leads_tenant ON leads
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =====================================================================
-- O HISTÓRICO DA CONVERSA
--
-- Separado do lead de propósito. Guardar o histórico num campo de texto
-- que cada pessoa acrescenta uma linha é o que transforma CRM em diário
-- ilegível: não dá para saber quem escreveu o quê, nem quando, e duas
-- pessoas editando ao mesmo tempo perdem uma das versões.
--
-- Aqui cada contato é uma linha, com autor e data. É append-only na
-- prática: não há rota que edite nem apague.
-- =====================================================================
CREATE TABLE IF NOT EXISTS lead_contatos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  texto       text NOT NULL CHECK (length(btrim(texto)) BETWEEN 1 AND 2000),
  autor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_contato
  ON lead_contatos (tenant_id, lead_id, created_at DESC);

ALTER TABLE lead_contatos ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_contatos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_contatos_tenant ON lead_contatos;
CREATE POLICY lead_contatos_tenant ON lead_contatos
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

COMMENT ON TABLE leads IS
  'Interessados que ainda nao sao alunos. Separado de students de proposito: um interessado nao tem CPF, codigo, contrato nem prontuario, e conta-lo como aluno estragaria toda metrica do sistema.';
COMMENT ON COLUMN leads.proximo_contato IS
  'A data que transforma a lista numa fila de trabalho. O que atrasa aparece primeiro.';
