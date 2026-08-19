import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatCents } from '@stabilize/shared';
import * as api from './api.js';
import { Carregando, Erro, Vazio } from './ui.jsx';
import type { Principal } from './api.js';

/**
 * Financeiro da academia.
 *
 * A TELA É ORGANIZADA POR "O QUE PRECISA DE AÇÃO HOJE", não pelo modelo
 * de dados. Quem abre esta aba de manhã tem uma pergunta só — *quem me
 * deve e o que eu tenho que pagar* — e a resposta precisa estar visível
 * antes de qualquer filtro. Por isso o vencido vem primeiro, sempre, com
 * a cor do alerta; o resto do mês vem embaixo.
 *
 * DAR BAIXA É UMA LINHA, NÃO UMA JANELA. O caso comum é receber o valor
 * cheio, hoje, no PIX. Uma caixa modal para confirmar três campos já
 * preenchidos transforma trinta segundos de recepção em três minutos, e
 * é a razão pela qual sistema financeiro de academia costuma ficar
 * desatualizado: não é falta de disciplina, é atrito.
 */

type Painel = 'receber' | 'pagar' | 'recorrencias' | 'relatorios' | 'comissoes';

const METODOS: { valor: api.MetodoPagamento; nome: string }[] = [
  { valor: 'PIX', nome: 'PIX' },
  { valor: 'CASH', nome: 'Dinheiro' },
  { valor: 'DEBIT_CARD', nome: 'Cartão de débito' },
  { valor: 'CREDIT_CARD', nome: 'Cartão de crédito' },
  { valor: 'BANK_TRANSFER', nome: 'Transferência' },
  { valor: 'BOLETO', nome: 'Boleto' },
  { valor: 'OTHER', nome: 'Outro' },
];

const NOME_DO_STATUS: Record<api.StatusLancamento, string> = {
  OPEN: 'em aberto',
  PARTIALLY_PAID: 'parcial',
  PAID: 'quitado',
  OVERDUE: 'vencido',
  CANCELLED: 'cancelado',
};

const TOM_DO_STATUS: Record<api.StatusLancamento, string> = {
  OPEN: 'neutra',
  PARTIALLY_PAID: 'atencao',
  PAID: 'ok',
  OVERDUE: 'erro',
  CANCELLED: 'neutra',
};

/** Primeiro e último dia do mês de uma data, em hora local. */
function limitesDoMes(d: Date): { de: Date; ate: Date } {
  return {
    de: new Date(d.getFullYear(), d.getMonth(), 1),
    ate: new Date(d.getFullYear(), d.getMonth() + 1, 0),
  };
}

const MES_ANO = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

/**
 * Primeira letra maiúscula, o resto intocado.
 *
 * `text-transform: capitalize` do CSS maiúscula TODA palavra e produz
 * "Agosto De 2026" — em português a preposição fica minúscula.
 */
const capitalizar = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** `date` vindo do servidor é "2026-08-18": formatar sem passar por Date
    evita o deslocamento de fuso que transforma dia 1 em dia 31. */
