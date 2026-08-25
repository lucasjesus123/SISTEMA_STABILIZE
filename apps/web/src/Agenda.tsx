import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Erro } from './ui.jsx';
import { JanelaDeAtendimento } from './JanelaDeAtendimento.jsx';
import { Espacos } from './Espacos.jsx';
import { Horarios } from './Horarios.jsx';
import type { Principal } from './api.js';

/**
 * Agenda da academia — a semana inteira numa grade.
 *
 * POR QUE GRADE E NÃO LISTA. Uma lista responde "o que tem hoje". Quem
 * toca uma academia precisa da outra pergunta: *onde tem buraco*. Um
 * vazio só aparece como vazio quando o tempo ocupa espaço na tela — numa
 * lista, a quinta-feira sem ninguém e a quinta-feira lotada têm a mesma
 * altura, e o horário ocioso fica invisível justamente para quem
 * poderia vendê-lo.
 *
 * O CALENDÁRIO É DE TODOS, A CANETA É DE CADA UM. Todo profissional
 * enxerga a semana inteira, com o nome do aluno do colega; só o dono e
 * o administrador mexem no horário alheio. Isso NÃO é imposto por esta
 * tela — é o servidor que recusa, e a tela apenas evita oferecer o
 * botão que levaria a um 404. Se o `disabled` daqui sumisse, nada
 * mudaria do lado de lá.
 *
 * A COR É DO PROFISSIONAL, e é o que faz a grade ser lida de longe: com
 * quatro pessoas atendendo no mesmo salão, a pergunta "esse bloco é meu?"
 * precisa ser respondida antes de o olho chegar ao texto.
 */

const HORA_INICIAL = 6;
const HORA_FINAL = 22;
const MINUTOS_POR_LINHA = 30;
const LINHAS = ((HORA_FINAL - HORA_INICIAL) * 60) / MINUTOS_POR_LINHA;

const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** A paleta usada quando o profissional ainda não tem cor gravada. */
const CORES_RESERVA = ['#2e9aa1', '#b2593a', '#5b7fb2', '#8a6bb2', '#3f9e6b', '#b23a72'];

/** Segunda-feira da semana de `d`, à meia-noite local. */
function segundaDa(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const desloca = (s.getDay() + 6) % 7;
  s.setDate(s.getDate() - desloca);
  return s;
}

