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

type Painel = 'receber' | 'pagar' | 'comissoes';

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
 * A situação REAL do lançamento.
 *
 * O `status` gravado no banco só vira OVERDUE quando alguma rotina passa
 * e o atualiza. Enquanto ela não passa, a linha diz "em aberto" com
 * vencimento de uma semana atrás — e o cartão do topo, que conta pela
 * DATA, diz "12 cobranças vencidas". Os dois números na mesma tela, se
 * contradizendo.
 *
 * Vencido é um fato do calendário, não um estado a ser mantido. Quem
 * decide aqui é a data.
 */
function situacaoReal(l: api.Lancamento): api.StatusLancamento {
  if (l.status === 'PAID' || l.status === 'CANCELLED') return l.status;
  if (l.saldoCentavos <= 0) return 'PAID';
  if (l.vencimento.slice(0, 10) < hojeIso()) return 'OVERDUE';
  return l.status;
}

export function Financeiro({ principal }: { principal: Principal }): ReactNode {
  const [painel, setPainel] = useState<Painel>('receber');
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

      {resumo !== null && <Cartoes resumo={resumo} />}

      <div className="fin-abas" role="tablist" aria-label="Áreas do financeiro">
        {(
          [
            ['receber', 'A receber'],
            ['pagar', 'A pagar'],
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
      ) : (
        <Lancamentos
          direcao={painel === 'receber' ? 'RECEIVABLE' : 'PAYABLE'}
          de={de}
          ate={ate}
          aoMudar={carregarResumo}
        />
      )}
    </>
  );
}

/* ====================================================================
 * Os números do mês
 * ================================================================== */

function Cartoes({ resumo }: { resumo: api.ResumoFinanceiro }): ReactNode {
  /* A ORDEM É DELIBERADA: o que está vencido vem primeiro porque é o
     único número desta tela que exige uma ligação hoje. O saldo, que é o
     mais bonito de olhar, vem por último. */
  const cartoes: { rotulo: string; valor: number; nota: string; tom?: string }[] = [
    {
      rotulo: 'Em atraso',
      valor: resumo.inadimplenteCentavos,
      nota:
        resumo.inadimplentesQtd === 0
          ? 'ninguém em atraso'
          : `${resumo.inadimplentesQtd} cobrança${resumo.inadimplentesQtd === 1 ? '' : 's'} vencida${resumo.inadimplentesQtd === 1 ? '' : 's'}`,
      ...(resumo.inadimplenteCentavos > 0 ? { tom: 'erro' } : {}),
    },
    {
      rotulo: 'A receber',
      valor: resumo.aReceberCentavos,
      nota: `${formatCents(resumo.recebidoCentavos)} já entrou`,
    },
    {
      rotulo: 'A pagar',
      valor: resumo.aPagarCentavos,
      nota: `${formatCents(resumo.pagoCentavos)} já saiu`,
    },
    {
      rotulo: 'Saldo realizado',
      valor: resumo.saldoRealizadoCentavos,
      nota: 'o que entrou menos o que saiu',
      ...(resumo.saldoRealizadoCentavos < 0 ? { tom: 'erro' } : {}),
    },
  ];

  return (
    <div className="fin-cartoes">
      {cartoes.map((c) => (
        <div key={c.rotulo} className={`fin-cartao ${c.tom ?? ''}`}>
          <span className="fin-cartao-rotulo">{c.rotulo}</span>
          <strong className="fin-cartao-valor">{formatCents(c.valor)}</strong>
          <span className="fin-cartao-nota">{c.nota}</span>
        </div>
      ))}
    </div>
  );
}

/* ====================================================================
 * A lista, com a baixa embutida
 * ================================================================== */

