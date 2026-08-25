-- ---------------------------------------------------------------------
-- Funções criadas pela própria academia.
--
-- O QUE ISTO RESOLVE. A lista de funções — Proprietário, Administrador,
-- Financeiro, Gerente, Recepção, Profissional — é boa e é fixa: está
-- escrita no código, e é a mesma para todo mundo. Só que cada academia
-- tem os cargos dela. Estagiário, nutricionista, coordenador de turma,
-- sócio que só olha o caixa. Sem um lugar para criá-los, quem cadastra
-- escolhe o mais parecido e escreve o cargo de verdade em lugar nenhum.
--
-- NÃO É UM CONCEITO NOVO DE PERMISSÃO, e esta é a parte que precisa
-- ficar clara: uma função é um NOME para um par (papel, áreas) que já
-- existia. Ela não inventa acesso, não soma permissão e não escapa do
-- teto do papel — a conta continua sendo a interseção, feita no
-- servidor, exatamente como para as funções prontas. O que a academia
-- cria é vocabulário, não poder.
--
-- POR QUE UMA TABELA E NÃO UMA COLUNA `cargo text` EM `users`. Um texto
-- livre ao lado do papel é um rótulo que pode mentir: alguém escreve
-- "Financeiro" e deixa o papel em ADMIN sem recorte, e a lista da equipe
-- passa a afirmar uma coisa que o acesso desmente. Aqui o nome está
-- amarrado ao par que ele descreve, e quem lê a lista lê a verdade.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_funcoes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  nome        text NOT NULL CHECK (length(btrim(nome)) BETWEEN 2 AND 40),
  descricao   text CHECK (descricao IS NULL OR length(descricao) <= 200),

  papel       user_role NOT NULL,
  -- NULL = tudo o que o papel permite. Lista = só essas seções.
  -- Mesma semântica de `users.areas`, de propósito: a função é lida de
  -- volta comparando os dois, e semânticas diferentes fariam a
  -- comparação falhar em silêncio.
  areas       text[],

  criada_em   timestamptz NOT NULL DEFAULT now(),
  criada_por  uuid REFERENCES users(id) ON DELETE SET NULL,

  -- O NOME É ÚNICO NA ACADEMIA. Duas funções "Estagiário" com recortes
  -- diferentes tornariam a lista da equipe indecifrável: a pílula diria
  -- a mesma palavra para duas pessoas com acessos distintos.
  CONSTRAINT funcao_nome_unico UNIQUE (tenant_id, nome),

  -- STUDENT não é cargo de equipe. Deixá-lo passar criaria uma função
  -- que, escolhida, transformaria um funcionário em aluno — com o
  -- acesso do aplicativo e nada do sistema.
  CONSTRAINT funcao_papel_de_equipe CHECK (papel <> 'STUDENT'),

  -- Recortar para NENHUMA área é o mesmo que não dar acesso, e é sempre
  -- um erro de preenchimento: quem quer isso desliga a pessoa.
  CONSTRAINT funcao_areas_nao_vazio CHECK (areas IS NULL OR cardinality(areas) > 0),

  -- As mesmas áreas conhecidas de `users.areas` (032). Repetir a lista
  -- aqui é chato e é o que impede uma função de nascer apontando para
  -- uma seção que não existe — o que daria uma pessoa sem menu nenhum.
  CONSTRAINT funcao_areas_conhecidas CHECK (
    areas IS NULL OR areas <@ ARRAY[
      'recepcao','alunos','agenda','financeiro','interessados','equipe','whatsapp','academia'
    ]::text[]
  )
);

CREATE INDEX IF NOT EXISTS idx_tenant_funcoes ON tenant_funcoes (tenant_id, nome);

ALTER TABLE tenant_funcoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_funcoes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS funcoes_tenant ON tenant_funcoes;
CREATE POLICY funcoes_tenant ON tenant_funcoes
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_funcoes TO stabilize_app;
