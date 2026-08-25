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
    const fim = new Date(semana);
    fim.setDate(fim.getDate() + 7);
    api
      .buscarAgendaDetalhada(semana, fim, {
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
    const fimDaSemana = new Date(semana);
    fimDaSemana.setDate(fimDaSemana.getDate() + 6);
    api
      .buscarReservas(comoData(semana), comoData(fimDaSemana))
      .then((r) => {
        if (vivo) setReservas(filtroSala === '' ? r.data : r.data.filter((x) => x.espacoId === filtroSala));
      })
      .catch(() => {
        if (vivo) setReservas([]);
      });

    return () => {
      vivo = false;
    };
  }, [semana, filtroProf, filtroSala, versao]);

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

  const andar = (semanas: number): void => {
    const s = new Date(semana);
    s.setDate(s.getDate() + semanas * 7);
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
            {dias[0]!.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} a{' '}
            {dias[6]!.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
          </p>
        </div>
        <div className="ag-navegacao">
          <button type="button" className="botao-secundario" onClick={() => andar(-1)}>
            ‹ Semana
          </button>
          <button
            type="button"
            className="botao-secundario"
            onClick={() => setSemana(segundaDa(new Date()))}
          >
            Hoje
          </button>
          <button type="button" className="botao-secundario" onClick={() => andar(1)}>
            Semana ›
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

      <ResumoDaSemana compromissos={compromissos} />

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
function ResumoDaSemana({ compromissos }: { compromissos: api.Compromisso[] }): ReactNode {
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
        <span>na semana</span>
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
    try {
      await api.marcarCompromisso({
        studentId: aluno,
        professionalId: profissional,
        ...(sala !== '' ? { roomId: sala } : {}),
        inicio: inicio.toISOString(),
        fim: new Date(inicio.getTime() + duracao * 60_000).toISOString(),
        ...(observacao !== '' ? { observacao } : {}),
      });
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

        {erro !== null && (
          <p className="mensagem-erro campo-cheia" role="alert">
            {erro}
          </p>
        )}

        <div className="formulario-acoes campo-cheia">
          <button type="button" className="botao-secundario" onClick={aoSair}>
            Cancelar
          </button>
          <button type="submit" className="botao-acao" disabled={enviando}>
            {enviando ? 'Marcando…' : 'Marcar'}
          </button>
        </div>
      </form>
    </>
  );
}

/** Data local em YYYY-MM-DD. `toISOString` deslocaria o dia a oeste de Greenwich. */
function comoData(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
