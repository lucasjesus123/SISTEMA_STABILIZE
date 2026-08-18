import { useEffect, useState, type ReactNode } from 'react';
import { Carregando, Vazio } from './ui.jsx';
import {
  ApiError,
  adicionarItemTreino,
  baixarFotoDoExercicio,
  buscarExercicios,
  buscarTreino,
  buscarTreinos,
  criarTreino,
  enviarFotoDoExercicio,
  publicarTreino,
  removerItemTreino,
  type Exercicio,
  type ItemTreino,
  type Treino,
} from './api.js';

/**
 * Prescrição de treino.
 *
 * A COMPOSIÇÃO SEGUE COMO A PRESCRIÇÃO É FEITA DE VERDADE: o
 * profissional pensa por DIA ("hoje é empurrar"), e dentro do dia por
 * ordem. Então a tela agrupa por dia e mantém a ordem, em vez de
 * oferecer uma tabela plana com uma coluna "dia" — que é o que sai
 * quando se desenha a tela a partir da tabela do banco.
 *
 * O SELETOR DE EXERCÍCIO É O CORAÇÃO. Se achar "remada curvada" custa
 * três cliques e uma rolagem, o profissional monta o treino no papel e
 * digita depois — ou não digita. Por isso ele abre já com a lista
 * inteira, filtra por grupo em um clique e busca sem exigir acento.
 */

const GRUPOS: { valor: string; rotulo: string }[] = [
  { valor: '', rotulo: 'Todos' },
  { valor: 'PEITO', rotulo: 'Peito' },
  { valor: 'COSTAS', rotulo: 'Costas' },
  { valor: 'OMBRO', rotulo: 'Ombro' },
  { valor: 'BICEPS', rotulo: 'Bíceps' },
  { valor: 'TRICEPS', rotulo: 'Tríceps' },
  { valor: 'ABDOMEN', rotulo: 'Abdômen' },
  { valor: 'LOMBAR', rotulo: 'Lombar' },
  { valor: 'GLUTEO', rotulo: 'Glúteo' },
  { valor: 'QUADRICEPS', rotulo: 'Quadríceps' },
  { valor: 'POSTERIOR', rotulo: 'Posterior' },
  { valor: 'PANTURRILHA', rotulo: 'Panturrilha' },
  { valor: 'CORPO_INTEIRO', rotulo: 'Corpo inteiro' },
  { valor: 'MOBILIDADE', rotulo: 'Mobilidade' },
  { valor: 'CARDIO', rotulo: 'Cardio' },
];

const rotuloGrupo = (v: string): string =>
  GRUPOS.find((g) => g.valor === v)?.rotulo ?? v.toLowerCase();

