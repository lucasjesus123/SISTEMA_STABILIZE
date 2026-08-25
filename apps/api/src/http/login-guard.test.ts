/**
 * O contador por IP e a academia inteira atrás de um Wi-Fi só.
 *
 * Este teste existe por causa de um risco concreto de produção: numa
 * academia, duzentos alunos entram no sistema pelo MESMO endereço de
 * saída. Se o contador de pulverização de senha somasse também os
 * logins que DERAM CERTO, o trigésimo aluno do dia trancaria a academia
 * inteira — e o erro pareceria "o sistema caiu", não "limite de
 * segurança".
 *
 * A rota (`auth.routes.ts`) usa o guarda em dois tempos: `registrar`
 * antes de tentar, `liberar` depois que a senha confere. Os testes
 * abaixo reproduzem esses dois tempos, porque é a COMBINAÇÃO deles que
 * precisa estar certa — o guarda sozinho não sabe se o login deu certo.
 */
import { describe, expect, it } from 'vitest';
import { LoginGuard } from './login-guard.js';

const IP = '203.0.113.42';
const JANELA = 15 * 60 * 1000;

/** Um login que dá certo: conta a tentativa e zera depois. */
function entrou(guarda: LoginGuard, agora: number): boolean {
  const limite = guarda.registrar(IP, agora);
  if (limite.bloqueado) return false;
  guarda.liberar(IP);
  return true;
}

/** Um login que falha: conta a tentativa e NÃO zera. */
function errou(guarda: LoginGuard, agora: number): boolean {
  return !guarda.registrar(IP, agora).bloqueado;
}

describe('LoginGuard', () => {
  it('deixa a academia inteira entrar pelo mesmo IP', () => {
    const guarda = new LoginGuard({ maxPorJanela: 30, janelaMs: JANELA });
    const agora = 1_700_000_000_000;

    // Duzentos alunos, um atrás do outro, todos com a senha certa.
    for (let n = 0; n < 200; n += 1) {
      expect(entrou(guarda, agora + n * 1000), `aluno ${n} foi barrado`).toBe(true);
    }
  });

  it('barra a pulverização de senha: erros seguidos estouram o limite', () => {
    const guarda = new LoginGuard({ maxPorJanela: 30, janelaMs: JANELA });
    const agora = 1_700_000_000_000;

    for (let n = 0; n < 30; n += 1) {
      expect(errou(guarda, agora + n), `tentativa ${n} devia passar`).toBe(true);
    }
    // A trigésima primeira é a que cai.
    expect(errou(guarda, agora + 30)).toBe(false);
  });

  it('um acerto no meio dos erros zera o contador — é o preço aceito', () => {
    /* `liberar` apaga o balde do IP inteiro. Isso é deliberado: sem
       isso, um aluno que erra a senha três vezes deixaria um rastro que
       vai somando com o do colega ao lado até trancar a recepção.
       Quem segura o atacante que TEM uma conta válida é o bloqueio por
       conta no banco (`failed_login_count` / `locked_until`), que é por
       e-mail e sobrevive a restart. Este teste registra a escolha para
       que ela não seja "corrigida" sem querer. */
    const guarda = new LoginGuard({ maxPorJanela: 30, janelaMs: JANELA });
    const agora = 1_700_000_000_000;

    for (let n = 0; n < 29; n += 1) errou(guarda, agora + n);
    expect(entrou(guarda, agora + 29)).toBe(true);
    expect(errou(guarda, agora + 30)).toBe(true);
  });

  it('a janela expira e o bloqueio sai sozinho', () => {
    const guarda = new LoginGuard({ maxPorJanela: 5, janelaMs: JANELA });
    const agora = 1_700_000_000_000;

    for (let n = 0; n < 5; n += 1) errou(guarda, agora + n);
    const barrado = guarda.registrar(IP, agora + 6);
    expect(barrado.bloqueado).toBe(true);
    expect(barrado.retryEmSegundos).toBeGreaterThan(0);
    expect(barrado.retryEmSegundos).toBeLessThanOrEqual(JANELA / 1000);

    expect(errou(guarda, agora + JANELA + 1)).toBe(true);
  });

  it('não vira vazamento de memória com IPs forjados', () => {
    const guarda = new LoginGuard({ maxPorJanela: 30, janelaMs: JANELA, maxChaves: 50 });
    const agora = 1_700_000_000_000;

    for (let n = 0; n < 500; n += 1) {
      guarda.registrar(`198.51.100.${n}`, agora);
    }
    expect(guarda.tamanho).toBeLessThanOrEqual(50);
  });
});
