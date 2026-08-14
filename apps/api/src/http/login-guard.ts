/**
 * Guarda de força bruta no login.
 *
 * Existem TRÊS ataques distintos contra uma tela de login, e cada um
 * exige uma contagem diferente. Proteger só um deixa os outros abertos:
 *
 *   1. FORÇA BRUTA DIRIGIDA — muitas senhas contra UMA conta.
 *      Contagem por (IP, e-mail). É o limite da rota.
 *
 *   2. PULVERIZAÇÃO DE SENHA — uma senha comum contra MUITAS contas.
 *      A contagem por (IP, e-mail) não vê isso: cada e-mail estreia um
 *      balde vazio. É preciso contar por IP, independentemente do
 *      e-mail. É o que este arquivo faz.
 *
 *   3. ATAQUE DISTRIBUÍDO — muitos IPs contra uma conta.
 *      Nenhuma contagem por IP resolve. Quem resolve é o bloqueio por
 *      conta no banco (`failed_login_count` / `locked_until`), que é
 *      compartilhado entre instâncias da API e sobrevive a restart.
 *
 * Este contador é de janela fixa, em memória do processo. Duas
 * limitações reconhecidas, e ambas são aceitáveis aqui porque este é o
 * segundo anel de defesa, não o único:
 *   - com várias instâncias da API, cada uma conta a sua parte;
 *   - um restart zera a contagem.
 * O bloqueio por conta no banco não tem nenhuma das duas fraquezas, e é
 * ele que segura o caso 3.
 */

export interface LoginGuardOptions {
  /** Tentativas permitidas por IP na janela, somando todos os e-mails. */
  readonly maxPorJanela: number;
  readonly janelaMs: number;
  /** Teto de IPs rastreados, para o contador não virar vazamento de memória. */
  readonly maxChaves?: number;
}

interface Contador {
  contagem: number;
  expiraEm: number;
}

export class LoginGuard {
  readonly #contadores = new Map<string, Contador>();
  readonly #max: number;
  readonly #janelaMs: number;
  readonly #maxChaves: number;

  constructor(options: LoginGuardOptions) {
    this.#max = options.maxPorJanela;
    this.#janelaMs = options.janelaMs;
    this.#maxChaves = options.maxChaves ?? 10_000;
  }

  /**
   * Registra uma tentativa e diz se o IP estourou o limite.
   * Devolve os segundos restantes quando bloqueado.
   */
  registrar(ip: string, agora = Date.now()): { bloqueado: boolean; retryEmSegundos: number } {
    this.#limpar(agora);

    const atual = this.#contadores.get(ip);

    if (atual === undefined || atual.expiraEm <= agora) {
      /* Teto de chaves: sem isto, um atacante forjando IPs (com
         X-Forwarded-For, atrás de um proxy mal configurado) faria o mapa
         crescer sem limite até derrubar o processo por memória. */
      if (this.#contadores.size >= this.#maxChaves) {
        this.#descartarMaisAntigo();
      }
      this.#contadores.set(ip, { contagem: 1, expiraEm: agora + this.#janelaMs });
      return { bloqueado: false, retryEmSegundos: 0 };
    }

    atual.contagem += 1;

    if (atual.contagem > this.#max) {
      return {
        bloqueado: true,
        retryEmSegundos: Math.max(1, Math.ceil((atual.expiraEm - agora) / 1000)),
      };
    }

    return { bloqueado: false, retryEmSegundos: 0 };
  }

  /** Zera a contagem do IP após um login bem-sucedido. */
  liberar(ip: string): void {
    this.#contadores.delete(ip);
  }

  /** Apenas para testes. */
  get tamanho(): number {
    return this.#contadores.size;
  }

  #limpar(agora: number): void {
    // Varredura barata: só percorre tudo quando o mapa está grande.
    if (this.#contadores.size < 256) return;
    for (const [chave, contador] of this.#contadores) {
      if (contador.expiraEm <= agora) this.#contadores.delete(chave);
    }
  }

  #descartarMaisAntigo(): void {
    // Map preserva ordem de inserção: o primeiro é o mais antigo.
    const primeiro = this.#contadores.keys().next();
    if (!primeiro.done) this.#contadores.delete(primeiro.value);
  }
}
