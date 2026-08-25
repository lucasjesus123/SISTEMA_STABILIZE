import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Carregando, Erro, Vazio } from './ui.jsx';

/**
 * Espaços da academia e reserva de horário.
 *
 * O CADASTRO EXISTIA NA API E NÃO TINHA TELA. `rooms` está no schema
 * desde o começo e as rotas respondem — mas nenhuma tela as chamava. Em
 * produção o efeito era mudo e enganoso: o filtro "Espaço" da agenda não
 * aparecia, porque ele só aparece quando existem espaços, e nunca
 * existiu nenhum porque não havia como cadastrar.
 *
 * DUAS COISAS NA MESMA TELA, e não duas telas. Cadastrar o mezanino e
 * reservar o mezanino são a mesma conversa: quem acabou de criar o
 * espaço quer dizer, no mesmo minuto, que ele é do funcional às terças.
 * Separar em dois lugares faria a segunda metade nunca ser encontrada.
 *
 * A LISTA DE RESERVAS MOSTRA O FUTURO, e não o histórico. Quem abre esta
 * tela está planejando; o passado da ocupação é relatório, não operação.
 */

const DIAS = [
  { n: 1, curto: 'Seg' },
  { n: 2, curto: 'Ter' },
  { n: 3, curto: 'Qua' },
  { n: 4, curto: 'Qui' },
  { n: 5, curto: 'Sex' },
  { n: 6, curto: 'Sáb' },
  { n: 0, curto: 'Dom' },
] as const;

/** Tons distinguíveis entre si, inclusive para quem não separa vermelho de verde. */
const PALETA = [
  '#2e9aa1',
  '#b2593a',
  '#5b7fb2',
  '#8a6bb2',
  '#3f9e6b',
  '#b23a72',
  '#9a6407',
  '#4a6b8a',
];

