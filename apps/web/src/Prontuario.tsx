import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Carregando, Vazio } from './ui.jsx';
import {
  ApiError,
  editarAnexo,
  baixarAnexo,
  buscarAnamnese,
  buscarAnexos,
  enviarAnexo,
  excluirAnexo,
  buscarEvolucoes,
  criarEvolucao,
  editarEvolucao,
  gravarAnamnese,
  type Anamnese,
  type Anexo,
  type Evolucao,
  type VersaoAnamnese,
} from './api.js';

/**
 * Prontuário na tela: anamnese e evolução.
 *
 * DUAS DECISÕES DE COMPOSIÇÃO que vieram do que o sistema já sabe
 * sobre o trabalho:
 *
 * 1. A ANAMNESE MOSTRA A VIGENTE, não um histórico paginado. Quem abre
 *    o prontuário antes do atendimento quer saber o quadro de HOJE. O
 *    histórico existe e está a um clique, mas não disputa a atenção com
 *    o que se precisa ler em trinta segundos entre um aluno e outro.
 *
 * 2. A EVOLUÇÃO ABRE JÁ ESCREVENDO. O campo de nova anotação fica no
 *    topo, aberto, com a data de hoje preenchida. Um formulário que
 *    exige clicar em "adicionar" antes de aparecer é um formulário que
 *    não é preenchido: a anotação some no fim do dia, quando ninguém
 *    lembra mais do detalhe.
 */

/* ====================================================================
 * Anamnese
 * ================================================================== */

const SECOES: { nome: keyof CamposAnamnese; rotulo: string; dica?: string }[] = [
  { nome: 'queixaPrincipal', rotulo: 'Queixa principal', dica: 'O que trouxe o aluno até aqui' },
  { nome: 'historicoClinico', rotulo: 'Histórico clínico' },
  { nome: 'lesoes', rotulo: 'Lesões' },
  { nome: 'cirurgias', rotulo: 'Cirurgias' },
  { nome: 'medicamentos', rotulo: 'Medicamentos em uso' },
  {
    nome: 'contraindicacoes',
    rotulo: 'Contraindicações',
    dica: 'O que NÃO pode ser feito — é o campo que evita acidente',
  },
  { nome: 'objetivos', rotulo: 'Objetivos' },
];

interface CamposAnamnese {
  queixaPrincipal: string;
  historicoClinico: string;
  lesoes: string;
  cirurgias: string;
  medicamentos: string;
  contraindicacoes: string;
  objetivos: string;
  alturaCm: string;
  pesoKg: string;
}

const VAZIA: CamposAnamnese = {
  queixaPrincipal: '',
  historicoClinico: '',
  lesoes: '',
  cirurgias: '',
  medicamentos: '',
  contraindicacoes: '',
  objetivos: '',
  alturaCm: '',
  pesoKg: '',
};