function Lancamentos({
  direcao,
  de,
  ate,
  aoMudar,
}: {
  direcao: api.DirecaoLancamento;
  de: Date;
  ate: Date;
  aoMudar: () => void;
}): ReactNode {
  const [linhas, setLinhas] = useState<api.Lancamento[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [emAberto, setEmAberto] = useState(false);
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

  const recarregar = (): void => {
    setVersao((v) => v + 1);
    aoMudar();
  };

  /* Vencido no topo, e não a ordem do banco. É a única ordenação que
     responde à pergunta com que a pessoa abriu a tela. */
  const ordenadas = useMemo(() => {
    if (linhas === null) return null;
    const peso = (l: api.Lancamento): number => {
      const s = situacaoReal(l);
      return s === 'OVERDUE' ? 0 : s === 'PAID' || s === 'CANCELLED' ? 2 : 1;
    };
    return [...linhas].sort((a, b) => peso(a) - peso(b) || a.vencimento.localeCompare(b.vencimento));
  }, [linhas]);

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
        <label className="fin-chave">
          <input
            type="checkbox"
            checked={emAberto}
            onChange={(e) => setEmAberto(e.target.checked)}
          />
          <span>Só o que falta receber</span>
        </label>
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
                <th scope="col">Valor</th>
                <th scope="col">Falta</th>
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

  return (
    <>
      <tr className={situacao === 'OVERDUE' ? 'fin-vencida' : ''}>
        <td className="fin-data">{diaMes(l.vencimento)}</td>
        <td>
          <span className="celula-forte">{l.descricao}</span>
          <span className="celula-apoio">
            {l.aluno?.nome ?? l.fornecedor ?? l.categoria ?? '—'}
            {l.parcela !== null && ` · parcela ${l.parcela}`}
          </span>
        </td>
        <td className="fin-numero">{l.valorFormatado}</td>
        <td className="fin-numero">
          {quitado ? <span className="plt-secundario">—</span> : formatCents(l.saldoCentavos)}
        </td>
        <td>
          <span className={`plt-pilula ${TOM_DO_STATUS[situacao]}`}>{NOME_DO_STATUS[situacao]}</span>
        </td>
        <td className="fin-acao">
          {!quitado && (
            <button type="button" className="botao-texto" onClick={aoAbrir}>
              {aberta ? 'Fechar' : 'Dar baixa'}
            </button>
          )}
        </td>
      </tr>
      {aberta && (
        <tr>
          <td colSpan={6} className="fin-baixa-celula">
            <FormularioDeBaixa lancamento={l} aoBaixar={aoBaixar} />
          </td>
        </tr>
      )}
    </>
  );
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

  return (
    <form className="fin-baixa" onSubmit={(e) => void enviar(e)}>
      <label className="campo">
        <span className="campo-rotulo">Valor recebido</span>
        <input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} required autoFocus />
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
      <button type="submit" className="botao-acao" disabled={enviando}>
        {enviando ? 'Registrando…' : 'Confirmar'}
      </button>
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
      <div className="fin-barra">
        <label className="campo campo-busca">
          <span className="campo-rotulo">Profissional</span>
          <select value={quem} onChange={(e) => setQuem(e.target.value)}>
            {equipe.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </label>
      </div>

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
          <div className="fin-cartoes">
            <div className="fin-cartao">
              <span className="fin-cartao-rotulo">A repassar</span>
              <strong className="fin-cartao-valor">{fechamento.data.totalFormatado}</strong>
              <span className="fin-cartao-nota">
                {fechamento.data.itens.length} recebimento
                {fechamento.data.itens.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="fin-cartao">
              <span className="fin-cartao-rotulo">Base de cálculo</span>
              <strong className="fin-cartao-valor">
                {formatCents(fechamento.data.baseTotalCentavos)}
              </strong>
              <span className="fin-cartao-nota">o que entrou por este profissional</span>
            </div>
            <div className="fin-cartao">
              <span className="fin-cartao-rotulo">Percentual médio</span>
              <strong className="fin-cartao-valor">
                {(fechamento.data.aliquotaMediaBp / 100).toLocaleString('pt-BR', {
                  maximumFractionDigits: 2,
                })}
                %
              </strong>
              <span className="fin-cartao-nota">ponderado pelo valor</span>
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
                  <th scope="col">Base</th>
                  <th scope="col">Comissão</th>
                </tr>
              </thead>
              <tbody>
                {fechamento.data.itens.map((i, n) => (
                  <tr key={`${i.descricao}-${n}`}>
                    <td>{i.descricao}</td>
                    <td className="fin-numero">{i.baseFormatada}</td>
                    <td className="fin-numero">{i.valorFormatado}</td>
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
