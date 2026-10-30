// fallback HUMANO para CAPTCHAs que a IA não consegue resolver sozinha.
// quando a IA falha (não lê ou lê errado), o solver pede ao usuário via callback;
// o index.js injeta uma função que envia a imagem + um botão pro Discord e registra
// uma pendência. quando o usuário digita a resposta num modal, resolvemos a promise
// pendente e o solver retoma com a resposta fornecida pela pessoa.

const pendentes = new Map(); // id -> { userId, resolve, reject, timer, info }

const TIMEOUT_MS = 90 * 1000; // 90 s pra pessoa responder (o challenge expira bem antes de 10 min)

// injetado pelo index.js: envia a mensagem com a imagem + botão pro Discord.
let enviar = null;

// devolve o timestamp (ms) em que a pendência atual expira, ou null se sem pendências.
export function proximaExpiracao() {
  let menor = null;
  for (const p of pendentes.values()) {
    if (!menor || p.expira < menor) menor = p.expira;
  }
  return menor;
}

export function registrarEnvioCaptcha(fn) {
  enviar = fn;
}

export function habilidadeEnvioCaptcha() {
  return typeof enviar === 'function';
}

// gera um id único e curto (evita colisão com outros customIds do bot).
let seq = 0;
export function gerarId() {
  seq = (seq + 1) % 0xffffff;
  return `h${Date.now().toString(36)}${seq.toString(36)}`;
}

// registra uma pendência e devolve { id, promise }. a promise resolve com a
// resposta do usuário (string) ou rejeita em timeout/cancelamento.
export function registrarPendencia(userId, info) {
  const id = gerarId();
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const expira = Date.now() + TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (pendentes.has(id)) {
      pendentes.delete(id);
      reject(new Error('timeout ao aguardar resposta do captcha'));
    }
  }, TIMEOUT_MS);
  pendentes.set(id, { userId, resolve, reject, timer, info, expira });
  return { id, promise };
}

// o index.js inspeciona isto quando recebe um botão/modal de captcha.
export function obterPendencia(id) {
  return pendentes.get(id);
}

// resolve uma pendência com a resposta digitada pelo usuário.
export function submitResposta(id, answer) {
  const p = pendentes.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pendentes.delete(id);
  p.resolve((answer || '').trim());
  return true;
}

// cancela (rejeita) uma pendência — DM falhou, erro interno etc.
export function cancelar(id, motivo) {
  const p = pendentes.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pendentes.delete(id);
  p.reject(new Error(motivo || 'captcha humano cancelado'));
  return true;
}

// o index.js injeta um envio; esta função é usada pelo callback do solver pra
// registrar a pendência, disparar a mensagem e AGUARDAR a resposta.
// devolve { answer } ou null em erro/timeout.
export async function pedirRespostaHumana(userId, info) {
  if (!enviar) return null;
  const { id, promise } = registrarPendencia(userId, info);
  try {
    await enviar(userId, id, info); // envia img + botão
  } catch (e) {
    cancelar(id, `falha ao enviar captcha: ${e.message}`);
    return null;
  }
  try {
    const answer = await promise;
    return answer ? { answer } : null;
  } catch (e) {
    console.warn(`[captcha-human] ${e.message}`);
    return null;
  }
}

// força o cancelamento de TODAS as pendências (boot/shutdown).
export function limparTodas() {
  for (const [id, p] of pendentes) {
    clearTimeout(p.timer);
    p.reject(new Error('sessão encerrada'));
    pendentes.delete(id);
  }
}
