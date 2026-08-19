import type { FastifyInstance } from 'fastify';
import { enviarAniversariosDoDia } from './aniversarios.js';
import { esvaziarFila } from './fila.js';
import { envelhecerCobrancas } from '../finance/vencimento.js';
import { gerarCobrancasDoMes } from '../finance/cobranca-recorrente.js';

/**
 * Agendador de tarefas de fundo.
 *
 * POR QUE DENTRO DA API, E NÃO UM CRON DO SISTEMA
 *
 * Um cron externo precisaria de credencial de banco própria, de um
 * caminho para o código e de manutenção separada — três coisas a
 * esquecer numa VPS. Aqui a tarefa mora no mesmo processo que já tem
 * tudo isso, e o Docker reinicia sozinho se cair.
 *
 * A contrapartida é conhecida: se um dia a API rodar em mais de uma
 * réplica, todas tentarão a tarefa. Isso é INOFENSIVO por construção —
 * a idempotência está no banco (UNIQUE em `idempotency_key`), não no
 * agendador. A segunda réplica esbarra na unicidade e não envia nada.
 * Quando houver réplica, isto vira desperdício de uma consulta por hora,
 * não mensagem duplicada.
 *
 * O TIQUE É DE HORA EM HORA, e a tarefa só age na hora configurada.
 * Um `setTimeout` calculado até o horário exato parece mais elegante e é
 * pior: qualquer suspensão do processo, ajuste de relógio ou horário de
 * verão desloca o disparo, e ninguém percebe até alguém reclamar que não
 * recebeu os parabéns.
 */

const UMA_HORA_MS = 60 * 60 * 1000;

/**
 * A FILA DO WHATSAPP TEM RITMO PRÓPRIO, e é muito mais rápido que o
 * resto deste arquivo.
 *
 * Cobrança que vence e aniversário são coisas do dia: errar por uma hora
 * não muda nada para ninguém. A confirmação de um horário é o oposto —
 * o aluno acabou de tocar em "marcar" no aplicativo e está olhando para
 * o celular. Uma confirmação que chega quarenta minutos depois não
 * confirma coisa nenhuma: nesse tempo ele já ligou para a academia
 * perguntando se deu certo.
 *
 * Dois minutos é o compromisso: rápido o bastante para parecer imediato,
 * lento o bastante para que a consulta de sondagem — que na maioria dos
 * giros não encontra nada — não custe nada.
 */
const GIRO_DA_FILA_MS = 2 * 60 * 1000;

/** Hora local do envio. 9h: cedo o bastante para ser no dia, tarde o
 *  bastante para não acordar ninguém. */
const HORA_DO_ENVIO = 9;

export function registrarAgendador(app: FastifyInstance): void {
  let ultimaExecucao = '';

  const tique = async (): Promise<void> => {
    const agora = new Date();

    /* ENVELHECER COBRANÇAS RODA A CADA TIQUE, e não uma vez por dia numa
       hora fixa como os aniversários. O motivo é o fuso: cada academia
       vira o dia numa hora diferente do relógio deste servidor, e uma
       tarefa presa às 9h de UTC deixaria a academia mais a oeste com o
       status errado por horas todo dia. De hora em hora, o pior atraso
       é de uma hora para qualquer fuso.

       É um UPDATE que só toca as linhas que realmente mudaram: quando
       não há nada vencendo, ele não escreve nada. */
    try {
      /* GERAR ANTES DE ENVELHECER: a mensalidade que nasce hoje com
         vencimento no dia 10 e hoje já é 15 precisa sair vencida na
         mesma passada. Na ordem inversa ela ficaria "em aberto" até o
         próximo tique. */
      const novas = await gerarCobrancasDoMes(app.log);
      if (novas.geradas > 0) {
        app.log.info({ cobrancas: novas }, 'mensalidades geradas a partir dos contratos');
      }
    } catch (erro) {
      app.log.error({ err: erro }, 'tarefa de cobrança recorrente falhou');
    }

    try {
      const venc = await envelhecerCobrancas(app.log);
      if (venc.vencidas > 0) {
        app.log.info({ vencimento: venc }, 'cobranças marcadas como vencidas');
      }
    } catch (erro) {
      app.log.error({ err: erro }, 'tarefa de vencimento falhou');
    }

    if (agora.getHours() !== HORA_DO_ENVIO) return;

    /* Guarda de dia: o tique de hora em hora cairia duas vezes dentro da
       mesma hora se o intervalo derivar. A idempotência do banco já
       protegeria, mas evitar a consulta é mais barato que desperdiçá-la. */
    const dia = agora.toDateString();
    if (dia === ultimaExecucao) return;
    ultimaExecucao = dia;

    try {
      const r = await enviarAniversariosDoDia(app.log);
      if (r.enviadas > 0 || r.falhas > 0) {
        app.log.info({ aniversarios: r }, 'tarefa de aniversários concluída');
      }
    } catch (erro) {
      /* NUNCA deixar a exceção escapar de um temporizador: uma rejeição
         não tratada derruba o processo inteiro, e uma falha na
         integração de WhatsApp não pode tirar o sistema do ar. */
      app.log.error({ err: erro }, 'tarefa de aniversários falhou');
    }
  };

  /* A FILA NÃO ESPERA O TIQUE DE HORA EM HORA. */
  const giroDaFila = async (): Promise<void> => {
    try {
      const r = await esvaziarFila(app.log);
      if (r.enviadas > 0 || r.falhas > 0 || r.descartadas > 0) {
        app.log.info({ fila: r }, 'fila de WhatsApp processada');
      }
    } catch (erro) {
      /* NUNCA deixar a exceção escapar de um temporizador: uma rejeição
         não tratada derruba o processo inteiro. */
      app.log.error({ err: erro }, 'giro da fila de WhatsApp falhou');
    }
  };

  const relogio = setInterval(() => void tique(), UMA_HORA_MS);
  const relogioDaFila = setInterval(() => void giroDaFila(), GIRO_DA_FILA_MS);
  relogioDaFila.unref();
  /* `unref` para o temporizador não segurar o processo vivo no
     encerramento — sem isto, `docker compose down` espera o timeout. */
  relogio.unref();

  app.addHook('onClose', async () => {
    clearInterval(relogio);
    clearInterval(relogioDaFila);
  });

  /* Uma passada agora, sem esperar a primeira hora: reiniciar a API
     depois da meia-noite não pode deixar o financeiro um dia atrasado. */
  void tique();
  void giroDaFila();

  app.log.info(
    { hora: HORA_DO_ENVIO, giroDaFilaMs: GIRO_DA_FILA_MS },
    'agendador ativo (mensalidades, vencimentos, aniversários e fila de WhatsApp)',
  );
}
