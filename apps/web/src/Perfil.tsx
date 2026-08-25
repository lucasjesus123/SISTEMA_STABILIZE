import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  buscarFoto,
  enviarFotoPerfil,
  lerPerfil,
  removerFotoPerfil,
  salvarPerfil,
  type Perfil as PerfilDados,
  type Principal,
} from './api.js';
import { Carregando, Erro } from './ui.jsx';
import { e164ParaMascara, mascararCep, mascararTelefone, telefoneParaE164 } from '@stabilize/shared';
import { mesclarEndereco, useBuscaDeCep } from './endereco.js';
import { prepararImagem } from './imagem.js';

/**
 * O perfil de quem está usando o sistema.
 *
 * Vale para todo mundo — dono, recepção, profissional e aluno —, e é a
 * única seção do menu que não depende de permissão: não existe papel que
 * não possa editar o próprio nome.
 *
 * O QUE ESTA TELA NÃO DEIXA MUDAR, e a ausência é o ponto: e-mail e
 * papel aparecem, em cinza, sem campo. O e-mail é a identidade do login
 * e trocá-lo é operação de administração, com confirmação; o papel é
 * quem pode o quê, e um formulário de perfil que muda o próprio papel é
 * um formulário que promove a si mesmo. O servidor também recusa os dois
 * — ver `gravarPerfil` —, mas a tela não deve nem oferecer.
 */

interface Formulario {
  nome: string;
  telefone: string;
  whatsapp: string;
  dataNascimento: string;
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
  telefone: '',
  whatsapp: '',
  dataNascimento: '',
  cep: '',
  logradouro: '',
  numero: '',
  complemento: '',
  bairro: '',
  cidade: '',
  uf: '',
};