export function AbaTreino({
  alunoId,
  podeEscrever,
}: {
  alunoId: string;
  podeEscrever: boolean;
}): ReactNode {
  const [lista, setLista] = useState<Omit<Treino, 'itens'>[]>([]);
  const [aberto, setAberto] = useState<Treino | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [nomeNovo, setNomeNovo] = useState('');
  const [objetivoNovo, setObjetivoNovo] = useState('');

  const carregarLista = async (): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await buscarTreinos(alunoId);
      setLista(r.data);
      /* Abre direto o treino vigente. Quem entra nesta aba quase sempre
         quer ver o que o aluno está fazendo hoje, não escolher de uma
         lista de históricos. */
      const ativo = r.data.find((t) => t.status === 'ACTIVE') ?? r.data[0];
      if (ativo !== undefined) {
        const detalhe = await buscarTreino(alunoId, ativo.id);
        setAberto(detalhe.data);
      } else {
        setAberto(null);
      }
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os treinos.');
    } finally {
      setCarregando(false);
    }
  };

  const abrir = async (id: string): Promise<void> => {
    setErro(null);
    try {
      const r = await buscarTreino(alunoId, id);
      setAberto(r.data);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível abrir o treino.');
    }
  };

  const recarregarAberto = async (): Promise<void> => {
    if (aberto === null) return;
    await abrir(aberto.id);
  };

  useEffect(() => {
    void carregarLista();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alunoId]);

  const criar = async (): Promise<void> => {
    setErro(null);
    try {
      const r = await criarTreino(alunoId, {
        nome: nomeNovo.trim(),
        ...(objetivoNovo.trim() === '' ? {} : { objetivo: objetivoNovo.trim() }),
      });
      setNomeNovo('');
      setObjetivoNovo('');
      setCriando(false);
      const nova = await buscarTreinos(alunoId);
      setLista(nova.data);
      await abrir(r.data.id);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível criar o treino.');
    }
  };

  const publicar = async (): Promise<void> => {
    if (aberto === null) return;
    setErro(null);
    try {
      await publicarTreino(alunoId, aberto.id);
      await carregarLista();
    } catch (e) {
      /* A mensagem do 422 ("acrescente pelo menos um exercício") já diz
         o que fazer — vale mais que um "erro ao publicar". */
      setErro(e instanceof ApiError ? e.message : 'Não foi possível publicar o treino.');
    }
  };

  if (carregando) return <Carregando rotulo="Carregando treinos" />;

  return (
    <section className="prontuario">
      {erro !== null && (
        <p className="mensagem-erro" role="alert">
          {erro}
        </p>
      )}

      {lista.length > 1 && (
        <nav className="treino-versoes" aria-label="Treinos do aluno">
          {lista.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`treino-versao ${aberto?.id === t.id ? 'ativa' : ''}`}
              onClick={() => void abrir(t.id)}
            >
              {t.nome}
              {t.status === 'ACTIVE' && <span className="treino-selo">vigente</span>}
            </button>
          ))}
        </nav>
      )}

      {podeEscrever &&
        (criando ? (
          <div className="formulario treino-novo">
            <label className="campo campo-meia">
              <span className="campo-rotulo">Nome do treino</span>
              <input
                value={nomeNovo}
                placeholder="Treino ABC — hipertrofia"
                autoFocus
                onChange={(e) => setNomeNovo(e.target.value)}
              />
            </label>
            <label className="campo campo-meia">
              <span className="campo-rotulo">Objetivo</span>
              <input
                value={objetivoNovo}
                placeholder="Ganho de força nos básicos"
                onChange={(e) => setObjetivoNovo(e.target.value)}
              />
            </label>
            <div className="formulario-acoes campo-cheia">
              <button type="button" className="botao-secundario" onClick={() => setCriando(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="botao-acao"
                disabled={nomeNovo.trim().length < 2}
                onClick={() => void criar()}
              >
                Criar treino
              </button>
            </div>
          </div>
        ) : (
          <div className="treino-acoes">
            <button type="button" className="botao-secundario" onClick={() => setCriando(true)}>
              Novo treino
            </button>
          </div>
        ))}

      {aberto === null ? (
        <Vazio
          titulo="Nenhum treino prescrito."
          descricao="O treino é o que o aluno leva para a sala — e o que a anamnese existe para condicionar."
        />
      ) : (
        <DetalheTreino
          alunoId={alunoId}
          treino={aberto}
          podeEscrever={podeEscrever}
          aoMudar={() => void recarregarAberto()}
          aoPublicar={() => void publicar()}
        />
      )}
    </section>
  );
}

/* ==================================================================== */

