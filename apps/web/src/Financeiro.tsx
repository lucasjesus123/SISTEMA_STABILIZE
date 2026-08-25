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

/**
 * A data por extenso, do jeito que o sistema ENTENDEU.
 *
 * O campo nativo de data mostra o formato do NAVEGADOR, não o da página:
 * medido com `navigator.language` e `Intl` resolvendo em pt-BR, o campo
 * ainda exibia 08/24/2026. O idioma da interface do navegador manda, e
 * ele não é nosso — muita gente no Brasil usa o Chrome em inglês.
 *
 * Para dia maior que 12 não há dúvida. Para 08/05 há: oito de maio ou
 * cinco de agosto? Num vencimento, essa dúvida é três meses de
 * diferença no fluxo de caixa.
 *
 * Então o sistema escreve o que entendeu, embaixo do campo. Não conserta
 * o formato do navegador — tira a ambiguidade, que é o que importa.
 */
const POR_EXTENSO = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function dataPorExtenso(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return capitalizar(POR_EXTENSO.format(d));
}

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

/**
 * As abas que ESTE papel pode abrir.
 *
 * O profissional entra no Financeiro para ver o PRÓPRIO fechamento —
 * `commission:read` é dele; `finance:*` não é. A tela abria em "A
 * receber" assim mesmo, pedia ao servidor o que ele nega, e o resultado
 * era "Seu perfil não tem acesso a esta funcionalidade" DUAS vezes em
 * vermelho, com as cinco abas no lugar, um botão "Nova cobrança" que
 * falharia, e um "Nada neste mês" logo abaixo dizendo que o mês estava
 * vazio — quando o mês nem tinha sido consultado.
 *
 * O servidor estava certo o tempo todo: negou, e a negativa ficou
 * auditada. Quem mentia era a tela. Oferecer a porta e depois dizer que
 * ela não abre é pior do que não oferecer.
 */
const ABAS: readonly (readonly [Painel, string, string])[] = [
  ['receber', 'A receber', 'finance:receivable:read'],
  ['pagar', 'A pagar', 'finance:payable:read'],
  /* RECORRÊNCIAS antes de RELATÓRIOS: é operação (o que vai nascer
     sozinho mês que vem), e relatório é leitura. */
  ['recorrencias', 'Recorrências', 'finance:receivable:read'],
  ['relatorios', 'Relatórios', 'finance:report:read'],
  ['comissoes', 'Comissões', 'commission:read'],
];

