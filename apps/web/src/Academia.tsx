import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  buscarLogoDaAcademia,
  enviarLogoDaAcademia,
  lerAcademia,
  removerLogoDaAcademia,
  salvarAcademia,
  type Academia as AcademiaDados,
} from './api.js';
import { Carregando, Erro } from './ui.jsx';
import { e164ParaMascara, mascararCep, mascararTelefone, telefoneParaE164 } from '@stabilize/shared';
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

const TAMANHO_MAXIMO_MB = 2;

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

export function Academia(): ReactNode {
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
      <div className="secao-cabecalho">
        <h1>A academia</h1>
        <p>
          O que está aqui sai impresso no papel timbrado dos relatórios e na carteirinha do aluno.
        </p>
      </div>

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
    if (arquivo.size > TAMANHO_MAXIMO_MB * 1024 * 1024) {
      setErro(`A imagem tem mais de ${TAMANHO_MAXIMO_MB} MB. Envie uma menor.`);
      return;
    }
    setErro(null);
    setOcupado(true);
    try {
      await enviarLogoDaAcademia(arquivo);
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
          PNG ou JPEG, até {TAMANHO_MAXIMO_MB} MB. Fundo transparente fica melhor na marca d’água.
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
