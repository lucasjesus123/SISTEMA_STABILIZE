import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Erro } from './ui.jsx';

/**
 * O balcão.
 *
 * ESTA TELA TEM UM ÚNICO USUÁRIO EM MENTE: a pessoa que está de pé
 * atrás do balcão com alguém esperando na frente dela. Isso muda tudo o
 * que normalmente se decide numa tela de sistema.
 *
 * O CAMPO DE BUSCA É O ÚNICO LUGAR ONDE O FOCO PODE ESTAR. Ele nasce
 * focado, volta a ficar focado depois de cada entrada registrada e
 * depois de cada erro. Quem está no balcão não tira a mão do teclado
 * para pegar o mouse: digita o número da carteirinha, olha, aperta
 * Enter, e o próximo já pode digitar.
 *
 * UM RESULTADO SÓ VIRA CARTÃO SOZINHO. Digitou o código e só existe um
 * aluno com aquele código — não há o que escolher. Fazer a pessoa
 * clicar num item de lista de um item é atrito puro.
 *
 * A FOTO É GRANDE PORQUE ELA É A CONFERÊNCIA. O nome na tela não prova
 * nada: quem passa o número da carteirinha do irmão passa o nome do
 * irmão junto. A foto é a única coisa nesta tela que confere se a
 * pessoa na frente do balcão é a pessoa do cadastro.
 *
 * O AVISO DE PENDÊNCIA NÃO É UMA PAREDE. O sistema mostra o que está
 * errado, em vermelho, do tamanho que dá para ler de longe — e oferece o
 * botão de liberar assim mesmo. Barrar aluno na porta é decisão da
 * academia, não do software; o que o software garante é que a liberação
 * fique registrada com o nome de quem liberou.
 */

const ROTULO: Record<api.SituacaoNaPorta, string> = {
  EM_DIA: 'Em dia',
  DEVENDO: 'Devendo',
  SEM_CONTRATO: 'Sem plano ativo',
  INATIVO: 'Matrícula inativa',
};

const TOM: Record<api.SituacaoNaPorta, string> = {
  EM_DIA: 'ok',
  DEVENDO: 'erro',
  SEM_CONTRATO: 'atencao',
  INATIVO: 'erro',
};