export function Espacos({ aoFechar }: { aoFechar?: (() => void) | undefined }): ReactNode {
  const [salas, setSalas] = useState<api.Sala[] | null>(null);
  const [reservas, setReservas] = useState<api.Reserva[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState<api.Sala | 'nova' | null>(null);
  const [reservando, setReservando] = useState(false);

  const carregar = useCallback(async (): Promise<void> => {
    try {
      const s = await api.buscarSalas();
      setSalas(s.data);
      /* SEIS MESES À FRENTE — o mesmo horizonte que o servidor aceita
         criar. Pedir menos esconderia reservas que existem. */
      const hoje = new Date();
      const fim = new Date();
      fim.setDate(fim.getDate() + 200);
      const r = await api.buscarReservas(iso(hoje), iso(fim));
      setReservas(r.data);
      setErro(null);
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const ativas = salas?.filter((s) => s.ativa) ?? [];

  return (
    <>
      {/* O CABEÇALHO E O "VOLTAR" SÓ APARECEM quando esta tela foi
          aberta a partir da Agenda. Dentro de "A academia" ela é uma ABA
          — e uma aba com o próprio h1 e um botão de voltar para outro
          lugar é o que faz o operador achar que se perdeu. */}
      {aoFechar !== undefined && (
        <div className="secao-cabecalho linha-cabecalho">
          <div>
            <h1>Espaços</h1>
            <p>
              Os lugares da academia — mezanino, hall, sala de bike — e o que ocupa cada um.
            </p>
          </div>
          <button type="button" className="botao-secundario" onClick={aoFechar}>
            ← Voltar para a agenda
          </button>
        </div>
      )}

      {erro !== null && <Erro mensagem={erro} />}

      {salas === null ? (
        <Carregando rotulo="Carregando espaços" />
      ) : (
        <div className="esp-mesa">
          {/* ---------------------------------------------------------
              Os lugares
              --------------------------------------------------------- */}
          <section className="esp-coluna">
            <div className="esp-titulo">
              <h2>Lugares</h2>
              {editando === null && (
                <button
                  type="button"
                  className="botao-acao"
                  onClick={() => setEditando('nova')}
                >
                  <span aria-hidden="true">+</span> Novo lugar
                </button>
              )}
            </div>

            {editando !== null && (
              <FormularioDeEspaco
                espaco={editando === 'nova' ? null : editando}
                usados={ativas.map((s) => s.cor).filter((c): c is string => c !== null)}
                aoSair={() => setEditando(null)}
                aoSalvar={() => {
                  setEditando(null);
                  void carregar();
                }}
              />
            )}

            {salas.length === 0 && editando === null ? (
              <Vazio
                titulo="Nenhum lugar cadastrado."
                descricao="Cadastre o mezanino, o hall, a sala de bike. É o que faz o filtro de espaço aparecer na agenda e o que permite reservar horário."
              />
            ) : (
              <ul className="esp-lista">
                {salas.map((s) => (
                  <li key={s.id} className={s.ativa ? '' : 'inativo'}>
                    <span
                      className="esp-cor"
                      style={{ background: s.cor ?? 'var(--fio-forte)' }}
                      aria-hidden="true"
                    />
                    <span className="esp-nome">
                      {s.nome}
                      {!s.ativa && <span className="pilula apagada pequena">inativo</span>}
                    </span>
                    <span className="esp-capacidade">
                      {s.capacidade === 1 ? '1 pessoa' : `até ${s.capacidade}`}
                    </span>
                    <button
                      type="button"
                      className="botao-texto"
                      onClick={() => setEditando(s)}
                    >
                      editar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ---------------------------------------------------------
              As reservas
              --------------------------------------------------------- */}
          <section className="esp-coluna">
            <div className="esp-titulo">
              <h2>Reservas</h2>
              {ativas.length > 0 && !reservando && (
                <button type="button" className="botao-acao" onClick={() => setReservando(true)}>
                  <span aria-hidden="true">+</span> Reservar horário
                </button>
              )}
            </div>

            {ativas.length === 0 ? (
              <p className="esp-nota">
                Cadastre um lugar ao lado para poder reservar horário nele.
              </p>
            ) : reservando ? (
              <FormularioDeReserva
                salas={ativas}
                aoSair={() => setReservando(false)}
                aoSalvar={() => {
                  setReservando(false);
                  void carregar();
                }}
              />
            ) : reservas.length === 0 ? (
              <Vazio
                titulo="Nenhuma reserva marcada."
                descricao="Reserve um lugar num dia e horário — de uma vez, ou repetindo toda semana. O horário reservado deixa de ser oferecido para agendamento."
              />
            ) : (
              <ListaDeReservas reservas={reservas} aoMudar={() => void carregar()} />
            )}
          </section>
        </div>
      )}
    </>
  );
}

/* ==================================================================== */

function FormularioDeEspaco({
  espaco,
  usados,
  aoSair,
  aoSalvar,
}: {
  espaco: api.Sala | null;
  usados: string[];
  aoSair: () => void;
  aoSalvar: () => void;
}): ReactNode {
  const [nome, setNome] = useState(espaco?.nome ?? '');
  const [descricao, setDescricao] = useState(espaco?.descricao ?? '');
  const [capacidade, setCapacidade] = useState(String(espaco?.capacidade ?? 1));
  /* A primeira cor livre da paleta, para que dois lugares não nasçam da
     mesma cor e a agenda fique ilegível. */
  const [cor, setCor] = useState(
    espaco?.cor ?? PALETA.find((c) => !usados.includes(c)) ?? PALETA[0]!,
  );
  const [ativa, setAtiva] = useState(espaco?.ativa ?? true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const salvar = async (): Promise<void> => {
    setErro(null);
    setSalvando(true);
    try {
      const dados = {
        nome: nome.trim(),
        descricao: descricao.trim() === '' ? null : descricao.trim(),
        capacidade: Number(capacidade) || 1,
        cor,
      };
      if (espaco === null) await api.criarSala(dados);
      else await api.salvarSala(espaco.id, { ...dados, ativa });
      aoSalvar();
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível salvar.');
      setSalvando(false);
    }
  };

  return (
    <div className="formulario esp-formulario">
      <label className="campo campo-cheia">
        <span className="campo-rotulo">Nome do lugar</span>
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="Mezanino"
          autoFocus
          maxLength={80}
        />
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">Cabem quantas pessoas?</span>
        <input
          inputMode="numeric"
          value={capacidade}
          onChange={(e) => setCapacidade(e.target.value.replace(/\D/g, ''))}
        />
        <span className="campo-dica">Serve para saber quando o lugar lotou.</span>
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">Observação (opcional)</span>
        <input
          value={descricao}
          onChange={(e) => setDescricao(e.target.value)}
          placeholder="Piso superior, ao lado da escada"
          maxLength={200}
        />
      </label>

      <div className="campo campo-cheia">
        <span className="campo-rotulo">Cor na agenda</span>
        {/* A COR É ESCOLHIDA AQUI e não numa tela de configuração: é no
            momento de criar o lugar que se decide como ele aparece na
            grade. Separar as duas coisas garante que metade dos espaços
            fique sem cor até alguém lembrar. */}
        <div className="esp-cores">
          {PALETA.map((c) => (
            <button
              key={c}
              type="button"
              className={`esp-cor-opcao ${cor === c ? 'escolhida' : ''}`}
              style={{ background: c }}
              aria-label={`Cor ${c}`}
              aria-pressed={cor === c}
              onClick={() => setCor(c)}
            />
          ))}
        </div>
      </div>

      {espaco !== null && (
        <label className="esp-ativo campo-cheia">
          <input type="checkbox" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} />
          <span>
            Lugar em uso.
            {/* Desativar em vez de apagar: as reservas passadas continuam
                apontando para ele, e o histórico de ocupação sobrevive. */}
            {' '}Desmarque para tirar da agenda sem apagar o histórico.
          </span>
        </label>
      )}

      {erro !== null && <Erro mensagem={erro} />}

      <div className="formulario-acoes campo-cheia">
        <button type="button" className="botao-secundario" onClick={aoSair}>
          Cancelar
        </button>
        <button
          type="button"
          className="botao-acao"
          disabled={salvando || nome.trim().length < 2}
          onClick={() => void salvar()}
        >
          {salvando ? 'Salvando…' : espaco === null ? 'Cadastrar lugar' : 'Salvar'}
        </button>
      </div>
    </div>
  );
}

/* ==================================================================== */

/**
 * Reservar um horário.
 *
 * A REPETIÇÃO É UMA CAIXA, e não uma tela separada. "Toda segunda e
 * quarta às 19h" é a reserva mais comum de uma academia — spinning,
 * funcional, pilates em grupo — e escondê-la atrás de outro fluxo faria
 * a recepcionista criar doze reservas à mão.
 */
function FormularioDeReserva({
  salas,
  aoSair,
  aoSalvar,
}: {
  salas: api.Sala[];
  aoSair: () => void;
  aoSalvar: () => void;
}): ReactNode {
  const [roomId, setRoomId] = useState(salas[0]?.id ?? '');
  const [titulo, setTitulo] = useState('');
  const [de, setDe] = useState(() => iso(new Date()));
  const [horaInicio, setHoraInicio] = useState('19:00');
  const [horaFim, setHoraFim] = useState('20:00');
  const [repete, setRepete] = useState(false);
  const [dias, setDias] = useState<number[]>([]);
  const [ate, setAte] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 84); // doze semanas
    return iso(d);
  });
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const valido =
    roomId !== '' &&
    titulo.trim().length >= 2 &&
    horaFim > horaInicio &&
    (!repete || dias.length > 0);

  const salvar = async (): Promise<void> => {
    setErro(null);
    setSalvando(true);
    try {
      const r = await api.criarReserva({
        roomId,
        titulo: titulo.trim(),
        de,
        horaInicio,
        horaFim,
        ...(repete ? { diasDaSemana: dias, ate } : {}),
      });
      /* Dizer QUANTAS foram criadas. "Reserva salva" depois de gerar
         vinte e quatro ocorrências esconde a única informação que a
         pessoa precisa conferir. */
      if (r.data.criadas > 1) {
        window.alert(`${r.data.criadas} reservas criadas.`);
      }
      aoSalvar();
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível reservar.');
      setSalvando(false);
    }
  };

  return (
    <div className="formulario esp-formulario">
      <label className="campo campo-meia">
        <span className="campo-rotulo">Lugar</span>
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          {salas.map((s) => (
            <option key={s.id} value={s.id}>
              {s.nome}
            </option>
          ))}
        </select>
      </label>

      <label className="campo campo-meia">
        <span className="campo-rotulo">O que ocupa o lugar</span>
        <input
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          placeholder="Spinning das 19h"
          autoFocus
          maxLength={120}
        />
      </label>

      <label className="campo campo-terco">
        <span className="campo-rotulo">{repete ? 'A partir de' : 'Dia'}</span>
        <input type="date" value={de} onChange={(e) => setDe(e.target.value)} />
      </label>

      <label className="campo campo-terco">
        <span className="campo-rotulo">Começa</span>
        <input type="time" value={horaInicio} onChange={(e) => setHoraInicio(e.target.value)} />
      </label>

      <label className="campo campo-terco">
        <span className="campo-rotulo">Termina</span>
        <input type="time" value={horaFim} onChange={(e) => setHoraFim(e.target.value)} />
      </label>

      <label className="esp-repete campo-cheia">
        <input
          type="checkbox"
          checked={repete}
          onChange={(e) => setRepete(e.target.checked)}
        />
        <span>Repete toda semana</span>
      </label>

      {repete && (
        <>
          <div className="campo campo-cheia">
            <span className="campo-rotulo">Em quais dias</span>
            <div className="esp-dias">
              {DIAS.map((d) => (
                <button
                  key={d.n}
                  type="button"
                  className={dias.includes(d.n) ? 'escolhido' : ''}
                  aria-pressed={dias.includes(d.n)}
                  onClick={() =>
                    setDias((atual) =>
                      atual.includes(d.n) ? atual.filter((x) => x !== d.n) : [...atual, d.n],
                    )
                  }
                >
                  {d.curto}
                </button>
              ))}
            </div>
          </div>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Até quando</span>
            <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
            <span className="campo-dica">
              O sistema cria no máximo seis meses à frente. Renovar depois é um clique.
            </span>
          </label>
        </>
      )}

      {erro !== null && <Erro mensagem={erro} />}

      <div className="formulario-acoes campo-cheia">
        <button type="button" className="botao-secundario" onClick={aoSair}>
          Cancelar
        </button>
        <button
          type="button"
          className="botao-acao"
          disabled={salvando || !valido}
          onClick={() => void salvar()}
        >
          {salvando ? 'Reservando…' : 'Reservar'}
        </button>
      </div>
    </div>
  );
}

/* ==================================================================== */

/**
 * As reservas, agrupadas por série.
 *
 * VINTE E QUATRO LINHAS IGUAIS NÃO SÃO UMA LISTA, são ruído. Uma reserva
 * que se repete é uma coisa só — "Spinning, seg e qua às 19h, até
 * dezembro" — e é assim que quem a criou pensa nela. As ocorrências
 * individuais só importam quando alguém vai cancelar um dia específico,
 * e para isso existe o "ver as datas".
 */
function ListaDeReservas({
  reservas,
  aoMudar,
}: {
  reservas: api.Reserva[];
  aoMudar: () => void;
}): ReactNode {
  const [erro, setErro] = useState<string | null>(null);

  const grupos: { chave: string; itens: api.Reserva[] }[] = [];
  for (const r of reservas) {
    const chave = r.serieId ?? r.id;
    const existente = grupos.find((g) => g.chave === chave);
    if (existente === undefined) grupos.push({ chave, itens: [r] });
    else existente.itens.push(r);
  }

  const agir = async (fn: () => Promise<unknown>): Promise<void> => {
    setErro(null);
    try {
      await fn();
      aoMudar();
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível cancelar.');
    }
  };

  return (
    <>
      {erro !== null && <Erro mensagem={erro} />}
      <ul className="esp-reservas">
        {grupos.map((g) => (
          <Grupo key={g.chave} itens={g.itens} aoAgir={agir} />
        ))}
      </ul>
    </>
  );
}

function Grupo({
  itens,
  aoAgir,
}: {
  itens: api.Reserva[];
  aoAgir: (fn: () => Promise<unknown>) => Promise<void>;
}): ReactNode {
  const [aberto, setAberto] = useState(false);
  const primeira = itens[0]!;
  const ultima = itens[itens.length - 1]!;
  const repetida = primeira.serieId !== null && itens.length > 1;

  return (
    <li className="esp-reserva">
      <span
        className="esp-reserva-cor"
        style={{ background: primeira.cor ?? 'var(--fio-forte)' }}
        aria-hidden="true"
      />
      <div className="esp-reserva-corpo">
        <span className="esp-reserva-titulo">{primeira.titulo}</span>
        <span className="esp-reserva-meta">
          {primeira.espaco ?? 'Sem lugar'} · {hora(primeira.inicio)} às {hora(primeira.fim)}
        </span>
        <span className="esp-reserva-quando">
          {repetida
            ? `${diasDe(itens)} · ${itens.length} datas, de ${dataCurta(primeira.inicio)} a ${dataCurta(ultima.inicio)}`
            : dataLonga(primeira.inicio)}
        </span>

        {repetida && (
          <button type="button" className="botao-texto" onClick={() => setAberto(!aberto)}>
            {aberto ? 'esconder as datas' : 'ver as datas'}
          </button>
        )}

        {aberto && (
          <ul className="esp-datas">
            {itens.map((r) => (
              <li key={r.id}>
                <span>{dataLonga(r.inicio)}</span>
                <button
                  type="button"
                  className="botao-texto"
                  onClick={() => void aoAgir(() => api.cancelarReserva(r.id))}
                >
                  cancelar este dia
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        className="botao-secundario"
        onClick={() => {
          const aviso = repetida
            ? `Cancelar as ${itens.length} datas de "${primeira.titulo}"? As que já passaram continuam no histórico.`
            : `Cancelar "${primeira.titulo}"?`;
          if (!window.confirm(aviso)) return;
          void aoAgir(() =>
            repetida
              ? api.cancelarSerieDeReservas(primeira.serieId!)
              : api.cancelarReserva(primeira.id),
          );
        }}
      >
        {repetida ? 'Cancelar tudo' : 'Cancelar'}
      </button>
    </li>
  );
}

/* ==================================================================== */

/** Data local em YYYY-MM-DD, sem passar por `toISOString` — que desloca. */
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const hora = (isoTexto: string): string =>
  new Date(isoTexto).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const dataCurta = (isoTexto: string): string =>
  new Date(isoTexto).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

const dataLonga = (isoTexto: string): string => {
  const texto = new Date(isoTexto).toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
  /* Só a primeira letra: `text-transform: capitalize` faria "Qua., 02 De
     Set." — maiusculização de inglês. */
  return texto.charAt(0).toUpperCase() + texto.slice(1);
};

/** "Seg e qua" a partir das ocorrências. */
function diasDe(itens: api.Reserva[]): string {
  const numeros = [...new Set(itens.map((r) => new Date(r.inicio).getDay()))];
  const nomes = DIAS.filter((d) => numeros.includes(d.n)).map((d) => d.curto.toLowerCase());
  if (nomes.length === 1) return nomes[0]!;
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}