function mesmoDia(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

const HORA = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function Agenda({ principal }: { principal: Principal }): ReactNode {
  const [semana, setSemana] = useState(() => segundaDa(new Date()));
  /* SEMANA OU MÊS. A grade de horários responde "o que acontece na
     terça às 9h" — é a visão de quem opera o dia. Ela não responde
     "como está o mês", que é a pergunta de quem planeja: quantos dias
     têm gente, onde estão os buracos, quando dá para tirar folga. São
     duas leituras diferentes do mesmo dado, e nenhuma substitui a
     outra. */
  const [modo, setModo] = useState<'semana' | 'mes'>('semana');
  /* O MÊS TEM ÂNCORA PRÓPRIA, e não é derivado de `semana`. Derivá-lo
     custou um bug medido: `semana` é sempre uma SEGUNDA-FEIRA, e a
     segunda da semana do dia 1º de setembro cai em 31 de AGOSTO. O
     cabeçalho continuava dizendo "Agosto" depois de clicar em "próximo
     mês", e a grade não mudava. Duas perguntas diferentes, dois
     estados. */
  const [ancora, setAncora] = useState(() => new Date());
  const [compromissos, setCompromissos] = useState<api.CompromissoDetalhado[]>([]);
  const [equipe, setEquipe] = useState<api.Profissional[]>([]);
  const [salas, setSalas] = useState<api.Sala[]>([]);
  const [espacos, setEspacos] = useState(false);
  const [reservas, setReservas] = useState<api.Reserva[]>([]);
  const [filtroProf, setFiltroProf] = useState('');
  const [filtroSala, setFiltroSala] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [selecionado, setSelecionado] = useState<api.CompromissoDetalhado | null>(null);
  const [novo, setNovo] = useState<{ inicio: Date; fim: Date } | null>(null);
  const [horarios, setHorarios] = useState(false);
  const [versao, setVersao] = useState(0);

  const dias = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(semana);
        d.setDate(d.getDate() + i);
        return d;
      }),
    [semana],
  );

  /* O MÊS COMEÇA NA SEGUNDA DA SEMANA DO DIA 1 e vai até o domingo da
     semana do último dia — sempre semanas inteiras. Um mês que começa
     numa quinta e termina num sábado deixaria a primeira e a última
     linha da grade truncadas, e o olho lê isso como dado faltando. */
  const mes = useMemo(() => {
    const primeiro = new Date(ancora.getFullYear(), ancora.getMonth(), 1);
    const inicio = segundaDa(primeiro);
    const ultimo = new Date(ancora.getFullYear(), ancora.getMonth() + 1, 0);
    const fim = segundaDa(ultimo);
    fim.setDate(fim.getDate() + 7);
    const total = Math.round((fim.getTime() - inicio.getTime()) / (24 * 3_600_000));
    return {
      referencia: primeiro,
      inicio,
      fim,
      dias: Array.from({ length: total }, (_, i) => {
        const d = new Date(inicio);
        d.setDate(d.getDate() + i);
        return d;
      }),
    };
  }, [ancora]);

  const janela = modo === 'mes' ? { de: mes.inicio, ate: mes.fim } : null;

  useEffect(() => {
    api
      .buscarProfissionais()
      .then((r) => setEquipe(r.data))
      .catch(() => undefined);
    /* Salas podem não estar cadastradas ainda, e a agenda tem de
       funcionar sem elas: a academia que atende num salão só nunca vai
       criar uma. Por isso a falha aqui é silenciosa. */
    api
      .buscarSalas()
      .then((r) => setSalas(r.data.filter((s) => s.ativa)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    const de = janela?.de ?? semana;
    const fim = janela?.ate ?? new Date(semana.getTime() + 7 * 24 * 3_600_000);
    api
      .buscarAgendaDetalhada(de, fim, {
        ...(filtroProf !== '' ? { profissionalId: filtroProf } : {}),
        ...(filtroSala !== '' ? { salaId: filtroSala } : {}),
      })
      .then((r) => {
        if (!vivo) return;
        setCompromissos(r.data);
        setErro(null);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setErro(e instanceof api.ApiError ? e.message : 'Não foi possível carregar a agenda.');
      })
      .finally(() => vivo && setCarregando(false));

    /* AS RESERVAS DE ESPAÇO ENTRAM NA MESMA GRADE. Um mezanino ocupado
       que não aparece na agenda é um mezanino que vai ser marcado em
       cima — e o conflito só vira problema quando as duas turmas chegam
       na porta.

       A falha é silenciosa de propósito: se esta chamada cair, a agenda
       de atendimentos ainda precisa aparecer. */
    const inicioDasReservas = janela?.de ?? semana;
    const fimDasReservas = new Date(janela?.ate ?? semana);
    fimDasReservas.setDate(fimDasReservas.getDate() + (janela === null ? 6 : -1));
    api
      .buscarReservas(comoData(inicioDasReservas), comoData(fimDasReservas))
      .then((r) => {
        if (vivo) setReservas(filtroSala === '' ? r.data : r.data.filter((x) => x.espacoId === filtroSala));
      })
      .catch(() => {
        if (vivo) setReservas([]);
      });

    return () => {
      vivo = false;
    };
  }, [semana, ancora, modo, filtroProf, filtroSala, versao]);

  /** Cor de cada profissional, com reserva estável por posição na lista. */
  const cores = useMemo(() => {
    const m = new Map<string, string>();
    equipe.forEach((p, i) => m.set(p.id, p.cor ?? CORES_RESERVA[i % CORES_RESERVA.length]!));
    return m;
  }, [equipe]);

  const podeEscrever = principal.permissions.includes('schedule:write');
  /* Só quem administra mexe no horário do colega. O servidor impõe isso
     pelo escopo; aqui é só para não oferecer o que vai ser recusado. */
  const mandaEmTodos =
    principal.permissions.includes('user:write') || principal.role === 'OWNER';

  const recarregar = useCallback(() => setVersao((v) => v + 1), []);

  /* A SETA ANDA NA UNIDADE QUE ESTÁ NA TELA. Em mês, avançar sete dias
     mudaria a semana e não o mês — o cabeçalho continuaria dizendo
     "agosto" na maioria dos cliques, e a grade mudaria pouco ou nada. */
  const andar = (passo: number): void => {
    if (modo === 'mes') {
      setAncora((a) => new Date(a.getFullYear(), a.getMonth() + passo, 1));
      return;
    }
    const s = new Date(semana);
    s.setDate(s.getDate() + passo * 7);
    setSemana(s);
  };

  if (horarios) {
    return (
      <Horarios
        equipe={equipe.filter((p) => p.ativo)}
        salas={salas}
        inicial={principal.id}
        podeEscolherProfissional={mandaEmTodos}
        aoSair={() => {
          setHorarios(false);
          recarregar();
        }}
      />
    );
  }

  if (novo !== null) {
    return (
      <Marcacao
        inicio={novo.inicio}
        fim={novo.fim}
        equipe={equipe.filter((p) => p.ativo)}
        salas={salas}
        principal={principal}
        podeEscolherProfissional={mandaEmTodos}
        aoSair={() => setNovo(null)}
        aoMarcar={() => {
          setNovo(null);
          recarregar();
        }}
      />
    );
  }

  /* A TELA DE ESPAÇOS SUBSTITUI A AGENDA, e não abre por cima dela. É
     uma tela de cadastro e planejamento, não uma janela de confirmação:
     quem vai criar quatro lugares e três reservas precisa de espaço,
     não de uma gaveta. */
  if (espacos) {
    return (
      <Espacos
        aoFechar={() => {
          setEspacos(false);
          /* Voltar da tela de espaços recarrega a agenda: quem acabou de
             reservar o mezanino espera vê-lo ocupado na grade. */
          setVersao((v) => v + 1);
          api
            .buscarSalas()
            .then((r) => setSalas(r.data.filter((s) => s.ativa)))
            .catch(() => undefined);
        }}
      />
    );
  }

  return (
    <>
      <div className="secao-cabecalho ag-cabecalho">
        <div>
          <h1>Agenda</h1>
          <p>
            {modo === 'mes'
              ? capitalizarMes(
                  mes.referencia.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
                )
              : `${dias[0]!.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} a ${dias[6]!.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}`}
          </p>
        </div>
        <div className="ag-navegacao">
          {/* O SELETOR DE MODO VEM ANTES DAS SETAS, porque ele muda o
              que as setas fazem: em mês elas andam de mês. Depois delas,
              a pessoa clica na seta e o salto é de tamanho diferente do
              que ela esperava. */}
          <div className="ag-modo" role="group" aria-label="Como ver a agenda">
            <button
              type="button"
              className={`ag-modo-botao ${modo === 'semana' ? 'ativo' : ''}`}
              aria-pressed={modo === 'semana'}
              onClick={() => setModo('semana')}
            >
              Semana
            </button>
            <button
              type="button"
              className={`ag-modo-botao ${modo === 'mes' ? 'ativo' : ''}`}
              aria-pressed={modo === 'mes'}
              onClick={() => {
                /* Entrar no mês pela semana que está na tela: quem está
                   olhando a semana do dia 30 de agosto e pede o mês quer
                   agosto, não o mês em que a âncora tiver parado. */
                setAncora(new Date(semana.getFullYear(), semana.getMonth(), semana.getDate() + 3));
                setModo('mes');
              }}
            >
              Mês
            </button>
          </div>

          <button
            type="button"
            className="botao-secundario"
            onClick={() => andar(-1)}
            aria-label={modo === 'mes' ? 'Mês anterior' : 'Semana anterior'}
          >
            ‹
          </button>
          <button
            type="button"
            className="botao-secundario"
            onClick={() => {
              /* "Hoje" volta os DOIS: quem estava em setembro e clica
                 aqui espera ver esta semana, e trocar de modo depois
                 não pode reabrir o mês onde ele estava. */
              setSemana(segundaDa(new Date()));
              setAncora(new Date());
            }}
          >
            Hoje
          </button>
          <button
            type="button"
            className="botao-secundario"
            onClick={() => andar(1)}
            aria-label={modo === 'mes' ? 'Próximo mês' : 'Próxima semana'}
          >
            ›
          </button>
          {podeEscrever && (
            <button type="button" className="botao-secundario" onClick={() => setEspacos(true)}>
              Espaços
            </button>
          )}
          {podeEscrever && (
            <button type="button" className="botao-acao" onClick={() => setHorarios(true)}>
              Horários de atendimento
            </button>
          )}
        </div>
      </div>

      <ResumoDaSemana compromissos={compromissos} periodo={modo} />

      <div className="ag-filtros">
        <label className="campo ag-filtro">
          <span className="campo-rotulo">Profissional</span>
          <select value={filtroProf} onChange={(e) => setFiltroProf(e.target.value)}>
            <option value="">Todos</option>
            {equipe.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </label>

        {/* A camada de ESPAÇOS só aparece quando existem espaços. Um
            seletor com uma opção só é ruído. */}
        {salas.length > 0 && (
          <label className="campo ag-filtro">
            <span className="campo-rotulo">Espaço</span>
            <select value={filtroSala} onChange={(e) => setFiltroSala(e.target.value)}>
              <option value="">Todos</option>
              {salas.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nome}
                  {s.capacidade > 1 && ` (até ${s.capacidade})`}
                </option>
              ))}
            </select>
          </label>
        )}

      </div>

      {/* A LEGENDA SAIU DA LINHA DOS FILTROS. Ela não é um controle — não
          se clica nela e não muda nada — e ficar ao lado de dois seletores
          fazia com que parecesse uma terceira coisa selecionável. Numa
          linha própria, embaixo, ela é o que é: o dicionário das cores da
          grade. */}
      <div className="ag-legenda">
        <span className="ag-legenda-titulo">Cores</span>
        {equipe
          .filter((p) => p.ativo)
          .map((p) => (
            <span key={p.id} className="ag-legenda-item">
              <span className="ag-ponto" style={{ background: cores.get(p.id) }} />
              {p.nome}
            </span>
          ))}
      </div>

      {erro !== null && <Erro mensagem={erro} />}

      {modo === 'mes' ? (
        <Mes
          dias={mes.dias}
          referencia={mes.referencia}
          compromissos={compromissos}
          cores={cores}
          carregando={carregando}
          aoAbrir={setSelecionado}
          aoEscolherDia={(d) => {
            /* CLICAR NUM DIA VOLTA PARA A SEMANA DELE. O mês responde
               "onde tem gente"; a pergunta seguinte é sempre "e a que
               horas" — e essa só a grade responde. */
            setSemana(segundaDa(d));
            setModo('semana');
          }}
        />
      ) : (
        <Grade
          dias={dias}
          compromissos={compromissos}
          reservas={reservas}
          cores={cores}
          carregando={carregando}
          podeMarcar={podeEscrever}
          aoAbrir={setSelecionado}
          aoVago={(inicio, fim) => setNovo({ inicio, fim })}
        />
      )}

      {selecionado !== null && (
        <Detalhe
          compromisso={selecionado}
          cor={cores.get(selecionado.profissional.id) ?? CORES_RESERVA[0]!}
          podeMexer={mandaEmTodos || selecionado.profissional.id === principal.id}
          aoFechar={() => setSelecionado(null)}
          aoMudar={() => {
            setSelecionado(null);
            recarregar();
          }}
        />
      )}
    </>
  );
}

