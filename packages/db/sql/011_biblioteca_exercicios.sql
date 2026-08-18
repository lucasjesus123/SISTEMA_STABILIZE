-- =====================================================================
-- CATÁLOGO DE EXERCÍCIOS, E A BIBLIOTECA DE QUEM AINDA NÃO TEM NENHUM
--
-- Uma academia que abre a aba de treino e encontra a biblioteca VAZIA
-- não prescreve treino nenhum. Foi exatamente o que aconteceu: o
-- catálogo existia em `packages/db/scripts/exercicios.ts` e só era
-- copiado pelo SEED, que popula a academia de DEMONSTRAÇÃO. Uma empresa
-- de verdade, criada pelo caminho normal, nascia sem um único exercício
-- — e a tela respondia "Nenhum exercício encontrado" para qualquer
-- busca, sem explicar que não havia nada a encontrar.
--
-- O CATÁLOGO É UMA TABELA, e não uma lista solta dentro desta migration.
-- A alternativa considerada era, na criação de cada empresa, copiar a
-- biblioteca "da empresa que tem mais exercícios". Funciona por
-- acidente: basta alguém apagar exercícios da empresa errada, ou a
-- primeira academia do sistema ser criada quando nenhuma outra existe,
-- para a nova nascer vazia de novo — o defeito que esta migration veio
-- consertar. Com uma tabela de catálogo a origem é sempre a mesma e não
-- depende do estado de nenhum inquilino.
--
-- `exercise_catalog` NÃO tem tenant_id e NÃO tem RLS: é conteúdo do
-- produto, igual para todo mundo, e ninguém escreve nela fora de
-- migration. A cópia por empresa continua existindo — cada academia
-- renomeia, ajusta a instrução e desativa o que quiser sem afetar
-- ninguém, que é a decisão tomada em 005.
--
-- GERADO a partir de `packages/db/scripts/exercicios.ts` — a mesma
-- lista que o seed usa, para as duas não divergirem.
-- =====================================================================

CREATE TABLE IF NOT EXISTS exercise_catalog (
  nome         text PRIMARY KEY,
  grupo        muscle_group NOT NULL,
  equipamento  text,
  instrucoes   text
);
REVOKE ALL ON exercise_catalog FROM PUBLIC;
GRANT SELECT ON exercise_catalog TO stabilize_app;