export function Perfil({
  principal,
  semCabecalho = false,
}: {
  principal: Principal;
  /* Dentro da janela de Configurações o título já está no alto dela.
     Repetir "Meu perfil" logo abaixo de "Configurações" é dizer duas
     vezes onde a pessoa está. */
  semCabecalho?: boolean;
}): ReactNode {
  const [dados, setDados] = useState<PerfilDados | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<{ campo: string; problema: string }[]>([]);
  const [salvo, setSalvo] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const carregar = useCallback(async (): Promise<void> => {
    setCarregando(true);
    setErro(null);
    try {
      const { data } = await lerPerfil();
      setDados(data);
      setForm({
        nome: data.nome,
        telefone: e164ParaMascara(data.telefone),
        whatsapp: e164ParaMascara(data.whatsapp),
        dataNascimento: data.dataNascimento ?? '',
        cep: mascararCep(data.endereco.cep ?? ''),
        logradouro: data.endereco.logradouro ?? '',
        numero: data.endereco.numero ?? '',
        complemento: data.endereco.complemento ?? '',
        bairro: data.endereco.bairro ?? '',
        cidade: data.endereco.cidade ?? '',
        uf: data.endereco.uf ?? '',
      });
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o perfil.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /* O endereço chega sozinho no oitavo dígito do CEP e só preenche o que
     está em branco — ver `useBuscaDeCep`. */
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
      /* A tela guarda a máscara; o servidor recebe o dado. O WhatsApp
         sai em E.164 e o CEP em oito dígitos — ver `formato.ts`. */
      const { data } = await salvarPerfil({
        nome: form.nome.trim(),
        telefone: telefoneParaE164(form.telefone),
        whatsapp: telefoneParaE164(form.whatsapp),
        dataNascimento: form.dataNascimento === '' ? null : form.dataNascimento,
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

  if (carregando) return <Carregando rotulo="Carregando o perfil" />;
  if (dados === null) {
    return <Erro mensagem={erro ?? 'Perfil indisponível.'} aoTentar={() => void carregar()} />;
  }

  return (
    <>
      {!semCabecalho && (
        <div className="secao-cabecalho">
          <h1>Meu perfil</h1>
          <p>Seus dados de contato e endereço. O e-mail e a senha ficam na aba Acesso.</p>
        </div>
      )}

      <RetratoDoPerfil
        temFoto={dados.temFoto}
        nome={dados.nome}
        aoMudar={(temFoto) => setDados((d) => (d === null ? d : { ...d, temFoto }))}
      />

      <form className="formulario" onSubmit={(e) => void enviar(e)} noValidate>
        <h2 className="formulario-secao campo-cheia">Dados pessoais</h2>

        <label className="campo campo-cheia">
          <span className="campo-rotulo">Nome completo</span>
          <input
            value={form.nome}
            onChange={(e) => mudar('nome', e.target.value)}
            required
            autoComplete="name"
          />
        </label>

        {/* Somente leitura, e sem cara de campo desabilitado: um campo
            cinza que não aceita clique parece defeito. Estes dois são
            informação, então são mostrados como informação. */}
        <div className="campo campo-meia campo-fixo">
          <span className="campo-rotulo">E-mail</span>
          <p className="campo-fixo-valor">{dados.email}</p>
          <span className="campo-dica">Você entra com ele. Para trocar, veja a aba Acesso.</span>
        </div>
        <div className="campo campo-meia campo-fixo">
          <span className="campo-rotulo">Papel</span>
          <p className="campo-fixo-valor">{principal.roleLabel}</p>
          <span className="campo-dica">Define o que você enxerga no sistema.</span>
        </div>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Telefone</span>
          <input
            inputMode="tel"
            autoComplete="tel"
            placeholder="(51) 99999-9999"
            value={form.telefone}
            onChange={(e) => mudar('telefone', mascararTelefone(e.target.value))}
          />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">WhatsApp</span>
          <input
            inputMode="tel"
            placeholder="(51) 99999-9999"
            value={form.whatsapp}
            onChange={(e) => mudar('whatsapp', mascararTelefone(e.target.value))}
          />
          <span className="campo-dica">É por aqui que a academia manda os lembretes.</span>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Nascimento</span>
          <input
            type="date"
            value={form.dataNascimento}
            onChange={(e) => mudar('dataNascimento', e.target.value)}
          />
        </label>

        {/* O título quebra a linha do grid, o que faz o CEP começar uma
            faixa nova em vez de sobrar ao lado do Nascimento. É layout
            saindo da estrutura, e não de uma regra de largura a mais. */}
        <h2 className="formulario-secao campo-cheia">Endereço</h2>

        {/* O CEP VEM PRIMEIRO, e a ordem é o recurso: preenchê-lo
            completa rua, bairro, cidade e estado sozinho. Se ele viesse
            depois do logradouro, a pessoa digitaria à mão o que o campo
            de baixo ia preencher. */}
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
            autoComplete="address-line1"
            value={form.logradouro}
            onChange={(e) => mudar('logradouro', e.target.value)}
          />
        </label>

        <label className="campo campo-terco">
          <span className="campo-rotulo">Número</span>
          <input value={form.numero} onChange={(e) => mudar('numero', e.target.value)} />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Complemento</span>
          <input value={form.complemento} onChange={(e) => mudar('complemento', e.target.value)} />
        </label>
        <label className="campo campo-terco">
          <span className="campo-rotulo">Bairro</span>
          <input value={form.bairro} onChange={(e) => mudar('bairro', e.target.value)} />
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Cidade</span>
          <input value={form.cidade} onChange={(e) => mudar('cidade', e.target.value)} />
        </label>
        <label className="campo campo-meia">
          <span className="campo-rotulo">Estado</span>
          <input
            maxLength={2}
            value={form.uf}
            onChange={(e) => mudar('uf', e.target.value.toUpperCase())}
          />
          <span className="campo-dica">Sigla, como RS</span>
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
          {/* `aria-live` para quem usa leitor de tela ouvir a
              confirmação — sem isso, salvar é silencioso. */}
          <span className="aviso-salvo" role="status" aria-live="polite">
            {salvo ? 'Perfil salvo.' : ''}
          </span>
          <button type="submit" className="botao-acao" disabled={enviando}>
            {enviando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </>
  );
}

function vazioParaNulo(v: string): string | null {
  const limpo = v.trim();
  return limpo === '' ? null : limpo;
}

/* ====================================================================
 * A foto
 * ================================================================== */

/**
 * Retrato com envio e remoção.
 *
 * A IMAGEM NÃO PODE VIR DE UM `<img src="/api/perfil/foto">`. O access
 * token vive em memória e viaja no cabeçalho Authorization; o carregador
 * de imagem do navegador não manda cabeçalho, então a requisição
 * chegaria sem autenticação e voltaria 401 — um retrato quebrado que
 * ninguém consegue explicar. Buscamos os bytes e montamos um endereço
 * temporário, que é revogado ao trocar de foto e ao sair da tela.
 */
function RetratoDoPerfil({
  temFoto,
  nome,
  aoMudar,
}: {
  temFoto: boolean;
  nome: string;
  aoMudar: (temFoto: boolean) => void;
}): ReactNode {
  const [endereco, setEndereco] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  /* Sobe a cada envio para forçar a rebusca SEM passar por `temFoto`
     false→true. A versão anterior fazia esse vai-e-volta, e ele dispara
     o efeito DUAS vezes: a segunda revoga o endereço que a primeira
     acabou de criar. O resultado é um `<img>` apontando para um blob que
     não existe mais — um círculo vazio, sem erro nenhum no console. */
  const [versao, setVersao] = useState(0);
  /* Um `<img>` que falha ao decodificar não avisa ninguém: ele
     simplesmente não desenha. Sem este estado, o retrato quebrado fica
     como um círculo cinza que parece "sem foto" e não é. */
  const [falhou, setFalhou] = useState(false);
  const entrada = useRef<HTMLInputElement>(null);

  /* Um blob vivo segura a imagem inteira na memória da aba. Guardamos o
     endereço atual numa ref para revogar o anterior ao trocar, e o
     último ao desmontar. */
  const atual = useRef<string | null>(null);
  const trocarEndereco = useCallback((novo: string | null) => {
    if (atual.current !== null) URL.revokeObjectURL(atual.current);
    atual.current = novo;
    setEndereco(novo);
  }, []);

  useEffect(() => {
    return () => {
      if (atual.current !== null) URL.revokeObjectURL(atual.current);
    };
  }, []);

  useEffect(() => {
    if (!temFoto) {
      trocarEndereco(null);
      return;
    }
    let valeu = true;
    setFalhou(false);
    void (async () => {
      const url = await buscarFoto('/api/perfil/foto');
      // Trocou de foto enquanto esta buscava: descarta a mais antiga.
      if (!valeu) {
        if (url !== null) URL.revokeObjectURL(url);
        return;
      }
      trocarEndereco(url);
    })();
    return () => {
      valeu = false;
    };
  }, [temFoto, versao, trocarEndereco]);

  const escolher = async (arquivo: File | undefined): Promise<void> => {
    if (arquivo === undefined) return;
    setErro(null);
    setFalhou(false);
    setOcupado(true);
    try {
      /* Diminuída e convertida ANTES de subir — ver `prepararFoto`. O
         que vai para o servidor é o que este navegador acabou de
         desenhar, então não existe mais o caso de a imagem subir e
         voltar sem conseguir ser mostrada. */
      await enviarFotoPerfil(await prepararImagem(arquivo, { lado: 512 }));
      /* `versao` força a rebusca mesmo quando `temFoto` já era `true` —
         sem ela o efeito não reexecuta e a tela segue mostrando a imagem
         antiga depois de um envio bem-sucedido.

         O que NÃO se faz aqui é passar por `aoMudar(false)` antes do
         `aoMudar(true)`: era o que a versão anterior fazia, e as duas
         mudanças disparam o efeito duas vezes, com a segunda revogando o
         endereço que a primeira criou. */
      aoMudar(true);
      setVersao((v) => v + 1);
    } catch (e) {
      setErro(
        e instanceof ApiError || e instanceof Error
          ? e.message
          : 'Não foi possível enviar a imagem.',
      );
    } finally {
      setOcupado(false);
      /* Limpa o input: sem isso, escolher O MESMO arquivo de novo (para
         repetir um envio que falhou) não dispara `change`. */
      if (entrada.current !== null) entrada.current.value = '';
    }
  };

  const remover = async (): Promise<void> => {
    setErro(null);
    setOcupado(true);
    try {
      await removerFotoPerfil();
      trocarEndereco(null);
      aoMudar(false);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível remover a imagem.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="retrato">
      <div className="retrato-imagem">
        {endereco !== null && !falhou ? (
          <img
            src={endereco}
            alt={`Foto de ${nome}`}
            /* Se o blob não decodificar — arquivo corrompido, endereço já
               revogado, formato que o navegador não abre —, cai para as
               iniciais em vez de deixar um círculo vazio que parece "sem
               foto". Um retrato que falha em silêncio é indistinguível de
               um retrato que não existe, e o usuário fica tentando
               reenviar a mesma imagem. */
            onError={() => setFalhou(true)}
          />
        ) : (
          /* Iniciais, e não um ícone genérico de pessoa: numa lista de
             gente, a inicial já distingue, e uma silhueta cinza repetida
             quinze vezes não distingue nada. */
          <span className="retrato-iniciais" aria-hidden="true">
            {iniciais(nome)}
          </span>
        )}
      </div>

      <div className="retrato-acoes">
        <p className="retrato-titulo">Foto</p>
        <p className="retrato-dica">
          Qualquer foto serve — ela é ajustada e recortada aqui mesmo, sem você precisar mexer.
        </p>

        <input
          ref={entrada}
          type="file"
          /* QUALQUER IMAGEM. A lista estreita escondia do seletor de
             arquivos exatamente as fotos que a pessoa tem no celular —
             HEIC do iPhone, à frente — e a mensagem que sobrava era "meu
             arquivo nem aparece". O navegador decodifica o que sabe
             abrir, e `prepararFoto` entrega um JPEG padrão; o que ele
             não abre é recusado na hora, com o motivo. */
          accept="image/*"
          className="retrato-entrada"
          id="foto-do-perfil"
          onChange={(e) => void escolher(e.target.files?.[0])}
          disabled={ocupado}
        />
        <div className="retrato-botoes">
          {/* `<label>` ligado ao input, e não um botão que o clica por
              script: o teclado alcança o rótulo nativamente, e o leitor
              de tela anuncia "escolher arquivo". */}
          <label className="botao-secundario" htmlFor="foto-do-perfil">
            {ocupado ? 'Enviando…' : endereco !== null ? 'Trocar foto' : 'Escolher foto'}
          </label>
          {endereco !== null && (
            <button
              type="button"
              className="botao-texto-perigo"
              onClick={() => void remover()}
              disabled={ocupado}
            >
              Remover
            </button>
          )}
        </div>

        {falhou && erro === null && (
          <p className="retrato-erro" role="alert">
            Não consegui abrir a imagem. Envie outra, de preferência JPG ou PNG.
          </p>
        )}

        {erro !== null && (
          <p className="retrato-erro" role="alert">
            {erro}
          </p>
        )}
      </div>
    </div>
  );
}

/** Até duas iniciais: primeira e última palavra do nome. */
export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '?';
  const primeira = partes[0]?.[0] ?? '';
  const ultima = partes.length > 1 ? (partes[partes.length - 1]?.[0] ?? '') : '';
  return (primeira + ultima).toUpperCase();
}