export function Recepcao(): ReactNode {
  const [termo, setTermo] = useState('');
  const [achados, setAchados] = useState<api.AlunoNaPorta[] | null>(null);
  const [escolhido, setEscolhido] = useState<api.AlunoNaPorta | null>(null);
  const [dentro, setDentro] = useState<api.PresenteNaAcademia[]>([]);
  const [movimento, setMovimento] = useState<api.MovimentoDoDia | null>(null);
  const [aviso, setAviso] = useState<{ nome: string; situacao: api.SituacaoNaPorta } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const busca = useRef<HTMLInputElement>(null);

  const recarregarPainel = useCallback(async (): Promise<void> => {
    const [presentes, dia] = await Promise.all([
      api.quemEstaNaAcademia().catch(() => ({ data: [] as api.PresenteNaAcademia[] })),
      api.movimentoDoDia().catch(() => null),
    ]);
    setDentro(presentes.data);
    if (dia !== null) setMovimento(dia.data);
  }, []);

  useEffect(() => {
    void recarregarPainel();
  }, [recarregarPainel]);

  /* A BUSCA ESPERA A PESSOA PARAR DE DIGITAR. Sem isso, "Conceição"
     dispara nove consultas e as respostas voltam fora de ordem — a de
     "Conc" chegando depois da de "Conceição" e apagando o resultado
     certo. O `vivo` também garante que uma resposta atrasada de um termo
     já abandonado não pinte a tela. */
  useEffect(() => {
    const limpo = termo.trim();
    if (limpo === '') {
      setAchados(null);
      setEscolhido(null);
      return;
    }
    let vivo = true;
    const t = setTimeout(() => {
      api
        .buscarNaPorta(limpo)
        .then((r) => {
          if (!vivo) return;
          setAchados(r.data);
          /* Um resultado só não precisa de escolha. */
          setEscolhido(r.data.length === 1 ? r.data[0]! : null);
        })
        .catch(() => {
          if (vivo) setAchados([]);
        });
    }, 220);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [termo]);

  const voltarAoBalcao = (): void => {
    setTermo('');
    setAchados(null);
    setEscolhido(null);
    busca.current?.focus();
  };

  const entrar = async (
    aluno: api.AlunoNaPorta,
    liberadoComAviso: boolean,
    observacao: string | null,
  ): Promise<void> => {
    setErro(null);
    try {
      const r = await api.registrarEntrada(aluno.id, { liberadoComAviso, observacao });
      setAviso({ nome: r.data.nome, situacao: r.data.situacao });
      voltarAoBalcao();
      await recarregarPainel();
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível registrar a entrada.');
      busca.current?.focus();
    }
  };

  const sair = async (checkinId: string): Promise<void> => {
    setErro(null);
    try {
      await api.registrarSaida(checkinId);
      await recarregarPainel();
      /* Se o cartão aberto era justamente de quem acabou de sair, ele
         precisa deixar de dizer "está na academia". */
      if (termo.trim() !== '') {
        const r = await api.buscarNaPorta(termo.trim());
        setAchados(r.data);
        setEscolhido(r.data.length === 1 ? r.data[0]! : null);
      }
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível registrar a saída.');
    }
  };

  return (
    <>
      <div className="secao-cabecalho linha-cabecalho">
        <div>
          <h1>Recepção</h1>
          <p>
            Digite o número da carteirinha, o CPF ou o nome. O aluno entra com um Enter.
          </p>
        </div>
        {movimento !== null && (
          <div className="rec-contadores">
            <Contador valor={movimento.dentro} rotulo="na academia" destaque />
            <Contador valor={movimento.total} rotulo="entradas hoje" />
            <Contador valor={movimento.devendo} rotulo="devendo" alerta={movimento.devendo > 0} />
          </div>
        )}
      </div>

      {erro !== null && <Erro mensagem={erro} />}

      {aviso !== null && <Confirmacao aviso={aviso} aoFechar={() => setAviso(null)} />}

      <div className="rec-mesa">
        <section className="rec-balcao">
          <label className="rec-busca">
            <span className="rec-busca-rotulo">Quem está entrando</span>
            <input
              ref={busca}
              value={termo}
              autoFocus
              autoComplete="off"
              /* `search` para o teclado do celular mostrar a lupa; a
                 recepção às vezes é um tablet no balcão. */
              type="search"
              placeholder="Nº da carteirinha, CPF ou nome"
              onChange={(e) => {
                setTermo(e.target.value);
                setAviso(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') voltarAoBalcao();
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const alvo = escolhido ?? achados?.[0];
                /* ENTER NÃO LIBERA NINGUÉM. Quem precisa de liberação
                   precisa de uma decisão consciente, e decisão
                   consciente não cabe na mesma tecla que a rotina. */
                if (alvo !== undefined && !alvo.precisaLiberar && !alvo.dentro) {
                  void entrar(alvo, false, null);
                } else if (alvo !== undefined) {
                  setEscolhido(alvo);
                }
              }}
            />
          </label>

          {escolhido !== null ? (
            <Cartao
              aluno={escolhido}
              aoEntrar={(liberado, obs) => void entrar(escolhido, liberado, obs)}
              aoVoltar={achados !== null && achados.length > 1 ? () => setEscolhido(null) : null}
            />
          ) : achados === null ? (
            <p className="rec-dica">
              O sistema procura por código exato primeiro. Se a academia numera as carteirinhas,
              é o caminho mais rápido do balcão.
            </p>
          ) : achados.length === 0 ? (
            <p className="rec-dica rec-dica-vazia">
              Ninguém encontrado com “{termo.trim()}”.
            </p>
          ) : (
            <ul className="rec-lista">
              {achados.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setEscolhido(a)}>
                    <span className="rec-lista-nome">{a.nome}</span>
                    <span className="rec-lista-meta">
                      {a.codigo === null ? 'sem número' : `nº ${a.codigo}`}
                    </span>
                    <span className={`pilula ${TOM[a.situacao]}`}>{ROTULO[a.situacao]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rec-dentro">
          <h2>
            Na academia agora
            <span className="rec-dentro-n">{dentro.length}</span>
          </h2>
          {dentro.length === 0 ? (
            <p className="rec-dica">Ninguém registrado dentro no momento.</p>
          ) : (
            <ul>
              {dentro.map((p) => (
                <li key={p.id}>
                  <span className="rec-dentro-nome">
                    {p.nome}
                    {p.situacao === 'DEVENDO' && (
                      <span className="pilula erro pequena">devendo</span>
                    )}
                  </span>
                  <span className="rec-dentro-hora">{hora(p.entrouEm)}</span>
                  <button type="button" className="botao-secundario" onClick={() => void sair(p.id)}>
                    Saída
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* O FECHAMENTO ESQUECIDO É O DEFEITO PREVISÍVEL desta tela:
              ninguém passa na recepção para dizer que está indo embora.
              Dizer isso aqui é mais honesto do que deixar a contagem
              inflar e a pessoa achar que o número está quebrado. */}
          {dentro.length > 0 && (
            <p className="rec-nota">
              A saída raramente é registrada pelo próprio aluno. No fim do expediente, feche as
              que sobraram por aqui.
            </p>
          )}
        </section>
      </div>
    </>
  );
}

/* ==================================================================== */

function Contador({
  valor,
  rotulo,
  destaque = false,
  alerta = false,
}: {
  valor: number;
  rotulo: string;
  destaque?: boolean;
  alerta?: boolean;
}): ReactNode {
  return (
    <span className={`rec-contador ${destaque ? 'destaque' : ''} ${alerta ? 'alerta' : ''}`}>
      <strong>{valor}</strong>
      <span>{rotulo}</span>
    </span>
  );
}

/* ==================================================================== */

/**
 * A confirmação depois da entrada.
 *
 * SOME SOZINHA. É informação de um segundo — "entrou, era este mesmo" —
 * e um aviso que exige clique para fechar vira lixo na tela do balcão,
 * onde passam cem pessoas por dia.
 */
function Confirmacao({
  aviso,
  aoFechar,
}: {
  aviso: { nome: string; situacao: api.SituacaoNaPorta };
  aoFechar: () => void;
}): ReactNode {
  useEffect(() => {
    const t = setTimeout(aoFechar, 4000);
    return () => clearTimeout(t);
  }, [aviso, aoFechar]);

  /* VERMELHO NÃO ENTRA AQUI. A entrada foi registrada — deu certo. Um
     aviso vermelho depois de uma ação bem-sucedida se lê como falha, e a
     recepcionista tenta de novo. O que a pendência merece é âmbar: "deu
     certo, e repare nisto". */
  return (
    <p
      className={`rec-confirmado ${aviso.situacao === 'EM_DIA' ? 'ok' : 'atencao'}`}
      role="status"
    >
      <strong>{aviso.nome}</strong> entrou
      {aviso.situacao !== 'EM_DIA' && <span> · {ROTULO[aviso.situacao]}</span>}
    </p>
  );
}

/* ==================================================================== */

function Cartao({
  aluno,
  aoEntrar,
  aoVoltar,
}: {
  aluno: api.AlunoNaPorta;
  aoEntrar: (liberadoComAviso: boolean, observacao: string | null) => void;
  aoVoltar: (() => void) | null;
}): ReactNode {
  const [foto, setFoto] = useState<string | null>(null);
  const [observacao, setObservacao] = useState('');

  /* A foto vem por `fetch` e não por `<img src>`: a rota exige o Bearer
     token, que a tag não tem como mandar. O blob é revogado ao trocar de
     aluno — sem isso o balcão vaza memória a cada pessoa que passa. */
  useEffect(() => {
    setObservacao('');
    if (!aluno.temFoto) {
      setFoto(null);
      return;
    }
    let vivo = true;
    let atual: string | null = null;
    void api.baixarFotoDoAluno(aluno.id).then((url) => {
      if (!vivo) {
        if (url !== null) URL.revokeObjectURL(url);
        return;
      }
      atual = url;
      setFoto(url);
    });
    return () => {
      vivo = false;
      if (atual !== null) URL.revokeObjectURL(atual);
      setFoto(null);
    };
  }, [aluno.id, aluno.temFoto]);

  return (
    <article className={`rec-cartao ${TOM[aluno.situacao]}`}>
      <div className="rec-cartao-topo">
        {foto === null ? (
          <span className="rec-retrato vazio" aria-hidden="true">
            {aluno.nome.trim().charAt(0).toUpperCase()}
          </span>
        ) : (
          <img className="rec-retrato" src={foto} alt={`Foto de ${aluno.nome}`} />
        )}
        <div className="rec-identidade">
          <h2>{aluno.nome}</h2>
          <span className="rec-codigo">
            {aluno.codigo === null ? 'sem número de carteirinha' : `Nº ${aluno.codigo}`}
          </span>
          <span className={`pilula ${TOM[aluno.situacao]}`}>{ROTULO[aluno.situacao]}</span>
        </div>
      </div>

      {aluno.situacao === 'DEVENDO' && (
        <p className="rec-pendencia">
          <strong>{aluno.devendoFormatado}</strong> em aberto ·{' '}
          {aluno.cobrancasVencidas === 1
            ? '1 cobrança vencida'
            : `${aluno.cobrancasVencidas} cobranças vencidas`}
          {aluno.diasDeAtraso > 0 && ` · ${aluno.diasDeAtraso} dias de atraso`}
        </p>
      )}

      {aluno.situacao === 'SEM_CONTRATO' && (
        <p className="rec-pendencia">Sem plano ativo. Vale conferir o cadastro antes de liberar.</p>
      )}

      {aluno.dentro ? (
        <p className="rec-ja-dentro">
          Já está registrado dentro da academia. A saída é registrada na coluna ao lado.
        </p>
      ) : aluno.precisaLiberar ? (
        <div className="rec-liberacao">
          <p>
            Esta entrada precisa da sua liberação. Ela fica registrada com o seu nome e a hora.
          </p>
          <label className="campo">
            <span>Por quê? (opcional)</span>
            <input
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="Combinou de pagar sexta"
              maxLength={300}
            />
          </label>
          <button
            type="button"
            className="botao-acao perigo"
            onClick={() => aoEntrar(true, observacao.trim() === '' ? null : observacao.trim())}
          >
            Liberar e registrar entrada
          </button>
        </div>
      ) : (
        <button type="button" className="botao-acao grande" onClick={() => aoEntrar(false, null)}>
          Registrar entrada
        </button>
      )}

      {aoVoltar !== null && (
        <button type="button" className="botao-secundario" onClick={aoVoltar}>
          Não é este
        </button>
      )}
    </article>
  );
}

/** "14:07" no fuso de quem está olhando — que aqui é quem está no balcão. */
function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