INSERT INTO exercise_catalog (nome, grupo, equipamento, instrucoes)
VALUES
  ('Supino reto com barra', 'PEITO', 'Barra', 'Escápulas retraídas e pés firmes. A barra desce na linha do mamilo, não do pescoço.'),
  ('Supino inclinado com halteres', 'PEITO', 'Halteres', 'Banco a 30–45°. Acima disso o ombro assume o trabalho.'),
  ('Crucifixo na máquina', 'PEITO', 'Máquina', 'Cotovelos levemente flexionados e fixos durante todo o movimento.'),
  ('Crossover na polia', 'PEITO', 'Polia', NULL),
  ('Flexão de braço', 'PEITO', 'Peso corporal', 'Corpo em prancha. Quadril caindo é sinal de fadiga do core, não do peito.'),
  ('Puxada frontal na polia alta', 'COSTAS', 'Polia', 'Puxar com os cotovelos, não com as mãos. Barra à frente, nunca atrás da nuca.'),
  ('Remada curvada com barra', 'COSTAS', 'Barra', 'Coluna neutra e quadril para trás. Se a lombar arredonda, reduza a carga.'),
  ('Remada baixa sentada', 'COSTAS', 'Polia', NULL),
  ('Remada unilateral com halter', 'COSTAS', 'Halteres', NULL),
  ('Barra fixa', 'COSTAS', 'Peso corporal', NULL),
  ('Pullover na polia', 'COSTAS', 'Polia', NULL),
  ('Desenvolvimento com halteres', 'OMBRO', 'Halteres', 'Não trave o cotovelo no topo. Costelas para baixo para poupar a lombar.'),
  ('Elevação lateral', 'OMBRO', 'Halteres', 'Sobe até a linha do ombro. Acima disso entra trapézio.'),
  ('Elevação frontal', 'OMBRO', 'Halteres', NULL),
  ('Crucifixo inverso', 'OMBRO', 'Máquina', 'Trabalha o deltoide posterior — o que costuma faltar em quem senta o dia todo.'),
  ('Remada alta', 'OMBRO', 'Barra', NULL),
  ('Face pull', 'OMBRO', 'Polia', 'Puxar na altura do rosto, cotovelos altos. Excelente para postura.'),
  ('Rosca direta com barra', 'BICEPS', 'Barra', NULL),
  ('Rosca alternada com halteres', 'BICEPS', 'Halteres', NULL),
  ('Rosca martelo', 'BICEPS', 'Halteres', NULL),
  ('Rosca scott', 'BICEPS', 'Máquina', NULL),
  ('Rosca concentrada', 'BICEPS', 'Halteres', NULL),
  ('Tríceps na polia com barra', 'TRICEPS', 'Polia', 'Cotovelos colados ao tronco. Se abrem, virou supino.'),
  ('Tríceps francês', 'TRICEPS', 'Halteres', NULL),
  ('Tríceps corda', 'TRICEPS', 'Polia', NULL),
  ('Mergulho no banco', 'TRICEPS', 'Peso corporal', NULL),
  ('Supino fechado', 'TRICEPS', 'Barra', NULL),
  ('Rosca de punho', 'ANTEBRACO', 'Halteres', NULL),
  ('Caminhada do fazendeiro', 'ANTEBRACO', 'Halteres', 'Ombros para trás, passos curtos. Mede preensão e core ao mesmo tempo.'),
  ('Prancha isométrica', 'ABDOMEN', 'Peso corporal', 'Glúteo contraído e costelas para baixo. Tempo só conta enquanto a forma se mantém.'),
  ('Prancha lateral', 'ABDOMEN', 'Peso corporal', NULL),
  ('Abdominal supra no solo', 'ABDOMEN', 'Peso corporal', NULL),
  ('Elevação de pernas suspenso', 'ABDOMEN', 'Barra fixa', NULL),
  ('Abdominal na polia (canivete)', 'ABDOMEN', 'Polia', NULL),
  ('Extensão lombar no banco romano', 'LOMBAR', 'Banco romano', 'Subir até a linha do corpo, sem hiperestender.'),
  ('Bird dog', 'LOMBAR', 'Peso corporal', 'Braço e perna opostos. O quadril não pode rodar — é o ponto do exercício.'),
  ('Elevação pélvica com barra', 'GLUTEO', 'Barra', 'Queixo para o peito e costelas para baixo. Pausa de 1 s no topo.'),
  ('Coice na polia', 'GLUTEO', 'Polia', NULL),
  ('Abdução na máquina', 'GLUTEO', 'Máquina', NULL),
  ('Levantamento terra romeno', 'POSTERIOR', 'Barra', 'Quadril para trás, joelhos quase estendidos. Para quando a lombar quiser arredondar.'),
  ('Mesa flexora', 'POSTERIOR', 'Máquina', NULL),
  ('Flexora em pé', 'POSTERIOR', 'Máquina', NULL),
  ('Bom dia com barra', 'POSTERIOR', 'Barra', NULL),
  ('Agachamento livre', 'QUADRICEPS', 'Barra', 'Pés na largura do quadril, joelho acompanha a ponta do pé.'),
  ('Agachamento na caixa', 'QUADRICEPS', 'Barra', 'Boa escolha para quem ainda não controla a profundidade.'),
  ('Leg press 45°', 'QUADRICEPS', 'Máquina', 'Não deixe a lombar descolar do encosto no fundo do movimento.'),
  ('Cadeira extensora', 'QUADRICEPS', 'Máquina', NULL),
  ('Afundo com halteres', 'QUADRICEPS', 'Halteres', NULL),
  ('Búlgaro', 'QUADRICEPS', 'Halteres', NULL),
  ('Hack machine', 'QUADRICEPS', 'Máquina', NULL),
  ('Panturrilha em pé', 'PANTURRILHA', 'Máquina', NULL),
  ('Panturrilha sentado', 'PANTURRILHA', 'Máquina', NULL),
  ('Levantamento terra convencional', 'CORPO_INTEIRO', 'Barra', 'Barra colada à canela. Se a lombar arredonda na saída, a carga está alta.'),
  ('Kettlebell swing', 'CORPO_INTEIRO', 'Kettlebell', 'Movimento de quadril, não de ombro. O kettlebell é jogado, não levantado.'),
  ('Burpee', 'CORPO_INTEIRO', 'Peso corporal', NULL),
  ('Thruster', 'CORPO_INTEIRO', 'Halteres', NULL),
  ('Mobilidade de quadril 90/90', 'MOBILIDADE', 'Peso corporal', NULL),
  ('Gato e camelo', 'MOBILIDADE', 'Peso corporal', NULL),
  ('Alongamento de peitoral na parede', 'MOBILIDADE', 'Peso corporal', NULL),
  ('Mobilidade torácica deitado', 'MOBILIDADE', 'Peso corporal', NULL),
  ('Alongamento de isquiotibiais', 'MOBILIDADE', 'Peso corporal', NULL),
  ('Esteira — caminhada inclinada', 'CARDIO', 'Esteira', NULL),
  ('Esteira — corrida contínua', 'CARDIO', 'Esteira', NULL),
  ('Bicicleta ergométrica', 'CARDIO', 'Bicicleta', NULL),
  ('Remo ergômetro', 'CARDIO', 'Remo', NULL),
  ('Corda naval', 'CARDIO', 'Corda', NULL),
  ('Escada ergométrica', 'CARDIO', 'Escada', NULL)
