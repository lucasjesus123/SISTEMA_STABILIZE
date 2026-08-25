import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  apagarPlano,
  buscarLogoDaAcademia,
  criarPlano,
  listarPlanos,
  salvarPlano,
  type Plano,
  enviarLogoDaAcademia,
  lerAcademia,
  removerLogoDaAcademia,
  salvarAcademia,
  type Academia as AcademiaDados,
} from './api.js';
import { prepararImagem } from './imagem.js';
import { Espacos } from './Espacos.jsx';
import { Carregando, Erro } from './ui.jsx';
import {
  e164ParaMascara,
  formatCents,
  mascararCep,
  mascararTelefone,
  telefoneParaE164,
} from '@stabilize/shared';
import { mesclarEndereco, useBuscaDeCep } from './endereco.js';

/**
 * A identidade da academia.
 *
 * ESTA TELA É A FONTE. O que se preenche aqui sai impresso no papel
 * timbrado de todo relatório, no cabeçalho e no rodapé, e na carteirinha
 * que o aluno leva na carteira. Não é uma tela de configuração entre
 * outras — é a única que muda o que os clientes da academia recebem na
 * mão.
 *
 * POR QUE ELA MOSTRA O RESULTADO ao lado do formulário. Preencher
 * endereço num formulário e descobrir como ficou só ao emitir um
 * relatório é o caminho para o CEP errado circular por três meses. O
 * painel da direita monta a mesma linha que vai para o rodapé, com os
 * mesmos separadores.
 */


interface Formulario {
  nome: string;
  documento: string;
  telefone: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
}

const VAZIO: Formulario = {
  nome: '',
  documento: '',
  telefone: '',
  cep: '',
  logradouro: '',
  numero: '',
  complemento: '',
  bairro: '',
  cidade: '',
  uf: '',
};

/**
 * As duas metades da configuração da empresa.
 *
 * ELAS MORAM JUNTAS DE PROPÓSITO. As configurações do tenant nasceram
 * espalhadas — o bloqueio de entrada dentro do check-in, as perguntas da
 * triagem dentro da ficha, o WhatsApp na aba dele —, cada uma no módulo
 * que precisou dela primeiro. É por isso que ninguém acha nenhuma. Esta
 * tela é o começo do endereço único; o que vier depois entra aqui.
 */
type Secao = 'identidade' | 'valores' | 'espacos';

export function Academia(): ReactNode {
  const [secao, setSecao] = useState<Secao>('identidade');

  return (
    <>
      <div className="secao-cabecalho">
        <h1>A academia</h1>
        <p>
          O que está aqui sai impresso no papel timbrado dos relatórios, na carteirinha do aluno e
          na cobrança.
        </p>
      </div>

      <nav className="acad-abas" aria-label="Seções da academia">
        <button
          type="button"
          className={`acad-aba ${secao === 'identidade' ? 'ativa' : ''}`}
          aria-current={secao === 'identidade' ? 'true' : undefined}
          onClick={() => setSecao('identidade')}
        >
          Identidade
        </button>
        <button
          type="button"
          className={`acad-aba ${secao === 'valores' ? 'ativa' : ''}`}
          aria-current={secao === 'valores' ? 'true' : undefined}
          onClick={() => setSecao('valores')}
        >
          Tabela de valores
        </button>
        {/* ESPAÇOS ENTRA AQUI porque é isto: uma coisa DA ACADEMIA, do
            mesmo tipo do endereço e da tabela de preços. Ele existia
            como um botão secundário dentro da Agenda — que é onde o
            espaço é USADO, e não onde ele é cadastrado. Quem procura
            "onde eu cadastro os campos" procura em "A academia", e a
            resposta estava a dois cliques de distância na tela errada.

            O botão da Agenda continua lá: quem está montando a semana e
            percebe que falta uma sala não deveria ter de sair do que
            estava fazendo. */}
        <button
          type="button"
          className={`acad-aba ${secao === 'espacos' ? 'ativa' : ''}`}
          aria-current={secao === 'espacos' ? 'true' : undefined}
          onClick={() => setSecao('espacos')}
        >
          Espaços
        </button>
      </nav>

      {secao === 'identidade' ? (
        <Identidade />
      ) : secao === 'espacos' ? (
        <Espacos />
      ) : (
        <TabelaDeValores />
      )}
    </>
  );
}