/* ====================================================================
 * O resumo da semana
 * ================================================================== */

/**
 * A GRADE RESPONDE "QUANDO", E NÃO RESPONDE "QUANTO". Para saber se a
 * semana está cheia era preciso contar retângulos com o dedo na tela — e
 * ninguém conta, então ninguém sabia. Quatro números resolvem: quantos
 * atendimentos, quantos ainda vêm, quantos vieram e quantas faltas.
 *
 * FALTA É O NÚMERO QUE VIRA TRABALHO. Aparece em vermelho quando existe
 * e apagado quando é zero, porque uma semana com sete faltas é uma
 * semana em que alguém precisa ligar para sete pessoas.
 */
function ResumoDaSemana({
  compromissos,
  periodo,
}: {
  compromissos: api.Compromisso[];
  /* O RÓTULO ACOMPANHA O QUE ESTÁ NA TELA. "163 na semana" mostrando o
     mês inteiro é um número certo com a legenda errada — e quem lê
     confia na legenda. */
  periodo: 'semana' | 'mes';
}): ReactNode {
  if (compromissos.length === 0) return null;

  const conta = (status: string): number =>
    compromissos.filter((c) => c.status === status).length;
  const vieram = conta('ATTENDED');
  const faltaram = conta('NO_SHOW');
  const cancelados = conta('CANCELLED');
  /* Marcados que ainda não tiveram desfecho. Contar por data seria mais
     preciso e mais frágil: o fuso do navegador não é o da academia. */
  const porVir = compromissos.length - vieram - faltaram - cancelados;

  /* A taxa só existe depois que alguma sessão teve desfecho. "0% de
     presença" numa segunda de manhã é informação falsa apresentada com
     dois dígitos de precisão. */
  const comDesfecho = vieram + faltaram;
  const presenca = comDesfecho === 0 ? null : Math.round((vieram / comDesfecho) * 100);

  return (
    <div className="ag-resumo">
      <span className="ag-resumo-item">
        <strong>{compromissos.length}</strong>
        <span>{periodo === 'mes' ? 'no mês' : 'na semana'}</span>
      </span>
      <span className="ag-resumo-item">
        <strong>{porVir}</strong>
        <span>ainda vêm</span>
      </span>
      <span className="ag-resumo-item">
        <strong>{vieram}</strong>
        <span>compareceram</span>
      </span>
      <span className={`ag-resumo-item ${faltaram > 0 ? 'alerta' : ''}`}>
        <strong>{faltaram}</strong>
        <span>{faltaram === 1 ? 'falta' : 'faltas'}</span>
      </span>
      {presenca !== null && (
        <span className="ag-resumo-item destaque">
          <strong>{presenca}%</strong>
          <span>de presença</span>
        </span>
      )}
    </div>
  );
}

