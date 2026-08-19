import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MeuProntuario } from './MeuProntuario.jsx';
import {
  ApiError,
  agendar,
  desmarcar,
  meuPerfil,
  meuTreino,
  minhaAgenda,
  sair,
  vagas,
  type MeuHorario,
  type MeuItemTreino,
  type MeuPerfil,
  type MeuTreino,
  type VagaProfissional,
} from './api.js';
import { Marca } from './Marca.jsx';

/**
 * O aplicativo do aluno.
 *
 * NÃO É O SISTEMA ENCOLHIDO. São dois produtos com públicos e posturas
 * diferentes, e tratá-los como um só produziria o pior dos dois:
 *
 *   O SISTEMA é usado sentado, com mouse, por quem trabalha nele o dia
 *   inteiro. Densidade é qualidade: quanto mais cabe na tela, menos
 *   cliques.
 *
 *   O APLICATIVO é usado EM PÉ, com uma mão, entre uma série e outra,
 *   com o polegar suado. Densidade é defeito. Cada tela responde UMA
 *   pergunta, o alvo mínimo é 44px e a navegação fica embaixo — onde o
 *   polegar chega sem trocar a mão de posição.
 *
 * O QUE FAZ PARECER APLICATIVO, e não site aberto no celular:
 *
 *   · navegação embaixo, não em cima;
 *   · `env(safe-area-inset-*)`, para não ficar sob o notch nem sob a
 *     barra de gestos;
 *   · resposta ao TOQUE (escala + vibração), não ao hover — celular não
 *     tem hover, e efeito de hover em toque fica "grudado" depois do
 *     clique;
 *   · rolagem com `overscroll-behavior: contain`, para o gesto não
 *     puxar a página inteira;
 *   · nada de spinner: esqueleto com a forma do conteúdo.
 *
 * E O QUE NENHUM SITE FAZ: o MODO SESSÃO segura a tela acesa (Wake Lock)
 * e vibra ao fim do descanso. É o que separa "abri o site da academia"
 * de "estou treinando com o aplicativo na mão".
 */

type Aba = 'hoje' | 'treino' | 'agenda' | 'eu';