ON CONFLICT (nome) DO UPDATE SET
  grupo       = EXCLUDED.grupo,
  equipamento = EXCLUDED.equipamento,
  instrucoes  = EXCLUDED.instrucoes;

-- ---------------------------------------------------------------------
-- E as empresas que já existem sem biblioteca recebem a cópia.
--
-- Idempotente por duas vias, e as duas são necessárias:
--   1. `WHERE NOT EXISTS` — só popula quem tem ZERO exercícios. Quem já
--      montou a própria biblioteca não recebe 67 linhas por cima do
--      trabalho dela.
--   2. `ON CONFLICT DO NOTHING` — protege da corrida entre migrações
--      simultâneas e de alguém ter cadastrado à mão um nome idêntico.
--
-- O `NO FORCE` NÃO É OPCIONAL, e a primeira versão desta migration não o
-- tinha: ela rodou, não acusou erro e inseriu ZERO linhas. O motivo é que
-- `stabilize_migrator` é o dono das tabelas mas está sob `FORCE ROW
-- LEVEL SECURITY` — que vale até para o dono — e uma migration roda sem
-- `app.tenant_id` definido. O `SELECT ... FROM tenants` devolvia nenhuma
-- empresa, o CROSS JOIN nenhuma linha, e o INSERT gravava nada com
-- sucesso. É o pior tipo de falha: silenciosa e marcada como aplicada.
-- ---------------------------------------------------------------------
ALTER TABLE tenants   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE exercises NO FORCE ROW LEVEL SECURITY;

INSERT INTO exercises (tenant_id, name, muscle_group, equipment, instructions)
SELECT t.id, c.nome, c.grupo, c.equipamento, c.instrucoes
  FROM tenants t
 CROSS JOIN exercise_catalog c
 WHERE NOT EXISTS (SELECT 1 FROM exercises e WHERE e.tenant_id = t.id)
ON CONFLICT (tenant_id, name) DO NOTHING;

ALTER TABLE tenants   FORCE ROW LEVEL SECURITY;
ALTER TABLE exercises FORCE ROW LEVEL SECURITY;
