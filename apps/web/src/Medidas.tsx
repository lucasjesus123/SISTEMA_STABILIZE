import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from './api.js';
import { Carregando, Erro, Vazio } from './ui.jsx';

/**
 * Avaliação física: a tabela fixa de medidas do aluno.
 *
 * O FORMATO É UMA TABELA COM AS DATAS LADO A LADO, e não uma ficha por
 * avaliação. A pergunta que se faz numa avaliação física nunca é "quanto
 * mede a cintura hoje" — é "quanto mudou desde a última". Uma ficha por
 * data responde a primeira e esconde a segunda; a tabela responde as
 * duas, e a variação aparece sem ninguém calcular nada.
 *
 * TUDO É INTEIRO NO CAMINHO DO DADO. Peso em gramas, circunferência em
 * milímetros, gordura em décimos de por cento. A pessoa digita "87,5" e
 * a tela converte para 875 antes de enviar; o servidor recusa decimal.
 * É a mesma disciplina do dinheiro, pelo mesmo motivo: 0,1 não existe
 * exatamente em ponto flutuante, e uma soma de diferenças acumula
 * resíduo que ninguém sabe explicar.
 */

/** A ordem em que a avaliação é feita, de cima para baixo no corpo. */
const LINHAS: { campo: api.CampoMedida; nome: string }[] = [
  { campo: 'ombro_mm', nome: 'Ombro' },
  { campo: 'busto_mm', nome: 'Busto' },
  { campo: 'peito_mm', nome: 'Peito' },
  { campo: 'braco_dir_mm', nome: 'Braço direito' },
  { campo: 'braco_esq_mm', nome: 'Braço esquerdo' },
  { campo: 'antebraco_dir_mm', nome: 'Antebraço direito' },
  { campo: 'antebraco_esq_mm', nome: 'Antebraço esquerdo' },
  { campo: 'abdomen_mm', nome: 'Abdômen' },
  { campo: 'cintura_mm', nome: 'Cintura' },
  { campo: 'quadril_mm', nome: 'Quadril' },
  { campo: 'culote_mm', nome: 'Culote' },
  { campo: 'coxa_dir_mm', nome: 'Coxa direita' },
  { campo: 'coxa_esq_mm', nome: 'Coxa esquerda' },
  { campo: 'panturrilha_dir_mm', nome: 'Panturrilha direita' },
  { campo: 'panturrilha_esq_mm', nome: 'Panturrilha esquerda' },
];

/** Inteiro guardado → texto que a pessoa reconhece. */
const deMm = (v: number | null): string => (v === null ? '' : (v / 10).toFixed(1).replace('.', ','));
const deKg = (g: number | null): string => (g === null ? '' : (g / 1000).toFixed(1).replace('.', ','));
const dePct = (x10: number | null): string => (x10 === null ? '' : (x10 / 10).toFixed(1).replace('.', ','));

/**
 * Texto digitado → inteiro, ou `null` quando vazio, ou `undefined`
 * quando não dá para ler.
 *
 * A distinção importa: `null` apaga a medida, `undefined` significa
 * "não entendi" e precisa impedir o envio. Tratar os dois como zero
 * gravaria uma cintura de 0 cm porque alguém digitou "oitenta".
 */
function paraInteiro(texto: string, fator: number): number | null | undefined {
  const limpo = texto.trim().replace(',', '.');
  if (limpo === '') return null;
  const n = Number(limpo);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * fator);
}