function DetalheTreino({
  alunoId,
  treino,
  podeEscrever,
  aoMudar,
  aoPublicar,
}: {
  alunoId: string;
  treino: Treino;
  podeEscrever: boolean;
  aoMudar: () => void;
  aoPublicar: () => void;
}): ReactNode {
  const [adicionandoEm, setAdicionandoEm] = useState<string | null>(null);

  /* Agrupa por dia mantendo a ordem em que os dias apareceram: quem
     montou "A, B, C" quer ler "A, B, C", não em ordem alfabética de um
     rótulo que ele escreveu à mão. */
  const dias: { dia: string; itens: ItemTreino[] }[] = [];
  for (const item of treino.itens) {
    const existente = dias.find((d) => d.dia === item.dia);
    if (existente === undefined) dias.push({ dia: item.dia, itens: [item] });
    else existente.itens.push(item);
  }
  if (dias.length === 0) dias.push({ dia: 'A', itens: [] });

  const remover = async (item: ItemTreino): Promise<void> => {
    await removerItemTreino(alunoId, treino.id, item.id).catch(() => undefined);
    aoMudar();
  };

  return (
    <>
      <header className="treino-topo">
        <div>
          <h3 className="treino-nome">
            {treino.nome}
            {treino.status === 'ACTIVE' && <span className="treino-selo">vigente</span>}
            {treino.status === 'DRAFT' && <span className="treino-selo rascunho">rascunho</span>}
          </h3>
          <span className="treino-meta">
            {treino.objetivo !== null && `${treino.objetivo} · `}
            {treino.profissional.nome}
          </span>
        </div>
        {podeEscrever && treino.status !== 'ACTIVE' && (
          <button type="button" className="botao-acao" onClick={aoPublicar}>
            Publicar para o aluno
          </button>
        )}
      </header>

      {/* OS DIAS EM QUADRADOS, e não empilhados um sob o outro.
          Empilhados, montar a semana inteira exigia rolar — e ninguém
          consegue olhar para "segunda" e "quinta" ao mesmo tempo para
          decidir se o volume está distribuído. Lado a lado, a semana é
          uma coisa só e o desequilíbrio salta aos olhos. */}
      <div className="treino-grade">
      {dias.map((bloco) => (
        <div key={bloco.dia} className="treino-dia">
          <h4 className="treino-dia-titulo">
            {bloco.dia}
            <span className="treino-dia-conta">
              {bloco.itens.length === 1 ? '1 exercício' : `${bloco.itens.length} exercícios`}
            </span>
          </h4>

          {bloco.itens.length === 0 ? (
            <p className="treino-dia-vazio">Nenhum exercício neste dia.</p>
          ) : (
            <ol className="treino-itens">
              {bloco.itens.map((item) => (
                <li key={item.id} className="treino-item">
                  <div className="treino-item-corpo">
                    <span className="treino-exercicio">{item.exercicio}</span>
                    <span className="treino-item-meta">
                      {rotuloGrupo(item.grupo)}
                      {item.equipamento !== null && ` · ${item.equipamento}`}
                    </span>
                  </div>

                  <span className="treino-prescricao tabular">
                    {item.series !== null && `${item.series}×`}
                    {item.repeticoes ?? ''}
                    {item.cargaG !== null && ` · ${(item.cargaG / 1000).toFixed(1)} kg`}
                    {item.descansoSegundos !== null && ` · ${item.descansoSegundos}s`}
                  </span>

                  {podeEscrever && (
                    <button
                      type="button"
                      className="botao-texto"
                      aria-label={`Remover ${item.exercicio}`}
                      onClick={() => void remover(item)}
                    >
                      remover
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}

          {podeEscrever &&
            (adicionandoEm === bloco.dia ? (
              <SeletorExercicio
                alunoId={alunoId}
                treinoId={treino.id}
                dia={bloco.dia}
                proximaPosicao={bloco.itens.length}
                aoFechar={() => setAdicionandoEm(null)}
                aoAdicionar={() => {
                  setAdicionandoEm(null);
                  aoMudar();
                }}
              />
            ) : (
              <button
                type="button"
                className="botao-texto treino-adicionar"
                onClick={() => setAdicionandoEm(bloco.dia)}
              >
                + exercício em {bloco.dia}
              </button>
            ))}
        </div>
      ))}
      {podeEscrever && <NovoDia alunoId={alunoId} treinoId={treino.id} aoAdicionar={aoMudar} />}
      </div>
    </>
  );
}

/* ==================================================================== */

/* Os dias da semana em um toque. A academia divide por dia da semana
   ("segunda é perna") ou por letra ("treino A"); as duas convivem, e o
   campo continua livre para quem escreve "A — Empurrar". Oferecer os
   sete prontos é o que evita digitar "Segunda", "segunda" e "SEG" no
   mesmo treino e acabar com três dias onde deveria haver um. */
const DIAS_DA_SEMANA = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

function NovoDia({
  alunoId,
  treinoId,
  aoAdicionar,
}: {
  alunoId: string;
  treinoId: string;
  aoAdicionar: () => void;
}): ReactNode {
  const [abrindo, setAbrindo] = useState(false);
  const [nome, setNome] = useState('');

  /* Um dia só existe quando tem exercício — não há tabela de "dias". O
     seletor abre já com o rótulo digitado, e o primeiro exercício
     adicionado é o que faz o dia aparecer. */
  if (!abrindo) {
    return (
      <button type="button" className="treino-dia treino-novo-quadrado" onClick={() => setAbrindo(true)}>
        <span className="treino-mais" aria-hidden="true">
          +
        </span>
        <span>novo dia</span>
      </button>
    );
  }

  return (
    <div className="treino-dia">
      <div className="treino-atalhos">
        {DIAS_DA_SEMANA.map((d) => (
          <button
            key={d}
            type="button"
            className={`treino-atalho ${nome === d ? 'ativo' : ''}`}
            onClick={() => setNome(d)}
          >
            {d.slice(0, 3)}
          </button>
        ))}
      </div>
      <div className="formulario">
        <label className="campo campo-cheia">
          <span className="campo-rotulo">Nome do dia</span>
          <input
            value={nome}
            placeholder="ou escreva: A — Empurrar"
            autoFocus
            onChange={(e) => setNome(e.target.value)}
          />
        </label>
      </div>
      {nome.trim() !== '' && (
        <SeletorExercicio
          alunoId={alunoId}
          treinoId={treinoId}
          dia={nome.trim()}
          proximaPosicao={0}
          aoFechar={() => {
            setAbrindo(false);
            setNome('');
          }}
          aoAdicionar={() => {
            setAbrindo(false);
            setNome('');
            aoAdicionar();
          }}
        />
      )}
    </div>
  );
}

/* ==================================================================== */

function SeletorExercicio({
  alunoId,
  treinoId,
  dia,
  proximaPosicao,
  aoFechar,
  aoAdicionar,
}: {
  alunoId: string;
  treinoId: string;
  dia: string;
  proximaPosicao: number;
  aoFechar: () => void;
  aoAdicionar: () => void;
}): ReactNode {
  const [busca, setBusca] = useState('');
  const [grupo, setGrupo] = useState('');
  const [opcoes, setOpcoes] = useState<Exercicio[]>([]);
  const [escolhido, setEscolhido] = useState<Exercicio | null>(null);
  /* Um contador que sobe a cada envio. Sem ele a `<FotoDoExercicio>`
     mantém o blob antigo em cache e a pessoa envia a imagem certa,
     recebe 201 e continua vendo a errada — o que se lê como "não
     salvou". */
  const [versaoDaFoto, setVersaoDaFoto] = useState(0);
  const aoTrocarFoto = (): void => {
    setVersaoDaFoto((v) => v + 1);
    setEscolhido((e) => (e === null ? null : { ...e, temFoto: true }));
  };
  const [series, setSeries] = useState('3');
  const [repeticoes, setRepeticoes] = useState('10-12');
  const [carga, setCarga] = useState('');
  const [descanso, setDescanso] = useState('60');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    // Espera parar de digitar: sem isso cada tecla vira uma requisição e
    // as respostas chegam fora de ordem.
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await buscarExercicios(busca.trim(), grupo);
          if (!cancelado) setOpcoes(r.data);
        } catch {
          if (!cancelado) setOpcoes([]);
        }
      })();
    }, 220);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [busca, grupo]);

  const adicionar = async (): Promise<void> => {
    if (escolhido === null) return;
    setSalvando(true);
    setErro(null);
    try {
      await adicionarItemTreino(alunoId, treinoId, {
        exercicioId: escolhido.id,
        dia,
        posicao: proximaPosicao,
        ...(series.trim() === '' ? {} : { series: Number(series) }),
        ...(repeticoes.trim() === '' ? {} : { repeticoes: repeticoes.trim() }),
        ...(carga.trim() === '' ? {} : { cargaKg: Number(carga.replace(',', '.')) }),
        ...(descanso.trim() === '' ? {} : { descansoSegundos: Number(descanso) }),
      });
      aoAdicionar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível adicionar o exercício.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="seletor-exercicio">
      {erro !== null && (
        <p className="mensagem-erro" role="alert">
          {erro}
        </p>
      )}

      {escolhido === null ? (
        <>
          <div className="seletor-filtros">
            <input
              className="campo-busca"
              value={busca}
              placeholder="Buscar exercício…"
              autoFocus
              onChange={(e) => setBusca(e.target.value)}
            />
            <select value={grupo} onChange={(e) => setGrupo(e.target.value)}>
              {GRUPOS.map((g) => (
                <option key={g.valor} value={g.valor}>
                  {g.rotulo}
                </option>
              ))}
            </select>
            <button type="button" className="botao-texto" onClick={aoFechar}>
              cancelar
            </button>
          </div>

          {opcoes.length === 0 ? (
            <p className="treino-dia-vazio">Nenhum exercício encontrado.</p>
          ) : (
            <ul className="seletor-opcoes">
              {opcoes.slice(0, 40).map((e) => (
                <li key={e.id}>
                  <button type="button" className="seletor-item" onClick={() => setEscolhido(e)}>
                    <FotoDoExercicio exercicio={e} tamanho="mini" />
                    <span className="seletor-item-texto">
                      <span>{e.nome}</span>
                      <span className="seletor-item-meta">
                        {rotuloGrupo(e.grupo)}
                        {e.equipamento !== null && ` · ${e.equipamento}`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="seletor-escolhido">
            <FotoDoExercicio exercicio={escolhido} tamanho="grande" versao={versaoDaFoto} />
            <div className="seletor-escolhido-texto">
              <p className="seletor-escolhido-nome">
                <strong>{escolhido.nome}</strong>
                <button type="button" className="botao-texto" onClick={() => setEscolhido(null)}>
                  trocar
                </button>
              </p>
              {escolhido.instrucoes !== null && (
                <p className="seletor-instrucao">{escolhido.instrucoes}</p>
              )}
              {/* O ENVIO DA FOTO FICA AQUI, e não numa tela de
                  biblioteca à parte. É neste instante que alguém está
                  olhando para o exercício e percebendo que falta a
                  imagem; obrigar a sair, achar a biblioteca e procurar o
                  mesmo exercício é o que faz a biblioteca ficar sem foto
                  nenhuma para sempre. */}
              <EnvioDeFoto exercicio={escolhido} aoEnviar={aoTrocarFoto} />
            </div>
          </div>

          <div className="formulario seletor-prescricao">
            <label className="campo campo-terco">
              <span className="campo-rotulo">Séries</span>
              <input inputMode="numeric" value={series} onChange={(e) => setSeries(e.target.value)} />
            </label>
            <label className="campo campo-terco">
              <span className="campo-rotulo">Repetições</span>
              <input
                value={repeticoes}
                placeholder="8-12, até a falha…"
                onChange={(e) => setRepeticoes(e.target.value)}
              />
            </label>
            <label className="campo campo-terco">
              <span className="campo-rotulo">Carga (kg)</span>
              <input
                inputMode="decimal"
                value={carga}
                placeholder="opcional"
                onChange={(e) => setCarga(e.target.value)}
              />
            </label>
            <label className="campo campo-terco">
              <span className="campo-rotulo">Descanso (s)</span>
              <input
                inputMode="numeric"
                value={descanso}
                onChange={(e) => setDescanso(e.target.value)}
              />
            </label>
            <div className="formulario-acoes campo-cheia">
              <button type="button" className="botao-secundario" onClick={aoFechar}>
                Cancelar
              </button>
              <button
                type="button"
                className="botao-acao"
                disabled={salvando}
                onClick={() => void adicionar()}
              >
                {salvando ? 'Adicionando…' : 'Adicionar ao treino'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ====================================================================
 * A foto do exercício
 * ================================================================== */

/**
 * Mostra a foto de um exercício, ou as iniciais do grupo muscular
 * quando não há foto.
 *
 * A IMAGEM PASSA POR `fetch`, e não vai direto no `src`. A rota exige o
 * token no cabeçalho `Authorization`, e uma tag `<img>` não manda
 * cabeçalho nenhum — sem este desvio, toda figura viria 401. O preço é
 * ter de revogar o blob ao desmontar, feito na limpeza do efeito: sem
 * isso, rolar uma lista de sessenta exercícios deixa sessenta blobs
 * presos na memória da aba.
 */
function FotoDoExercicio({
  exercicio,
  tamanho,
  versao = 0,
}: {
  exercicio: Exercicio;
  tamanho: 'mini' | 'grande';
  versao?: number;
}): ReactNode {
  const [endereco, setEndereco] = useState<string | null>(null);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    if (!exercicio.temFoto) return;
    let vivo = true;
    let atual: string | null = null;

    void baixarFotoDoExercicio(exercicio.id).then((url) => {
      if (!vivo) {
        if (url !== null) URL.revokeObjectURL(url);
        return;
      }
      atual = url;
      if (url === null) setFalhou(true);
      else setEndereco(url);
    });

    return () => {
      vivo = false;
      if (atual !== null) URL.revokeObjectURL(atual);
    };
  }, [exercicio.id, exercicio.temFoto, versao]);

  if (!exercicio.temFoto || falhou || endereco === null) {
    return (
      <span className={`ex-foto ex-${tamanho} ex-vazia`} aria-hidden="true">
        {rotuloGrupo(exercicio.grupo).slice(0, 3)}
      </span>
    );
  }

  return (
    <img
      className={`ex-foto ex-${tamanho}`}
      src={endereco}
      alt={`Demonstração de ${exercicio.nome}`}
      loading="lazy"
    />
  );
}

/** Envia (ou troca) a foto de um exercício. */
function EnvioDeFoto({
  exercicio,
  aoEnviar,
}: {
  exercicio: Exercicio;
  aoEnviar: () => void;
}): ReactNode {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const escolher = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const arquivo = e.target.files?.[0];
    /* O valor do input é limpo sempre: sem isto, escolher o MESMO
       arquivo depois de um erro não dispara `change` de novo, e a tela
       fica parecendo travada. */
    e.target.value = '';
    if (arquivo === undefined) return;

    setErro(null);
    setEnviando(true);
    try {
      await enviarFotoDoExercicio(exercicio.id, arquivo);
      aoEnviar();
    } catch (x) {
      setErro(x instanceof ApiError ? x.message : 'Não foi possível enviar a imagem.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <p className="ex-envio">
      <label className="botao-texto">
        {enviando ? 'Enviando…' : exercicio.temFoto ? 'Trocar a foto' : 'Adicionar uma foto'}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => void escolher(e)}
          disabled={enviando}
        />
      </label>
      {erro !== null && (
        <span className="mensagem-erro" role="alert">
          {erro}
        </span>
      )}
    </p>
  );
}
