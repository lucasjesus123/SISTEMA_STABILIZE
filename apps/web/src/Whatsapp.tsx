import { useEffect, useState, type ReactNode } from 'react';
import { Carregando, Vazio } from './ui.jsx';
import * as api from './api.js';
import {
  ApiError,
  buscarMensagens,
  buscarWhatsapp,
  conectarWhatsapp,
  dispararAniversarios,
  testarWhatsapp,
  type ConexaoWhatsapp,
  type MensagemWhatsapp,
} from './api.js';

/**
 * Conexão do WhatsApp da academia.
 *
 * A TELA EXISTE PARA UMA COISA: conectar um número lendo um QR Code. É
 * a única operação do sistema que depende de alguém pegar o celular, e
 * por isso o estado tem que ser óbvio o tempo todo — quem está no meio
 * de escanear não deve precisar adivinhar se funcionou.
 *
 * O QR EXPIRA. A uazapi troca o código a cada poucos segundos, então a
 * tela repete a consulta enquanto a conexão não fecha. Sem isso, a
 * pessoa escaneia um código morto e conclui que o sistema está quebrado.
 */

const ROTULO_STATUS: Record<string, string> = {
  CONNECTED: 'conectado',
  CONNECTING: 'aguardando leitura',
  DISCONNECTED: 'desconectado',
  DESCONHECIDO: 'não foi possível consultar',
};