export function Financeiro({ principal }: { principal: Principal }): ReactNode {
  const abas = useMemo(
    () => ABAS.filter(([, , p]) => principal.permissions.includes(p)),
    [principal.permissions],
  );
  /* Começa na primeira aba que este papel REALMENTE abre — para o dono
     continua sendo "A receber", que é a primeira da lista. */
  const [painel, setPainel] = useState<Painel>(() => abas[0]?.[0] ?? 'comissoes');
  const podeVerResumo = principal.permissions.includes('finance:report:read');
  /* Um contador em vez de um booleano: clicar em "Vencido" duas vezes
     precisa reaplicar o filtro, e um booleano já `true` não dispara
     efeito nenhum. */
  const [pedidoDeVencidos, setPedidoDeVencidos] = useState(0);
  const [mes, setMes] = useState(() => new Date());
  const [resumo, setResumo] = useState<api.ResumoFinanceiro | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const { de, ate } = useMemo(() => limitesDoMes(mes), [mes]);

  const carregarResumo = useCallback(() => {
    /* Não pedir o que o papel não pode ver: a resposta seria 403 e o
       403 virava faixa vermelha no alto da tela. */
    if (!podeVerResumo) return;
    api
      .buscarResumo(de, ate)
      .then((r) => {
        setResumo(r.data);
        setErro(null);
      })
      .catch((e: unknown) => setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar.'));
  }, [de, ate, podeVerResumo]);

  useEffect(carregarResumo, [carregarResumo]);

  const andar = (passo: number): void =>
    setMes((m) => new Date(m.getFullYear(), m.getMonth() + passo, 1));

  return (
    <>
      <div className="secao-cabecalho fin-cabecalho">
        <div>
          <h1>Financeiro</h1>
          {/* A chamada descreve o que ESTA pessoa vê. Prometer "contas a
              receber e a pagar" para quem só abre o próprio fechamento
              é a mesma mentira das abas, escrita menor. */}
          <p>
            {podeVerResumo
              ? 'Contas a receber e a pagar, baixas e o fechamento de cada profissional.'
              : 'O seu fechamento do mês.'}
          </p>
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

      {/* Uma aba só não é barra de abas: para o profissional, que só
          abre "Comissões", a fileira vira ruído. */}
      <div
        className="fin-abas"
        role="tablist"
        aria-label="Áreas do financeiro"
        hidden={abas.length < 2}
      >
        {abas.map(([id, nome]) => (
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
        <Recorrencias podeEscrever={principal.permissions.includes('finance:recurring:write')} />
      ) : painel === 'relatorios' ? (
        <Relatorios de={de} ate={ate} mes={mes} />
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
 * que acontece em nove de cada dez vezes. Quem recebeu tudo em PIX
 * aperta um botão e acabou.
 *
 * A DIVISÃO EM VÁRIAS FORMAS FICA ESCONDIDA ATRÁS DE UM LINK. Metade no
 * PIX e metade no cartão acontece, mas é a exceção — mostrar duas linhas
 * de pagamento de saída faria a operação mais comum do financeiro ficar
 * mais difícil para atender a mais rara. O link aparece; as linhas só
 * quando alguém pede.
 *
 * A SEGUNDA LINHA NASCE COM O QUE FALTA. Quem clica em "dividir" acabou
 * de digitar quanto entrou na primeira forma; o resto é aritmética que o
 * sistema faz melhor do que a pessoa com fila no balcão.
 */
function FormularioDeBaixa({
  lancamento: l,
  aoBaixar,
}: {
  lancamento: api.Lancamento;
  aoBaixar: () => void;
}): ReactNode {
  const [linhas, setLinhas] = useState<{ valor: string; metodo: api.MetodoPagamento }[]>(() => [
    { valor: (l.saldoCentavos / 100).toFixed(2).replace('.', ','), metodo: 'PIX' },
  ]);
  const [quando, setQuando] = useState(() => {
    const h = new Date();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
  });
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const emCentavos = (v: string): number =>
    Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);

  const total = linhas.reduce((s, x) => s + (Number.isFinite(emCentavos(x.valor)) ? emCentavos(x.valor) : 0), 0);
  const todasValidas = linhas.every((x) => Number.isFinite(emCentavos(x.valor)) && emCentavos(x.valor) > 0);
  const valido = todasValidas && total > 0;
  const restante = valido ? l.saldoCentavos - total : l.saldoCentavos;

  const dividir = (): void => {
    const falta = Math.max(0, l.saldoCentavos - total);
    setLinhas((atual) => [
      ...atual,
      { valor: (falta / 100).toFixed(2).replace('.', ','), metodo: 'CASH' },
    ]);
  };

  const mudar = (i: number, campo: 'valor' | 'metodo', v: string): void => {
    setLinhas((atual) =>
      atual.map((x, k) => (k === i ? { ...x, [campo]: v } : x)),
    );
  };

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      if (linhas.length === 1) {
        /* Uma forma só continua indo pela rota antiga: é o caminho
           exercitado por todo o resto e não há por que mudá-lo. */
        await api.darBaixa(l.id, { valor: linhas[0]!.valor, metodo: linhas[0]!.metodo, pagoEm: quando });
      } else {
        await api.darBaixaEmLote(
          l.id,
          linhas.map((x) => ({ valor: x.valor, metodo: x.metodo, pagoEm: quando })),
        );
      }
      aoBaixar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível registrar a baixa.');
      setEnviando(false);
    }
  };

  return (
    <form className="fin-baixa" onSubmit={(e) => void enviar(e)}>
      <div className="fin-baixa-conta">
        <span className="fin-baixa-rotulo">Em aberto</span>
        <strong className="dinheiro fin-baixa-devido">{formatCents(l.saldoCentavos)}</strong>
        {l.pagoCentavos > 0 && (
          <span className="fin-baixa-ja">de {l.valorFormatado} · {formatCents(l.pagoCentavos)} já pago</span>
        )}
      </div>

      {linhas.map((linha, i) => (
        <div className="fin-baixa-campos" key={i}>
          <label className="campo">
            <span className="campo-rotulo">
              {linhas.length === 1 ? 'Valor recebido' : `${i + 1}ª forma`}
            </span>
            <input
              inputMode="decimal"
              value={linha.valor}
              onChange={(e) => mudar(i, 'valor', e.target.value)}
              required
              autoFocus={i === 0}
            />
          </label>
          <label className="campo">
            <span className="campo-rotulo">Forma</span>
            <select
              value={linha.metodo}
              onChange={(e) => mudar(i, 'metodo', e.target.value)}
            >
              {METODOS.map((m) => (
                <option key={m.valor} value={m.valor}>
                  {m.nome}
                </option>
              ))}
            </select>
          </label>
          {i === 0 ? (
            <label className="campo">
              <span className="campo-rotulo">Quando</span>
              <input type="date" value={quando} onChange={(e) => setQuando(e.target.value)} required />
            </label>
          ) : (
            <button
              type="button"
              className="fin-baixa-tirar"
              onClick={() => setLinhas((atual) => atual.filter((_, k) => k !== i))}
              aria-label={`Remover a ${i + 1}ª forma`}
            >
              Remover
            </button>
          )}
          {i === 0 && (
            <button type="submit" className="botao-acao" disabled={enviando || !valido}>
              {enviando ? 'Registrando…' : 'Confirmar'}
            </button>
          )}
        </div>
      ))}

      {/* Seis é onde uma baixa dividida deixa de ser uma baixa dividida.
          O servidor recusa acima disso; o botão some antes, para que a
          recusa nunca precise aparecer. */}
      {linhas.length < 6 && (
        <button type="button" className="botao-texto fin-baixa-dividir" onClick={dividir}>
          + Recebeu em mais de uma forma?
        </button>
      )}

      {/* O RESULTADO CALCULADO AO VIVO. É o detalhe que mais reduz erro de
          digitação: a pessoa confere antes de confirmar, em vez de descobrir
          depois na listagem que digitou 3500 no lugar de 350,00. */}
      {valido && (
        <p className={`fin-previsao ${restante <= 0 ? 'quita' : ''}`} aria-live="polite">
          {linhas.length > 1 && `${formatCents(total)} em ${linhas.length} formas. `}
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
  /* QUEM PAGA, quando não é aluno.
     Uma conta a receber SEM devedor é buraco de contabilidade, e o banco
     recusa: `entry_counterparty` exige aluno ou nome de quem paga. A
     tela oferecia "Sem aluno vinculado" — exatamente o que a regra
     proíbe — e o lançamento voltava com "os dados enviados não atendem
     às regras do sistema", sem dizer qual dado nem qual regra.
     Este campo é a saída legítima: produto vendido no balcão para quem
     ainda não é aluno tem pagador, só não tem matrícula. */
  const [pagador, setPagador] = useState('');
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

    /* A CONFERÊNCIA ACONTECE AQUI, e não depois da viagem ao servidor.
       O banco recusaria de qualquer forma — mas recusaria com o texto
       genérico do CHECK, que não diz o que fazer. Dito antes de enviar,
       com o nome do campo, vira instrução em vez de parede. */
    if (receber && quem === '' && pagador.trim() === '') {
      setErro('Diga de quem é esta cobrança: escolha o aluno ou escreva quem vai pagar.');
      return;
    }

    setEnviando(true);
    try {
      await api.criarLancamento({
        direcao,
        descricao,
        valor,
        vencimento,
        ...(categoria !== '' ? { categoria } : {}),
        ...(receber && quem !== '' ? { studentId: quem } : {}),
        ...(receber && quem === '' && pagador.trim() !== ''
          ? { fornecedor: pagador.trim() }
          : {}),
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
          {/* O que o sistema ENTENDEU, por extenso — ver dataPorExtenso. */}
          <span className="campo-dica">{dataPorExtenso(vencimento) ?? 'Escolha a data do vencimento.'}</span>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">{receber ? 'Aluno' : 'Fornecedor'}</span>
          {receber ? (
            <select value={quem} onChange={(e) => setQuem(e.target.value)}>
              {/* "Não é aluno" e não "sem aluno vinculado": toda conta a
                  receber tem devedor. O que pode faltar é a MATRÍCULA
                  dele, não o nome. */}
              <option value="">
                {alunos.length === 0 ? 'Nenhum aluno cadastrado ainda' : 'Não é aluno — vou escrever o nome'}
              </option>
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

        {/* Só aparece quando faz falta — e no primeiro dia da academia,
            sem nenhum aluno cadastrado, é o único caminho possível. */}
        {receber && quem === '' && (
          <label className="campo campo-meia">
            <span className="campo-rotulo">Quem paga</span>
            <input
              value={pagador}
              onChange={(e) => setPagador(e.target.value)}
              placeholder="Nome de quem vai pagar"
              maxLength={160}
            />
          </label>
        )}
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
  const [previa, setPrevia] = useState<Awaited<ReturnType<typeof api.buscarComissao>> | null>(null);
  const [fechado, setFechado] = useState<api.FechamentoDeComissao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [baixando, setBaixando] = useState(false);
  const [versao, setVersao] = useState(0);

  /* SÓ QUEM LÊ A EQUIPE ESCOLHE ALGUÉM DA EQUIPE.
     A intenção abaixo sempre foi "o profissional cai direto no próprio
     fechamento" — mas a lista vinha com a academia inteira, e ele podia
     escolher um colega. O servidor negava (404, escopo OWN_PROFESSIONAL,
     medido), então nunca vazou centavo nenhum; o que sobrava era um beco
     sem saída com o nome do colega na porta. */
  const soEuMesmo = !principal.permissions.includes('user:read');
  /* FECHAR É DE QUEM PAGA, não de quem recebe. `commission:settle` é
     do dono e do administrador; o profissional lê o próprio fechamento
     e baixa o PDF, e não fecha o próprio mês. */
  const podeFechar = principal.permissions.includes('commission:settle');

  useEffect(() => {
    api
      .buscarProfissionais()
      .then((r) => {
        const ativos = r.data
          .filter((p) => p.ativo)
          .filter((p) => !soEuMesmo || p.id === principal.id);
        setEquipe(ativos);
        /* O profissional cai direto no PRÓPRIO fechamento: é o único que
           ele pode ver, e obrigá-lo a escolher a si mesmo numa lista de
           um item é perguntar o que já se sabe. */
        setQuem((q) => q || (ativos.find((p) => p.id === principal.id)?.id ?? ativos[0]?.id) || '');
      })
      .catch((e: unknown) =>
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar a equipe.'),
      );
  }, [principal.id, soEuMesmo]);

  useEffect(() => {
    if (quem === '') return;
    let vivo = true;
    setCarregando(true);
    /* AS DUAS COISAS DE UMA VEZ: o cálculo de agora e o fechamento
       gravado, se houver. Qual dos dois a tela mostra é a decisão
       central desta aba, e ela não pode ser tomada com metade da
       informação na mão. */
    void Promise.all([
      api.buscarComissao(quem, mes),
      api.buscarFechamentoDeComissao(quem, mes).then((r) => r.data),
    ])
      .then(([p, f]) => {
        if (!vivo) return;
        setPrevia(p);
        setFechado(f);
        setErro(null);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setPrevia(null);
        setFechado(null);
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao calcular.');
      })
      .finally(() => vivo && setCarregando(false));
    return () => {
      vivo = false;
    };
  }, [quem, mes, versao]);

  /* O AVISO SÓ SOME QUANDO A PERGUNTA MUDA — trocar de profissional ou
     de mês. Limpá-lo dentro do efeito de carga apagava a confirmação de
     "mês fechado" no mesmo instante em que ela aparecia: fechar dispara
     a recarga, a recarga limpava o aviso, e a única prova de que o
     clique funcionou piscava e sumia. */
  useEffect(() => setAviso(null), [quem, mes]);

  const agir = async (fn: () => Promise<unknown>, sucesso: string): Promise<void> => {
    setErro(null);
    setOcupado(true);
    try {
      await fn();
      setAviso(sucesso);
      setVersao((v) => v + 1);
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível concluir.');
    } finally {
      setOcupado(false);
    }
  };

  /* O QUE A TELA MOSTRA: o gravado quando existe, o calculado quando
     não. São os mesmos campos, e o que muda é se eles ainda podem
     mudar. */
  const itens =
    fechado !== null
      ? fechado.itens.map((i) => ({
          descricao: i.descricao,
          baseFormatada: formatCents(i.baseCentavos),
          valorFormatado: formatCents(i.valorCentavos),
          aliquotaBp: i.aliquotaBp,
        }))
      : (previa?.data.itens ?? []).map((i) => ({ ...i, aliquotaBp: null as number | null }));
  const total = fechado?.totalCentavos ?? previa?.data.totalCentavos ?? 0;
  const base = fechado?.baseCentavos ?? previa?.data.baseTotalCentavos ?? 0;
  const aliquota = fechado?.aliquotaMediaBp ?? previa?.data.aliquotaMediaBp ?? 0;

  const nomeDoEscolhido = equipe.find((p) => p.id === quem)?.nome ?? 'este profissional';
  const mesPorExtenso = capitalizar(MES_ANO.format(mes));

  return (
    <>
      {/* Uma pessoa só não é escolha: quem vê apenas o próprio
          fechamento lê o nome, não opera um seletor de um item. */}
      {equipe.length > 1 ? (
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
      ) : (
        equipe[0] !== undefined && (
          <p className="campo fin-selecao">
            <span className="campo-rotulo">Profissional</span>
            <strong>{equipe[0].nome}</strong>
          </p>
        )
      )}

      {erro !== null && <Erro mensagem={erro} />}
      {aviso !== null && (
        <p className="fin-aviso" role="status">
          {aviso}
        </p>
      )}

      {carregando ? (
        <Carregando rotulo="Calculando o fechamento" />
      ) : previa === null && fechado === null ? null : (
        <>
          {/* ==================================================
              A FAIXA DE ESTADO — fechado ou aberto.

              É a primeira coisa da tela porque muda o significado de
              todos os números abaixo dela. O mesmo "R$ 1.240,00"
              quer dizer "é isto que ele vai receber" quando o mês
              está fechado, e "é isto se nada mais entrar" quando não
              está. Sem dizer qual dos dois, a tela deixa a pessoa
              escolher a leitura errada — e o erro só aparece no dia
              do pagamento.
              ================================================== */}
          <div className={`fech-faixa ${fechado === null ? 'aberta' : 'fechada'}`}>
            <div className="fech-estado">
              <span className="pilula-grande">
                {fechado === null ? 'Mês em aberto' : 'Mês fechado'}
              </span>
              <p>
                {fechado === null ? (
                  <>
                    Os números são os de agora e ainda podem mudar: uma baixa lançada hoje com data
                    de {mesPorExtenso.toLowerCase()} entra nesta conta.
                  </>
                ) : (
                  <>
                    Congelado em {new Date(fechado.fechadoEm).toLocaleDateString('pt-BR')}. O
                    repasse virou uma conta a pagar
                    {fechado.lancamentoVencimento === null
                      ? ''
                      : `, com vencimento em ${fechado.lancamentoVencimento.split('-').reverse().join('/')}`}
                    {fechado.quitado
                      ? ' — e já foi quitada.'
                      : fechado.lancamentoPagoCentavos > 0
                        ? ` — paga até aqui: ${fechado.pagoFormatado}.`
                        : ' — ainda não paga.'}
                  </>
                )}
              </p>
            </div>

            <div className="fech-acoes">
              {/* O PDF SAI DOS DOIS JEITOS, e o documento diz qual dos
                  dois é: quem só quer conferir antes de fechar precisa
                  do papel também. */}
              <button
                type="button"
                className="botao-secundario"
                disabled={baixando || quem === ''}
                onClick={() => {
                  setBaixando(true);
                  void api
                    .baixarFechamentoDoProfissional(quem, mes)
                    .catch((e: unknown) =>
                      setErro(e instanceof api.ApiError ? e.message : 'Falha ao gerar o PDF.'),
                    )
                    .finally(() => setBaixando(false));
                }}
              >
                {baixando ? 'Gerando…' : fechado === null ? 'Baixar prévia' : 'Baixar recibo'}
              </button>

              {podeFechar &&
                (fechado === null ? (
                  <button
                    type="button"
                    className="botao-acao"
                    disabled={ocupado || total <= 0}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Fechar ${mesPorExtenso.toLowerCase()} de ${nomeDoEscolhido}?\n\n` +
                            `Valor: ${formatCents(total)}\n\n` +
                            'Os números ficam congelados e o repasse entra em "A pagar". Fechar não paga — a baixa é lá.',
                        )
                      ) {
                        void agir(
                          () => api.fecharMesDoProfissional(quem, mes),
                          `Mês fechado. O repasse de ${formatCents(total)} está em "A pagar".`,
                        );
                      }
                    }}
                  >
                    {ocupado ? 'Fechando…' : 'Fechar o mês'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="botao-texto"
                    disabled={ocupado}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Reabrir ${mesPorExtenso.toLowerCase()} de ${nomeDoEscolhido}?\n\n` +
                            'O fechamento é apagado e a conta a pagar do repasse é cancelada. Só funciona enquanto ninguém deu baixa nela.',
                        )
                      ) {
                        void agir(
                          () => api.reabrirMesDoProfissional(quem, mes),
                          'Mês reaberto. O lançamento do repasse foi cancelado.',
                        );
                      }
                    }}
                  >
                    Reabrir
                  </button>
                ))}
            </div>
          </div>

          {itens.length === 0 ? (
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
                  valor={total}
                  nota={`${itens.length} recebimento${itens.length === 1 ? '' : 's'}`}
                />
                <Kpi
                  rotulo="Base de cálculo"
                  valor={base}
                  nota="o que entrou por este profissional"
                />
                <div className="fin-kpi">
                  <span className="fin-kpi-rotulo">Percentual médio</span>
                  <strong className="fin-kpi-valor">
                    {(aliquota / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%
                  </strong>
                  <span className="fin-kpi-nota">ponderado pelo valor</span>
                </div>
                <Kpi
                  rotulo="Fica na academia"
                  valor={base - total}
                  nota="a base menos o repasse"
                />
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
                      <th scope="col" className="fin-col-num">
                        Base
                      </th>
                      <th scope="col" className="fin-col-num">
                        %
                      </th>
                      <th scope="col" className="fin-col-num">
                        Comissão
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {itens.map((i, n) => (
                      <tr key={`${i.descricao}-${n}`}>
                        <td>{i.descricao}</td>
                        <td className="fin-col-num">
                          <span className="dinheiro">{i.baseFormatada}</span>
                        </td>
                        <td className="fin-col-num tabular">
                          {i.aliquotaBp === null
                            ? '—'
                            : `${(i.aliquotaBp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`}
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
const CICLOS_FIXOS: { valor: string; nome: string; porAno: number }[] = [
  { valor: 'MONTHLY', nome: 'Todo mês', porAno: 12 },
  { valor: 'QUARTERLY', nome: 'A cada 3 meses', porAno: 4 },
  { valor: 'SEMIANNUAL', nome: 'A cada 6 meses', porAno: 2 },
  { valor: 'ANNUAL', nome: 'Uma vez por ano', porAno: 1 },
];

/** O que este molde representa por MÊS, para poder somar tudo junto. */
function porMesDoCiclo(valorCentavos: number, ciclo: string): number {
  const c = CICLOS_FIXOS.find((x) => x.valor === ciclo);
  return c === undefined ? 0 : Math.round((valorCentavos * c.porAno) / 12);
}

/**
 * A aba das coisas que se repetem.
 *
 * SÃO DUAS FONTES DIFERENTES, e a tela mostra as duas porque a pergunta
 * de quem abre aqui é uma só — *o que nasce sozinho* — e ela não separa
 * por origem:
 *
 *   CONTAS FIXAS  → cadastradas aqui. Aluguel, energia, contador, a sala
 *     que a academia subloca. Direção livre: sai ou entra.
 *   MENSALIDADES  → nascem do CONTRATO do aluno, que mora no cadastro
 *     dele. São mostradas, não editadas: mexer no valor da mensalidade
 *     por esta tela seria mexer no contrato pelas costas de quem o
 *     assinou.
 *
 * O QUE ESTA ABA ERA. Só a segunda lista, sem cadastro nenhum. A tabela
 * `finance_recurrences` existia no banco desde o primeiro dia e nunca
 * teve uma linha: o aluguel era digitado à mão todo mês, e no mês em que
 * alguém esquecia, o "a pagar" mentia.
 */
function Recorrencias({ podeEscrever }: { podeEscrever: boolean }): ReactNode {
  const [fixas, setFixas] = useState<api.ContaFixa[] | null>(null);
  const [contratos, setContratos] = useState<api.Recorrencia[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [editando, setEditando] = useState<api.ContaFixa | 'nova' | null>(null);
  const [versao, setVersao] = useState(0);

  const recarregar = useCallback(() => setVersao((v) => v + 1), []);

  useEffect(() => {
    let vivo = true;
    void Promise.all([
      api.buscarContasFixas().then((r) => r.data),
      api.buscarRecorrencias().then((r) => r.data),
    ])
      .then(([f, c]) => {
        if (!vivo) return;
        setFixas(f);
        setContratos(c);
        setErro(null);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setFixas([]);
        setContratos([]);
        setErro(e instanceof api.ApiError ? e.message : 'Falha ao carregar.');
      });
    return () => {
      vivo = false;
    };
  }, [versao]);

  if (editando !== null) {
    return (
      <FormularioDeContaFixa
        conta={editando === 'nova' ? null : editando}
        aoSair={() => setEditando(null)}
        aoSalvar={(geradas) => {
          setEditando(null);
          setAviso(
            geradas > 0
              ? `Pronto. ${geradas} lançamento${geradas === 1 ? '' : 's'} ${geradas === 1 ? 'já entrou' : 'já entraram'} nas contas do período.`
              : 'Pronto. O próximo lançamento nasce na data combinada.',
          );
          recarregar();
        }}
      />
    );
  }

  const ativas = (fixas ?? []).filter((f) => f.ativa);
  const saiPorMes = ativas
    .filter((f) => f.direcao === 'PAYABLE')
    .reduce((a, f) => a + porMesDoCiclo(f.valorCentavos, f.ciclo), 0);
  const entraPorMes =
    ativas
      .filter((f) => f.direcao === 'RECEIVABLE')
      .reduce((a, f) => a + porMesDoCiclo(f.valorCentavos, f.ciclo), 0) +
    (contratos ?? [])
      .filter((c) => c.ciclo === 'MONTHLY' && !c.encerrandoNoFim)
      .reduce((a, c) => a + c.valorCentavos, 0);

  return (
    <>
      {erro !== null && <Erro mensagem={erro} />}
      {aviso !== null && (
        <p className="fin-aviso" role="status">
          {aviso}
        </p>
      )}

      {/* O SALDO DO QUE SE REPETE, antes das listas. É a única pergunta
          que ninguém consegue responder olhando as linhas: quanto desta
          academia já está comprometido antes de o mês começar. */}
      <div className="fin-kpis fin-kpis-largo">
        <Kpi
          rotulo="Entra por mês"
          valor={entraPorMes}
          nota="mensalidades dos contratos e receitas fixas"
        />
        <Kpi rotulo="Sai por mês" valor={saiPorMes} nota="aluguel, energia e o resto do fixo" />
        <div className="fin-kpi">
          <span className="fin-kpi-rotulo">Sobra antes do resto</span>
          <strong className={`fin-kpi-valor ${entraPorMes - saiPorMes < 0 ? 'negativo' : ''}`}>
            {formatCents(entraPorMes - saiPorMes)}
          </strong>
          <span className="fin-kpi-nota">
            {/* O ciclo é normalizado para o mês: um contador trimestral
                de R$ 900 pesa R$ 300 por mês. Somar o valor cheio de um
                anual junto com um mensal daria um número que não é
                despesa de mês nenhum. */}
            só o que se repete, já rateado por mês
          </span>
        </div>
      </div>

      <div className="secao-cabecalho linha-cabecalho fin-fixas-topo">
        <div>
          <h2 className="plt-titulo">Contas fixas</h2>
          <p className="rel-apoio">
            O que nasce sozinho na data combinada — de um lado e do outro do caixa. Mudar o valor
            vale do próximo em diante; o que já foi lançado não muda.
          </p>
        </div>
        {podeEscrever && (
          <button type="button" className="botao-acao" onClick={() => setEditando('nova')}>
            <span aria-hidden="true">+</span> Nova conta fixa
          </button>
        )}
      </div>

      {fixas === null ? (
        <Carregando rotulo="Carregando as contas fixas" />
      ) : fixas.length === 0 ? (
        <Vazio
          titulo="Nenhuma conta fixa ainda."
          descricao="Aluguel, energia, internet, contador. Cadastre uma vez e ela aparece em “A pagar” todo mês, na data certa, sem ninguém lembrar."
        />
      ) : (
        <div className="fix-grade">
          {fixas.map((f) => (
            <CartaoDeContaFixa
              key={f.id}
              conta={f}
              podeEscrever={podeEscrever}
              aoEditar={() => setEditando(f)}
              aoMudar={recarregar}
              aoFalhar={setErro}
            />
          ))}
        </div>
      )}

      {/* ==================================================
          AS MENSALIDADES, embaixo e sem botão de editar.
          Elas nascem do contrato do aluno; esta tela mostra o
          resultado, e quem muda o contrato é o cadastro dele.
          ================================================== */}
      <h2 className="plt-titulo fix-titulo-contratos">Mensalidades dos alunos</h2>
      <p className="rel-apoio">
        Nascem do contrato de cada aluno, que fica no cadastro dele. Aqui é só para conferir o que
        vai entrar.
      </p>

      {contratos === null ? (
        <Carregando rotulo="Carregando os contratos" />
      ) : contratos.length === 0 ? (
        <Vazio
          titulo="Nenhum contrato ativo."
          descricao="O plano do aluno é definido no cadastro dele. É o contrato que faz a mensalidade nascer sozinha todo mês."
        />
      ) : (
        <div className="rolo">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Aluno</th>
                <th scope="col">Plano</th>
                <th scope="col" className="fin-col-num">
                  Valor
                </th>
                <th scope="col">Cobra dia</th>
                <th scope="col">Situação</th>
              </tr>
            </thead>
            <tbody>
              {contratos.map((r) => (
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
      )}
    </>
  );
}

/**
 * Uma conta fixa, como cartão.
 *
 * CARTÃO E NÃO LINHA DE TABELA. Uma conta fixa tem sete campos que
 * importam juntos — o que é, para quem, quanto, quando, desde quando,
 * quantas já nasceram, quantas estão vencidas — e uma tabela com sete
 * colunas obriga a rolar na horizontal para ler uma linha inteira. São
 * poucas por academia: cabem lado a lado.
 */
function CartaoDeContaFixa({
  conta: f,
  podeEscrever,
  aoEditar,
  aoMudar,
  aoFalhar,
}: {
  conta: api.ContaFixa;
  podeEscrever: boolean;
  aoEditar: () => void;
  aoMudar: () => void;
  aoFalhar: (m: string) => void;
}): ReactNode {
  const [ocupado, setOcupado] = useState(false);
  const sai = f.direcao === 'PAYABLE';

  const agir = async (fn: () => Promise<unknown>): Promise<void> => {
    setOcupado(true);
    try {
      await fn();
      aoMudar();
    } catch (e) {
      aoFalhar(e instanceof api.ApiError ? e.message : 'Não foi possível concluir.');
      setOcupado(false);
    }
  };

  return (
    <article className={`fix-cartao ${f.ativa ? '' : 'pausada'} ${sai ? 'sai' : 'entra'}`}>
      <header className="fix-cabeca">
        {/* A DIREÇÃO É A PRIMEIRA COISA e não uma cor só: numa lista
            misturada, confundir uma receita fixa com uma despesa fixa
            inverte o sinal da conta que a pessoa está fazendo de
            cabeça. */}
        <span className={`pilula ${sai ? 'atrasada' : 'viva'}`}>{sai ? 'Sai' : 'Entra'}</span>
        {!f.ativa && <span className="pilula apagada">pausada</span>}
        {f.vencidasAbertas > 0 && (
          <span className="pilula atrasada">
            {f.vencidasAbertas} vencida{f.vencidasAbertas === 1 ? '' : 's'}
          </span>
        )}
      </header>

      <h3 className="fix-nome">{f.descricao}</h3>
      <p className="fix-quem">
        {f.aluno ?? f.contraparte ?? (sai ? 'sem fornecedor' : 'sem pagador')}
        {f.categoria !== null && f.categoria !== '' && ` · ${f.categoria}`}
      </p>

      <p className="fix-valor">
        <strong className="dinheiro">{f.valorFormatado}</strong>
        <span>
          {CICLOS_FIXOS.find((c) => c.valor === f.ciclo)?.nome ?? f.ciclo}, dia {f.diaDeCobranca}
        </span>
      </p>

      <dl className="fix-fatos">
        <div>
          <dt>Já lançadas</dt>
          <dd className="tabular">{f.geradas}</dd>
        </div>
        <div>
          <dt>Desde</dt>
          <dd className="tabular">{f.inicio.slice(0, 7).split('-').reverse().join('/')}</dd>
        </div>
        <div>
          <dt>{f.fim === null ? 'Até' : 'Encerra em'}</dt>
          <dd className="tabular">
            {f.fim === null ? 'sem prazo' : f.fim.split('-').reverse().join('/')}
          </dd>
        </div>
      </dl>

      {podeEscrever && (
        <footer className="fix-acoes">
          <button type="button" className="botao-texto" onClick={aoEditar} disabled={ocupado}>
            Editar
          </button>
          <button
            type="button"
            className="botao-texto"
            disabled={ocupado}
            onClick={() => void agir(() => api.alterarContaFixa(f.id, { ativa: !f.ativa }))}
          >
            {f.ativa ? 'Pausar' : 'Retomar'}
          </button>
          <button
            type="button"
            className="botao-texto-perigo"
            disabled={ocupado}
            onClick={() => {
              /* O AVISO DIZ O QUE *NÃO* ACONTECE. O medo de quem clica
                 aqui é apagar o histórico junto; dizer que ele fica é o
                 que transforma "não vou mexer" em "pode excluir". */
              if (
                window.confirm(
                  `Excluir "${f.descricao}"?\n\nEla para de nascer. Os ${f.geradas} lançamento${f.geradas === 1 ? '' : 's'} que já ${f.geradas === 1 ? 'nasceu' : 'nasceram'} continua${f.geradas === 1 ? '' : 'm'} no financeiro, com o histórico de pagamento.`,
                )
              ) {
                void agir(() => api.excluirContaFixa(f.id));
              }
            }}
          >
            Excluir
          </button>
        </footer>
      )}
    </article>
  );
}

/**
 * Cadastrar ou alterar uma conta fixa.
 *
 * O QUE NÃO MUDA NA EDIÇÃO: a direção e a data de início. Ambas já
 * produziram lançamentos, e trocá-las não reescreveria o passado —
 * deixaria o molde descrevendo uma coisa e o extrato mostrando outra.
 * Quem errou a direção exclui e cadastra de novo, que é honesto.
 */
function FormularioDeContaFixa({
  conta,
  aoSair,
  aoSalvar,
}: {
  conta: api.ContaFixa | null;
  aoSair: () => void;
  aoSalvar: (geradas: number) => void;
}): ReactNode {
  const nova = conta === null;
  const [direcao, setDirecao] = useState<api.DirecaoLancamento>(conta?.direcao ?? 'PAYABLE');
  const [descricao, setDescricao] = useState(conta?.descricao ?? '');
  const [valor, setValor] = useState(
    conta === null ? '' : (conta.valorCentavos / 100).toFixed(2).replace('.', ','),
  );
  const [ciclo, setCiclo] = useState(conta?.ciclo ?? 'MONTHLY');
  const [dia, setDia] = useState(String(conta?.diaDeCobranca ?? 10));
  const [contraparte, setContraparte] = useState(conta?.contraparte ?? '');
  const [categoria, setCategoria] = useState(conta?.categoria ?? '');
  const [inicio, setInicio] = useState(() => {
    if (conta !== null) return conta.inicio;
    const h = new Date();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [fim, setFim] = useState(conta?.fim ?? '');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const sai = direcao === 'PAYABLE';

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);

    if (contraparte.trim() === '' && !sai) {
      setErro('Diga de quem você vai receber.');
      return;
    }
    setEnviando(true);
    try {
      if (nova) {
        const r = await api.criarContaFixa({
          direcao,
          descricao: descricao.trim(),
          valor,
          ciclo,
          diaDeCobranca: Number(dia),
          inicio,
          ...(categoria.trim() !== '' ? { categoria: categoria.trim() } : {}),
          ...(contraparte.trim() !== '' ? { contraparte: contraparte.trim() } : {}),
          ...(fim !== '' ? { fim } : {}),
        });
        aoSalvar(r.data.geradas);
      } else {
        await api.alterarContaFixa(conta.id, {
          descricao: descricao.trim(),
          valor,
          ciclo,
          diaDeCobranca: Number(dia),
          categoria: categoria.trim() === '' ? null : categoria.trim(),
          contraparte: contraparte.trim() === '' ? null : contraparte.trim(),
          fim: fim === '' ? null : fim,
        });
        aoSalvar(0);
      }
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível salvar.');
      setEnviando(false);
    }
  };

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Voltar
      </button>
      <div className="secao-cabecalho">
        <h1>{nova ? 'Nova conta fixa' : `Editar ${conta.descricao}`}</h1>
        <p>
          {nova
            ? 'Cadastre uma vez e ela nasce sozinha na data combinada, todo período, até você mandar parar.'
            : 'A alteração vale do próximo lançamento em diante. O que já nasceu fica como está.'}
        </p>
      </div>

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        {/* A DIREÇÃO PRIMEIRO e como escolha visível, não como um select
            no meio do formulário: ela muda o rótulo de metade dos campos
            abaixo, e descobrir isso depois de preencher é refazer. */}
        <fieldset className="campo campo-cheia fix-direcao" disabled={!nova}>
          <legend className="campo-rotulo">Esta conta</legend>
          <div className="fix-direcao-opcoes">
            <label className={`fix-opcao ${sai ? 'ativa' : ''}`}>
              <input
                type="radio"
                name="direcao"
                checked={sai}
                onChange={() => setDirecao('PAYABLE')}
              />
              <span>
                <strong>Sai da academia</strong>
                <span className="campo-dica">Aluguel, energia, internet, contador.</span>
              </span>
            </label>
            <label className={`fix-opcao ${sai ? '' : 'ativa'}`}>
              <input
                type="radio"
                name="direcao"
                checked={!sai}
                onChange={() => setDirecao('RECEIVABLE')}
              />
              <span>
                <strong>Entra na academia</strong>
                <span className="campo-dica">Sublocação de sala, parceria, patrocínio.</span>
              </span>
            </label>
          </div>
          {!nova && (
            <span className="campo-dica">
              A direção não muda depois de cadastrada — ela já gerou lançamentos.
            </span>
          )}
        </fieldset>

        <label className="campo campo-cheia">
          <span className="campo-rotulo">O que é</span>
          <input
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            required
            autoFocus
            maxLength={200}
            placeholder={sai ? 'Aluguel do salão' : 'Sublocação da sala 2'}
          />
          <span className="campo-dica">
            O mês entra no fim sozinho: “{descricao.trim() === '' ? 'Aluguel do salão' : descricao.trim()} 08/2026”.
          </span>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Valor</span>
          <input
            inputMode="decimal"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            required
            placeholder="2.500,00"
          />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">{sai ? 'Para quem' : 'De quem'}</span>
          <input
            value={contraparte}
            onChange={(e) => setContraparte(e.target.value)}
            maxLength={160}
            placeholder={sai ? 'Imobiliária Central' : 'Studio vizinho'}
          />
          {!sai && (
            <span className="campo-dica">Obrigatório: toda conta a receber tem devedor.</span>
          )}
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Repete</span>
          <select value={ciclo} onChange={(e) => setCiclo(e.target.value)}>
            {CICLOS_FIXOS.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.nome}
              </option>
            ))}
          </select>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Vence no dia</span>
          <select value={dia} onChange={(e) => setDia(e.target.value)}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={String(d)}>
                {d}
              </option>
            ))}
          </select>
          {/* O TETO DE 28 É EXPLICADO, e não só imposto: quem procura o
              31 precisa saber por que ele não está lá, senão conclui que
              o campo está quebrado. */}
          <span className="campo-dica">
            Até 28 — é o maior dia que existe em todo mês, inclusive fevereiro.
          </span>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Começou em</span>
          <input
            type="date"
            value={inicio}
            onChange={(e) => setInicio(e.target.value)}
            required
            disabled={!nova}
          />
          <span className="campo-dica">
            {nova
              ? 'Se for uma data passada, os meses que faltam entram agora, de uma vez.'
              : 'Não muda: os lançamentos anteriores já saíram daqui.'}
          </span>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Encerra em (opcional)</span>
          <input type="date" value={fim} onChange={(e) => setFim(e.target.value)} />
          <span className="campo-dica">
            {fim === '' ? 'Em branco, repete para sempre.' : (dataPorExtenso(fim) ?? '')}
          </span>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Categoria (opcional)</span>
          <input
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            maxLength={80}
            placeholder={sai ? 'Ocupação, pessoal…' : 'Parceria…'}
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
            {enviando ? 'Salvando…' : nova ? 'Cadastrar' : 'Salvar'}
          </button>
        </div>
      </form>
    </>
  );
}

/* ====================================================================
 * Relatórios
 * ================================================================== */

/**
 * O gráfico de caixa — doze meses de entrada, saída e saldo.
 *
 * SVG E NÃO UMA PILHA DE `div`s COM ALTURA EM PORCENTAGEM. A versão
 * anterior desenhava duas caixas por mês e mais nada: sem eixo, sem
 * escala, sem o saldo. Dava para ver que um mês era maior que o outro e
 * não dava para dizer quanto — o que faz o gráfico ocupar meia tela para
 * responder menos do que a tabela ao lado.
 *
 * O SALDO É UMA LINHA POR CIMA DAS BARRAS, e é a informação que
 * ninguém consegue montar de cabeça: entrou e saiu são dois números, e
 * a pergunta é sobre a diferença entre eles ao longo do tempo. Com a
 * linha, um mês que virou negativo salta; sem ela, é preciso comparar
 * duas alturas mês a mês.
 *
 * A LINHA DO ZERO É DESENHADA SEMPRE, mesmo quando nada fica abaixo
 * dela. É o que dá sentido à altura de tudo o mais — um gráfico de
 * dinheiro sem o zero visível deixa a impressão de que a menor barra é
 * "nada", quando ela pode ser oito mil reais.
 */
function GraficoDeCaixa({
  fluxo,
  mesEmFoco,
}: {
  fluxo: api.Relatorios['fluxo'];
  mesEmFoco: string;
}): ReactNode {
  const L = 62; /* espaço da escala, à esquerda */
  const R = 8;
  const T = 12;
  const B = 26; /* espaço dos nomes dos meses, embaixo */
  const LARG = 760;
  const ALT = 250;
  const util = LARG - L - R;
  const alturaUtil = ALT - T - B;

  const maiorBarra = Math.max(...fluxo.map((m) => Math.max(m.recebidoCentavos, m.pagoCentavos)), 0);
  const menorSaldo = Math.min(...fluxo.map((m) => m.saldoCentavos), 0);
  const teto = Math.max(maiorBarra, ...fluxo.map((m) => m.saldoCentavos), 1);
  const piso = Math.min(menorSaldo, 0);
  const faixa = teto - piso || 1;

  /* Um valor em centavos vira uma coordenada vertical. Tudo o que é
     desenhado passa por aqui — barra, linha do saldo e a régua —, então
     a escala não tem como divergir entre as três. */
  const y = (centavos: number): number => T + alturaUtil * (1 - (centavos - piso) / faixa);
  const passo = util / Math.max(fluxo.length, 1);
  const meio = (i: number): number => L + passo * i + passo / 2;

  /* Três marcas: o teto, o meio e o zero. Mais linhas não ajudam a ler
     dinheiro — ajudam a poluir. */
  const reguas = [teto, (teto + piso) / 2, 0].filter(
    (v, i, a) => a.indexOf(v) === i && v <= teto && v >= piso,
  );

  const curto = (centavos: number): string => {
    const reais = centavos / 100;
    if (Math.abs(reais) >= 1000) return `${Math.round(reais / 1000)}k`;
    return String(Math.round(reais));
  };

  const vazio = fluxo.every((m) => m.recebidoCentavos === 0 && m.pagoCentavos === 0);

  if (vazio) {
    /* O GRÁFICO VAZIO ERA O PIOR RESULTADO POSSÍVEL: doze tocos de dois
       pixels, que parecem um defeito de desenho e não uma academia sem
       baixa lançada. Dizer o que falta é a única leitura útil aqui. */
    return (
      <div className="rel-vazio">
        <p>
          <strong>Nenhum pagamento registrado nos últimos 12 meses.</strong>
        </p>
        <p>
          O gráfico é feito de BAIXAS, não de cobranças: uma mensalidade lançada aparece em “A
          receber”, e só entra aqui quando alguém clica em “Dar baixa”. É o que separa o previsto do
          que realmente entrou no caixa.
        </p>
      </div>
    );
  }

  const linhaDoSaldo = fluxo
    .map((m, i) => `${i === 0 ? 'M' : 'L'} ${meio(i).toFixed(1)} ${y(m.saldoCentavos).toFixed(1)}`)
    .join(' ');

  return (
    <figure className="rel-grafico">
      <svg
        viewBox={`0 0 ${LARG} ${ALT}`}
        role="img"
        aria-label={`Entradas, saídas e saldo dos últimos ${fluxo.length} meses`}
      >
        {reguas.map((v) => (
          <g key={v}>
            <line
              x1={L}
              x2={LARG - R}
              y1={y(v)}
              y2={y(v)}
              className={v === 0 ? 'rel-zero' : 'rel-regua'}
            />
            <text x={L - 8} y={y(v) + 3.5} className="rel-escala" textAnchor="end">
              {v === 0 ? '0' : `R$ ${curto(v)}`}
            </text>
          </g>
        ))}

        {fluxo.map((m, i) => {
          const larguraBarra = Math.min(13, passo * 0.3);
          const base = y(0);
          const foco = m.mes === mesEmFoco;
          return (
            <g key={m.mes} className={foco ? 'rel-col foco' : 'rel-col'}>
              {foco && (
                /* O MÊS QUE A TELA ESTÁ MOSTRANDO, marcado. Sem isto, o
                   gráfico e os números acima dele falam de períodos
                   diferentes sem avisar. */
                <rect x={L + passo * i} y={T} width={passo} height={alturaUtil} className="rel-foco" />
              )}
              <rect
                x={meio(i) - larguraBarra - 1}
                y={y(m.recebidoCentavos)}
                width={larguraBarra}
                height={Math.max(1, base - y(m.recebidoCentavos))}
                className="rel-b-entrou"
              >
                <title>{`${m.mes}: entrou ${formatCents(m.recebidoCentavos)}`}</title>
              </rect>
              <rect
                x={meio(i) + 1}
                y={y(m.pagoCentavos)}
                width={larguraBarra}
                height={Math.max(1, base - y(m.pagoCentavos))}
                className="rel-b-saiu"
              >
                <title>{`${m.mes}: saiu ${formatCents(m.pagoCentavos)}`}</title>
              </rect>
            </g>
          );
        })}

        <path d={linhaDoSaldo} className="rel-linha-saldo" fill="none" />
        {fluxo.map((m, i) => (
          <circle
            key={m.mes}
            cx={meio(i)}
            cy={y(m.saldoCentavos)}
            r={2.6}
            className={`rel-ponto ${m.saldoCentavos < 0 ? 'negativo' : ''}`}
          >
            <title>{`${m.mes}: saldo ${formatCents(m.saldoCentavos)}`}</title>
          </circle>
        ))}

        {fluxo.map((m, i) => (
          <text
            key={m.mes}
            x={meio(i)}
            y={ALT - 8}
            className={`rel-mes-eixo ${m.mes === mesEmFoco ? 'foco' : ''}`}
            textAnchor="middle"
          >
            {m.mes.slice(5)}
          </text>
        ))}
      </svg>

      <figcaption className="rel-legenda">
        <span className="rel-chave entrou">entrou</span>
        <span className="rel-chave saiu">saiu</span>
        <span className="rel-chave saldo">saldo do mês</span>
      </figcaption>
    </figure>
  );
}

/** A variação de um número contra o anterior, em pontos percentuais. */
function variacao(agora: number, antes: number): { texto: string; tom: string } | null {
  if (antes === 0) return null;
  const pct = Math.round(((agora - antes) / Math.abs(antes)) * 100);
  if (pct === 0) return { texto: 'igual ao mês anterior', tom: 'neutro' };
  return {
    texto: `${pct > 0 ? '+' : ''}${pct}% vs. o mês anterior`,
    tom: pct > 0 ? 'sobe' : 'desce',
  };
}

/**
 * Relatórios.
 *
 * A ORDEM DAS PERGUNTAS É A DA CONVERSA DO FIM DO MÊS, e não a do
 * modelo de dados:
 *
 *   1. como foi o mês?          → o resumo, com a comparação
 *   2. estou melhorando?        → o gráfico de doze meses
 *   3. para onde vai o dinheiro?→ as categorias
 *   4. quem eu cobro hoje?      → a inadimplência, por faixa de atraso
 *   5. o que eu levo impresso?  → os PDFs
 *
 * OS PDFs FICAM POR ÚLTIMO e não em primeiro, que é onde estavam. Eles
 * são o que se leva PARA a reunião, e ninguém pede o papel antes de
 * olhar o número: a fileira de três botões abrindo a aba empurrava todo
 * o conteúdo para baixo da dobra e fazia a tela parecer uma gaveta de
 * downloads.
 */
function Relatorios({ de, ate, mes }: { de: Date; ate: Date; mes: Date }): ReactNode {
  const [dados, setDados] = useState<api.Relatorios | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [baixandoCsv, setBaixandoCsv] = useState(false);

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

  const chaveDoMes = `${mes.getFullYear()}-${String(mes.getMonth() + 1).padStart(2, '0')}`;
  const indice = dados.fluxo.findIndex((m) => m.mes === chaveDoMes);
  const atual = dados.fluxo[indice] ?? { recebidoCentavos: 0, pagoCentavos: 0, saldoCentavos: 0 };
  const anterior = indice > 0 ? dados.fluxo[indice - 1] : undefined;

  const recebido = atual.recebidoCentavos;
  const pago = atual.pagoCentavos;
  const saldo = atual.saldoCentavos;

  /* A MÉDIA DE DOZE MESES ao lado do mês: um mês sozinho não diz se foi
     bom. R$ 12 mil é ótimo numa academia que faz 9 e ruim numa que faz
     15, e a tela é a mesma nos dois casos. */
  const mesesComMovimento = dados.fluxo.filter(
    (m) => m.recebidoCentavos > 0 || m.pagoCentavos > 0,
  );
  const mediaRecebido =
    mesesComMovimento.length === 0
      ? 0
      : Math.round(
          mesesComMovimento.reduce((a, m) => a + m.recebidoCentavos, 0) / mesesComMovimento.length,
        );

  const entrouPorCategoria = dados.categorias.filter((c) => c.direcao === 'RECEIVABLE');
  const saiuPorCategoria = dados.categorias.filter((c) => c.direcao === 'PAYABLE');

  /* FAIXAS DE ATRASO, e não uma lista ordenada por dias. Quem deve há
     cinco dias esqueceu o boleto; quem deve há noventa é outra conversa,
     e provavelmente outro telefonema. Separar em três blocos é o que
     transforma a tabela numa lista de tarefas. */
  const faixas = [
    { nome: 'Até 30 dias', teto: 30, apoio: 'lembrete resolve na maioria' },
    { nome: '31 a 60 dias', teto: 60, apoio: 'ligar, não mandar mensagem' },
    { nome: 'Mais de 60 dias', teto: Infinity, apoio: 'decidir: renegociar ou encerrar' },
  ].map((f, i, todas) => {
    const chao = i === 0 ? 0 : todas[i - 1]!.teto;
    const lista = dados.inadimplentes.filter(
      (d) => d.diasDeAtraso > chao && d.diasDeAtraso <= f.teto,
    );
    return { ...f, lista, total: lista.reduce((a, d) => a + d.devendoCentavos, 0) };
  });

  return (
    <>
      {/* ==================================================
          1. COMO FOI O MÊS
          ================================================== */}
      <div className="rel-barra-topo">
        <div>
          <h2 className="plt-titulo">Como foi o mês</h2>
          <p className="rel-apoio">
            Contado pela data do <strong>pagamento</strong> — é a pergunta sobre caixa. Uma
            mensalidade de janeiro paga em março entrou em março.
          </p>
        </div>
        <button
          type="button"
          className="botao-secundario"
          disabled={baixandoCsv}
          onClick={() => {
            setBaixandoCsv(true);
            void api.baixarCsvDoFinanceiro(de, ate).finally(() => setBaixandoCsv(false));
          }}
        >
          {baixandoCsv ? 'Gerando…' : 'Exportar CSV'}
        </button>
      </div>

      <div className="rel-resumo">
        <CartaoDeResumo
          rotulo="Entrou"
          valor={recebido}
          tom="entrou"
          variacao={anterior === undefined ? null : variacao(recebido, anterior.recebidoCentavos)}
          apoio={
            mediaRecebido === 0
              ? undefined
              : `média de 12 meses: ${formatCents(mediaRecebido)}`
          }
        />
        <CartaoDeResumo
          rotulo="Saiu"
          valor={pago}
          tom="saiu"
          variacao={anterior === undefined ? null : variacao(pago, anterior.pagoCentavos)}
        />
        <CartaoDeResumo
          rotulo="Saldo"
          valor={saldo}
          tom={saldo < 0 ? 'negativo' : 'saldo'}
          variacao={anterior === undefined ? null : variacao(saldo, anterior.saldoCentavos)}
          apoio={
            recebido === 0
              ? undefined
              : `${Math.round((saldo / recebido) * 100)}% do que entrou sobrou`
          }
        />
        <CartaoDeResumo
          rotulo="Em atraso agora"
          valor={dados.totalDevendoCentavos}
          tom={dados.totalDevendoCentavos > 0 ? 'negativo' : 'saldo'}
          variacao={null}
          apoio={
            dados.inadimplentes.length === 0
              ? 'ninguém devendo'
              : `${dados.inadimplentes.length} aluno${dados.inadimplentes.length === 1 ? '' : 's'} · posição de hoje, não do período`
          }
        />
      </div>

      {/* ==================================================
          2. ESTOU MELHORANDO
          ================================================== */}
      <h2 className="plt-titulo rel-secao">Doze meses de caixa</h2>
      <GraficoDeCaixa fluxo={dados.fluxo} mesEmFoco={chaveDoMes} />

      {/* ==================================================
          3. PARA ONDE VAI O DINHEIRO
          ================================================== */}
      <h2 className="plt-titulo rel-secao">Para onde vai o dinheiro</h2>
      {dados.categorias.length === 0 ? (
        <p className="rel-apoio">Nenhum pagamento no período — nada a separar por categoria.</p>
      ) : (
        <div className="rel-categorias">
          <ColunaDeCategorias titulo="Entrou" linhas={entrouPorCategoria} direcao="RECEIVABLE" />
          <ColunaDeCategorias titulo="Saiu" linhas={saiuPorCategoria} direcao="PAYABLE" />
        </div>
      )}

      {/* ==================================================
          4. QUEM EU COBRO HOJE
          ================================================== */}
      <h2 className="plt-titulo rel-secao">
        Quem está devendo{' '}
        <span className="rel-total">{formatCents(dados.totalDevendoCentavos)}</span>
      </h2>
      {dados.inadimplentes.length === 0 ? (
        <p className="rel-apoio">Ninguém em atraso. Raro e bom.</p>
      ) : (
        <div className="rel-faixas">
          {faixas.map((f) => (
            <section key={f.nome} className="rel-faixa">
              <header>
                <h3>{f.nome}</h3>
                <strong className="dinheiro">{formatCents(f.total)}</strong>
                <span className="rel-apoio">
                  {f.lista.length === 0
                    ? 'ninguém'
                    : `${f.lista.length} aluno${f.lista.length === 1 ? '' : 's'} · ${f.apoio}`}
                </span>
              </header>
              {f.lista.length > 0 && (
                <ul className="rel-devedores">
                  {f.lista.map((d) => (
                    <li key={d.studentId}>
                      <span className="rel-devedor-nome">
                        <strong>{d.nome}</strong>
                        <span className="celula-apoio">
                          {d.telefone ?? 'sem telefone'} · {d.cobrancas} cobrança
                          {d.cobrancas === 1 ? '' : 's'} · {d.diasDeAtraso} dias
                        </span>
                      </span>
                      <span className="dinheiro">{d.devendoFormatado}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}

      {/* ==================================================
          5. O QUE EU LEVO IMPRESSO
          ================================================== */}
      <PapelTimbrado de={de} ate={ate} mes={mes} />
    </>
  );
}

function CartaoDeResumo({
  rotulo,
  valor,
  tom,
  variacao: v,
  apoio,
}: {
  rotulo: string;
  valor: number;
  tom: string;
  variacao: { texto: string; tom: string } | null;
  apoio?: string | undefined;
}): ReactNode {
  return (
    <div className={`rel-cartao ${tom}`}>
      <span className="rel-cartao-rotulo">{rotulo}</span>
      <strong className="rel-cartao-valor">{formatCents(valor)}</strong>
      {v !== null && <span className={`rel-variacao ${v.tom}`}>{v.texto}</span>}
      {apoio !== undefined && <span className="rel-cartao-apoio">{apoio}</span>}
    </div>
  );
}

function ColunaDeCategorias({
  titulo,
  linhas,
  direcao,
}: {
  titulo: string;
  linhas: api.Relatorios['categorias'];
  direcao: api.DirecaoLancamento;
}): ReactNode {
  const total = linhas.reduce((a, c) => a + c.totalCentavos, 0);

  return (
    <section className="rel-lado">
      <header className="rel-lado-topo">
        <h3>{titulo}</h3>
        <strong className="dinheiro">{formatCents(total)}</strong>
      </header>
      {linhas.length === 0 ? (
        <p className="rel-apoio">Nada neste período.</p>
      ) : (
        linhas.map((c) => {
          const parte = total === 0 ? 0 : (c.totalCentavos / total) * 100;
          return (
            <div key={c.categoria} className="rel-categoria">
              <div className="rel-categoria-topo">
                <span>{c.categoria}</span>
                {/* O PERCENTUAL ESCRITO, e não só a largura da barra. A
                    barra responde "qual é a maior" de relance; o número
                    é o que se leva para a conversa. */}
                <span className="rel-categoria-num">
                  <span className="dinheiro">{c.totalFormatado}</span>
                  <span className="rel-pct">{parte.toFixed(0)}%</span>
                </span>
              </div>
              <span
                className={`rel-fatia ${direcao === 'RECEIVABLE' ? 'entrou' : 'saiu'}`}
                style={{ width: `${Math.max(2, parte)}%` }}
              />
              <span className="rel-categoria-qtd">
                {c.quantidade} lançamento{c.quantidade === 1 ? '' : 's'}
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}

/**
 * Os relatórios em PDF timbrado.
 *
 * FICAM AQUI, e não numa aba própria, porque é aqui que a pergunta
 * nasce: quem está olhando o fechamento do mês é quem precisa levar o
 * papel para a reunião. Uma aba "Relatórios" separada seria mais
 * arrumada e menos usada.
 *
 * E FICAM NO FIM DA ABA, não no começo. Ninguém pede o papel antes de
 * olhar o número — a fileira de botões abrindo a tela empurrava o
 * conteúdo todo para baixo da dobra e fazia a aba parecer uma gaveta de
 * downloads.
 *
 * O PERÍODO É O MESMO da tela — os botões herdam o filtro que já está
 * na barra de cima. Repetir dois campos de data aqui abriria a
 * possibilidade de emitir um relatório de um mês diferente do que se
 * está olhando, sem perceber.
 *
 * A inadimplência é a exceção e não tem período: ela é uma FOTOGRAFIA
 * de agora. "Quem estava devendo em março" é outra pergunta, e uma que
 * o sistema não sabe responder — o saldo de uma cobrança é o de hoje,
 * não o daquele dia.
 */
function PapelTimbrado({ de, ate, mes }: { de: Date; ate: Date; mes: Date }): ReactNode {
  const [equipe, setEquipe] = useState<api.Profissional[]>([]);
  const [profissional, setProfissional] = useState('');
  const [paraFechamento, setParaFechamento] = useState('');
  const [baixando, setBaixando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void api
      .buscarProfissionais()
      .then((r) => {
        if (!vivo) return;
        const ativos = r.data.filter((p) => p.ativo);
        setEquipe(ativos);
        setParaFechamento((q) => q || (ativos[0]?.id ?? ''));
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);

  const baixar = (qual: string, fn: () => Promise<void>): void => {
    setBaixando(qual);
    setErro(null);
    void fn()
      .catch((e: unknown) =>
        setErro(e instanceof api.ApiError ? e.message : 'Não foi possível gerar o PDF.'),
      )
      .finally(() => setBaixando(null));
  };

  return (
    <section className="rel-pdf">
      <h2 className="plt-titulo rel-secao">Para levar impresso</h2>
      <p className="rel-apoio">
        Saem timbrados com a marca e o endereço da academia — o que estiver preenchido em{' '}
        <strong>A academia</strong>. O período é o que está selecionado lá em cima.
      </p>

      {erro !== null && <Erro mensagem={erro} />}

      <div className="rel-pdf-grade">
        {/* O FECHAMENTO VEM PRIMEIRO. É o único destes papéis que sai da
            academia para a mão de outra pessoa, e é o que tem data
            marcada: todo dia 5, alguém precisa dele. */}
        <div className="rel-pdf-item destaque">
          <h3>Fechamento do profissional</h3>
          <p>
            O que ele fez no mês, quanto entrou por ele, o percentual e o valor a receber — com a
            memória de cálculo linha a linha. É o papel que vai junto com o pagamento.
          </p>
          <div className="rel-pdf-acoes">
            <select
              value={paraFechamento}
              onChange={(e) => setParaFechamento(e.target.value)}
              aria-label="Profissional do fechamento"
            >
              {equipe.length === 0 && <option value="">Nenhum profissional ativo</option>}
              {equipe.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="botao-acao"
              disabled={baixando !== null || paraFechamento === ''}
              onClick={() =>
                baixar('fechamento', () =>
                  api.baixarFechamentoDoProfissional(paraFechamento, mes),
                )
              }
            >
              {baixando === 'fechamento' ? 'Gerando…' : 'Baixar'}
            </button>
          </div>
          <p className="rel-pdf-nota">
            Se o mês ainda não foi fechado em <strong>Comissões</strong>, o PDF sai marcado como
            prévia.
          </p>
        </div>

        <div className="rel-pdf-item">
          <h3>Presença no período</h3>
          <p>Quem veio e quem faltou, com a taxa de comparecimento de cada aluno.</p>
          <div className="rel-pdf-acoes">
            <select
              value={profissional}
              onChange={(e) => setProfissional(e.target.value)}
              aria-label="Filtrar por professor"
            >
              <option value="">Toda a academia</option>
              {equipe.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="botao-secundario"
              disabled={baixando !== null}
              onClick={() => baixar('presenca', () => api.baixarPresenca(de, ate, profissional))}
            >
              {baixando === 'presenca' ? 'Gerando…' : 'Baixar'}
            </button>
          </div>
        </div>

        <div className="rel-pdf-item">
          <h3>Ocupação por professor</h3>
          <p>Quantas horas cada um atendeu de fato, pela duração real de cada sessão.</p>
          <div className="rel-pdf-acoes">
            <button
              type="button"
              className="botao-secundario"
              disabled={baixando !== null}
              onClick={() => baixar('ocupacao', () => api.baixarOcupacao(de, ate))}
            >
              {baixando === 'ocupacao' ? 'Gerando…' : 'Baixar'}
            </button>
          </div>
        </div>

        <div className="rel-pdf-item">
          <h3>Inadimplência</h3>
          <p>Quem está devendo e há quantos dias. Posição de agora, não do período.</p>
          <div className="rel-pdf-acoes">
            <button
              type="button"
              className="botao-secundario"
              disabled={baixando !== null}
              onClick={() => baixar('inadimplencia', () => api.baixarInadimplencia())}
            >
              {baixando === 'inadimplencia' ? 'Gerando…' : 'Baixar'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
