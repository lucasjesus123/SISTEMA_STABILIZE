import { useEffect, useState, type ReactNode } from 'react';
import { Carregando, Vazio } from './ui.jsx';
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
  const [conectando, setConectando] = useState(false);
  const [numeroTeste, setNumeroTeste] = useState('');

  const carregar = async (comEsqueleto = true): Promise<void> => {
    if (comEsqueleto) setCarregando(true);
    try {
      const [c, m] = [await buscarWhatsapp(), await buscarMensagens()];
      setConexao(c.data);
      setMensagens(m.data);
      if (c.data?.status === 'CONNECTED') setQr(null);
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
      if (r.data.qr === null) {
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
