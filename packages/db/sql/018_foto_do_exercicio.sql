-- =====================================================================
-- FOTO DO EXERCÍCIO
--
-- A biblioteca tinha nome, grupo muscular, equipamento, instruções e
-- `video_url` — e nenhuma imagem. Na prática isso significa que o aluno
-- abre o treino no aplicativo e lê "remada curvada com halteres" sem
-- fazer ideia do movimento; quem nunca fez, não faz, ou faz errado.
--
-- É UM CAMINHO NO NOSSO ARMAZENAMENTO, não uma URL externa.
--
-- URL externa parece mais simples e envelhece mal: a academia hospeda a
-- imagem num site qualquer, o link morre em seis meses e o treino fica
-- com um quadrado quebrado — sem que ninguém perceba, porque quem monta
-- o treino já sabe o movimento e não olha a figura.
--
-- Guardar a chave aqui usa o mesmo cofre dos anexos: cifrado em disco,
-- servido por rota autenticada, apagado junto quando trocado. A coluna
-- `video_url` continua onde está, para quem preferir apontar um vídeo.
-- =====================================================================

ALTER TABLE exercises ADD COLUMN IF NOT EXISTS image_key text;

COMMENT ON COLUMN exercises.image_key IS
  'Chave do arquivo no armazenamento cifrado. NULL = exercício sem foto.';
