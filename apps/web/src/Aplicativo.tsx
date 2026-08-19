import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MeuProntuario } from './MeuProntuario.jsx';
import * as api from './api.js';
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
  const [diario, setDiario] = useState<api.MeuDiario | null>(null);

  const carregar = useCallback(async (comEsqueleto = true): Promise<void> => {
    if (comEsqueleto) setCarregando(true);
    try {
      const p = await meuPerfil();
      const t = await meuTreino();
      const a = await minhaAgenda();
      setPerfil(p.data);
      setTreino(t.data);
      setHorarios(a.data);
      /* O DIÁRIO NÃO PODE DERRUBAR A TELA. É informação de apoio: se a
         chamada falhar, o aluno ainda precisa ver o treino de hoje. */
      setDiario(await api.buscarMeuDiario().then((r) => r.data).catch(() => null));
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
        jaFeitoHoje={diario?.feitosHoje.includes(emSessao.dia) ?? false}
        aoSair={() => {
          setEmSessao(null);
          void carregar(false);
        }}
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
            diario={diario}
            aoTreinar={(dia) => setEmSessao({ dia })}
            aoIrParaAgenda={() => setAba('agenda')}
          />
        ) : aba === 'eu' ? (
          <MeuProntuario />
        ) : aba === 'treino' ? (
          <TelaTreino
            treino={treino}
            diario={diario}
            aoTreinar={(dia) => setEmSessao({ dia })}
            aoMudar={() => void carregar(false)}
          />
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
  diario,
  aoTreinar,
  aoIrParaAgenda,
}: {
  nome: string;
  perfil: MeuPerfil | null;
  treino: MeuTreino | null;
  horarios: MeuHorario[];
  diario: api.MeuDiario | null;
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
  /* ENTRADAS NA RECEPÇÃO CONTAM. Quem faz musculação não tem agendamento
     nenhum, e o anel dizia 0% para quem treinava toda semana. */
  const entradas = perfil?.frequencia.entradas ?? 0;
  const feitos = diario?.total ?? 0;

  return (
    <>
      <h1 className="app-saudacao">
        {saudacao()},<br />
        <strong>{nome.split(' ')[0]}</strong>
      </h1>

      {/* A PENDÊNCIA VEM ANTES DE TUDO, e é a primeira coisa da tela
          quando existe. Descobrir a dívida no balcão, na frente de
          outras pessoas, é constrangimento evitável — e quem vê no
          celular de casa costuma resolver antes de sair. */}
      {perfil !== null && perfil.devendoCentavos > 0 && (
        <div className="app-pendencia" role="status">
          <span className="app-pendencia-rotulo">Em aberto</span>
          <strong>{perfil.devendoFormatado}</strong>
          <span className="app-pendencia-nota">Fale com a recepção para acertar.</span>
        </div>
      )}

      {proximo !== null && <CartaoProximo horario={proximo} />}

      {proximo === null && (
        <button type="button" className="app-cartao app-cartao-vazio" onClick={aoIrParaAgenda}>
          <span className="app-cartao-rotulo">Sem horário marcado</span>
          <strong>Marcar um treino →</strong>
        </button>
      )}

      {/* A SEQUÊNCIA É O NÚMERO QUE FAZ VOLTAR AMANHÃ, e por isso fica
          acima da constância — que é retrospectiva. Contada em SEMANAS e
          não em dias: ninguém treina sete dias por semana, e uma
          sequência de dias corridos quebraria todo domingo. */}
      {diario !== null && diario.sequenciaDeSemanas > 0 && (
        <div className="app-sequencia">
          <strong className="tabular">{diario.sequenciaDeSemanas}</strong>
          <span>
            {diario.sequenciaDeSemanas === 1
              ? 'semana treinando'
              : 'semanas seguidas treinando'}
          </span>
          {diario.noMes > 0 && (
            <span className="app-sequencia-mes">
              {diario.noMes === 1 ? '1 treino este mês' : `${diario.noMes} treinos este mês`}
            </span>
          )}
        </div>
      )}

      <section className="app-secao">
        <h2>Sua constância</h2>
        <div className="app-constancia">
          <Anel valor={taxa} />
          <div className="app-constancia-numeros">
            <div>
              <strong className="tabular">{presencas + entradas}</strong>
              <span>presenças</span>
            </div>
            <div>
              <strong className="tabular">{feitos}</strong>
              <span>treinos marcados</span>
            </div>
          </div>
        </div>
      </section>

      {treino !== null && dias.length > 0 && (
        <section className="app-secao">
          <h2>Treinar agora</h2>
          <div className="app-dias">
            {dias.map((d) => {
              const feitoHoje = diario?.feitosHoje.includes(d) ?? false;
              return (
                <button
                  key={d}
                  type="button"
                  className={`app-dia ${feitoHoje ? 'feito' : ''}`}
                  onClick={() => {
                    tocar();
                    aoTreinar(d);
                  }}
                >
                  <span className="app-dia-nome">{d}</span>
                  <span className="app-dia-qtd">
                    {/* O QUE JÁ FOI FEITO HOJE DIZ ISSO, e não a
                        contagem de exercícios: quem já treinou o A não
                        precisa saber quantos exercícios ele tem. */}
                    {feitoHoje
                      ? '✓ feito hoje'
                      : `${treino.itens.filter((i) => i.dia === d).length} exercícios`}
                  </span>
                </button>
              );
            })}
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
  diario,
  aoTreinar,
  aoMudar,
}: {
  treino: MeuTreino | null;
  diario: api.MeuDiario | null;
  aoTreinar: (dia: string) => void;
  aoMudar: () => void;
}): ReactNode {
  const dias = treino === null ? [] : [...new Set(treino.itens.map((i) => i.dia))];
  const [dia, setDia] = useState<string | null>(null);
  const atual = dia ?? dias[0] ?? null;
  const feitoHoje = atual !== null && (diario?.feitosHoje.includes(atual) ?? false);

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

      {/* QUEM TREINOU SEM ABRIR O MODO SESSÃO TAMBÉM PRECISA MARCAR.
          O caminho principal registra sozinho no fim da sessão guiada,
          mas metade das pessoas treina com o papel na mão e o celular no
          bolso — negar a elas o registro seria dizer que só conta o
          treino feito do jeito do aplicativo. */}
      {atual !== null && !feitoHoje && <MarcarSemSessao dia={atual} aoMarcar={aoMudar} />}

      {atual !== null && feitoHoje && (
        <p className="app-feito-hoje">✓ Você já marcou o {atual} hoje.</p>
      )}

      {diario !== null && diario.registros.length > 0 && (
        <Historico registros={diario.registros} aoMudar={aoMudar} />
      )}

      {treino.observacoes !== null && <p className="app-nota">{treino.observacoes}</p>}
    </>
  );
}

/* ==================================================================== */

/**
 * Marcar sem passar pelo modo sessão.
 *
 * FICA DISCRETO DE PROPÓSITO. O caminho que o aplicativo quer é o modo
 * sessão, que já registra no fim; este é a saída para quem treinou de
 * outro jeito. Se os dois tivessem o mesmo peso visual, ninguém usaria o
 * primeiro — e o modo sessão é o que traz o esforço percebido, que é o
 * dado mais útil para o professor.
 */
function MarcarSemSessao({ dia, aoMarcar }: { dia: string; aoMarcar: () => void }): ReactNode {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const marcar = async (): Promise<void> => {
    setErro(null);
    setEnviando(true);
    try {
      await api.marcarTreinoFeito(dia);
      aoMarcar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível marcar.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="app-botao-fraco app-marcar"
        disabled={enviando}
        onClick={() => void marcar()}
      >
        {enviando ? 'Marcando…' : `Já fiz o ${dia} hoje, marcar sem abrir`}
      </button>
      {erro !== null && <p className="app-erro-linha">{erro}</p>}
    </>
  );
}

/**
 * O histórico do diário.
 *
 * DESFAZER EXISTE PORQUE O TOQUE ERRADO EXISTE. Sem ele, quem marcou o B
 * quando fez o A fica com o histórico errado para sempre — e a reação
 * seguinte é parar de marcar.
 */
function Historico({
  registros,
  aoMudar,
}: {
  registros: api.TreinoFeito[];
  aoMudar: () => void;
}): ReactNode {
  const [aberto, setAberto] = useState(false);

  return (
    <section className="app-bloco app-diario">
      <button
        type="button"
        className="app-diario-topo"
        aria-expanded={aberto}
        onClick={() => setAberto(!aberto)}
      >
        <span>Meus treinos ({registros.length})</span>
        <span aria-hidden="true">{aberto ? '−' : '+'}</span>
      </button>

      {aberto && (
        <ul className="app-diario-lista">
          {registros.slice(0, 30).map((r) => (
            <li key={r.id}>
              <span className="app-diario-dia">{r.dia}</span>
              <span className="app-diario-data">{dataCurtaBr(r.quando)}</span>
              {r.esforco !== null && (
                <span className="app-diario-esforco">{'●'.repeat(r.esforco)}</span>
              )}
              <button
                type="button"
                className="app-diario-desfazer"
                aria-label={`Desmarcar ${r.dia} de ${dataCurtaBr(r.quando)}`}
                onClick={() => void api.desmarcarTreinoFeito(r.id).then(aoMudar).catch(() => undefined)}
              >
                desfazer
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "2026-08-19" → "19/08", sem passar por Date e sem deslocar fuso. */
function dataCurtaBr(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}`;
}

/* ==================================================================== */

/**
 * O fim do treino — e o único lugar onde vale a pena perguntar o esforço.
 *
 * AQUI É O MOMENTO CERTO E É O ÚNICO. A pessoa acabou de terminar, ainda
 * está com a sensação na cabeça, e o celular já está na mão. Perguntar
 * "como foi?" numa tela separada depois, ou num formulário no dia
 * seguinte, é perguntar para quem já esqueceu.
 *
 * CADA BOTÃO REGISTRA. Não existe "escolher e depois confirmar": são dois
 * toques onde um basta, e o segundo é onde as pessoas desistem. Quem não
 * quiser responder tem "pular", que registra o treino sem o esforço — o
 * que importa mais é o registro.
 *
 * O ESFORÇO VAI DE 1 A 5 porque é a escala que o banco declara desde o
 * começo, e porque cinco botões grandes cabem lado a lado num celular.
 * Dez não cabem, e alvo pequeno com a mão suada é resposta errada.
 */
function FimDaSessao({
  dia,
  quantos,
  jaFeitoHoje,
  aoSair,
}: {
  dia: string;
  quantos: number;
  jaFeitoHoje: boolean;
  aoSair: () => void;
}): ReactNode {
  const [estado, setEstado] = useState<'perguntando' | 'salvando' | 'salvo'>(
    /* Quem já tinha marcado este treino hoje não é perguntado de novo:
       o servidor recusaria com 409 e a pessoa veria um erro depois de
       ter feito tudo certo. */
    jaFeitoHoje ? 'salvo' : 'perguntando',
  );
  const [erro, setErro] = useState<string | null>(null);

  const registrar = async (esforco: number | null): Promise<void> => {
    setErro(null);
    setEstado('salvando');
    try {
      await api.marcarTreinoFeito(dia, esforco);
      setEstado('salvo');
      navigator.vibrate?.(60);
    } catch (e) {
      /* 409 aqui significa "já estava marcado" — que do ponto de vista
         de quem acabou de treinar é sucesso, e não erro. */
      if (e instanceof ApiError && e.status === 409) {
        setEstado('salvo');
        return;
      }
      setErro(e instanceof ApiError ? e.message : 'Não foi possível marcar.');
      setEstado('perguntando');
    }
  };

  return (
    <div className="sessao sessao-fim">
      <h1>Treino concluído</h1>
      <p>
        {quantos} {quantos === 1 ? 'exercício' : 'exercícios'} de {dia}.
      </p>

      {estado === 'salvo' ? (
        <p className="sessao-marcado">✓ Marcado no seu histórico.</p>
      ) : (
        <div className="sessao-esforco">
          <span className="sessao-esforco-titulo">Como foi?</span>
          <div className="sessao-esforco-botoes">
            {([1, 2, 3, 4, 5] as const).map((n) => (
              <button
                key={n}
                type="button"
                disabled={estado === 'salvando'}
                onClick={() => {
                  tocar();
                  void registrar(n);
                }}
              >
                <strong>{n}</strong>
                <span>{ROTULO_DO_ESFORCO[n]}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="app-botao-fraco"
            disabled={estado === 'salvando'}
            onClick={() => void registrar(null)}
          >
            Pular e só marcar
          </button>
        </div>
      )}

      {erro !== null && <p className="app-erro-linha">{erro}</p>}

      <button type="button" className="app-botao-grande" onClick={aoSair}>
        Voltar
      </button>
    </div>
  );
}

/* Palavras, e não só números: "4" sozinho não diz nada, e a pessoa
   escolhe o do meio por não saber o que os outros significam. */
const ROTULO_DO_ESFORCO: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'leve',
  2: 'tranquilo',
  3: 'certo',
  4: 'puxado',
  5: 'no limite',
};

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
  jaFeitoHoje,
  aoSair,
}: {
  treino: MeuTreino;
  dia: string;
  jaFeitoHoje: boolean;
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
    return <FimDaSessao dia={dia} quantos={itens.length} jaFeitoHoje={jaFeitoHoje} aoSair={aoSair} />;
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