/** "2026-08-18" → "18/08". Sem passar por `Date`, que desloca o fuso. */
const diaMes = (iso: string): string => {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}`;
};

const hojeIso = (): string => {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
};

export function AbaMedidas({
  alunoId,
  podeEscrever,
}: {
  alunoId: string;
  podeEscrever: boolean;
}): ReactNode {
  const [medidas, setMedidas] = useState<api.Medida[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState<api.Medida | 'nova' | null>(null);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    let vivo = true;
    api
      .buscarMedidas(alunoId)
      .then((r) => {
        if (!vivo) return;
        setMedidas(r.data);
        setErro(null);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setMedidas([]);
        setErro(e instanceof api.ApiError ? e.message : 'Não foi possível carregar as medidas.');
      });
    return () => {
      vivo = false;
    };
  }, [alunoId, versao]);

  /* Da mais recente para a mais antiga: a coluna que importa é a de
     hoje, e ela precisa estar onde o olho começa a ler. */
  const colunas = useMemo(
    () => (medidas === null ? [] : [...medidas].sort((a, b) => b.data.localeCompare(a.data))),
    [medidas],
  );

  if (editando !== null) {
    return (
      <FormularioDeMedida
        alunoId={alunoId}
        medida={editando === 'nova' ? null : editando}
        anterior={colunas[0] ?? null}
        aoSair={() => setEditando(null)}
        aoSalvar={() => {
          setEditando(null);
          setVersao((v) => v + 1);
        }}
      />
    );
  }

  return (
    <>
      {podeEscrever && (
        <div className="med-barra">
          <button type="button" className="botao-acao" onClick={() => setEditando('nova')}>
            Nova avaliação
          </button>
        </div>
      )}

      {erro !== null && <Erro mensagem={erro} />}

      {medidas === null ? (
        <Carregando rotulo="Carregando as medidas" />
      ) : colunas.length === 0 ? (
        <Vazio
          titulo="Nenhuma avaliação registrada."
          descricao="A primeira avaliação é o ponto de partida: sem ela não há do que comparar daqui a três meses."
        />
      ) : (
        <Tabela
          colunas={colunas}
          alunoId={alunoId}
          podeEscrever={podeEscrever}
          aoEditar={setEditando}
          aoMudar={() => setVersao((v) => v + 1)}
        />
      )}
    </>
  );
}

/* ====================================================================
 * A tabela comparativa
 * ================================================================== */

function Tabela({
  colunas,
  alunoId,
  podeEscrever,
  aoEditar,
  aoMudar,
}: {
  colunas: api.Medida[];
  alunoId: string;
  podeEscrever: boolean;
  aoEditar: (m: api.Medida) => void;
  aoMudar: () => void;
}): ReactNode {
  /* NO MÁXIMO SEIS COLUNAS. Um aluno de três anos tem trinta avaliações,
     e trinta colunas não cabem em tela nenhuma — a tabela viraria uma
     rolagem horizontal onde nada se compara com nada. Seis cobre um ano
     e meio de avaliações bimestrais, que é o horizonte em que a
     comparação ainda diz alguma coisa. */
  const visiveis = colunas.slice(0, 6);
  const maisAntiga = visiveis[visiveis.length - 1]!;
  const atual = visiveis[0]!;

  /** A diferença entre a coluna mais recente e a mais antiga visível. */
  const variacao = (pega: (m: api.Medida) => number | null): number | null => {
    if (visiveis.length < 2) return null;
    const a = pega(atual);
    const b = pega(maisAntiga);
    if (a === null || b === null) return null;
    return a - b;
  };

  const linhaVazia = (pega: (m: api.Medida) => number | null): boolean =>
    visiveis.every((m) => pega(m) === null);

  return (
    <>
      <div className="rolo">
        <table className="tabela med-tabela">
          <thead>
            <tr>
              <th scope="col">Medida</th>
              {visiveis.map((m) => (
                <th key={m.id} scope="col" className="med-col">
                  {diaMes(m.data)}
                  <span className="med-ano">{m.data.slice(0, 4)}</span>
                </th>
              ))}
              {visiveis.length > 1 && (
                <th scope="col" className="med-col med-variacao-col">
                  Variação
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            <Linha
              nome="Peso"
              unidade="kg"
              colunas={visiveis}
              pega={(m) => m.pesoG}
              formata={deKg}
              variacao={variacao((m) => m.pesoG)}
              fatorDaVariacao={1000}
              /* Emagrecer é o objetivo mais comum, então peso PARA BAIXO
                 é a variação boa. Não é universal — quem faz hipertrofia
                 quer o contrário —, por isso nenhuma cor de julgamento
                 aqui, só o sinal e a seta. */
              destaque
            />
            <Linha
              nome="Altura"
              unidade="cm"
              colunas={visiveis}
              pega={(m) => m.alturaCm}
              formata={(v) => (v === null ? '' : String(v))}
              variacao={null}
            />
            <Linha
              nome="Gordura"
              unidade="%"
              colunas={visiveis}
              pega={(m) => m.gorduraPctX10}
              formata={dePct}
              variacao={variacao((m) => m.gorduraPctX10)}
              fatorDaVariacao={10}
              destaque
            />
            <tr className="med-separador">
              <th colSpan={visiveis.length + 2} scope="colgroup">
                Circunferências <span className="med-unidade">em cm</span>
              </th>
            </tr>
            {LINHAS.filter((l) => !linhaVazia((m) => m.circunferenciasMm[l.campo])).map((l) => (
              <Linha
                key={l.campo}
                nome={l.nome}
                colunas={visiveis}
                pega={(m) => m.circunferenciasMm[l.campo]}
                formata={deMm}
                variacao={variacao((m) => m.circunferenciasMm[l.campo])}
                fatorDaVariacao={10}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Quem mediu e quando, e a observação daquele dia. Fica embaixo
          da tabela porque é contexto: importa quando alguém questiona um
          número, não enquanto se lê a evolução. */}
      <div className="med-rodape">
        {visiveis.map((m) => (
          <div key={m.id} className="med-registro">
            <span className="med-registro-data">
              {diaMes(m.data)}/{m.data.slice(0, 4)}
            </span>
            <span className="med-registro-quem">{m.profissional ?? 'sem registro de quem mediu'}</span>
            {m.observacoes !== null && <p className="med-registro-obs">{m.observacoes}</p>}
            {podeEscrever && (
              <span className="eq-acoes">
                <button type="button" className="botao-texto" onClick={() => aoEditar(m)}>
                  Editar
                </button>
                <button
                  type="button"
                  className="botao-texto-perigo"
                  onClick={() => {
                    if (window.confirm(`Apagar a avaliação de ${diaMes(m.data)}?`)) {
                      void api.excluirMedida(alunoId, m.id).then(aoMudar).catch(() => undefined);
                    }
                  }}
                >
                  Apagar
                </button>
              </span>
            )}
          </div>
        ))}
      </div>

      {colunas.length > visiveis.length && (
        <p className="med-nota">
          Mostrando as {visiveis.length} avaliações mais recentes de {colunas.length}.
        </p>
      )}
    </>
  );
}

function Linha({
  nome,
  unidade,
  colunas,
  pega,
  formata,
  variacao,
  fatorDaVariacao = 1,
  destaque = false,
}: {
  nome: string;
  unidade?: string;
  colunas: api.Medida[];
  pega: (m: api.Medida) => number | null;
  formata: (v: number | null) => string;
  variacao: number | null;
  fatorDaVariacao?: number;
  destaque?: boolean;
}): ReactNode {
  const texto =
    variacao === null || variacao === 0
      ? null
      : `${variacao > 0 ? '+' : '−'}${(Math.abs(variacao) / fatorDaVariacao).toFixed(1).replace('.', ',')}`;

  return (
    <tr className={destaque ? 'med-destaque' : ''}>
      <th scope="row">
        {nome}
        {unidade !== undefined && <span className="med-unidade">{unidade}</span>}
      </th>
      {colunas.map((m) => {
        const v = pega(m);
        return (
          <td key={m.id} className="med-valor">
            {v === null ? <span className="fin-nada">—</span> : <span className="dinheiro">{formata(v)}</span>}
          </td>
        );
      })}
      {colunas.length > 1 && (
        <td className="med-valor med-variacao">
          {texto === null ? (
            <span className="fin-nada">—</span>
          ) : (
            <span className={`dinheiro ${variacao! > 0 ? 'subiu' : 'desceu'}`}>{texto}</span>
          )}
        </td>
      )}
    </tr>
  );
}

/* ====================================================================
 * O formulário
 * ================================================================== */

function FormularioDeMedida({
  alunoId,
  medida,
  anterior,
  aoSair,
  aoSalvar,
}: {
  alunoId: string;
  medida: api.Medida | null;
  anterior: api.Medida | null;
  aoSair: () => void;
  aoSalvar: () => void;
}): ReactNode {
  const [data, setData] = useState(medida?.data ?? hojeIso());
  const [peso, setPeso] = useState(deKg(medida?.pesoG ?? null));
  /* A ALTURA VEM PREENCHIDA DA ÚLTIMA AVALIAÇÃO. Adulto não muda de
     altura, e digitá-la de novo a cada avaliação é trabalho que só
     produz erro de digitação. */
  const [altura, setAltura] = useState(
    medida?.alturaCm !== undefined && medida.alturaCm !== null
      ? String(medida.alturaCm)
      : anterior?.alturaCm !== undefined && anterior?.alturaCm !== null
        ? String(anterior.alturaCm)
        : '',
  );
  const [gordura, setGordura] = useState(dePct(medida?.gorduraPctX10 ?? null));
  const [observacoes, setObservacoes] = useState(medida?.observacoes ?? '');
  const [circ, setCirc] = useState<Record<string, string>>(() => {
    const inicial: Record<string, string> = {};
    for (const l of LINHAS) inicial[l.campo] = deMm(medida?.circunferenciasMm[l.campo] ?? null);
    return inicial;
  });
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);

    const pesoG = paraInteiro(peso, 1000);
    const alturaCm = paraInteiro(altura, 1);
    const gorduraPctX10 = paraInteiro(gordura, 10);
    const circunferenciasMm: Partial<Record<api.CampoMedida, number | null>> = {};

    /* Um campo ilegível recusa o envio inteiro em vez de virar zero.
       Gravar 0 cm de cintura porque alguém digitou "oitenta" é um dado
       falso no prontuário, e dado falso é pior que dado faltando. */
    for (const l of LINHAS) {
      const v = paraInteiro(circ[l.campo] ?? '', 10);
      if (v === undefined) {
        setErro(`O valor de "${l.nome}" não é um número. Use centímetros, como 87,5.`);
        return;
      }
      circunferenciasMm[l.campo] = v;
    }
    if (pesoG === undefined || alturaCm === undefined || gorduraPctX10 === undefined) {
      setErro('Peso, altura e gordura precisam ser números.');
      return;
    }

    setEnviando(true);
    try {
      await api.gravarMedida(alunoId, {
        data,
        pesoG,
        alturaCm,
        gorduraPctX10,
        observacoes: observacoes.trim() === '' ? null : observacoes.trim(),
        circunferenciasMm,
      });
      aoSalvar();
    } catch (x) {
      setErro(x instanceof api.ApiError ? x.message : 'Não foi possível salvar a avaliação.');
      setEnviando(false);
    }
  };

  return (
    <>
      <button type="button" className="botao-voltar" onClick={aoSair}>
        ← Voltar para as medidas
      </button>
      <div className="secao-cabecalho">
        <h2>{medida === null ? 'Nova avaliação' : `Avaliação de ${diaMes(medida.data)}`}</h2>
        <p>
          Deixe em branco o que não foi medido — campo vazio é honesto, e zero seria uma medida
          falsa no prontuário.
        </p>
      </div>

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Data</span>
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} required />
          {medida === null && anterior !== null && (
            /* Repetir a data corrige a avaliação daquele dia em vez de
               criar uma segunda — é o `PUT` do servidor. Dizer isso
               aqui evita a dúvida de "salvei duas vezes?". */
            <span className="campo-dica">
              A última foi em {diaMes(anterior.data)}. Repetir uma data corrige aquela avaliação.
            </span>
          )}
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Peso (kg)</span>
          <input inputMode="decimal" value={peso} onChange={(e) => setPeso(e.target.value)} placeholder="72,4" />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Altura (cm)</span>
          <input inputMode="numeric" value={altura} onChange={(e) => setAltura(e.target.value)} placeholder="168" />
        </label>

        <label className="campo campo-terco">
          <span className="campo-rotulo">Gordura (%)</span>
          <input inputMode="decimal" value={gordura} onChange={(e) => setGordura(e.target.value)} placeholder="24,5" />
        </label>

        <h3 className="formulario-secao campo-cheia">Circunferências, em centímetros</h3>

        {LINHAS.map((l) => (
          <label key={l.campo} className="campo campo-terco">
            <span className="campo-rotulo">{l.nome}</span>
            <input
              inputMode="decimal"
              value={circ[l.campo] ?? ''}
              onChange={(e) => setCirc((c) => ({ ...c, [l.campo]: e.target.value }))}
              placeholder="—"
            />
          </label>
        ))}

        <label className="campo campo-cheia">
          <span className="campo-rotulo">Observações</span>
          <textarea rows={3} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
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
            {enviando ? 'Salvando…' : 'Salvar avaliação'}
          </button>
        </div>
      </form>
    </>
  );
}