export function AbaAnamnese({
  alunoId,
  podeEscrever,
  aoGravar,
}: {
  alunoId: string;
  podeEscrever: boolean;
  /** Avisa a ficha para reler o resumo, que depende de haver anamnese. */
  aoGravar?: (() => void) | undefined;
}): ReactNode {
  const [vigente, setVigente] = useState<Anamnese | null>(null);
  const [versoes, setVersoes] = useState<VersaoAnamnese[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  const [campos, setCampos] = useState<CamposAnamnese>(VAZIA);
  const [salvando, setSalvando] = useState(false);
  const [errosCampo, setErrosCampo] = useState<Record<string, string>>({});

  const carregar = async (): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await buscarAnamnese(alunoId);
      setVigente(r.data.vigente);
      setVersoes(r.data.versoes);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível abrir a anamnese.');
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alunoId]);

  const abrirEdicao = (): void => {
    /* Partir da versão vigente, não de um formulário em branco. A
       anamnese seguinte quase sempre é a anterior com um parágrafo a
       mais; obrigar a redigitar tudo é o caminho mais curto para o
       profissional parar de atualizar. */
    setCampos(
      vigente === null
        ? VAZIA
        : {
            queixaPrincipal: vigente.queixaPrincipal ?? '',
            historicoClinico: vigente.historicoClinico ?? '',
            lesoes: vigente.lesoes ?? '',
            cirurgias: vigente.cirurgias ?? '',
            medicamentos: vigente.medicamentos ?? '',
            contraindicacoes: vigente.contraindicacoes ?? '',
            objetivos: vigente.objetivos ?? '',
            alturaCm: vigente.alturaCm === null ? '' : String(vigente.alturaCm),
            pesoKg: vigente.pesoG === null ? '' : (vigente.pesoG / 1000).toFixed(1),
          },
    );
    setErrosCampo({});
    setEditando(true);
  };

  const salvar = async (): Promise<void> => {
    setSalvando(true);
    setErro(null);
    setErrosCampo({});
    try {
      const corpo: Record<string, string | number | undefined> = {};
      for (const s of SECOES) {
        const v = campos[s.nome].trim();
        if (v !== '') corpo[s.nome] = v;
      }
      if (campos.alturaCm.trim() !== '') corpo['alturaCm'] = Number(campos.alturaCm);
      /* O usuário digita quilos; o banco guarda gramas inteiros. A
         conversão é aqui e arredondada, porque 82,35 kg em ponto
         flutuante vira 82349,999… e o CHECK do banco recusa. */
      if (campos.pesoKg.trim() !== '') {
        corpo['pesoG'] = Math.round(Number(campos.pesoKg.replace(',', '.')) * 1000);
      }

      await gravarAnamnese(alunoId, corpo);
      setEditando(false);
      await carregar();
      aoGravar?.();
    } catch (e) {
      if (e instanceof ApiError) {
        setErro(e.message);
        setErrosCampo(Object.fromEntries(e.campos.map((c) => [c.campo, c.problema])));
      } else {
        setErro('Não foi possível salvar a anamnese.');
      }
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) return <Carregando rotulo="Abrindo a anamnese" />;

  if (editando) {
    return (
      <section className="prontuario">
        {erro !== null && (
          <p className="mensagem-erro" role="alert">
            {erro}
          </p>
        )}

        <div className="formulario">
          <label className="campo campo-terco">
            <span className="campo-rotulo">Altura (cm)</span>
            <input
              inputMode="numeric"
              value={campos.alturaCm}
              onChange={(e) => setCampos({ ...campos, alturaCm: e.target.value })}
            />
            {errosCampo['alturaCm'] !== undefined && (
              <span className="campo-erro">{errosCampo['alturaCm']}</span>
            )}
          </label>

          <label className="campo campo-terco">
            <span className="campo-rotulo">Peso (kg)</span>
            <input
              inputMode="decimal"
              value={campos.pesoKg}
              onChange={(e) => setCampos({ ...campos, pesoKg: e.target.value })}
            />
            {errosCampo['pesoG'] !== undefined && (
              <span className="campo-erro">{errosCampo['pesoG']}</span>
            )}
          </label>

          {SECOES.map((s) => (
            <label key={s.nome} className="campo campo-cheia">
              <span className="campo-rotulo">{s.rotulo}</span>
              <textarea
                rows={s.nome === 'historicoClinico' ? 5 : 3}
                value={campos[s.nome]}
                onChange={(e) => setCampos({ ...campos, [s.nome]: e.target.value })}
              />
              {s.dica !== undefined && <span className="campo-dica">{s.dica}</span>}
              {errosCampo[s.nome] !== undefined && (
                <span className="campo-erro">{errosCampo[s.nome]}</span>
              )}
            </label>
          ))}
        </div>

        <p className="prontuario-aviso">
          Salvar cria uma <strong>versão nova</strong>. A anterior continua no histórico —
          prontuário não se apaga.
        </p>

        <div className="formulario-acoes">
          <button type="button" className="botao-secundario" onClick={() => setEditando(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className="botao-acao"
            disabled={salvando}
            onClick={() => void salvar()}
          >
            {salvando ? 'Salvando…' : 'Salvar anamnese'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="prontuario">
      {erro !== null && <p className="mensagem-erro" role="alert">{erro}</p>}

      {vigente === null ? (
        <div className="prontuario-vazio">
          <Vazio
            titulo="Este aluno ainda não tem anamnese."
            descricao="É ela que registra lesões, cirurgias e contraindicações — o que o treino precisa respeitar."
          />
          {podeEscrever && (
            <button type="button" className="botao-acao" onClick={abrirEdicao}>
              Preencher anamnese
            </button>
          )}
        </div>
      ) : (
        <>
          <header className="prontuario-topo">
            <div>
              <span className="prontuario-data">
                Atualizada em {formatarDataHora(vigente.realizadaEm)}
              </span>
              {vigente.profissional !== null && (
                <span className="prontuario-autor">por {vigente.profissional.nome}</span>
              )}
            </div>
            {podeEscrever && (
              <button type="button" className="botao-acao" onClick={abrirEdicao}>
                Atualizar
              </button>
            )}
          </header>

          {(vigente.alturaCm !== null || vigente.pesoG !== null) && (
            <div className="prontuario-medidas-leitura">
              {vigente.alturaCm !== null && (
                <span>
                  <strong className="tabular">{vigente.alturaCm}</strong> cm
                </span>
              )}
              {vigente.pesoG !== null && (
                <span>
                  <strong className="tabular">{(vigente.pesoG / 1000).toFixed(1)}</strong> kg
                </span>
              )}
              {vigente.alturaCm !== null && vigente.pesoG !== null && (
                <span className="prontuario-imc">
                  IMC <strong className="tabular">{imc(vigente.alturaCm, vigente.pesoG)}</strong>
                </span>
              )}
            </div>
          )}

          {/* Contraindicações primeiro, e destacada. É o campo cuja
              ausência de leitura machuca alguém — não pode estar no fim
              de uma lista de sete parágrafos. */}
          {vigente.contraindicacoes !== null && (
            <div className="prontuario-alerta">
              <span className="prontuario-alerta-rotulo">Contraindicações</span>
              <p>{vigente.contraindicacoes}</p>
            </div>
          )}

          {SECOES.filter((s) => s.nome !== 'contraindicacoes').map((s) => {
            const valor = vigente[s.nome as keyof Anamnese];
            if (typeof valor !== 'string' || valor === '') return null;
            return (
              <div key={s.nome} className="prontuario-secao">
                <h3>{s.rotulo}</h3>
                <p>{valor}</p>
              </div>
            );
          })}

          {versoes.length > 1 && (
            <details className="prontuario-historico">
              <summary>{versoes.length} versões registradas</summary>
              <ul>
                {versoes.map((v) => (
                  <li key={v.id}>
                    {formatarDataHora(v.realizadaEm)}
                    {v.profissional !== null && ` · ${v.profissional}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/* ====================================================================
 * Evolução
 * ================================================================== */

export function AbaEvolucao({
  alunoId,
  podeEscrever,
}: {
  alunoId: string;
  podeEscrever: boolean;
}): ReactNode {
  const [itens, setItens] = useState<Evolucao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const [data, setData] = useState(hoje());
  const [texto, setTexto] = useState('');
  const [dor, setDor] = useState('');

  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [textoEdicao, setTextoEdicao] = useState('');

  const carregar = async (): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await buscarEvolucoes(alunoId);
      setItens(r.data);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as evoluções.');
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alunoId]);

  const registrar = async (): Promise<void> => {
    setSalvando(true);
    setErro(null);
    try {
      await criarEvolucao(alunoId, {
        dataSessao: data,
        conteudo: texto.trim(),
        ...(dor.trim() === '' ? {} : { escalaDor: Number(dor) }),
      });
      setTexto('');
      setDor('');
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível registrar a evolução.');
    } finally {
      setSalvando(false);
    }
  };

  const salvarEdicao = async (id: string): Promise<void> => {
    setSalvando(true);
    setErro(null);
    try {
      await editarEvolucao(alunoId, id, { conteudo: textoEdicao.trim() });
      setEditandoId(null);
      await carregar();
    } catch (e) {
      /* O 409 da janela expirada chega aqui com a mensagem que a API
         escreveu — que já diz o que fazer (registrar uma nova). Vale
         mais mostrá-la do que traduzir para um "erro ao salvar". */
      setErro(e instanceof ApiError ? e.message : 'Não foi possível salvar a alteração.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <section className="prontuario">
      {erro !== null && <p className="mensagem-erro" role="alert">{erro}</p>}

      {podeEscrever && (
        <div className="evolucao-nova formulario">
          {/* O FORMULÁRIO PRECISAVA DE UM TÍTULO. Sem ele, quem abria a
              aba via três campos soltos flutuando na página e levava um
              instante para entender se aquilo era o histórico do aluno
              ou um formulário em branco. Uma linha resolve. */}
          <div className="evolucao-nova-topo campo-cheia">
            <h3>Registrar atendimento de hoje</h3>
            <p>O que ficar escrito aqui é o que explica o resultado daqui a três meses.</p>
          </div>
          <label className="campo campo-terco">
            <span className="campo-rotulo">Data do atendimento</span>
            <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
          </label>
          <label className="campo campo-terco">
            <span className="campo-rotulo">Dor (0 a 10)</span>
            <input
              inputMode="numeric"
              placeholder="opcional"
              value={dor}
              onChange={(e) => setDor(e.target.value)}
            />
          </label>
          <label className="campo campo-cheia">
            <span className="campo-rotulo">O que foi feito hoje</span>
            <textarea
              rows={4}
              placeholder="Exercícios, respostas do aluno, ajustes para a próxima sessão…"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
          </label>
          <div className="formulario-acoes campo-cheia">
            <button
              type="button"
              className="botao-acao"
              disabled={salvando || texto.trim().length < 3}
              onClick={() => void registrar()}
            >
              {salvando ? 'Registrando…' : 'Registrar evolução'}
            </button>
          </div>
        </div>
      )}

      {carregando ? (
        <Carregando rotulo="Carregando evoluções" />
      ) : itens.length === 0 ? (
        <Vazio
          titulo="Nenhuma evolução registrada."
          descricao="Cada atendimento anotado aqui vira o histórico que explica o resultado depois."
        />
      ) : (
        <ol className="evolucao-linha">
          {itens.map((e) => (
            <li key={e.id} className="evolucao-item">
              <div className="evolucao-item-topo">
                <span className="evolucao-data tabular">{formatarData(e.dataSessao)}</span>
                <span className="evolucao-autor">{e.profissional.nome}</span>
                {e.escalaDor !== null && (
                  <span className={`selo-dor selo-dor-${faixaDor(e.escalaDor)}`}>
                    dor {e.escalaDor}
                  </span>
                )}
                {e.editavel && editandoId !== e.id && (
                  <button
                    type="button"
                    className="botao-texto"
                    onClick={() => {
                      setEditandoId(e.id);
                      setTextoEdicao(e.conteudo);
                    }}
                  >
                    corrigir
                  </button>
                )}
              </div>

              {editandoId === e.id ? (
                <>
                  <textarea
                    className="evolucao-correcao"
                    rows={4}
                    value={textoEdicao}
                    onChange={(ev) => setTextoEdicao(ev.target.value)}
                  />
                  <div className="formulario-acoes">
                    <button
                      type="button"
                      className="botao-acao"
                      disabled={salvando}
                      onClick={() => void salvarEdicao(e.id)}
                    >
                      Salvar correção
                    </button>
                    <button
                      type="button"
                      className="botao-secundario"
                      onClick={() => setEditandoId(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                </>
              ) : (
                <p className="evolucao-conteudo">{e.conteudo}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ==================================================================== */

function hoje(): string {
  const d = new Date();
  /* Data local, não `toISOString()`: às 21h em Brasília o ISO já é o dia
     seguinte em UTC, e a sessão seria registrada com a data errada. */
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function formatarData(iso: string): string {
  const [ano, mes, dia] = iso.slice(0, 10).split('-');
  return `${dia}/${mes}/${ano}`;
}

function formatarDataHora(iso: string): string {
  const d = new Date(iso);
  return `${formatarData(iso)} às ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

function imc(alturaCm: number, pesoG: number): string {
  const m = alturaCm / 100;
  return (pesoG / 1000 / (m * m)).toFixed(1);
}

/** Três faixas, porque uma escala de 11 cores não comunica nada. */
function faixaDor(v: number): 'leve' | 'media' | 'alta' {
  if (v <= 3) return 'leve';
  if (v <= 6) return 'media';
  return 'alta';
}

/* ====================================================================
 * Anexos
 * ================================================================== */

const CATEGORIAS: { valor: string; rotulo: string }[] = [
  { valor: 'EXAME', rotulo: 'Exame' },
  { valor: 'LAUDO', rotulo: 'Laudo' },
  { valor: 'FOTO', rotulo: 'Foto' },
  { valor: 'TERMO', rotulo: 'Termo' },
  { valor: 'OUTRO', rotulo: 'Outro' },
];

export function AbaAnexos({
  alunoId,
  podeEnviar,
  podeExcluir,
}: {
  alunoId: string;
  podeEnviar: boolean;
  podeExcluir: boolean;
}): ReactNode {
  const [itens, setItens] = useState<Anexo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [categoria, setCategoria] = useState('EXAME');
  const [descricao, setDescricao] = useState('');
  const [baixando, setBaixando] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const entrada = useRef<HTMLInputElement>(null);

  const carregar = async (): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await buscarAnexos(alunoId);
      setItens(r.data);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os anexos.');
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alunoId]);

  const enviar = async (arquivo: File): Promise<void> => {
    setEnviando(true);
    setErro(null);
    try {
      await enviarAnexo(alunoId, arquivo, {
        categoria,
        ...(descricao.trim() === '' ? {} : { descricao: descricao.trim() }),
      });
      setDescricao('');
      /* Limpa o input para que enviar O MESMO arquivo de novo dispare o
         evento: sem isso, o `change` não ocorre e a segunda tentativa
         parece travada. */
      if (entrada.current !== null) entrada.current.value = '';
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível enviar o arquivo.');
    } finally {
      setEnviando(false);
    }
  };

  const baixar = async (a: Anexo): Promise<void> => {
    setBaixando(a.id);
    setErro(null);
    try {
      await baixarAnexo(alunoId, a.id, a.nome);
    } catch {
      setErro('Não foi possível baixar o anexo.');
    } finally {
      setBaixando(null);
    }
  };

  const excluir = async (a: Anexo): Promise<void> => {
    setErro(null);
    try {
      await excluirAnexo(alunoId, a.id);
      setConfirmando(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível excluir o anexo.');
    }
  };

  return (
    <section className="prontuario">
      {erro !== null && (
        <p className="mensagem-erro" role="alert">
          {erro}
        </p>
      )}

      {podeEnviar && (
        <div className="anexo-envio formulario">
          <label className="campo campo-terco">
            <span className="campo-rotulo">Tipo</span>
            <select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
              {CATEGORIAS.map((c) => (
                <option key={c.valor} value={c.valor}>
                  {c.rotulo}
                </option>
              ))}
            </select>
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Descrição</span>
            <input
              value={descricao}
              placeholder="Ressonância de coluna, jan/2026"
              onChange={(e) => setDescricao(e.target.value)}
            />
          </label>

          <div className="campo campo-cheia">
            <input
              ref={entrada}
              type="file"
              className="apenas-leitor-de-tela"
              id="anexo-arquivo"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
              onChange={(e) => {
                const arquivo = e.target.files?.[0];
                if (arquivo !== undefined) void enviar(arquivo);
              }}
            />
            <label htmlFor="anexo-arquivo" className="anexo-alvo">
              {enviando ? 'Enviando…' : 'Escolher arquivo'}
              <span className="anexo-alvo-dica">PDF, Word ou imagem — até 20 MB</span>
            </label>
          </div>
        </div>
      )}

      {carregando ? (
        <Carregando rotulo="Carregando anexos" />
      ) : itens.length === 0 ? (
        <Vazio
          titulo="Nenhum anexo."
          descricao="Exames, laudos e fotos de avaliação ficam aqui, junto do prontuário."
        />
      ) : (
        <ul className="anexo-lista">
          {itens.map((a) => (
            <li key={a.id} className="anexo-item">
              <span className="anexo-icone" aria-hidden="true">
                {a.tipo.startsWith('image/') ? '▣' : '▤'}
              </span>

              <div className="anexo-corpo">
                <button
                  type="button"
                  className="anexo-nome"
                  disabled={baixando === a.id}
                  onClick={() => void baixar(a)}
                >
                  {baixando === a.id ? 'Baixando…' : a.nome}
                </button>
                <span className="anexo-detalhe">
                  {a.categoria !== null && `${rotuloCategoria(a.categoria)} · `}
                  {tamanho(a.tamanhoBytes)}
                  {/* A DATA DO DOCUMENTO na frente da do envio: um exame
                      de janeiro digitalizado em julho pertence a janeiro
                      na leitura do prontuário. */}
                  {a.dataDoDocumento != null
                    ? ` · documento de ${a.dataDoDocumento.split('-').reverse().join('/')}`
                    : ''}
                  {a.enviadoPor !== null && ` · enviado por ${a.enviadoPor}`}
                  {` em ${formatarData(a.criadoEm)}`}
                </span>
                {a.descricao !== null && <span className="anexo-descricao">{a.descricao}</span>}
                {/* QUEM MEXEU POR ÚLTIMO. `enviadoPor` diz quem mandou o
                    arquivo e isso não muda nunca; esta linha diz quem
                    corrigiu a descrição depois. Sem a distinção, quem
                    confere vai atrás da pessoa errada. */}
                {a.editadoPor != null && a.editadoEm != null && (
                  <span className="anexo-editado">
                    descrição corrigida por {a.editadoPor} em {formatarData(a.editadoEm)}
                  </span>
                )}
                {a.enviadoPeloAluno === true && (
                  <span className="anexo-origem">enviado pelo próprio aluno</span>
                )}
              </div>

              {podeEnviar && (
                <button
                  type="button"
                  className="botao-texto"
                  onClick={() => setEditando(editando === a.id ? null : a.id)}
                >
                  {editando === a.id ? 'fechar' : 'editar'}
                </button>
              )}

              {podeExcluir &&
                (confirmando === a.id ? (
                  /* Confirmação inline, e com o nome do arquivo no texto:
                     apagar aqui remove os bytes do disco, não manda para
                     uma lixeira. Quem confirma precisa ler o que vai
                     perder. */
                  <span className="anexo-confirma">
                    Apagar “{a.nome}” em definitivo?
                    <button type="button" className="botao-texto" onClick={() => void excluir(a)}>
                      apagar
                    </button>
                    <button
                      type="button"
                      className="botao-texto"
                      onClick={() => setConfirmando(null)}
                    >
                      cancelar
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="botao-texto"
                    onClick={() => setConfirmando(a.id)}
                  >
                    excluir
                  </button>
                ))}

              {editando === a.id && (
                <FormularioDeAnexo
                  alunoId={alunoId}
                  anexo={a}
                  aoSalvar={() => {
                    setEditando(null);
                    void carregar();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function rotuloCategoria(v: string): string {
  return CATEGORIAS.find((c) => c.valor === v)?.rotulo ?? v;
}

/** Tamanho legível. KB e MB bastam — anexo tem teto de 20 MB. */
function tamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ====================================================================
 * Corrigir o que descreve um anexo
 * ================================================================== */

/**
 * Edita descrição, categoria e data do documento — nunca o arquivo.
 *
 * O ARQUIVO É IMUTÁVEL de propósito. Ele tem checksum gravado e é peça
 * de prontuário; trocar os bytes por baixo de um registro já lido e
 * auditado apagaria a prova do que estava lá. Exame errado se corrige
 * enviando outro e apagando o primeiro — as duas ações ficam no log, a
 * substituição silenciosa não ficaria.
 */
function FormularioDeAnexo({
  alunoId,
  anexo,
  aoSalvar,
}: {
  alunoId: string;
  anexo: Anexo;
  aoSalvar: () => void;
}): ReactNode {
  const [descricao, setDescricao] = useState(anexo.descricao ?? '');
  const [categoria, setCategoria] = useState(anexo.categoria ?? '');
  const [data, setData] = useState(anexo.dataDoDocumento ?? '');
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setSalvando(true);
    try {
      await editarAnexo(alunoId, anexo.id, {
        descricao: descricao.trim() === '' ? null : descricao.trim(),
        categoria: categoria.trim() === '' ? null : categoria.trim(),
        dataDoDocumento: data === '' ? null : data,
      });
      aoSalvar();
    } catch (x) {
      setErro(x instanceof ApiError ? x.message : 'Não foi possível salvar.');
      setSalvando(false);
    }
  };

  return (
    <form className="anexo-form" onSubmit={(e) => void enviar(e)}>
      <label className="campo">
        <span className="campo-rotulo">O que é este arquivo</span>
        <input
          value={descricao}
          onChange={(e) => setDescricao(e.target.value)}
          placeholder="Hemograma completo"
          autoFocus
          maxLength={500}
        />
      </label>
      <label className="campo">
        <span className="campo-rotulo">Categoria</span>
        <input
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
          placeholder="Exame, laudo, receita…"
          maxLength={80}
        />
      </label>
      <label className="campo">
        <span className="campo-rotulo">Data do documento</span>
        <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
        {/* A DATA DO DOCUMENTO, não a do envio: um exame de janeiro
            digitalizado em julho pertence a janeiro na linha do tempo
            clínica, e é por ela que a lista se ordena. */}
        <span className="campo-dica">Quando o exame foi feito, não quando foi enviado.</span>
      </label>
      <button type="submit" className="botao-acao" disabled={salvando}>
        {salvando ? 'Salvando…' : 'Salvar'}
      </button>
      {erro !== null && (
        <p className="mensagem-erro anexo-form-erro" role="alert">
          {erro}
        </p>
      )}
    </form>
  );
}