function diaMes(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}`;
}

const hojeIso = (): string => {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
};

/**
 * A situação do lançamento, conferida contra o calendário.
 *
 * QUEM MANTÉM O `status` É O SERVIDOR — uma tarefa de fundo que roda de
 * hora em hora (`envelhecerCobrancas`) e marca como vencido o que passou
 * da data, no fuso de cada academia. Isso é de propósito: se cada tela
 * calculasse "vencido" por conta própria, o relatório, a API e a régua
 * de cobrança calculariam de três jeitos e um dia divergiriam.
 *
 * ESTA FUNÇÃO NÃO SUBSTITUI AQUILO — cobre a fresta entre a virada do
 * dia e o próximo tique da tarefa, que é de no máximo uma hora. Sem ela,
 * nessa fresta, o cartão do topo (que conta pela data) diria "12
 * vencidas" enquanto as 12 linhas diriam "em aberto".
 */
function situacaoReal(l: api.Lancamento): api.StatusLancamento {
  if (l.status === 'PAID' || l.status === 'CANCELLED') return l.status;
  if (l.saldoCentavos <= 0) return 'PAID';
  if (l.vencimento.slice(0, 10) < hojeIso()) return 'OVERDUE';
  return l.status;
}

export function Financeiro({ principal }: { principal: Principal }): ReactNode {
  const [painel, setPainel] = useState<Painel>('receber');
  /* Um contador em vez de um booleano: clicar em "Vencido" duas vezes
     precisa reaplicar o filtro, e um booleano já `true` não dispara
     efeito nenhum. */
  const [pedidoDeVencidos, setPedidoDeVencidos] = useState(0);
  const [mes, setMes] = useState(() => new Date());
  const [resumo, setResumo] = useState<api.ResumoFinanceiro | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const { de, ate } = useMemo(() => limitesDoMes(mes), [mes]);

  const carregarResumo = useCallback(() => {
    api
      .buscarResumo(de, ate)
      .then((r) => {
        setResumo(r.data);
        setErro(null);
      })
      .catch((e: unknown) => setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar.'));
  }, [de, ate]);

  useEffect(carregarResumo, [carregarResumo]);

  const andar = (passo: number): void =>
    setMes((m) => new Date(m.getFullYear(), m.getMonth() + passo, 1));

  return (
    <>
      <div className="secao-cabecalho fin-cabecalho">
        <div>
          <h1>Financeiro</h1>
          <p>Contas a receber e a pagar, baixas e o fechamento de cada profissional.</p>
        </div>
        <div className="fin-mes">
          <button type="button" className="botao-secundario" onClick={() => andar(-1)}>
            ‹
          </button>
          <span className="fin-mes-nome">{capitalizar(MES_ANO.format(mes))}</span>
          <button type="button" className="botao-secundario" onClick={() => andar(1)}>
            ›
          </button>
        </div>
      </div>

      {erro !== null && <Erro mensagem={erro} />}

      {resumo !== null && (
        <Cartoes
          resumo={resumo}
          aoFiltrarVencidos={() => {
            setPainel('receber');
            setPedidoDeVencidos((v) => v + 1);
          }}
        />
      )}

      <div className="fin-abas" role="tablist" aria-label="Áreas do financeiro">
        {(
          [
            ['receber', 'A receber'],
            ['pagar', 'A pagar'],
            /* RECORRÊNCIAS antes de RELATÓRIOS: é operação (o que vai
               nascer sozinho mês que vem), e relatório é leitura. */
            ['recorrencias', 'Recorrências'],
            ['relatorios', 'Relatórios'],
            ['comissoes', 'Comissões'],
          ] as [Painel, string][]
        ).map(([id, nome]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={painel === id}
            className={`fin-aba ${painel === id ? 'ativa' : ''}`}
            onClick={() => setPainel(id)}
          >
            {nome}
          </button>
        ))}
      </div>

      {painel === 'comissoes' ? (
        <Comissoes mes={mes} principal={principal} />
      ) : painel === 'recorrencias' ? (
        <Recorrencias />
      ) : painel === 'relatorios' ? (
        <Relatorios de={de} ate={ate} />
      ) : (
        <Lancamentos
          direcao={painel === 'receber' ? 'RECEIVABLE' : 'PAYABLE'}
          de={de}
          ate={ate}
          pedidoDeVencidos={pedidoDeVencidos}
          aoMudar={carregarResumo}
        />
      )}
    </>
  );
}

/* ====================================================================
 * Os números do mês
 * ================================================================== */

function Cartoes({
  resumo,
  aoFiltrarVencidos,
}: {
  resumo: api.ResumoFinanceiro;
  aoFiltrarVencidos: () => void;
}): ReactNode {
  const positivo = resumo.saldoRealizadoCentavos >= 0;

  return (
    <section className="fin-topo">
      {/* O NÚMERO GRANDE É O SALDO REALIZADO — o que sobrou de verdade,
          entradas menos saídas efetivadas. Quatro cartões do mesmo
          tamanho não têm hierarquia nenhuma: o olho tem de escolher por
          onde começar, e escolhe errado. Aqui a resposta principal tem
          o tamanho de resposta principal, e o resto apoia. */}
      <div className="fin-hero">
        <span className="fin-hero-rotulo">Saldo do mês</span>
        <strong className={`fin-hero-valor ${positivo ? '' : 'negativo'}`}>
          {formatCents(resumo.saldoRealizadoCentavos)}
        </strong>
        <span className="fin-hero-nota">
          <span className="fin-entrou">{formatCents(resumo.recebidoCentavos)} entrou</span>
          <span className="fin-sep" aria-hidden="true" />
          <span className="fin-saiu">{formatCents(resumo.pagoCentavos)} saiu</span>
        </span>
      </div>

      <div className="fin-kpis">
        <Kpi
          rotulo="Vence hoje"
          valor={resumo.venceHojeCentavos}
          nota={
            resumo.venceHojeQtd === 0
              ? 'nada para hoje'
              : `${resumo.venceHojeQtd} cobrança${resumo.venceHojeQtd === 1 ? '' : 's'}`
          }
        />
        {/* VENCIDO É CLICÁVEL. Um número que não leva a lugar nenhum
            vira decoração — e este é justamente o que faz alguém pegar
            o telefone. */}
        <Kpi
          rotulo="Vencido"
          valor={resumo.inadimplenteCentavos}
          nota={
            resumo.inadimplentesQtd === 0
              ? 'ninguém em atraso'
              : `${resumo.inadimplentesQtd} em atraso · ver`
          }
          tom={resumo.inadimplenteCentavos > 0 ? 'erro' : undefined}
          {...(resumo.inadimplenteCentavos > 0 ? { aoClicar: aoFiltrarVencidos } : {})}
        />
        <Kpi
          rotulo="A receber no mês"
          valor={resumo.aReceberCentavos}
          nota={`${formatCents(resumo.recebidoCentavos)} já entrou`}
        />
        <Kpi
          rotulo="A pagar no mês"
          valor={resumo.aPagarCentavos}
          nota={`${formatCents(resumo.pagoCentavos)} já saiu`}
        />
      </div>
    </section>
  );
}

function Kpi({
  rotulo,
  valor,
  nota,
  tom,
  aoClicar,
}: {
  rotulo: string;
  valor: number;
  nota: string;
  tom?: 'erro' | undefined;
  aoClicar?: (() => void) | undefined;
}): ReactNode {
  const conteudo = (
    <>
      <span className="fin-kpi-rotulo">{rotulo}</span>
      <strong className="fin-kpi-valor">{formatCents(valor)}</strong>
      <span className="fin-kpi-nota">{nota}</span>
    </>
  );
  const classe = `fin-kpi ${tom ?? ''}`;

  return aoClicar === undefined ? (
    <div className={classe}>{conteudo}</div>
  ) : (
    <button type="button" className={`${classe} clicavel`} onClick={aoClicar}>
      {conteudo}
    </button>
  );
}

/* ====================================================================
 * A lista, com a baixa embutida
 * ================================================================== */

function Lancamentos({
  direcao,
  de,
  ate,
  pedidoDeVencidos,
  aoMudar,
}: {
  direcao: api.DirecaoLancamento;
  de: Date;
  ate: Date;
  pedidoDeVencidos: number;
  aoMudar: () => void;
}): ReactNode {
  const [linhas, setLinhas] = useState<api.Lancamento[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [emAberto, setEmAberto] = useState(false);
  const [soVencidos, setSoVencidos] = useState(false);
  const [baixando, setBaixando] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    let vivo = true;
    setLinhas(null);
    api
      .buscarLancamentos({ direcao, de, ate, apenasEmAberto: emAberto })
      .then((r) => {
        if (!vivo) return;
        setLinhas(r.data);
        setErro(null);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar os lançamentos.');
        setLinhas([]);
      });
    return () => {
      vivo = false;
    };
  }, [direcao, de, ate, emAberto, versao]);

  useEffect(() => {
    if (pedidoDeVencidos === 0) return;
    setSoVencidos(true);
    setEmAberto(true);
  }, [pedidoDeVencidos]);

  const recarregar = (): void => {
    setVersao((v) => v + 1);
    aoMudar();
  };

  /* Vencido no topo, e não a ordem do banco. É a única ordenação que
     responde à pergunta com que a pessoa abriu a tela. */
  const ordenadas = useMemo(() => {
    if (linhas === null) return null;
    const base = soVencidos ? linhas.filter((l) => situacaoReal(l) === 'OVERDUE') : linhas;
    const peso = (l: api.Lancamento): number => {
      const s = situacaoReal(l);
      return s === 'OVERDUE' ? 0 : s === 'PAID' || s === 'CANCELLED' ? 2 : 1;
    };
    return [...base].sort((a, b) => peso(a) - peso(b) || a.vencimento.localeCompare(b.vencimento));
  }, [linhas, soVencidos]);

  if (criando) {
    return (
      <NovoLancamento
        direcao={direcao}
        aoSair={() => setCriando(false)}
        aoCriar={() => {
          setCriando(false);
          recarregar();
        }}
      />
    );
  }

  return (
    <>
      <div className="fin-barra">
        <div className="fin-filtros">
          <label className="fin-chave">
            <input
              type="checkbox"
              checked={emAberto}
              onChange={(e) => {
                setEmAberto(e.target.checked);
                if (!e.target.checked) setSoVencidos(false);
              }}
            />
            <span>Só o que falta {direcao === 'RECEIVABLE' ? 'receber' : 'pagar'}</span>
          </label>
          {/* O filtro aplicado FICA VISÍVEL e sai com um clique. Filtro
              invisível é a origem de "sumiram meus lançamentos". */}
          {soVencidos && (
            <button
              type="button"
              className="fin-marcador"
              onClick={() => setSoVencidos(false)}
            >
              só vencidos <span aria-hidden="true">×</span>
              <span className="apenas-leitor-de-tela">remover filtro</span>
            </button>
          )}
        </div>
        <button type="button" className="botao-acao" onClick={() => setCriando(true)}>
          {direcao === 'RECEIVABLE' ? 'Nova cobrança' : 'Nova despesa'}
        </button>
      </div>

      {erro !== null && <Erro mensagem={erro} />}
      {ordenadas === null ? (
        <Carregando rotulo="Carregando lançamentos" />
      ) : ordenadas.length === 0 ? (
        <Vazio
          titulo="Nada neste mês."
          descricao={
            direcao === 'RECEIVABLE'
              ? 'Cobranças aparecem aqui quando um contrato é gerado ou lançado à mão.'
              : 'Lance aluguel, energia, comissão — o que sai da academia.'
          }
        />
      ) : (
        <div className="rolo">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Vence</th>
                <th scope="col">{direcao === 'RECEIVABLE' ? 'Cobrança' : 'Despesa'}</th>
                <th scope="col" className="fin-col-num">Valor</th>
                {/* PAGO / DEVIDO na mesma célula. Só "pendente" não conta
                    a história, e o operador dá baixa duas vezes na conta
                    que já recebeu metade. */}
                <th scope="col" className="fin-col-num">Pago</th>
                <th scope="col">Situação</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {ordenadas.map((l) => (
                <Linha
                  key={l.id}
                  lancamento={l}
                  aberta={baixando === l.id}
                  aoAbrir={() => setBaixando(baixando === l.id ? null : l.id)}
                  aoBaixar={() => {
                    setBaixando(null);
                    recarregar();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Linha({
  lancamento: l,
  aberta,
  aoAbrir,
  aoBaixar,
}: {
  lancamento: api.Lancamento;
  aberta: boolean;
  aoAbrir: () => void;
  aoBaixar: () => void;
}): ReactNode {
  const situacao = situacaoReal(l);
  const quitado = l.saldoCentavos <= 0 || l.status === 'CANCELLED';
  const parcial = l.pagoCentavos > 0 && !quitado;

  return (
    <>
      <tr className={`fin-linha ${situacao === 'OVERDUE' ? 'vencida' : ''} ${quitado ? 'quitada' : ''}`}>
        <td className="fin-data">
          <span className="fin-dia">{diaMes(l.vencimento)}</span>
          {situacao === 'OVERDUE' && (
            <span className="fin-atraso">{diasDeAtraso(l.vencimento)}d</span>
          )}
        </td>
        <td>
          <span className="celula-forte">{l.aluno?.nome ?? l.fornecedor ?? l.descricao}</span>
          <span className="celula-apoio">
            {l.aluno !== null || l.fornecedor !== null ? l.descricao : (l.categoria ?? '—')}
            {l.parcela !== null && ` · parcela ${l.parcela}`}
          </span>
        </td>
        <td className="fin-col-num">
          <span className="dinheiro">{l.valorFormatado}</span>
        </td>
        <td className="fin-col-num">
          {quitado ? (
            <span className="dinheiro fin-quitado">{l.valorFormatado}</span>
          ) : parcial ? (
            /* "R$ 300 de R$ 500" em vez de um status vago. */
            <span className="fin-parcial">
              <span className="dinheiro">{formatCents(l.pagoCentavos)}</span>
              <span className="fin-parcial-falta">faltam {formatCents(l.saldoCentavos)}</span>
            </span>
          ) : (
            <span className="fin-nada">—</span>
          )}
        </td>
        <td>
          <span className={`fin-selo ${TOM_DO_STATUS[situacao]}`}>{NOME_DO_STATUS[situacao]}</span>
        </td>
        <td className="fin-acao">
          {!quitado && (
            <button type="button" className="fin-botao-baixa" onClick={aoAbrir}>
              {aberta ? 'Fechar' : 'Dar baixa'}
            </button>
          )}
        </td>
      </tr>
      {aberta && (
        <tr className="fin-linha-baixa">
          <td colSpan={6} className="fin-baixa-celula">
            <FormularioDeBaixa lancamento={l} aoBaixar={aoBaixar} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Quantos dias uma cobrança está atrasada, contados no calendário. */
function diasDeAtraso(vencimento: string): number {
  const [a, m, d] = vencimento.slice(0, 10).split('-').map(Number);
  const venceu = new Date(a!, m! - 1, d!);
  const hoje = new Date();
  const zero = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return Math.max(0, Math.round((zero.getTime() - venceu.getTime()) / 86_400_000));
}

/**
 * A baixa.
 *
 * O VALOR JÁ VEM PREENCHIDO COM O SALDO e o método com PIX, porque é o
 * que acontece em nove de cada dez vezes. Quem recebeu metade em
 * dinheiro corrige dois campos; quem recebeu tudo aperta um botão.
 */
function FormularioDeBaixa({
  lancamento: l,
  aoBaixar,
}: {
  lancamento: api.Lancamento;
  aoBaixar: () => void;
}): ReactNode {
  const [valor, setValor] = useState(() => (l.saldoCentavos / 100).toFixed(2).replace('.', ','));
  const [metodo, setMetodo] = useState<api.MetodoPagamento>('PIX');
  const [quando, setQuando] = useState(() => {
    const h = new Date();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
  });
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await api.darBaixa(l.id, { valor, metodo, pagoEm: quando });
      aoBaixar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível registrar a baixa.');
      setEnviando(false);
    }
  };

  /* O RESULTADO CALCULADO AO VIVO. É o detalhe que mais reduz erro de
     digitação: a pessoa confere antes de confirmar, em vez de descobrir
     depois na listagem que digitou 3500 no lugar de 350,00. */
  const centavos = Math.round(Number(valor.replace(/\./g, '').replace(',', '.')) * 100);
  const valido = Number.isFinite(centavos) && centavos > 0;
  const restante = valido ? l.saldoCentavos - centavos : l.saldoCentavos;

  return (
    <form className="fin-baixa" onSubmit={(e) => void enviar(e)}>
      <div className="fin-baixa-conta">
        <span className="fin-baixa-rotulo">Em aberto</span>
        <strong className="dinheiro fin-baixa-devido">{formatCents(l.saldoCentavos)}</strong>
        {l.pagoCentavos > 0 && (
          <span className="fin-baixa-ja">de {l.valorFormatado} · {formatCents(l.pagoCentavos)} já pago</span>
        )}
      </div>

      <div className="fin-baixa-campos">
        <label className="campo">
          <span className="campo-rotulo">Valor recebido</span>
          <input
            inputMode="decimal"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="campo">
          <span className="campo-rotulo">Forma</span>
          <select value={metodo} onChange={(e) => setMetodo(e.target.value as api.MetodoPagamento)}>
            {METODOS.map((m) => (
              <option key={m.valor} value={m.valor}>
                {m.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="campo">
          <span className="campo-rotulo">Quando</span>
          <input type="date" value={quando} onChange={(e) => setQuando(e.target.value)} required />
        </label>
        <button type="submit" className="botao-acao" disabled={enviando || !valido}>
          {enviando ? 'Registrando…' : 'Confirmar'}
        </button>
      </div>

      {valido && (
        <p className={`fin-previsao ${restante <= 0 ? 'quita' : ''}`} aria-live="polite">
          {restante <= 0
            ? restante < 0
              ? `A conta fica QUITADA, com ${formatCents(-restante)} a mais que o devido.`
              : 'A conta fica QUITADA.'
            : `A conta continua aberta, com ${formatCents(restante)} a receber.`}
        </p>
      )}

      {erro !== null && (
        <p className="mensagem-erro fin-baixa-erro" role="alert">
          {erro}
        </p>
      )}
    </form>
  );
}

/* ====================================================================
 * Novo lançamento
 * ================================================================== */

function NovoLancamento({
  direcao,
  aoSair,
  aoCriar,
}: {
  direcao: api.DirecaoLancamento;
  aoSair: () => void;
  aoCriar: () => void;
}): ReactNode {
  const receber = direcao === 'RECEIVABLE';
  const [descricao, setDescricao] = useState('');
  const [valor, setValor] = useState('');
  const [vencimento, setVencimento] = useState(() => {
    const h = new Date();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
  });
  const [categoria, setCategoria] = useState('');
  const [quem, setQuem] = useState('');
  const [alunos, setAlunos] = useState<api.Aluno[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!receber) return;
    api
      .buscarAlunos(1)
      .then((r) => setAlunos(r.data))
      .catch(() => undefined);
  }, [receber]);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await api.criarLancamento({
        direcao,
        descricao,
        valor,
        vencimento,
        ...(categoria !== '' ? { categoria } : {}),
        ...(receber && quem !== '' ? { studentId: quem } : {}),
        ...(!receber && quem !== '' ? { fornecedor: quem } : {}),
      });
      aoCriar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível lançar.');
      setEnviando(false);
    }
  };

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Voltar
      </button>
      <div className="secao-cabecalho">
        <h1>{receber ? 'Nova cobrança' : 'Nova despesa'}</h1>
        <p>
          {receber
            ? 'Uma cobrança avulsa: matrícula, avaliação, produto. A mensalidade do contrato é gerada sozinha.'
            : 'O que sai da academia: aluguel, energia, comissão, material.'}
        </p>
      </div>

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <label className="campo campo-cheia">
          <span className="campo-rotulo">Descrição</span>
          <input
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            required
            autoFocus
            placeholder={receber ? 'Mensalidade de agosto' : 'Aluguel do salão'}
          />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Valor</span>
          <input
            inputMode="decimal"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            required
            placeholder="350,00"
          />
        </label>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Vence em</span>
          <input
            type="date"
            value={vencimento}
            onChange={(e) => setVencimento(e.target.value)}
            required
          />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">{receber ? 'Aluno' : 'Fornecedor'}</span>
          {receber ? (
            <select value={quem} onChange={(e) => setQuem(e.target.value)}>
              <option value="">Sem aluno vinculado</option>
              {alunos.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nome}
                </option>
              ))}
            </select>
          ) : (
            <input value={quem} onChange={(e) => setQuem(e.target.value)} placeholder="Imobiliária" />
          )}
        </label>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Categoria</span>
          <input
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            placeholder={receber ? 'Mensalidade, avaliação…' : 'Ocupação, pessoal…'}
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
            {enviando ? 'Lançando…' : 'Lançar'}
          </button>
        </div>
      </form>
    </>
  );
}

/* ====================================================================
 * Comissões
 * ================================================================== */

function Comissoes({ mes, principal }: { mes: Date; principal: Principal }): ReactNode {
  const [equipe, setEquipe] = useState<api.Profissional[]>([]);
  const [quem, setQuem] = useState('');
  const [fechamento, setFechamento] = useState<Awaited<
    ReturnType<typeof api.buscarComissao>
  > | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    api
      .buscarProfissionais()
      .then((r) => {
        const ativos = r.data.filter((p) => p.ativo);
        setEquipe(ativos);
        /* O profissional cai direto no PRÓPRIO fechamento: é o único que
           ele pode ver, e obrigá-lo a escolher a si mesmo numa lista de
           um item é perguntar o que já se sabe. */
        setQuem((q) => q || (ativos.find((p) => p.id === principal.id)?.id ?? ativos[0]?.id) || '');
      })
      .catch((e: unknown) =>
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar a equipe.'),
      );
  }, [principal.id]);

  useEffect(() => {
    if (quem === '') return;
    let vivo = true;
    setCarregando(true);
    api
      .buscarComissao(quem, mes)
      .then((r) => {
        if (!vivo) return;
        setFechamento(r);
        setErro(null);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setFechamento(null);
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao calcular.');
      })
      .finally(() => vivo && setCarregando(false));
    return () => {
      vivo = false;
    };
  }, [quem, mes]);

  return (
    <>
      <label className="campo fin-selecao">
        <span className="campo-rotulo">Profissional</span>
        <select value={quem} onChange={(e) => setQuem(e.target.value)}>
          {equipe.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nome}
            </option>
          ))}
        </select>
      </label>

      {erro !== null && <Erro mensagem={erro} />}
      {carregando ? (
        <Carregando rotulo="Calculando o fechamento" />
      ) : fechamento === null ? null : fechamento.data.itens.length === 0 ? (
        <Vazio
          titulo="Nenhum recebimento neste mês."
          descricao="A comissão sai do que foi efetivamente PAGO — não do que foi cobrado. Enquanto o aluno não paga, não há o que repassar."
        />
      ) : (
        <>
          {/* Os MESMOS indicadores da lista, e não um segundo conjunto
              de cartões parecido: duas caixas de número quase iguais na
              mesma tela é como uma delas envelhece diferente. */}
          <div className="fin-kpis fin-kpis-largo">
            <Kpi
              rotulo="A repassar"
              valor={fechamento.data.totalCentavos}
              nota={`${fechamento.data.itens.length} recebimento${fechamento.data.itens.length === 1 ? '' : 's'}`}
            />
            <Kpi
              rotulo="Base de cálculo"
              valor={fechamento.data.baseTotalCentavos}
              nota="o que entrou por este profissional"
            />
            <div className="fin-kpi">
              <span className="fin-kpi-rotulo">Percentual médio</span>
              <strong className="fin-kpi-valor">
                {(fechamento.data.aliquotaMediaBp / 100).toLocaleString('pt-BR', {
                  maximumFractionDigits: 2,
                })}
                %
              </strong>
              <span className="fin-kpi-nota">ponderado pelo valor</span>
            </div>
          </div>

          {/* A MEMÓRIA DE CÁLCULO, linha a linha. É o que transforma o
              fechamento em algo conferível: sem ela, o profissional
              recebe um número e tem de acreditar. */}
          <h2 className="plt-titulo">De onde veio cada centavo</h2>
          <div className="rolo">
            <table className="tabela">
              <thead>
                <tr>
                  <th scope="col">Recebimento</th>
                  <th scope="col" className="fin-col-num">Base</th>
                  <th scope="col" className="fin-col-num">Comissão</th>
                </tr>
              </thead>
              <tbody>
                {fechamento.data.itens.map((i, n) => (
                  <tr key={`${i.descricao}-${n}`}>
                    <td>{i.descricao}</td>
                    <td className="fin-col-num">
                      <span className="dinheiro">{i.baseFormatada}</span>
                    </td>
                    <td className="fin-col-num">
                      <span className="dinheiro">{i.valorFormatado}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/* ====================================================================
 * Recorrências — o que nasce sozinho todo mês
 * ================================================================== */

const NOME_DO_CICLO: Record<string, string> = {
  SESSION: 'por sessão',
  WEEKLY: 'semanal',
  BIWEEKLY: 'quinzenal',
  MONTHLY: 'mensal',
  QUARTERLY: 'trimestral',
  SEMIANNUAL: 'semestral',
  ANNUAL: 'anual',
};

/**
 * Os contratos ativos, que é de onde a mensalidade nasce.
 *
 * A ABA EXISTE PARA RESPONDER "O QUE VAI ENTRAR MÊS QUE VEM". A lista de
 * lançamentos mostra o que já foi emitido; sem esta, o previsto do mês
 * seguinte é uma conta que alguém faz de cabeça — e ninguém faz.
 */
function Recorrencias(): ReactNode {
  const [linhas, setLinhas] = useState<api.Recorrencia[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    api
      .buscarRecorrencias()
      .then((r) => vivo && setLinhas(r.data))
      .catch((e: unknown) => {
        if (!vivo) return;
        setLinhas([]);
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar.');
      });
    return () => {
      vivo = false;
    };
  }, []);

  const mensais = (linhas ?? []).filter((r) => r.ciclo === 'MONTHLY');
  const previsto = mensais
    .filter((r) => !r.encerrandoNoFim)
    .reduce((a, r) => a + r.valorCentavos, 0);

  return (
    <>
      {erro !== null && <Erro mensagem={erro} />}
      {linhas === null ? (
        <Carregando rotulo="Carregando as recorrências" />
      ) : linhas.length === 0 ? (
        <Vazio
          titulo="Nenhum contrato ativo."
          descricao="O plano do aluno é definido no cadastro dele. É o contrato que faz a mensalidade nascer sozinha todo mês."
        />
      ) : (
        <>
          <div className="fin-kpis fin-kpis-largo">
            <Kpi
              rotulo="Previsto por mês"
              valor={previsto}
              /* "mensais", não "mensalis": o plural de mensal troca o
                 -l por -is. Concatenar sufixo cegamente produz a forma
                 errada em toda palavra terminada em -al. */
              nota={
                mensais.length === 1
                  ? '1 contrato mensal'
                  : `${mensais.length} contratos mensais`
              }
            />
            <div className="fin-kpi">
              <span className="fin-kpi-rotulo">Saindo</span>
              <strong className="fin-kpi-valor">
                {linhas.filter((r) => r.encerrandoNoFim).length}
              </strong>
              <span className="fin-kpi-nota">pediram para encerrar no fim do período</span>
            </div>
            <div className="fin-kpi">
              <span className="fin-kpi-rotulo">Com atraso</span>
              <strong className="fin-kpi-valor">
                {linhas.filter((r) => r.vencidasAbertas > 0).length}
              </strong>
              <span className="fin-kpi-nota">têm cobrança vencida em aberto</span>
            </div>
          </div>

          <div className="rolo">
            <table className="tabela">
              <thead>
                <tr>
                  <th scope="col">Aluno</th>
                  <th scope="col">Plano</th>
                  <th scope="col" className="fin-col-num">Valor</th>
                  <th scope="col">Cobra dia</th>
                  <th scope="col">Situação</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((r) => (
                  <tr key={r.contratoId}>
                    <td>
                      <span className="celula-forte">{r.aluno}</span>
                      <span className="celula-apoio">
                        {r.profissional ?? 'sem professor'} · desde {r.desde.slice(0, 7)}
                      </span>
                    </td>
                    <td className="plt-secundario">{NOME_DO_CICLO[r.ciclo] ?? r.ciclo}</td>
                    <td className="fin-col-num">
                      <span className="dinheiro">{r.valorFormatado}</span>
                    </td>
                    <td className="tabular">{r.diaDeCobranca ?? '—'}</td>
                    <td>
                      {r.encerrandoNoFim ? (
                        <span className="pilula apagada">encerrando</span>
                      ) : r.vencidasAbertas > 0 ? (
                        /* O NÚMERO, e não só "em atraso": três vencidas
                           é um aluno a ligar hoje, uma é um boleto que
                           venceu ontem. */
                        <span className="pilula atrasada">
                          {r.vencidasAbertas} vencida{r.vencidasAbertas === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="pilula viva">em dia</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/* ====================================================================
 * Relatórios
 * ================================================================== */

function Relatorios({ de, ate }: { de: Date; ate: Date }): ReactNode {
  const [dados, setDados] = useState<api.Relatorios | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setDados(null);
    api
      .buscarRelatorios(de, ate)
      .then((r) => vivo && setDados(r.data))
      .catch((e: unknown) => {
        if (!vivo) return;
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar os relatórios.');
      });
    return () => {
      vivo = false;
    };
  }, [de, ate]);

  if (erro !== null) return <Erro mensagem={erro} />;
  if (dados === null) return <Carregando rotulo="Calculando os relatórios" />;

  const maior = Math.max(
    1,
    ...dados.fluxo.map((m) => Math.max(m.recebidoCentavos, m.pagoCentavos)),
  );

  return (
    <>
      <div className="fin-barra">
        <p className="rel-apoio">
          Entradas e saídas contadas pela data do PAGAMENTO — é a pergunta sobre caixa. Uma
          mensalidade de janeiro paga em março entrou em março.
        </p>
        <button
          type="button"
          className="botao-secundario"
          onClick={() => void api.baixarCsvDoFinanceiro(de, ate)}
        >
          Exportar CSV
        </button>
      </div>

      {/* ---- 1. estou melhorando? ---- */}
      <h2 className="plt-titulo">Entrou e saiu, mês a mês</h2>
      <div className="rel-barras" role="img" aria-label="Entradas e saídas dos últimos meses">
        {dados.fluxo.map((m) => (
          <div key={m.mes} className="rel-mes">
            <div className="rel-par">
              <span
                className="rel-barra entrou"
                style={{ height: `${(m.recebidoCentavos / maior) * 100}%` }}
                title={`Entrou ${formatCents(m.recebidoCentavos)}`}
              />
              <span
                className="rel-barra saiu"
                style={{ height: `${(m.pagoCentavos / maior) * 100}%` }}
                title={`Saiu ${formatCents(m.pagoCentavos)}`}
              />
            </div>
            <span className="rel-mes-nome">{m.mes.slice(5)}</span>
          </div>
        ))}
      </div>
      <p className="rel-legenda">
        <span className="fin-entrou">entrou</span>
        <span className="fin-saiu">saiu</span>
      </p>

      {/* ---- 2. para onde vai o dinheiro? ---- */}
      <h2 className="plt-titulo">Por categoria</h2>
      {dados.categorias.length === 0 ? (
        <p className="rel-apoio">Nenhum pagamento no período.</p>
      ) : (
        <div className="rel-categorias">
          {(['RECEIVABLE', 'PAYABLE'] as const).map((direcao) => {
            const doLado = dados.categorias.filter((c) => c.direcao === direcao);
            if (doLado.length === 0) return null;
            const total = doLado.reduce((a, c) => a + c.totalCentavos, 0);
            return (
              <section key={direcao} className="rel-lado">
                <h3>{direcao === 'RECEIVABLE' ? 'Entrou' : 'Saiu'}</h3>
                {doLado.map((c) => (
                  <div key={c.categoria} className="rel-categoria">
                    <div className="rel-categoria-topo">
                      <span>{c.categoria}</span>
                      <span className="dinheiro">{c.totalFormatado}</span>
                    </div>
                    {/* A barra proporcional responde "quanto disso é
                        isso" sem o leitor dividir dois números de cabeça. */}
                    <span
                      className={`rel-fatia ${direcao === 'RECEIVABLE' ? 'entrou' : 'saiu'}`}
                      style={{ width: `${Math.max(2, (c.totalCentavos / total) * 100)}%` }}
                    />
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {/* ---- 3. quem eu cobro hoje? ---- */}
      <h2 className="plt-titulo">
        Quem está devendo{' '}
        <span className="rel-total">{formatCents(dados.totalDevendoCentavos)}</span>
      </h2>
      {dados.inadimplentes.length === 0 ? (
        <p className="rel-apoio">Ninguém em atraso. Raro e bom.</p>
      ) : (
        <div className="rolo">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Aluno</th>
                <th scope="col">Contato</th>
                <th scope="col" className="fin-col-num">Deve</th>
                <th scope="col" className="fin-col-num">Cobranças</th>
                <th scope="col" className="fin-col-num">Atraso</th>
              </tr>
            </thead>
            <tbody>
              {dados.inadimplentes.map((i) => (
                <tr key={i.studentId}>
                  <td className="celula-forte">{i.nome}</td>
                  <td className="tabular plt-secundario">{i.telefone ?? '—'}</td>
                  <td className="fin-col-num">
                    <span className="dinheiro">{i.devendoFormatado}</span>
                  </td>
                  <td className="fin-col-num tabular">{i.cobrancas}</td>
                  <td className="fin-col-num">
                    {/* ORDENADO POR DIAS, não por valor: quem deve R$ 200
                        há seis meses é um problema diferente de quem deve
                        R$ 800 desde ontem. */}
                    <span className={`pilula ${i.diasDeAtraso > 60 ? 'atrasada' : 'apagada'}`}>
                      {i.diasDeAtraso} dias
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