/* ====================================================================
 * A grade
 * ================================================================== */

function Grade({
  dias,
  compromissos,
  reservas,
  cores,
  carregando,
  podeMarcar,
  aoAbrir,
  aoVago,
}: {
  dias: Date[];
  compromissos: api.CompromissoDetalhado[];
  reservas: api.Reserva[];
  cores: Map<string, string>;
  carregando: boolean;
  podeMarcar: boolean;
  aoAbrir: (c: api.CompromissoDetalhado) => void;
  aoVago: (inicio: Date, fim: Date) => void;
}): ReactNode {
  const corpo = useRef<HTMLDivElement>(null);
  const agora = new Date();

  /* Abre já no começo do expediente, e não às 6h. Sem isto a primeira
     coisa que se vê é uma faixa de madrugada vazia. */
  useEffect(() => {
    const el = corpo.current;
    if (el === null) return;
    el.scrollTop = ((7 - HORA_INICIAL) * 60) / MINUTOS_POR_LINHA * 28;
  }, []);

  /** Compromissos de um dia, já posicionados. */
  const doDia = (dia: Date): (api.CompromissoDetalhado & { linha: number; altura: number })[] =>
    compromissos
      .filter((c) => c.status !== 'CANCELLED' && mesmoDia(new Date(c.inicio), dia))
      .map((c) => {
        const i = new Date(c.inicio);
        const f = new Date(c.fim);
        const minutosDoTopo = (i.getHours() - HORA_INICIAL) * 60 + i.getMinutes();
        const duracao = Math.max(20, (f.getTime() - i.getTime()) / 60_000);
        return {
          ...c,
          linha: minutosDoTopo / MINUTOS_POR_LINHA,
          altura: duracao / MINUTOS_POR_LINHA,
        };
      })
      .sort((a, b) => a.linha - b.linha);

  /** Reservas de espaço do dia, posicionadas do mesmo jeito. */
  const reservasDoDia = (dia: Date): (api.Reserva & { linha: number; altura: number })[] =>
    reservas
      .filter((r) => mesmoDia(new Date(r.inicio), dia))
      .map((r) => {
        const i = new Date(r.inicio);
        const f = new Date(r.fim);
        const minutosDoTopo = (i.getHours() - HORA_INICIAL) * 60 + i.getMinutes();
        const duracao = Math.max(20, (f.getTime() - i.getTime()) / 60_000);
        return { ...r, linha: minutosDoTopo / MINUTOS_POR_LINHA, altura: duracao / MINUTOS_POR_LINHA };
      })
      .sort((a, b) => a.linha - b.linha);

  return (
    <div className={`ag-grade ${carregando ? 'ocupada' : ''}`}>
      <div className="ag-cabecalho-dias">
        <div className="ag-canto" />
        {dias.map((d) => (
          <div key={d.toISOString()} className={`ag-dia ${mesmoDia(d, agora) ? 'hoje' : ''}`}>
            <span className="ag-dia-nome">{DIAS_CURTOS[d.getDay()]}</span>
            <span className="ag-dia-numero">{d.getDate()}</span>
          </div>
        ))}
      </div>

      <div className="ag-corpo" ref={corpo}>
        <div className="ag-horas">
          {Array.from({ length: HORA_FINAL - HORA_INICIAL }, (_, i) => (
            <div key={i} className="ag-hora">
              <span>{String(HORA_INICIAL + i).padStart(2, '0')}h</span>
            </div>
          ))}
        </div>

        {dias.map((d) => (
          <div key={d.toISOString()} className="ag-coluna">
            {/* As faixas clicáveis do fundo. Cada uma é meia hora: clicar
                no vazio já abre a marcação naquele horário, que é o
                gesto que as pessoas tentam antes de procurar o botão. */}
            {Array.from({ length: LINHAS }, (_, i) => {
              const inicio = new Date(d);
              inicio.setHours(HORA_INICIAL + Math.floor(i / 2), (i % 2) * 30, 0, 0);
              const fim = new Date(inicio.getTime() + 60 * 60_000);
              const passou = inicio < agora;
              return (
                <button
                  key={i}
                  type="button"
                  className={`ag-vago ${i % 2 === 1 ? 'meia' : ''} ${passou ? 'passado' : ''}`}
                  disabled={!podeMarcar || passou}
                  aria-label={`Marcar ${DIAS_CURTOS[d.getDay()]} ${String(inicio.getHours()).padStart(2, '0')}:${String(inicio.getMinutes()).padStart(2, '0')}`}
                  onClick={() => aoVago(inicio, fim)}
                />
              );
            })}

            {/* AS RESERVAS DE ESPAÇO FICAM ATRÁS DOS ATENDIMENTOS, e
                não são clicáveis. Elas dizem "este lugar está ocupado",
                não "clique para editar" — quem for mexer nelas vai pela
                tela de Espaços. Deixá-las clicáveis aqui roubaria o
                clique de quem quer marcar um atendimento em cima. */}
            {reservasDoDia(d).map((r) => (
              <div
                key={r.id}
                className="ag-reserva"
                style={{
                  top: `calc(${r.linha} * var(--ag-linha))`,
                  height: `calc(${r.altura} * var(--ag-linha) - 2px)`,
                  '--ag-cor': r.cor ?? 'var(--fio-forte)',
                } as React.CSSProperties}
                title={`${r.titulo} — ${r.espaco ?? ''}`}
              >
                <span className="ag-reserva-titulo">{r.titulo}</span>
                {r.espaco !== null && <span className="ag-reserva-espaco">{r.espaco}</span>}
              </div>
            ))}

            {doDia(d).map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ag-bloco ${c.presencaEm !== null ? 'compareceu' : ''}`}
                style={{
                  top: `calc(${c.linha} * var(--ag-linha))`,
                  height: `calc(${c.altura} * var(--ag-linha) - 2px)`,
                  '--ag-cor': cores.get(c.profissional.id) ?? CORES_RESERVA[0]!,
                } as React.CSSProperties}
                onClick={() => aoAbrir(c)}
              >
                <span className="ag-bloco-hora">{HORA.format(new Date(c.inicio))}</span>
                <span className="ag-bloco-aluno">{c.aluno.nome}</span>
                {c.sala !== null && <span className="ag-bloco-sala">{c.sala.nome}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ====================================================================
 * Detalhe de um horário
 * ================================================================== */

function Detalhe({
  compromisso: c,
  cor,
  podeMexer,
  aoFechar,
  aoMudar,
}: {
  compromisso: api.CompromissoDetalhado;
  cor: string;
  podeMexer: boolean;
  aoFechar: () => void;
  aoMudar: () => void;
}): ReactNode {
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const agir = async (fn: () => Promise<unknown>): Promise<void> => {
    setErro(null);
    setOcupado(true);
    try {
      await fn();
      aoMudar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível concluir.');
      setOcupado(false);
    }
  };

  const inicio = new Date(c.inicio);

  return (
    <div className="ag-gaveta-fundo" onClick={aoFechar} role="presentation">
      <aside
        className="ag-gaveta"
        role="dialog"
        aria-label={`Horário de ${c.aluno.nome}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="ag-gaveta-cor" style={{ background: cor }} />
        <button type="button" className="botao-texto ag-fechar" onClick={aoFechar}>
          Fechar
        </button>

        <h2>{c.aluno.nome}</h2>
        <p className="ag-gaveta-quando">
          {inicio.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })} ·{' '}
          {HORA.format(inicio)} às {HORA.format(new Date(c.fim))}
        </p>

        <dl className="ag-gaveta-dados">
          <div>
            <dt>Profissional</dt>
            <dd>{c.profissional.nome}</dd>
          </div>
          {c.sala !== null && (
            <div>
              <dt>Espaço</dt>
              <dd>{c.sala.nome}</dd>
            </div>
          )}
          <div>
            <dt>Cobrança</dt>
            <dd>
              {c.incluidoNoPlano
                ? 'incluída no plano'
                : c.valorCentavos === null
                  ? 'sem valor definido'
                  : (c.valorCentavos / 100).toLocaleString('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    })}
            </dd>
          </div>
          {c.observacao !== null && c.observacao !== '' && (
            <div>
              <dt>Observação</dt>
              <dd>{c.observacao}</dd>
            </div>
          )}
        </dl>

        {erro !== null && (
          <p className="mensagem-erro" role="alert">
            {erro}
          </p>
        )}

        {podeMexer ? (
          <div className="ag-gaveta-acoes">
            {c.presencaEm === null ? (
              <button
                type="button"
                className="botao-acao"
                disabled={ocupado}
                onClick={() => void agir(() => api.marcarPresenca(c.id, true))}
              >
                Compareceu
              </button>
            ) : (
              <span className="plt-pilula ok">presença registrada</span>
            )}
            <button
              type="button"
              className="botao-texto-perigo"
              disabled={ocupado}
              onClick={() => {
                if (window.confirm(`Cancelar o horário de ${c.aluno.nome}?`)) {
                  void agir(() => api.cancelarCompromisso(c.id));
                }
              }}
            >
              Cancelar horário
            </button>
          </div>
        ) : (
          /* Dizer POR QUE o botão não está aqui. Um espaço vazio faz a
             pessoa procurar; uma frase encerra a busca. */
          <p className="ag-gaveta-nota">
            Este horário é de {c.profissional.nome}. Só quem administra a academia mexe na agenda de
            outro profissional.
          </p>
        )}
      </aside>
    </div>
  );
}

/* ====================================================================
 * Marcar
 * ================================================================== */

function Marcacao({
  inicio,
  fim,
  equipe,
  salas,
  principal,
  podeEscolherProfissional,
  aoSair,
  aoMarcar,
}: {
  inicio: Date;
  fim: Date;
  equipe: api.Profissional[];
  salas: api.Sala[];
  principal: Principal;
  podeEscolherProfissional: boolean;
  aoSair: () => void;
  aoMarcar: () => void;
}): ReactNode {
  const [alunos, setAlunos] = useState<api.Aluno[]>([]);
  const [busca, setBusca] = useState('');
  const [aluno, setAluno] = useState('');
  const [profissional, setProfissional] = useState(
    () => equipe.find((p) => p.id === principal.id)?.id ?? equipe[0]?.id ?? '',
  );
  const [sala, setSala] = useState('');
  const [duracao, setDuracao] = useState(60);
  const [observacao, setObservacao] = useState('');
  /* REPETE TODA SEMANA. O aluno de pilates faz terça e quinta às 9h
     durante meses, com a mesma professora; marcar isso uma sessão de
     cada vez são vinte e quatro passagens pelo mesmo formulário — e
     ninguém faz. A recepção marca duas semanas e o resto vira combinado
     de boca, que é como o calendário deixa de descrever a academia. */
  const [repete, setRepete] = useState(false);
  const [semanas, setSemanas] = useState(12);
  const [parcial, setParcial] = useState<{
    criadas: number;
    pedidas: number;
    recusadas: { inicio: string; motivo: string }[];
  } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .buscarAlunos(1, busca === '' ? undefined : busca)
        .then((r) => setAlunos(r.data))
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [busca]);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (aluno === '') {
      setErro('Escolha o aluno.');
      return;
    }
    setErro(null);
    setEnviando(true);
    const comum = {
      studentId: aluno,
      professionalId: profissional,
      ...(sala !== '' ? { roomId: sala } : {}),
      inicio: inicio.toISOString(),
      fim: new Date(inicio.getTime() + duracao * 60_000).toISOString(),
      ...(observacao !== '' ? { observacao } : {}),
    };
    try {
      if (repete) {
        const r = await api.marcarSerie({ ...comum, semanas });
        /* AS RECUSADAS SÃO MOSTRADAS ANTES DE FECHAR. Sair da tela
           dizendo só "pronto" quando três das doze não couberam é a
           recepção descobrir o buraco no dia em que o aluno aparecer. */
        if (r.data.recusadas.length > 0) {
          setParcial(r.data);
          setEnviando(false);
          return;
        }
      } else {
        await api.marcarCompromisso(comum);
      }
      aoMarcar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível marcar.');
      setEnviando(false);
    }
  };

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Voltar para a agenda
      </button>
      <div className="secao-cabecalho">
        <h1>Marcar horário</h1>
        <p>
          {inicio.toLocaleDateString('pt-BR', {
            weekday: 'long',
            day: '2-digit',
            month: 'long',
          })}{' '}
          às {HORA.format(inicio)}
        </p>
      </div>

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <label className="campo campo-cheia">
          <span className="campo-rotulo">Procurar aluno</span>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Nome do aluno"
            autoFocus
          />
        </label>

        <label className="campo campo-cheia">
          <span className="campo-rotulo">Aluno</span>
          <select value={aluno} onChange={(e) => setAluno(e.target.value)} required>
            <option value="">Escolha…</option>
            {alunos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nome}
              </option>
            ))}
          </select>
          {alunos.length === 0 && <span className="campo-dica">Nenhum aluno encontrado.</span>}
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Profissional</span>
          <select
            value={profissional}
            onChange={(e) => setProfissional(e.target.value)}
            disabled={!podeEscolherProfissional}
          >
            {equipe.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
          {!podeEscolherProfissional ? (
            <span className="campo-dica">Você marca na sua própria agenda.</span>
          ) : (
            <JanelaDeAtendimento
              profissionalId={profissional}
              dia={`${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, '0')}-${String(inicio.getDate()).padStart(2, '0')}`}
              hora={`${String(inicio.getHours()).padStart(2, '0')}:${String(inicio.getMinutes()).padStart(2, '0')}`}
              {...(principal.timezone !== undefined ? { fuso: principal.timezone } : {})}
            />
          )}
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Duração</span>
          <select value={duracao} onChange={(e) => setDuracao(Number(e.target.value))}>
            {[30, 45, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m} minutos
              </option>
            ))}
          </select>
        </label>

        {salas.length > 0 && (
          <label className="campo campo-meia">
            <span className="campo-rotulo">Espaço</span>
            <select value={sala} onChange={(e) => setSala(e.target.value)}>
              <option value="">Sem espaço definido</option>
              {salas.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nome}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="campo campo-cheia">
          <span className="campo-rotulo">Observação</span>
          <input
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="Opcional"
          />
        </label>

        {/* ==================================================
            O MESMO HORÁRIO, TODA SEMANA

            A caixa fica no fim porque é a última decisão: primeiro se
            escolhe quem, com quem e quando: só então faz sentido
            perguntar "e isso se repete?".
            ================================================== */}
        <fieldset className={`campo campo-cheia ag-serie ${repete ? 'ligada' : ''}`}>
          <label className="ag-serie-chave">
            <input type="checkbox" checked={repete} onChange={(e) => setRepete(e.target.checked)} />
            <span>
              <strong>Repetir toda semana, no mesmo horário</strong>
              <span className="campo-dica">
                Com o mesmo profissional. Cada semana vira um horário normal — dá para cancelar ou
                mudar uma sem mexer nas outras.
              </span>
            </span>
          </label>

          {repete && (
            <div className="ag-serie-campos">
              <label className="campo">
                <span className="campo-rotulo">Por quantas semanas</span>
                <select value={String(semanas)} onChange={(e) => setSemanas(Number(e.target.value))}>
                  {[4, 8, 12, 16, 24, 36, 52].map((n) => (
                    <option key={n} value={String(n)}>
                      {n} semanas{n === 52 ? ' (um ano)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <p className="ag-serie-explica">
                {(() => {
                  const ultima = new Date(inicio.getTime() + (semanas - 1) * 7 * 24 * 3_600_000);
                  return (
                    <>
                      Vai de{' '}
                      <strong>
                        {inicio.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })}
                      </strong>{' '}
                      até{' '}
                      <strong>
                        {ultima.toLocaleDateString('pt-BR', {
                          day: '2-digit',
                          month: 'long',
                          year: 'numeric',
                        })}
                      </strong>
                      , sempre {inicio.toLocaleDateString('pt-BR', { weekday: 'long' })} às{' '}
                      {HORA.format(inicio)}. As semanas que não couberem — feriado, horário já
                      ocupado — são puladas, e a tela avisa quais.
                    </>
                  );
                })()}
              </p>
            </div>
          )}
        </fieldset>

        {/* A SÉRIE PARCIAL É MOSTRADA ANTES DE SAIR DA TELA. Fechar
            dizendo só "pronto" quando três das doze não couberam é a
            recepção descobrir o buraco no dia em que o aluno aparecer. */}
        {parcial !== null && (
          <div className="campo campo-cheia ag-parcial" role="status">
            <strong>
              {parcial.criadas} de {parcial.pedidas} semanas foram marcadas.
            </strong>
            <p>Estas não couberam e continuam livres:</p>
            <ul>
              {parcial.recusadas.map((r) => (
                <li key={r.inicio}>
                  <span className="ag-parcial-data">
                    {new Date(r.inicio).toLocaleDateString('pt-BR', {
                      weekday: 'short',
                      day: '2-digit',
                      month: '2-digit',
                    })}
                  </span>
                  <span>{r.motivo}</span>
                </li>
              ))}
            </ul>
            <button type="button" className="botao-acao" onClick={aoMarcar}>
              Entendi, ver a agenda
            </button>
          </div>
        )}

        {erro !== null && (
          <p className="mensagem-erro campo-cheia" role="alert">
            {erro}
          </p>
        )}

        {parcial === null && (
          <div className="formulario-acoes campo-cheia">
            <button type="button" className="botao-secundario" onClick={aoSair}>
              Cancelar
            </button>
            <button type="submit" className="botao-acao" disabled={enviando}>
              {enviando
                ? repete
                  ? `Marcando ${semanas} semanas…`
                  : 'Marcando…'
                : repete
                  ? `Marcar as ${semanas} semanas`
                  : 'Marcar'}
            </button>
          </div>
        )}
      </form>
    </>
  );
}

/** Data local em YYYY-MM-DD. `toISOString` deslocaria o dia a oeste de Greenwich. */
function comoData(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ====================================================================
 * A VISÃO DE MÊS
 * ================================================================== */

/** "agosto de 2026" vira "Agosto de 2026". */
function capitalizarMes(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const CURTOS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

/**
 * O mês inteiro, um quadrado por dia.
 *
 * O QUE ESTA VISÃO RESPONDE, E A GRADE NÃO. A grade de horários é a
 * ferramenta de quem opera o dia: "o que acontece na terça às 9h". Ela
 * não responde a pergunta de quem PLANEJA — quantos dias têm gente, onde
 * estão os buracos, quando dá para tirar folga, em que semana o mês
 * aperta. Para isso é preciso ver trinta dias de uma vez, e trinta dias
 * de grade horária não cabem numa tela.
 *
 * CADA DIA MOSTRA ATÉ QUATRO E DEPOIS CONTA. Uma academia cheia tem
 * doze sessões numa terça; listar as doze faria a linha da semana
 * esticar e o mês voltar a não caber. Quatro nomes dão a textura do dia
 * — quem está lá, de que cor —, e o "+8" diz que tem mais sem mentir
 * sobre o tamanho.
 *
 * NÃO SE MARCA DAQUI. Clicar num dia leva para a semana dele: marcar
 * exige escolher a hora, e a hora não existe nesta visão. Um formulário
 * aberto a partir de um quadrado do mês começaria com o campo mais
 * importante em branco.
 */
function Mes({
  dias,
  referencia,
  compromissos,
  cores,
  carregando,
  aoAbrir,
  aoEscolherDia,
}: {
  dias: Date[];
  referencia: Date;
  compromissos: api.CompromissoDetalhado[];
  cores: Map<string, string>;
  carregando: boolean;
  aoAbrir: (c: api.CompromissoDetalhado) => void;
  aoEscolherDia: (d: Date) => void;
}): ReactNode {
  const hoje = new Date();

  /* Um índice por dia, montado UMA VEZ. Filtrar a lista inteira dentro
     de cada um dos 35 quadrados é varrer o mês 35 vezes. */
  const porDia = new Map<string, api.CompromissoDetalhado[]>();
  for (const c of compromissos) {
    const chave = comoData(new Date(c.inicio));
    const lista = porDia.get(chave);
    if (lista === undefined) porDia.set(chave, [c]);
    else lista.push(c);
  }
  for (const lista of porDia.values()) {
    lista.sort((a, b) => a.inicio.localeCompare(b.inicio));
  }

  return (
    <div className={`ag-mes ${carregando ? 'ocupada' : ''}`}>
      <div className="ag-mes-cabeca" aria-hidden="true">
        {CURTOS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>

      <div className="ag-mes-grade">
        {dias.map((d) => {
          const doDia = porDia.get(comoData(d)) ?? [];
          const deOutroMes = d.getMonth() !== referencia.getMonth();
          const eHoje = mesmoDia(d, hoje);

          return (
            <div
              key={d.toISOString()}
              className={`ag-mes-dia ${deOutroMes ? 'fora' : ''} ${eHoje ? 'hoje' : ''}`}
            >
              <button
                type="button"
                className="ag-mes-numero"
                onClick={() => aoEscolherDia(d)}
                aria-label={`Ver a semana de ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })}`}
              >
                {d.getDate()}
                {/* A CONTAGEM AO LADO DO NÚMERO, e não só a lista: é ela
                    que dá para comparar dois dias com o olho, sem contar
                    linha por linha. */}
                {doDia.length > 0 && <span className="ag-mes-conta">{doDia.length}</span>}
              </button>

              <ul className="ag-mes-lista">
                {doDia.slice(0, 4).map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`ag-mes-item ${c.status === 'CANCELLED' ? 'cancelado' : ''}`}
                      onClick={() => aoAbrir(c)}
                      title={`${HORA.format(new Date(c.inicio))} · ${c.aluno.nome} · ${c.profissional.nome}`}
                    >
                      <span
                        className="ag-ponto"
                        style={{ background: cores.get(c.profissional.id) }}
                        aria-hidden="true"
                      />
                      <span className="ag-mes-hora">{HORA.format(new Date(c.inicio))}</span>
                      <span className="ag-mes-nome">{c.aluno.nome}</span>
                    </button>
                  </li>
                ))}
                {doDia.length > 4 && (
                  <li>
                    <button
                      type="button"
                      className="ag-mes-mais"
                      onClick={() => aoEscolherDia(d)}
                    >
                      +{doDia.length - 4} no dia
                    </button>
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
