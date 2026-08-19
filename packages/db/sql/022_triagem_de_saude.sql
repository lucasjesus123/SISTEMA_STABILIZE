-- =====================================================================
-- TRIAGEM DE SAÚDE (PAR-Q) E TERMO DE RESPONSABILIDADE
--
-- O QUE FALTAVA: nada no sistema perguntava se a pessoa PODE treinar.
-- Havia anamnese — que é registro clínico, feito pelo profissional, com
-- calma, depois que o aluno já está matriculado. O PAR-Q é outra coisa e
-- vem antes: sete perguntas de sim ou não que a própria pessoa responde
-- ANTES do primeiro treino, e um termo que ela assina.
--
-- POR QUE ISSO É JURÍDICO E NÃO SÓ BOA PRÁTICA
--
-- Quando alguém passa mal treinando, a primeira pergunta que se faz à
-- academia é "o que vocês sabiam sobre a saúde dessa pessoa e o que
-- fizeram com isso". Sem um questionário respondido e datado, a resposta
-- é "nada", e a academia responde pelo resultado. Com ele, a academia
-- mostra o que perguntou, o que a pessoa declarou e o que exigiu em
-- seguida.
--
-- AS TRÊS DECISÕES QUE ESTA TABELA CARREGA
--
-- 1. O TEXTO DO TERMO É CONGELADO NA LINHA, e não referenciado por id
--    de uma tabela de modelos. Se a academia melhorar o texto ano que
--    vem, a assinatura do ano passado tem que continuar mostrando o que
--    a pessoa REALMENTE leu. Guardar um ponteiro para o modelo atual faz
--    o documento assinado mudar sozinho depois de assinado — que é
--    exatamente o que um termo não pode fazer.
--
-- 2. QUALQUER "SIM" EXIGE LIBERAÇÃO MÉDICA. É a regra do PAR-Q, e ela é
--    calculada aqui (coluna gerada) e não na aplicação: assim vale para
--    qualquer caminho que grave a triagem, inclusive um script.
--
-- 3. A TRIAGEM VENCE. Doze meses é o intervalo usual — a saúde muda, e
--    um questionário de 2019 não diz nada sobre 2026. Vencida, ela não é
--    apagada: continua no histórico e uma nova é assinada por cima.
-- =====================================================================

CREATE TABLE IF NOT EXISTS health_screenings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  /* As sete respostas do PAR-Q, em chaves estáveis. jsonb e não sete
     colunas porque o questionário tem variações (PAR-Q+ tem
     subperguntas) e uma coluna por pergunta transformaria cada revisão
     do formulário numa migração. */
  respostas    jsonb NOT NULL DEFAULT '{}'::jsonb,

  /* Regra do PAR-Q: um "sim" em qualquer pergunta manda procurar um
     médico antes de começar. Coluna GERADA para que a regra não dependa
     de quem escreveu o INSERT. */
  precisa_liberacao_medica boolean NOT NULL GENERATED ALWAYS AS (
    respostas @> '{"coracao": true}'::jsonb
    OR respostas @> '{"dor_no_peito": true}'::jsonb
    OR respostas @> '{"tontura": true}'::jsonb
    OR respostas @> '{"osso_articulacao": true}'::jsonb
    OR respostas @> '{"remedio_pressao": true}'::jsonb
    OR respostas @> '{"outra_razao": true}'::jsonb
    OR respostas @> '{"gravidez": true}'::jsonb
  ) STORED,

  observacoes  text,

  /* -----------------------------------------------------------------
     A ASSINATURA

     `termo_texto` é o documento inteiro, como estava no dia. Não é
     desperdício de espaço: é a única forma de provar o que foi assinado.
     ----------------------------------------------------------------- */
  termo_versao text NOT NULL,
  termo_texto  text NOT NULL,
  assinado_em  timestamptz NOT NULL DEFAULT now(),
  /* Nome digitado pela própria pessoa. Assinatura eletrônica simples,
     que é o que a MP 2.200-2/2001 admite entre as partes quando há
     como identificar quem assinou — daí guardarmos IP e navegador. */
  assinado_nome text NOT NULL,
  assinado_ip   inet,
  assinado_agente text,
  /* Quem assinou: o próprio aluno pelo aplicativo, ou alguém da
     academia com o aluno na frente. Muda o peso da prova, então fica
     registrado. */
  assinado_pelo_aluno boolean NOT NULL DEFAULT false,
  registrado_por uuid REFERENCES users(id) ON DELETE SET NULL,

  /* -----------------------------------------------------------------
     A LIBERAÇÃO, quando o PAR-Q exigiu

     `atestado_id` aponta para o anexo do atestado médico. Fica NULL
     enquanto o aluno não trouxe — e é esse NULL que a recepção vê.
     ----------------------------------------------------------------- */
  atestado_id  uuid REFERENCES attachments(id) ON DELETE SET NULL,
  liberado_em  timestamptz,
  liberado_por uuid REFERENCES users(id) ON DELETE SET NULL,

  /* Doze meses por padrão. Guardado e não calculado na consulta porque
     a academia pode encurtar o prazo de um aluno específico. */
  valido_ate   date NOT NULL DEFAULT (current_date + 365),

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT triagem_liberacao_coerente
    CHECK ((liberado_em IS NULL) = (liberado_por IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_triagem_aluno
  ON health_screenings (tenant_id, student_id, assinado_em DESC);

/* O índice da recepção: quem está vencido ou pendente de atestado. */
CREATE INDEX IF NOT EXISTS idx_triagem_validade
  ON health_screenings (tenant_id, valido_ate);

ALTER TABLE health_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_screenings FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'health_screenings' AND policyname = 'triagem_tenant') THEN
    CREATE POLICY triagem_tenant ON health_screenings
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id());
  END IF;
END
$$;

COMMENT ON TABLE health_screenings IS
  'PAR-Q respondido e termo de responsabilidade assinado. O texto do termo é congelado na linha porque um documento assinado não pode mudar depois.';
COMMENT ON COLUMN health_screenings.termo_texto IS
  'O documento inteiro como estava no dia da assinatura. Referenciar um modelo por id faria o termo assinado mudar quando o modelo mudasse.';

-- ---------------------------------------------------------------------
-- O MODELO DO TERMO, por academia
--
-- Fica em `tenants` e não numa tabela à parte porque é UM texto por
-- empresa. Uma tabela de modelos com histórico seria a resposta certa se
-- o termo assinado apontasse para ela — mas ele não aponta, ele copia.
-- O histórico do que foi assinado mora nas assinaturas.
-- ---------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS termo_versao text NOT NULL DEFAULT 'v1';
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS termo_texto text;
/* Quantos dias a triagem vale. 0 = nunca vence, para quem não quer
   controlar isso. */
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS triagem_validade_dias integer NOT NULL DEFAULT 365;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_validade_sana') THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_validade_sana
      CHECK (triagem_validade_dias BETWEEN 0 AND 3650);
  END IF;
END
$$;

/* Se a recepção deve barrar quem está sem triagem. Zero na porta é o
   padrão, pela mesma razão do check-in: barrar aluno é decisão de
   negócio. Mas aqui o padrão é AVISAR SEMPRE — porque o risco desta
   pendência não é financeiro, é físico. */
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS exigir_triagem_na_porta boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.termo_texto IS
  'Modelo do termo de responsabilidade. NULL usa o texto padrão do sistema.';
COMMENT ON COLUMN tenants.exigir_triagem_na_porta IS
  'Se true, entrar sem triagem válida exige liberação manual da recepção.';