function Identidade(): ReactNode {
  const [dados, setDados] = useState<AcademiaDados | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [logo, setLogo] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<{ campo: string; problema: string }[]>([]);
  const [salvo, setSalvo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [versaoDoLogo, setVersaoDoLogo] = useState(0);

  const carregar = useCallback(async (): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const { data } = await lerAcademia();
      setDados(data);
      setForm({
        nome: data.nome,
        documento: data.documento ?? '',
        telefone: e164ParaMascara(data.telefone),
        cep: mascararCep(data.endereco.cep ?? ''),
        logradouro: data.endereco.logradouro ?? '',
        numero: data.endereco.numero ?? '',
        complemento: data.endereco.complemento ?? '',
        bairro: data.endereco.bairro ?? '',
        cidade: data.endereco.cidade ?? '',
        uf: data.endereco.uf ?? '',
      });
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os dados da academia.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /* O endereço de blob precisa ser revogado ao trocar de logo e ao sair
     da tela — senão a imagem inteira fica viva na memória da aba. */
  useEffect(() => {
    let vivo = true;
    let atual: string | null = null;
    void buscarLogoDaAcademia().then((url) => {
      if (!vivo) {
        if (url !== null) URL.revokeObjectURL(url);
        return;
      }
      atual = url;
      setLogo(url);
    });
    return () => {
      vivo = false;
      if (atual !== null) URL.revokeObjectURL(atual);
    };
  }, [versaoDoLogo]);

  const { buscando, naoEncontrado, indisponivel } = useBuscaDeCep(form.cep, (achado) => {
    setForm((f) =>
      mesclarEndereco(f, achado, {
        logradouro: 'logradouro',
        bairro: 'bairro',
        cidade: 'cidade',
        uf: 'uf',
      }),
    );
  });

  const mudar = (campo: keyof Formulario, valor: string): void => {
    setSalvo(false);
    setForm((f) => ({ ...f, [campo]: valor }));
  };

  const enviar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setErro(null);
    setDetalhes([]);
    setEnviando(true);
    try {
      const { data } = await salvarAcademia({
        nome: form.nome.trim(),
        documento: vazioParaNulo(form.documento),
        telefone: telefoneParaE164(form.telefone),
        cep: form.cep.replace(/\D/g, '') === '' ? null : form.cep.replace(/\D/g, ''),
        logradouro: vazioParaNulo(form.logradouro),
        numero: vazioParaNulo(form.numero),
        complemento: vazioParaNulo(form.complemento),
        bairro: vazioParaNulo(form.bairro),
        cidade: vazioParaNulo(form.cidade),
        uf: vazioParaNulo(form.uf),
      });
      setDados(data);
      setSalvo(true);
    } catch (e) {
      if (e instanceof ApiError) {
        setErro(e.message);
        setDetalhes(e.campos);
      } else {
        setErro('Não foi possível salvar. Verifique sua conexão.');
      }
    } finally {
      setEnviando(false);
    }
  };

  if (carregando) return <Carregando rotulo="Carregando os dados da academia" />;
  if (dados === null) {
    return <Erro mensagem={erro ?? 'Dados indisponíveis.'} aoTentar={() => void carregar()} />;
  }

  return (
    <>
      <div className="acad-tela">
        <form className="formulario acad-form" onSubmit={(e) => void enviar(e)} noValidate>
          <h2 className="formulario-secao campo-cheia">Marca</h2>

          <div className="campo campo-cheia">
            <LogoDaAcademia
              logo={logo}
              nome={dados.nome}
              aoMudar={() => setVersaoDoLogo((v) => v + 1)}
            />
          </div>

          <h2 className="formulario-secao campo-cheia">Identificação</h2>

          <label className="campo campo-cheia">
            <span className="campo-rotulo">Nome da academia</span>
            <input value={form.nome} onChange={(e) => mudar('nome', e.target.value)} required />
            <span className="campo-dica">É o que aparece no alto de todo relatório.</span>
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">CNPJ</span>
            <input
              inputMode="numeric"
              value={form.documento}
              onChange={(e) => mudar('documento', e.target.value)}
            />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Telefone</span>
            <input
              inputMode="tel"
              placeholder="(41) 3345-0054"
              value={form.telefone}
              onChange={(e) => mudar('telefone', mascararTelefone(e.target.value))}
            />
            <span className="campo-dica">Vai no rodapé — é por onde o aluno liga.</span>
          </label>

          <h2 className="formulario-secao campo-cheia">Endereço</h2>

          <label className="campo campo-meia">
            <span className="campo-rotulo">CEP</span>
            <input
              inputMode="numeric"
              autoComplete="postal-code"
              placeholder="99999-999"
              value={form.cep}
              onChange={(e) => mudar('cep', mascararCep(e.target.value))}
            />
            <span className="campo-dica" aria-live="polite">
              {buscando
                ? 'Buscando o endereço…'
                : naoEncontrado
                  ? 'CEP não encontrado. Preencha o endereço abaixo.'
                  : indisponivel
                    ? 'Não consegui consultar o CEP agora. Preencha o endereço à mão.'
                    : 'Preencha o CEP e o endereço vem sozinho.'}
            </span>
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Logradouro</span>
            <input
              value={form.logradouro}
              onChange={(e) => mudar('logradouro', e.target.value)}
            />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Número</span>
            <input value={form.numero} onChange={(e) => mudar('numero', e.target.value)} />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Complemento</span>
            <input
              value={form.complemento}
              onChange={(e) => mudar('complemento', e.target.value)}
            />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Bairro</span>
            <input value={form.bairro} onChange={(e) => mudar('bairro', e.target.value)} />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Cidade</span>
            <input value={form.cidade} onChange={(e) => mudar('cidade', e.target.value)} />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">UF</span>
            <input
              maxLength={2}
              value={form.uf}
              onChange={(e) => mudar('uf', e.target.value.toUpperCase())}
            />
          </label>

          {erro !== null && (
            <div className="mensagem-erro campo-cheia" role="alert">
              <p>{erro}</p>
              {detalhes.length > 0 && (
                <ul className="lista-erros">
                  {detalhes.map((d) => (
                    <li key={d.campo}>
                      <b>{d.campo}:</b> {d.problema}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="formulario-acoes campo-cheia">
            <button type="submit" className="botao-acao" disabled={enviando}>
              {enviando ? 'Salvando…' : 'Salvar'}
            </button>
            {salvo && <span className="formulario-ok">Salvo.</span>}
          </div>
        </form>

        <PreviaDoTimbre form={form} logo={logo} />
      </div>
    </>
  );
}

/**
 * O logo, com pré-visualização.
 *
 * ACEITA MENOS FORMATOS QUE O RESTO DO SISTEMA, e o `accept` do campo
 * diz exatamente quais. Exames aceitam WebP; o logo não, porque o
 * gerador de PDF só embute PNG e JPEG. Deixar o seletor oferecer WebP
 * faria a pessoa escolher um arquivo e levar um erro depois — o
 * servidor recusa de qualquer jeito, mas a hora de dizer "este não" é
 * antes de escolher.
 */
function LogoDaAcademia({
  logo,
  nome,
  aoMudar,
}: {
  logo: string | null;
  nome: string;
  aoMudar: () => void;
}): ReactNode {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const entrada = useRef<HTMLInputElement>(null);

  const enviar = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const arquivo = e.target.files?.[0];
    e.target.value = '';
    if (arquivo === undefined) return;
    setErro(null);
    setOcupado(true);
    try {
      /* `transparente` porque é LOGOTIPO: ele é impresso sobre o papel
         timbrado e usado como marca d'água, e achatá-lo contra um fundo
         branco deixaria um retângulo visível em cima do relatório. Sai
         em PNG, com o fundo que veio. */
      await enviarLogoDaAcademia(await prepararImagem(arquivo, { lado: 640, transparente: true }));
      aoMudar();
    } catch (x) {
      setErro(x instanceof ApiError ? x.message : 'Não foi possível enviar o logo.');
    } finally {
      setOcupado(false);
    }
  };

  const remover = async (): Promise<void> => {
    if (!window.confirm('Remover o logo da academia?\n\nOs relatórios voltam a sair sem ele.')) {
      return;
    }
    setOcupado(true);
    try {
      await removerLogoDaAcademia();
      aoMudar();
    } catch {
      setErro('Não foi possível remover o logo.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="acad-logo">
      <div className={`acad-logo-quadro ${logo === null ? 'vazio' : ''}`}>
        {logo === null ? (
          <span className="acad-logo-vazio">
            Sem logo — o relatório sai com a marca d’água da Stabilize
          </span>
        ) : (
          <img src={logo} alt={`Logo de ${nome}`} />
        )}
      </div>

      <div className="acad-logo-acoes">
        <button
          type="button"
          className="botao-secundario"
          disabled={ocupado}
          onClick={() => entrada.current?.click()}
        >
          {ocupado ? 'Enviando…' : logo === null ? 'Enviar o logo' : 'Trocar o logo'}
        </button>
        {logo !== null && (
          <button
            type="button"
            className="botao-texto-perigo"
            disabled={ocupado}
            onClick={() => void remover()}
          >
            Remover
          </button>
        )}
        <input
          ref={entrada}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => void enviar(e)}
        />
        <p className="campo-dica">
          Envie qualquer imagem — ela é ajustada aqui mesmo. Fundo transparente fica melhor na
          marca d’água, e é preservado.
        </p>
        {erro !== null && <p className="acad-logo-erro">{erro}</p>}
      </div>
    </div>
  );
}

/**
 * Como vai ficar no papel.
 *
 * Monta a MESMA linha do rodapé, com os mesmos separadores do servidor —
 * ver `montarEndereco` em `reports/timbre.ts`. Duas montagens do mesmo
 * texto é uma que fica para trás, e o jeito honesto de evitar isso seria
 * mover a função para o pacote compartilhado. Não foi feito aqui porque
 * tocaria o servidor fora do escopo desta fatia, e fica anotado.
 */
function PreviaDoTimbre({ form, logo }: { form: Formulario; logo: string | null }): ReactNode {
  const rua = [form.logradouro, form.numero].filter((p) => p !== '').join(', ');
  const comRua = [rua, form.complemento].filter((p) => p !== '').join(' — ');
  const municipio =
    form.cidade !== '' && form.uf !== '' ? `${form.cidade}/${form.uf}` : form.cidade || form.uf;
  const cep = form.cep === '' ? '' : `CEP ${form.cep}`;
  const linha = [comRua, form.bairro, municipio, cep].filter((p) => p !== '').join(' · ');

  return (
    <aside className="acad-previa">
      <h2>No papel</h2>
      <p className="acad-previa-nota">É assim que o relatório sai impresso.</p>

      <div className="acad-folha">
        <div className="acad-folha-topo">
          {logo === null ? (
            <span className="acad-folha-semlogo" />
          ) : (
            <img src={logo} alt="" className="acad-folha-logo" />
          )}
          <div className="acad-folha-contato">
            <strong>{(form.nome || 'NOME DA ACADEMIA').toUpperCase()}</strong>
            {form.telefone !== '' && <span>{form.telefone}</span>}
          </div>
        </div>

        <div className="acad-folha-titulo">Relação de alunos</div>
        <div className="acad-folha-corpo">
          <span />
          <span />
          <span />
          <span />
        </div>

        <div className="acad-folha-rodape">
          <span>Relação de alunos · emitido em {new Date().toLocaleDateString('pt-BR')}</span>
          {linha !== '' && (
            <span className="acad-folha-endereco">
              {form.telefone !== '' ? `${form.telefone}  ·  ` : ''}
              {linha}
            </span>
          )}
        </div>
      </div>

      {linha === '' && (
        <p className="acad-previa-aviso">
          Sem endereço, o rodapé sai só com a identificação do relatório — como hoje.
        </p>
      )}
    </aside>
  );
}

function vazioParaNulo(v: string): string | null {
  const t = v.trim();
  return t === '' ? null : t;
}

/* ====================================================================
 * A TABELA DE VALORES
 * ================================================================== */

/**
 * Os ciclos de cobrança do sistema, com nome de gente.
 *
 * A ORDEM É A DA DURAÇÃO, e não a alfabética: quem monta uma tabela de
 * preços pensa "da sessão avulsa até o anual", e uma lista que começa
 * em "Anual" obriga a procurar.
 */
const CICLOS: { valor: string; rotulo: string }[] = [
  { valor: 'SESSION', rotulo: 'Por sessão' },
  { valor: 'WEEKLY', rotulo: 'Semanal' },
  { valor: 'BIWEEKLY', rotulo: 'Quinzenal' },
  { valor: 'MONTHLY', rotulo: 'Mensal' },
  { valor: 'QUARTERLY', rotulo: 'Trimestral' },
  { valor: 'SEMIANNUAL', rotulo: 'Semestral' },
  { valor: 'ANNUAL', rotulo: 'Anual' },
];
/**
 * O que os números do formulário significam, enquanto são digitados.
 *
 * Não é decoração: são as duas contas que decidem se a tabela está certa
 * — o equivalente mensal, que é a única forma de comparar ciclos
 * diferentes, e a divisão entre o profissional e a academia.
 */
function Previa({
  ciclo,
  valor,
  comissao,
}: {
  ciclo: string;
  valor: string;
  comissao: string;
}): ReactNode {
  let centavos = 0;
  try {
    centavos = reaisParaCentavos(valor);
  } catch {
    /* Digitando ainda — "39," não é um número, e piscar um erro a cada
       tecla é pior do que não mostrar nada até fazer sentido. */
    return null;
  }
  if (centavos <= 0) return null;

  const pontos = Number(comissao.replace(',', '.'));
  const bp = Number.isFinite(pontos) && pontos > 0 ? Math.round(pontos * 100) : 0;
  const doProfissional = Math.round((centavos * bp) / 10_000);
  const mensal = porMes(ciclo, centavos);

  return (
    <div className="plano-previa campo-cheia">
      <div className="plano-previa-item">
        <span>O aluno paga</span>
        <strong className="dinheiro">{formatCents(centavos)}</strong>
        <span className="plano-previa-nota">{rotuloDoCiclo(ciclo).toLowerCase()}</span>
      </div>

      {mensal !== null && (
        <div className="plano-previa-item">
          <span>Equivale por mês</span>
          <strong className="dinheiro">{formatCents(mensal)}</strong>
          <span className="plano-previa-nota">para comparar com o mensal</span>
        </div>
      )}

      {bp > 0 && (
        <>
          <div className="plano-previa-item">
            <span>Do profissional</span>
            <strong className="dinheiro">{formatCents(doProfissional)}</strong>
            <span className="plano-previa-nota">{(bp / 100).toFixed(0)}% do recebido</span>
          </div>
          <div className="plano-previa-item destaque">
            <span>Fica na academia</span>
            <strong className="dinheiro">{formatCents(centavos - doProfissional)}</strong>
            <span className="plano-previa-nota">por cobrança</span>
          </div>
        </>
      )}
    </div>
  );
}

const rotuloDoCiclo = (v: string): string =>
  CICLOS.find((c) => c.valor === v)?.rotulo ?? v;

/**
 * Quantos meses cada cobrança cobre.
 *
 * Serve para uma coisa só, e é a que falta numa tabela de preços:
 * comparar planos de ciclos diferentes. "Trimestral R$ 900" e "Mensal
 * R$ 350" não se comparam de cabeça — o primeiro é R$ 300 por mês, e é
 * mais barato. Quem monta a tabela decide errado sem essa conta, e ela é
 * a conta que ninguém faz na hora.
 *
 * `SESSION` e `WEEKLY` ficam de fora: cobrança por sessão não tem mês, e
 * semanal depende de quantas vezes a pessoa vem. Inventar um número aqui
 * seria pior do que não mostrar.
 */
const MESES_DO_CICLO: Record<string, number> = {
  BIWEEKLY: 0.5,
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
};

/** O equivalente mensal em centavos, ou `null` quando não faz sentido. */
function porMes(ciclo: string, valorCentavos: number): number | null {
  const meses = MESES_DO_CICLO[ciclo];
  if (meses === undefined || valorCentavos <= 0) return null;
  if (meses === 1) return null; // já é mensal: repetir o número é ruído
  return Math.round(valorCentavos / meses);
}

interface FormPlano {
  id: string | null;
  nome: string;
  ciclo: string;
  valor: string;
  sessoes: string;
  comissao: string;
}

const PLANO_VAZIO: FormPlano = {
  id: null,
  nome: '',
  ciclo: 'MONTHLY',
  valor: '',
  sessoes: '',
  comissao: '',
};

function TabelaDeValores(): ReactNode {
  const [planos, setPlanos] = useState<Plano[] | null>(null);
  const [inativos, setInativos] = useState(false);
  const [form, setForm] = useState<FormPlano | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async (): Promise<void> => {
    try {
      const { data } = await listarPlanos(inativos);
      setPlanos(data);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a tabela.');
    }
  }, [inativos]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const gravar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (form === null) return;
    setErro(null);
    setOcupado(true);
    try {
      const dados = {
        nome: form.nome.trim(),
        ciclo: form.ciclo,
        /* O valor entra em reais e sai em centavos. A conversão é aqui e
           não no servidor porque a tela é a única que sabe que o campo
           está em reais — mandar "390,00" para a API obrigaria o
           servidor a adivinhar a vírgula. */
        valorCentavos: reaisParaCentavos(form.valor),
        sessoesIncluidas: form.sessoes.trim() === '' ? null : Number(form.sessoes),
        comissaoBp: form.comissao.trim() === '' ? 0 : Math.round(Number(form.comissao) * 100),
      };
      if (form.id === null) await criarPlano(dados);
      else await salvarPlano(form.id, dados);
      setForm(null);
      await carregar();
    } catch (x) {
      setErro(x instanceof ApiError ? x.message : 'Não foi possível salvar o plano.');
    } finally {
      setOcupado(false);
    }
  };

  const desativar = async (p: Plano): Promise<void> => {
    const aviso =
      p.emUso === 0
        ? `Tirar "${p.nome}" da tabela?`
        : `Tirar "${p.nome}" da tabela?\n\n${p.emUso} contrato(s) usam este plano hoje. Eles CONTINUAM cobrando normalmente — o plano só deixa de aparecer para novos contratos.`;
    if (!window.confirm(aviso)) return;
    setOcupado(true);
    try {
      await apagarPlano(p.id);
      await carregar();
    } catch {
      setErro('Não foi possível tirar o plano da tabela.');
    } finally {
      setOcupado(false);
    }
  };

  if (planos === null) return <Carregando rotulo="Carregando a tabela de valores" />;

  return (
    <section className="plano-tela">
      <div className="plano-cabecalho">
        <div>
          <h2>Tabela de valores</h2>
          <p>
            O contrato do aluno puxa daqui. O valor continua editável em cada contrato — a tabela é
            a sugestão, não a trava.
          </p>
        </div>
        <button
          type="button"
          className="botao-acao"
          onClick={() => setForm({ ...PLANO_VAZIO })}
          disabled={ocupado}
        >
          Novo plano
        </button>
      </div>

      {erro !== null && (
        <div className="mensagem-erro" role="alert">
          <p>{erro}</p>
        </div>
      )}

      {form !== null && (
        <form className="formulario plano-form" onSubmit={(e) => void gravar(e)} noValidate>
          <label className="campo campo-meia">
            <span className="campo-rotulo">Nome do plano</span>
            <input
              value={form.nome}
              autoFocus
              required
              placeholder="Mensal 3× por semana"
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
            />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Cobrança</span>
            <select
              value={form.ciclo}
              onChange={(e) => setForm({ ...form, ciclo: e.target.value })}
            >
              {CICLOS.map((c) => (
                <option key={c.valor} value={c.valor}>
                  {c.rotulo}
                </option>
              ))}
            </select>
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Valor (R$)</span>
            <input
              inputMode="decimal"
              required
              placeholder="390,00"
              value={form.valor}
              onChange={(e) => setForm({ ...form, valor: e.target.value })}
            />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Sessões incluídas</span>
            <input
              inputMode="numeric"
              placeholder="deixe vazio se for ilimitado"
              value={form.sessoes}
              onChange={(e) => setForm({ ...form, sessoes: e.target.value })}
            />
          </label>

          <label className="campo campo-meia">
            <span className="campo-rotulo">Comissão do profissional (%)</span>
            <input
              inputMode="decimal"
              placeholder="0"
              value={form.comissao}
              onChange={(e) => setForm({ ...form, comissao: e.target.value })}
            />
            <span className="campo-dica">Sobre o valor recebido. Zero se não houver.</span>
          </label>

          {/* ==================================================
              A CONTA, ENQUANTO SE DIGITA

              Uma tabela de preços é uma decisão de negócio, e as duas
              perguntas que ela levanta não estão em nenhum campo:
              "quanto isso dá por mês?" e "quanto sobra para a
              academia?". Sem elas, quem monta a tabela põe um trimestral
              mais caro que o mensal e só descobre quando um aluno
              aponta.

              Aparece a partir do momento em que há um valor, e some
              quando não há — um quadro que fica ali dizendo R$ 0,00 vira
              parte do formulário e para de ser lido.
              ================================================== */}
          <Previa ciclo={form.ciclo} valor={form.valor} comissao={form.comissao} />

          <div className="formulario-acoes campo-cheia">
            <button type="submit" className="botao-acao" disabled={ocupado}>
              {ocupado ? 'Salvando…' : form.id === null ? 'Criar plano' : 'Salvar'}
            </button>
            <button type="button" className="botao-texto" onClick={() => setForm(null)}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      {planos.length === 0 ? (
        <div className="estado-vazio">
          <p>
            <strong>A tabela está vazia.</strong> Sem ela, o valor de cada aluno é digitado à mão,
            um a um — e é assim que dois alunos do mesmo plano acabam pagando diferente.
          </p>
        </div>
      ) : (
        <div className="plano-grade">
          {planos.map((p) => {
            const mensal = porMes(p.ciclo, p.valorCentavos);
            const comissao = Math.round((p.valorCentavos * p.comissaoBp) / 10_000);
            return (
              <article key={p.id} className={`plano-cartao ${p.ativo ? '' : 'fora'}`}>
                <header className="plano-cartao-topo">
                  <span className="plano-ciclo">{rotuloDoCiclo(p.ciclo)}</span>
                  {!p.ativo && <span className="plano-selo">fora da tabela</span>}
                </header>

                <h3 className="plano-nome">{p.nome}</h3>

                {/* O VALOR É O ASSUNTO DA TELA, e por isso é o maior
                    elemento do cartão. Na tabela ele era uma célula entre
                    seis, do mesmo tamanho de "Sessões" — que quase sempre
                    é um travessão. */}
                <p className="plano-valor dinheiro">{formatCents(p.valorCentavos)}</p>
                {mensal !== null && (
                  <p className="plano-equivalente">
                    equivale a <strong className="dinheiro">{formatCents(mensal)}</strong> por mês
                  </p>
                )}

                <dl className="plano-detalhes">
                  <div>
                    <dt>Sessões</dt>
                    <dd>{p.sessoesIncluidas === null ? 'ilimitadas' : p.sessoesIncluidas}</dd>
                  </div>
                  <div>
                    <dt>Comissão</dt>
                    <dd>
                      {p.comissaoBp === 0 ? (
                        'não há'
                      ) : (
                        <>
                          {(p.comissaoBp / 100).toFixed(0)}%{' '}
                          <span className="plano-secundario dinheiro">
                            ({formatCents(comissao)})
                          </span>
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Em uso</dt>
                    {/* CONTRATOS, e não um travessão: é este número que
                        transforma "tirar da tabela" numa decisão
                        informada. */}
                    <dd>
                      {p.emUso === 0
                        ? 'nenhum aluno'
                        : `${p.emUso} aluno${p.emUso === 1 ? '' : 's'}`}
                    </dd>
                  </div>
                </dl>

                {p.ativo && (
                  <div className="plano-acoes">
                    <button
                      type="button"
                      className="botao-texto"
                      disabled={ocupado}
                      onClick={() =>
                        setForm({
                          id: p.id,
                          nome: p.nome,
                          ciclo: p.ciclo,
                          valor: (p.valorCentavos / 100).toFixed(2).replace('.', ','),
                          sessoes: p.sessoesIncluidas === null ? '' : String(p.sessoesIncluidas),
                          comissao: p.comissaoBp === 0 ? '' : String(p.comissaoBp / 100),
                        })
                      }
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="botao-texto-perigo"
                      disabled={ocupado}
                      onClick={() => void desativar(p)}
                    >
                      Tirar da tabela
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <label className="plano-inativos">
        <input
          type="checkbox"
          checked={inativos}
          onChange={(e) => setInativos(e.target.checked)}
        />
        Mostrar planos que saíram da tabela
      </label>
    </section>
  );
}

/**
 * "390,00" e "390.00" e "1.390,50" viram centavos.
 *
 * ACEITA AS DUAS PONTUAÇÕES porque as duas são digitadas: quem usa
 * teclado numérico do celular põe ponto, quem usa o teclado do
 * computador põe vírgula. Recusar uma delas transforma um plano de
 * R$ 1.390,50 em R$ 139.050,00 ou num erro de validação sem explicação.
 */
function reaisParaCentavos(v: string): number {
  const limpo = v.trim().replace(/\s/g, '');
  /* Se tem vírgula, ela é o separador decimal e o ponto é de milhar. */
  const normalizado = limpo.includes(',')
    ? limpo.replace(/\./g, '').replace(',', '.')
    : limpo;
  const numero = Number(normalizado);
  return Number.isFinite(numero) ? Math.round(numero * 100) : 0;
}