export function Aplicativo({ nome, aoSair }: { nome: string; aoSair: () => void }): ReactNode {
  const [aba, setAba] = useState<Aba>('hoje');
  const [perfil, setPerfil] = useState<MeuPerfil | null>(null);
  const [treino, setTreino] = useState<MeuTreino | null>(null);
  const [horarios, setHorarios] = useState<MeuHorario[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [emSessao, setEmSessao] = useState<{ dia: string } | null>(null);

  const carregar = useCallback(async (comEsqueleto = true): Promise<void> => {
    if (comEsqueleto) setCarregando(true);
    try {
      const p = await meuPerfil();
      const t = await meuTreino();
      const a = await minhaAgenda();
      setPerfil(p.data);
      setTreino(t.data);
      setHorarios(a.data);
      setErro(null);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar seus dados.');
    } finally {
      if (comEsqueleto) setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (emSessao !== null && treino !== null) {
    return (
      <ModoSessao
        treino={treino}
        dia={emSessao.dia}
        aoSair={() => setEmSessao(null)}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-topo">
        <Marca variante="horizontal" altura={30} decorativa />
        <button type="button" className="app-sair" onClick={() => void sair().then(aoSair)}>
          sair
        </button>
      </header>

      <main className="app-conteudo">
        {erro !== null && (
          <p className="app-erro" role="alert">
            {erro}
          </p>
        )}

        {carregando ? (
          <Esqueleto />
        ) : aba === 'hoje' ? (
          <Hoje
            nome={nome}
            perfil={perfil}
            treino={treino}
            horarios={horarios}
            aoTreinar={(dia) => setEmSessao({ dia })}
            aoIrParaAgenda={() => setAba('agenda')}
          />
        ) : aba === 'eu' ? (
          <MeuProntuario />
        ) : aba === 'treino' ? (
          <TelaTreino treino={treino} aoTreinar={(dia) => setEmSessao({ dia })} />
        ) : (
          <TelaAgenda
            horarios={horarios}
            mensalista={perfil?.mensalista ?? true}
            aoMudar={() => void carregar(false)}
          />
        )}
      </main>

      {/* A navegação fica EMBAIXO: é onde o polegar alcança sem
          reposicionar a mão. Barra de topo em celular é herança de
          desktop e obriga a esticar o dedo a cada troca de tela. */}
      <nav className="app-barra" aria-label="Seções">
        {(
          [
            ['hoje', 'Hoje', 'M3 10.5 12 3l9 7.5V21H3z'],
            ['treino', 'Treino', 'M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11'],
            ['agenda', 'Agenda', 'M4 5h16v16H4zM4 9h16M9 3v4M15 3v4'],
            /* "Eu" e não "Perfil": é a carteirinha, a anamnese e os
               exames — o que é DELE, não uma tela de configuração. */
            ['eu', 'Eu', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0'],
          ] as const
        ).map(([id, rotulo, desenho]) => (
          <button
            key={id}
            type="button"
            className={`app-aba ${aba === id ? 'ativa' : ''}`}
            aria-current={aba === id ? 'page' : undefined}
            onClick={() => {
              tocar();
              setAba(id);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={desenho} fill="none" stroke="currentColor" strokeWidth="1.7"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {rotulo}
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ====================================================================
 * Hoje
 * ================================================================== */

function Hoje({
  nome,
  perfil,
  treino,
  horarios,
  aoTreinar,
  aoIrParaAgenda,
}: {
  nome: string;
  perfil: MeuPerfil | null;
  treino: MeuTreino | null;
  horarios: MeuHorario[];
  aoTreinar: (dia: string) => void;
  aoIrParaAgenda: () => void;
}): ReactNode {
  const proximo = useMemo(
    () =>
      horarios
        .filter((h) => new Date(h.inicio) > new Date() && h.status !== 'CANCELLED')
        .sort((a, b) => a.inicio.localeCompare(b.inicio))[0] ?? null,
    [horarios],
  );

  const dias = treino === null ? [] : [...new Set(treino.itens.map((i) => i.dia))];

  const presencas = perfil?.frequencia.presencas ?? 0;
  const faltas = perfil?.frequencia.faltas ?? 0;
  const total = presencas + faltas;
  const taxa = total === 0 ? 0 : presencas / total;

  return (
    <>
      <h1 className="app-saudacao">
        {saudacao()},<br />
        <strong>{nome.split(' ')[0]}</strong>
      </h1>

      {proximo !== null && <CartaoProximo horario={proximo} />}

      {proximo === null && (
        <button type="button" className="app-cartao app-cartao-vazio" onClick={aoIrParaAgenda}>
          <span className="app-cartao-rotulo">Sem horário marcado</span>
          <strong>Marcar um treino →</strong>
        </button>
      )}

      <section className="app-secao">
        <h2>Sua constância</h2>
        <div className="app-constancia">
          <Anel valor={taxa} />
          <div className="app-constancia-numeros">
            <div>
              <strong className="tabular">{presencas}</strong>
              <span>presenças</span>
            </div>
            <div>
              <strong className="tabular">{faltas}</strong>
              <span>faltas</span>
            </div>
          </div>
        </div>
      </section>

      {treino !== null && dias.length > 0 && (
        <section className="app-secao">
          <h2>Treinar agora</h2>
          <div className="app-dias">
            {dias.map((d) => (
              <button
                key={d}
                type="button"
                className="app-dia"
                onClick={() => {
                  tocar();
                  aoTreinar(d);
                }}
              >
                <span className="app-dia-nome">{d}</span>
                <span className="app-dia-qtd">
                  {treino.itens.filter((i) => i.dia === d).length} exercícios
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Cartão do próximo horário, com contagem regressiva ao vivo. */
function CartaoProximo({ horario }: { horario: MeuHorario }): ReactNode {
  const [agora, setAgora] = useState(() => Date.now());

  useEffect(() => {
    /* Um relógio parado num cartão que diz "faltam 2 horas" envelhece
       na tela enquanto a pessoa olha. Um tique por minuto basta e não
       gasta bateria. */
    const t = setInterval(() => setAgora(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const inicio = new Date(horario.inicio);
  const faltam = inicio.getTime() - agora;
  const horas = Math.floor(faltam / 3_600_000);
  const minutos = Math.floor((faltam % 3_600_000) / 60_000);

  return (
    <article className="app-cartao app-cartao-proximo">
      <span className="app-cartao-rotulo">Seu próximo treino</span>
      <strong className="app-cartao-quando">
        {primeiraMaiuscula(
          inicio.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }),
        )}
      </strong>
      <span className="app-cartao-hora tabular">
        {inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
      </span>
      <span className="app-cartao-com">com {horario.profissional}</span>
      <span className="app-contagem">
        {faltam <= 0
          ? 'começando agora'
          : horas >= 24
            ? `em ${Math.floor(horas / 24)} dia${horas >= 48 ? 's' : ''}`
            : horas >= 1
              ? `em ${horas}h${String(minutos).padStart(2, '0')}`
              : `em ${minutos} min`}
      </span>
    </article>
  );
}

/**
 * Só a PRIMEIRA letra da frase, e não a de cada palavra.
 *
 * O `text-transform: capitalize` do CSS fazia "sexta-feira, 21 de agosto"
 * virar "Sexta-Feira, 21 De Agosto" — que é maiusculização de inglês. Em
 * português, dia da semana, mês e preposição são minúsculos; o hífen de
 * "sexta-feira" ainda começa uma "palavra" nova para o CSS, o que dá o
 * "Feira" no meio. Não há como corrigir isso com regra de estilo.
 */
const primeiraMaiuscula = (texto: string): string =>
  texto.charAt(0).toUpperCase() + texto.slice(1);

/** Anel de constância. SVG puro: sem biblioteca de gráfico para um anel. */
function Anel({ valor }: { valor: number }): ReactNode {
  const raio = 46;
  const volta = 2 * Math.PI * raio;
  const pct = Math.round(valor * 100);

  return (
    <svg className="app-anel" viewBox="0 0 110 110" role="img" aria-label={`${pct}% de presença`}>
      <circle cx="55" cy="55" r={raio} className="app-anel-trilho" />
      <circle
        cx="55"
        cy="55"
        r={raio}
        className="app-anel-valor"
        style={{ strokeDasharray: volta, strokeDashoffset: volta * (1 - valor) }}
      />
      <text x="55" y="61" className="app-anel-texto">
        {pct}%
      </text>
    </svg>
  );
}

/* ====================================================================
 * Treino
 * ================================================================== */

function TelaTreino({
  treino,
  aoTreinar,
}: {
  treino: MeuTreino | null;
  aoTreinar: (dia: string) => void;
}): ReactNode {
  const dias = treino === null ? [] : [...new Set(treino.itens.map((i) => i.dia))];
  const [dia, setDia] = useState<string | null>(null);
  const atual = dia ?? dias[0] ?? null;

  if (treino === null) {
    return (
      <div className="app-vazio">
        <p className="app-vazio-titulo">Você ainda não tem treino.</p>
        <p>Seu profissional monta a prescrição e ela aparece aqui.</p>
      </div>
    );
  }

  return (
    <>
      <h1 className="app-titulo">{treino.nome}</h1>
      {treino.objetivo !== null && <p className="app-subtitulo">{treino.objetivo}</p>}

      {/* Faixa de dias que ROLA na horizontal com encaixe. Empilhar
          verticalmente comeria a tela antes do primeiro exercício. */}
      <div className="app-chips">
        {dias.map((d) => (
          <button
            key={d}
            type="button"
            className={`app-chip ${atual === d ? 'ativo' : ''}`}
            onClick={() => {
              tocar();
              setDia(d);
            }}
          >
            {d}
          </button>
        ))}
      </div>

      <ol className="app-exercicios">
        {treino.itens
          .filter((i) => i.dia === atual)
          .map((i, idx) => (
            <li key={`${i.exercicio}-${idx}`} className="app-exercicio">
              <div>
                <strong>{i.exercicio}</strong>
                {i.equipamento !== null && <span>{i.equipamento}</span>}
              </div>
              <span className="app-prescricao tabular">{prescricao(i)}</span>
            </li>
          ))}
      </ol>

      {atual !== null && (
        <button
          type="button"
          className="app-botao-grande"
          onClick={() => {
            tocar();
            aoTreinar(atual);
          }}
        >
          Iniciar {atual}
        </button>
      )}

      {treino.observacoes !== null && <p className="app-nota">{treino.observacoes}</p>}
    </>
  );
}

/**
 * Carga em gramas → o número que se lê na anilha.
 *
 * `toFixed(1)` escrevia "55.0 kg": ponto onde o Brasil usa vírgula, e uma
 * casa decimal inventada num número que é inteiro. As anilhas existem de
 * 2,5 em 2,5 kg, então "52,5" precisa aparecer inteiro — mas "55" não
 * pode virar "55,0". `maximumFractionDigits` dá as duas coisas.
 */
const kg = (gramas: number): string =>
  (gramas / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

const prescricao = (i: MeuItemTreino): string =>
  [i.series === null ? null : `${i.series}×`, i.repeticoes, i.cargaG === null ? null : `${kg(i.cargaG)} kg`]
    .filter((x) => x !== null && x !== '')
    .join(' · ');

/* ====================================================================
 * Modo sessão — a tela que só um aplicativo tem
 * ================================================================== */

function ModoSessao({
  treino,
  dia,
  aoSair,
}: {
  treino: MeuTreino;
  dia: string;
  aoSair: () => void;
}): ReactNode {
  const itens = useMemo(() => treino.itens.filter((i) => i.dia === dia), [treino, dia]);
  const [indice, setIndice] = useState(0);
  const [serie, setSerie] = useState(1);
  const [descanso, setDescanso] = useState<number | null>(null);
  const bloqueio = useRef<WakeLockSentinel | null>(null);

  const item = itens[indice];
  const totalSeries = item?.series ?? 1;

  /* TELA ACESA DURANTE O TREINO.
     Sem isto o celular apaga entre as séries e a pessoa desbloqueia a
     cada exercício, com a mão suada. É a diferença mais concreta entre
     um site aberto no celular e um aplicativo. Nem todo navegador
     suporta — e por isso a falha é silenciosa: sem Wake Lock o app
     continua funcionando, só apaga a tela. */
  useEffect(() => {
    let cancelado = false;
    const pedir = async (): Promise<void> => {
      try {
        const wl = await navigator.wakeLock?.request('screen');
        if (cancelado) void wl?.release();
        else bloqueio.current = wl ?? null;
      } catch {
        /* Recusado ou indisponível: seguimos sem. */
      }
    };
    void pedir();

    /* Voltar de segundo plano perde o bloqueio; é preciso pedir de novo,
       senão a tela apaga depois da primeira troca de aplicativo. */
    const aoVoltar = (): void => {
      if (document.visibilityState === 'visible') void pedir();
    };
    document.addEventListener('visibilitychange', aoVoltar);

    return () => {
      cancelado = true;
      document.removeEventListener('visibilitychange', aoVoltar);
      void bloqueio.current?.release();
      bloqueio.current = null;
    };
  }, []);

  /* Contagem do descanso. */
  useEffect(() => {
    if (descanso === null) return;
    if (descanso <= 0) {
      /* Vibração ao terminar: a pessoa está olhando para o outro lado da
         sala, não para a tela. É o aviso que faz o timer ser útil. */
      navigator.vibrate?.([120, 60, 120]);
      setDescanso(null);
      return;
    }
    const t = setTimeout(() => setDescanso((d) => (d === null ? null : d - 1)), 1000);
    return () => clearTimeout(t);
  }, [descanso]);

  if (item === undefined) {
    return (
      <div className="sessao sessao-fim">
        <h1>Treino concluído</h1>
        <p>{itens.length} exercícios de {dia}.</p>
        <button type="button" className="app-botao-grande" onClick={aoSair}>
          Voltar
        </button>
      </div>
    );
  }

  const avancarSerie = (): void => {
    tocar();
    if (serie < totalSeries) {
      setSerie(serie + 1);
      setDescanso(item.descansoSegundos ?? 60);
    } else {
      setIndice(indice + 1);
      setSerie(1);
      setDescanso(item.descansoSegundos ?? 60);
    }
  };

  const progresso = (indice + (serie - 1) / totalSeries) / itens.length;

  return (
    <div className="sessao">
      <header className="sessao-topo">
        <button type="button" className="sessao-fechar" onClick={aoSair} aria-label="Sair do treino">
          ✕
        </button>
        <span className="sessao-dia">{dia}</span>
        <span className="sessao-contador tabular">
          {indice + 1}/{itens.length}
        </span>
      </header>

      {/* Barra de progresso da sessão inteira: dá noção de quanto falta,
          que é a primeira coisa que se quer saber na quarta série. */}
      <div className="sessao-progresso" aria-hidden="true">
        <span style={{ width: `${Math.min(progresso * 100, 100)}%` }} />
      </div>

      {descanso !== null ? (
        <div className="sessao-descanso">
          <span className="sessao-descanso-rotulo">Descanso</span>
          <strong className="sessao-relogio tabular">
            {String(Math.floor(descanso / 60)).padStart(2, '0')}:
            {String(descanso % 60).padStart(2, '0')}
          </strong>
          <button type="button" className="app-botao-grande" onClick={() => setDescanso(null)}>
            Pular descanso
          </button>
        </div>
      ) : (
        <div className="sessao-corpo">
          <h1 className="sessao-exercicio">{item.exercicio}</h1>
          {item.equipamento !== null && <p className="sessao-equipamento">{item.equipamento}</p>}

          <div className="sessao-numeros">
            <div>
              <strong className="tabular">{serie}</strong>
              <span>de {totalSeries} séries</span>
            </div>
            {item.repeticoes !== null && (
              <div>
                <strong className="tabular">{item.repeticoes}</strong>
                <span>repetições</span>
              </div>
            )}
            {item.cargaG !== null && (
              <div>
                <strong className="tabular">{kg(item.cargaG)}</strong>
                <span>kg</span>
              </div>
            )}
          </div>

          <button type="button" className="sessao-concluir" onClick={avancarSerie}>
            {serie < totalSeries ? 'Série feita' : 'Exercício concluído'}
          </button>

          {indice > 0 && (
            <button
              type="button"
              className="sessao-voltar"
              onClick={() => {
                setIndice(indice - 1);
                setSerie(1);
              }}
            >
              ← exercício anterior
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ====================================================================
 * Agenda
 * ================================================================== */

function TelaAgenda({
  horarios,
  mensalista,
  aoMudar,
}: {
  horarios: MeuHorario[];
  mensalista: boolean;
  aoMudar: () => void;
}): ReactNode {
  const [dia, setDia] = useState(0);
  const [opcoes, setOpcoes] = useState<VagaProfissional[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [marcando, setMarcando] = useState<string | null>(null);

  const proximosDias = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    return Array.from({ length: 14 }, (_, i) => new Date(base.getTime() + i * 86_400_000));
  }, []);

  useEffect(() => {
    const alvo = proximosDias[dia];
    if (alvo === undefined) return;
    let cancelado = false;
    setBuscando(true);
    void (async () => {
      try {
        const fim = new Date(alvo.getTime() + 86_400_000);
        const r = await vagas(alvo, fim);
        if (!cancelado) setOpcoes(r.data);
      } catch (e) {
        if (!cancelado) setErro(e instanceof ApiError ? e.message : 'Não foi possível buscar.');
      } finally {
        if (!cancelado) setBuscando(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [dia, proximosDias]);

  const marcar = async (profissionalId: string, inicio: string, fim: string): Promise<void> => {
    setMarcando(inicio);
    setErro(null);
    try {
      await agendar({ profissionalId, inicio, fim });
      navigator.vibrate?.(40);
      aoMudar();
      setOpcoes([]);
      setDia((d) => d);
      const alvo = proximosDias[dia]!;
      const r = await vagas(alvo, new Date(alvo.getTime() + 86_400_000));
      setOpcoes(r.data);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível marcar.');
    } finally {
      setMarcando(null);
    }
  };

  const futuros = horarios
    .filter((h) => new Date(h.inicio) > new Date() && h.status !== 'CANCELLED')
    .sort((a, b) => a.inicio.localeCompare(b.inicio));

  return (
    <>
      <h1 className="app-titulo">Marcar treino</h1>

      {erro !== null && (
        <p className="app-erro" role="alert">
          {erro}
        </p>
      )}

      {/* Faixa de dias com encaixe: o gesto é o mesmo de qualquer app de
          agendamento, e o dia escolhido para no lugar. */}
      <div className="app-faixa-dias">
        {proximosDias.map((d, i) => (
          <button
            key={i}
            type="button"
            className={`app-dia-chip ${dia === i ? 'ativo' : ''}`}
            onClick={() => {
              tocar();
              setDia(i);
            }}
          >
            <span className="app-dia-semana">
              {d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}
            </span>
            <strong className="tabular">{d.getDate()}</strong>
          </button>
        ))}
      </div>

      {buscando ? (
        <div className="app-esqueleto-linhas">
          <span /> <span /> <span />
        </div>
      ) : opcoes.length === 0 ? (
        <p className="app-nota">Nenhum horário livre neste dia.</p>
      ) : (
        opcoes.map((o) => (
          <section key={o.profissional.id} className="app-secao">
            <h2>{o.profissional.nome}</h2>
            <div className="app-horarios">
              {o.horarios.map((h) => (
                <button
                  key={h.inicio}
                  type="button"
                  className="app-horario"
                  disabled={marcando !== null}
                  onClick={() => void marcar(o.profissional.id, h.inicio, h.fim)}
                >
                  {marcando === h.inicio
                    ? '…'
                    : new Date(h.inicio).toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      {/* O aviso de preço aparece UMA vez, e só para quem paga por
          sessão. Mostrar valor para mensalista gera a ligação mais
          constrangedora que uma recepção recebe. */}
      {!mensalista && (
        <p className="app-nota">O valor da sessão é cobrado conforme seu plano.</p>
      )}

      {futuros.length > 0 && (
        <section className="app-secao">
          <h2>Seus horários</h2>
          {futuros.map((h) => (
            <article key={h.id} className="app-marcado">
              <div>
                <strong>
                  {/* Sem o ponto de "sex.": a faixa de dias logo acima
                      escreve DOM, SEG, TER, e duas abreviações
                      diferentes na mesma tela parecem descuido. */}
                  {new Date(h.inicio)
                    .toLocaleDateString('pt-BR', {
                      weekday: 'short',
                      day: '2-digit',
                      month: '2-digit',
                    })
                    .replace('.', '')}
                  {' · '}
                  {new Date(h.inicio).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </strong>
                <span>
                  {h.profissional}
                  {h.precoCentavos !== null &&
                    ` · ${(h.precoCentavos / 100).toLocaleString('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    })}`}
                </span>
              </div>
              {h.podeCancelar && (
                <button
                  type="button"
                  className="app-desmarcar"
                  onClick={() => {
                    void desmarcar(h.id)
                      .then(() => {
                        navigator.vibrate?.(30);
                        aoMudar();
                      })
                      .catch((e: unknown) =>
                        setErro(e instanceof ApiError ? e.message : 'Não foi possível desmarcar.'),
                      );
                  }}
                >
                  desmarcar
                </button>
              )}
            </article>
          ))}
        </section>
      )}
    </>
  );
}

/* ==================================================================== */

/** Esqueleto com a forma do conteúdo — nunca um spinner girando. */
function Esqueleto(): ReactNode {
  return (
    <div className="app-esqueleto" aria-hidden="true">
      <span style={{ width: '55%', height: 30 }} />
      <span style={{ width: '100%', height: 120 }} />
      <span style={{ width: '40%', height: 18 }} />
      <span style={{ width: '100%', height: 90 }} />
    </div>
  );
}

function saudacao(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Boa madrugada';
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** Vibração curta ao tocar. Ignorada em quem não suporta. */
function tocar(): void {
  navigator.vibrate?.(8);
}