export function Whatsapp(): ReactNode {
  const [conexao, setConexao] = useState<ConexaoWhatsapp | null>(null);
  const [mensagens, setMensagens] = useState<MensagemWhatsapp[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  /* O código de pareamento anda junto do QR: quando a câmera não lê —
     luz ruim, tela suja, celular antigo —, é por ele que se conecta. */
  const [codigo, setCodigo] = useState<string | null>(null);
  const [conectando, setConectando] = useState(false);
  const [numeroTeste, setNumeroTeste] = useState('');

  const carregar = async (comEsqueleto = true): Promise<void> => {
    if (comEsqueleto) setCarregando(true);
    try {
      const [c, m] = [await buscarWhatsapp(), await buscarMensagens()];
      setConexao(c.data);
      setMensagens(m.data);
      if (c.data?.status === 'CONNECTED') {
        setQr(null);
        setCodigo(null);
      }
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a conexão.');
    } finally {
      if (comEsqueleto) setCarregando(false);
    }
  };

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Enquanto há QR na tela, reconsulta a cada 5s: o código expira, e o
     status muda no momento em que o celular termina de ler. */
  useEffect(() => {
    if (qr === null) return;
    const t = setInterval(() => void carregar(false), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr]);

  const conectar = async (): Promise<void> => {
    setConectando(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await conectarWhatsapp();
      setQr(r.data.qr);
      setCodigo(r.data.codigo);
      if (r.data.qr === null && r.data.codigo === null) {
        setAviso('O provedor não devolveu um código. Tente de novo em alguns segundos.');
      }
      await carregar(false);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível iniciar a conexão.');
    } finally {
      setConectando(false);
    }
  };

  const testar = async (): Promise<void> => {
    setErro(null);
    setAviso(null);
    try {
      await testarWhatsapp(numeroTeste.trim(), 'Teste de conexão do sistema Stabilize ✅');
      setAviso('Mensagem de teste enviada.');
      setNumeroTeste('');
      await carregar(false);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível enviar o teste.');
    }
  };

  const aniversarios = async (): Promise<void> => {
    setErro(null);
    setAviso(null);
    try {
      const r = await dispararAniversarios();
      setAviso(
        r.data.enviadas === 0 && r.data.jaEnviadas === 0
          ? 'Ninguém faz aniversário hoje.'
          : `${r.data.enviadas} enviada(s), ${r.data.jaEnviadas} já enviada(s) hoje.`,
      );
      await carregar(false);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível disparar os aniversários.');
    }
  };

  if (carregando) return <Carregando rotulo="Carregando a conexão" />;

  const conectado = conexao?.status === 'CONNECTED';

  return (
    <>
      <div className="secao-cabecalho">
        <h1>WhatsApp</h1>
        <p>
          O número conectado aqui é quem envia os parabéns de aniversário, todo dia às 9h.
        </p>
      </div>

      {erro !== null && (
        <p className="mensagem-erro" role="alert">
          {erro}
        </p>
      )}
      {aviso !== null && <p className="mensagem-aviso">{aviso}</p>}

      <section className="wa-conexao">
        <div className="wa-estado">
          <span className={`wa-bolinha ${conectado ? 'ligada' : ''}`} aria-hidden="true" />
          <div>
            <strong>{ROTULO_STATUS[conexao?.status ?? 'DISCONNECTED'] ?? conexao?.status}</strong>
            <span className="wa-numero">
              {conexao?.numero ?? 'nenhum número conectado'}
            </span>
          </div>
        </div>

        <div className="wa-acoes">
          <button type="button" className="botao-acao" disabled={conectando} onClick={() => void conectar()}>
            {conectando ? 'Gerando…' : conectado ? 'Reconectar' : 'Conectar número'}
          </button>
        </div>
      </section>

      {qr === null && codigo !== null && (
        /* SEM QR MAS COM CÓDIGO. Acontece quando o provedor devolve só o
           pareamento; antes disso a tela dizia "não devolveu um código"
           tendo um código na mão. */
        <section className="wa-qr">
          <p className="wa-qr-nota">
            No celular: <b>WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com
            número de telefone</b>, e digite o código abaixo.
          </p>
          <p className="wa-codigo">{codigo}</p>
        </section>
      )}

      {qr !== null && (
        <section className="wa-qr">
          <h2>Leia o código no celular</h2>
          <ol className="wa-passos">
            <li>Abra o WhatsApp no celular que vai enviar as mensagens.</li>
            <li>Toque em <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong>.</li>
            <li>Aponte a câmera para o código abaixo.</li>
          </ol>
          {/* O QR vem como data URI do provedor. Renderizado como imagem,
              nunca como HTML — conteúdo de terceiro não vira markup. */}
          <img src={qr} alt="Código QR para conectar o WhatsApp" className="wa-qr-imagem" />
          <p className="wa-qr-nota">
            O código muda a cada poucos segundos; a tela se atualiza sozinha.
          </p>

          {codigo !== null && (
            /* A SAÍDA PARA QUANDO A CÂMERA NÃO LÊ. Luz ruim, tela suja,
               celular antigo — e a pessoa fica tentando enquadrar um
               quadrado que expira a cada poucos segundos. Oito
               caracteres digitados valem o mesmo. */
            <p className="wa-qr-alternativa">
              Câmera não pega? Em <b>Conectar com número de telefone</b>, digite:{' '}
              <span className="wa-codigo-linha">{codigo}</span>
            </p>
          )}
        </section>
      )}

      {conectado && (
        <section className="wa-testes formulario">
          <label className="campo campo-meia">
            <span className="campo-rotulo">Enviar um teste para</span>
            <input
              value={numeroTeste}
              placeholder="+5531999998888"
              onChange={(e) => setNumeroTeste(e.target.value)}
            />
            <span className="campo-dica">Com país e DDD.</span>
          </label>
          <div className="formulario-acoes campo-cheia">
            <button
              type="button"
              className="botao-secundario"
              onClick={() => void aniversarios()}
            >
              Disparar aniversários de hoje
            </button>
            <button
              type="button"
              className="botao-acao"
              disabled={numeroTeste.trim().length < 8}
              onClick={() => void testar()}
            >
              Enviar teste
            </button>
          </div>
        </section>
      )}

      <Avisos />

      <div className="secao-cabecalho">
        <h2>Mensagens enviadas</h2>
      </div>

      {mensagens.length === 0 ? (
        <Vazio
          titulo="Nenhuma mensagem ainda."
          descricao="Os parabéns de aniversário aparecem aqui assim que forem enviados."
        />
      ) : (
        <table className="tabela">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Para</th>
              <th>Tipo</th>
              <th>Situação</th>
              <th>Mensagem</th>
            </tr>
          </thead>
          <tbody>
            {mensagens.map((m) => (
              <tr key={m.id}>
                <td className="tabular">{new Date(m.criadoEm).toLocaleString('pt-BR')}</td>
                <td>{m.aluno ?? m.numero}</td>
                <td>{m.tipo === 'BIRTHDAY' ? 'aniversário' : 'manual'}</td>
                <td className={m.status === 'FAILED' ? 'tom-negativo' : 'tom-positivo'}>
                  {m.status === 'SENT' ? 'enviada' : m.status === 'FAILED' ? 'falhou' : m.status}
                  {/* O motivo da falha fica visível: sem ele, "falhou" não
                      dá o que fazer a seguir. */}
                  {m.erro !== null && <span className="wa-erro">{m.erro}</span>}
                </td>
                <td className="wa-texto">{m.texto}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/* ==================================================================== */

/**
 * Avisos automáticos de agendamento.
 *
 * ESTA CONFIGURAÇÃO EXISTIA NO BANCO E NÃO TINHA TELA. Pior: a
 * mecânica que ela controla também não existia — a academia teria
 * ligado uma chave que não acendia nada. Agora liga.
 *
 * APARECE MESMO SEM WHATSAPP CONECTADO, de propósito. A decisão de
 * mandar lembrete é anterior à conexão, e as mensagens ficam na fila
 * esperando: conectar à tarde faz sair o lembrete de amanhã.
 */
function Avisos(): ReactNode {
  const [dados, setDados] = useState<api.AvisosDeAgendamento | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [salvo, setSalvo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api
      .buscarAvisos()
      .then((r) => setDados(r.data))
      .catch(() => setDados(null));
  }, []);

  if (dados === null) return null;

  const gravar = async (novo: api.AvisosDeAgendamento): Promise<void> => {
    setDados(novo);
    setErro(null);
    setSalvando(true);
    try {
      await api.salvarAvisos(novo);
      setSalvo(true);
      setTimeout(() => setSalvo(false), 2500);
    } catch (e) {
      setErro(e instanceof api.ApiError ? e.message : 'Não foi possível salvar.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <>
      <div className="secao-cabecalho">
        <h2>Avisos automáticos</h2>
        <p>
          Saem sozinhos quando um horário é marcado. O aluno precisa ter WhatsApp no cadastro.
        </p>
      </div>

      <section className="wa-testes formulario">
        <label className="campo campo-meia">
          <span className="campo-rotulo">Confirmar na hora de marcar</span>
          <select
            value={dados.confirmarAgendamento ? 'sim' : 'nao'}
            onChange={(e) =>
              void gravar({ ...dados, confirmarAgendamento: e.target.value === 'sim' })
            }
          >
            <option value="sim">Sim, avisar assim que marcar</option>
            <option value="nao">Não enviar confirmação</option>
          </select>
          <span className="campo-dica">
            Chega em até dois minutos depois de o horário ser marcado.
          </span>
        </label>

        <label className="campo campo-meia">
          <span className="campo-rotulo">Lembrete antes da aula</span>
          <select
            value={String(dados.lembreteHoras)}
            onChange={(e) => void gravar({ ...dados, lembreteHoras: Number(e.target.value) })}
          >
            <option value="0">Não enviar lembrete</option>
            <option value="1">1 hora antes</option>
            <option value="3">3 horas antes</option>
            <option value="12">12 horas antes</option>
            <option value="24">1 dia antes</option>
            <option value="48">2 dias antes</option>
          </select>
          <span className="campo-dica">
            Desmarcar a aula cancela o lembrete que ainda não saiu.
          </span>
        </label>

        <div className="formulario-acoes campo-cheia">
          {salvando && <span className="campo-dica">Salvando…</span>}
          {salvo && <span className="campo-dica">Salvo.</span>}
          {erro !== null && <span className="wa-erro">{erro}</span>}
        </div>
      </section>
    </>
  );
}
