// orquestrador: apply -> IA por questão -> valida shape -> monta payload -> envia.
// junta a lógica de solveAI() (validação de shape) de js/api.js com o solver de ai.js.
//
// paralelismo por chave de IA:
//   solveTask(task, { apiKeyIndex }) resolve a tarefa inteira presa à chave N do
//   Gemini (ver ai.js/withApiKey). solveTasksParallel() distribui as tarefas entre
//   as chaves (1 tarefa = 1 chave) e mantém uma FILA: enquanto houver chave livre
//   entra a próxima tarefa; quando todas as chaves estão ocupadas, espera liberar.
import { taskApply, submitAnswer, updateAnswer, essayCheck, resolveTarget, rooms, isFinished, isExpired, ehProva, exigeTokenCode, foraDoEscopo, bypassCaptcha } from './edusp.js';
import { solveQuestion, withApiKey, apiKeyCount, qtdChavesGroq, verifyAnswers, intentionalMisses } from './ai.js';
import { buildAnswers } from './heuristic.js';
import { rodadasAtivas } from './fila.js';
import { config } from './config.js';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// o site grava a questão como: question_type = q.rawType || q.type (2025+).
// mandar só "type" quando rawType é o campo real derruba a nota (NaN).
function tipoQuestao(q) {
  const r = String(q?.rawType ?? '').trim();
  return (r && r !== 'undefined') ? r : q?.type;
}

// padrão do client web oficial: target válido é uma sala (r<hex>-l[:...]) ou
// um id numérico de categoria. nick/apelido NÃO passa.
function isTargetValido(v) {
  return /^(?:r[a-z0-9]+-l(?::[^\s]+)?|\d+)$/i.test(String(v || '').trim());
}

// espera em pedaços de 2s checando cancelamento — usado nas esperas LONGAS
// (tempo-alvo da tarefa, re-tentativas de IA) pra o botão 🛑 Cancelar da UI
// responder rápido em vez de só depois da espera inteira.
async function delayCancelavel(ms, opts) {
  const passo = 2000;
  let restante = Math.max(0, ms);
  while (restante > 0) {
    if (typeof opts?.deveCancelar === 'function' && opts.deveCancelar()) {
      const e = new Error('cancelado pelo usuário');
      e.cancelado = true;
      throw e;
    }
    const t = Math.min(passo, restante);
    await delay(t);
    restante -= t;
  }
}

// pausa ENTRE questões: usa QUESTION_DELAY_SECONDS do .env tanto no ritmo solo
// quanto no compartilhado (default 60s se não configurado).
export function pausaEntreQuestoes() {
  return config.pace.questionDelayMs;
}

// resolve uma tarefa inteira.
// opts: { token, nick, essay, draft (bool), debugCallback, apiKeyIndex (0..n-1),
//         onQuestion(feitas, totalQuestoes) — progresso ao vivo DENTRO da tarefa }
// agendar (opcional): fn(concluir) — recebe a fase FINAL da tarefa (esperar
//         tempo-alvo + enviar) e devolve um marcador; o pool usa isso pra
//         liberar o slot do worker enquanto a tarefa só espera o relógio.
// retorna o resultado do submit/update (lança em erro).
// executa `fn(captchaToken)` e, se a plataforma pedir CAPTCHA, resolve um
// novo (token JÁ validado pelo /captcha/verify) e re-tenta — um número
// elevado de tentativas (o bot persiste até resolver, sem limite rígido).
// detecta por mensagem E pelo corpo da resposta (jfetch anexa err.body).
const MAX_CAPTCHA = 999;

function pediuCaptcha(e) {
  const corpo = (() => { try { return JSON.stringify(e?.body); } catch { return ''; } })();
  return `${e?.message || ''} ${corpo}`.toLowerCase().includes('captcha');
}

// ── fila de captcha (SERIALIZADA POR TOKEN) ───────────────────
// as tarefas da MESMA rodada compartilham o MESMO token de conta (ver
// solveTasksParallel). desafios de CAPTCHA paralelos com o mesmo token se
// invalidam (context_mismatch) — por isso a fila serializa POR TOKEN, mas
// permite rodar em paralelo tokens DIFERENTES (outras contas/rodadas) até o
// teto global CAPTCHA_PARALELO. o OCR do browser segue serializado internamente.
const CAPTCHA_PARALELO = Math.max(1, Number(process.env.CAPTCHA_PARALELO) || 3);
let captchaEmAndamento = 0;
const captchaFila = [];
const captchaPorToken = new Map(); // token -> nº de captchas em andamento

function avancarCaptcha() {
  for (let i = 0; i < captchaFila.length && captchaEmAndamento < CAPTCHA_PARALELO; ) {
    const item = captchaFila[i];
    // mesmo token: espera o captcha anterior desse token terminar (um challenge
    // novo invalidaria o que está em curso → context_mismatch).
    if ((captchaPorToken.get(item.token) || 0) > 0) { i++; continue; }
    captchaFila.splice(i, 1);
    captchaEmAndamento++;
    captchaPorToken.set(item.token, (captchaPorToken.get(item.token) || 0) + 1);
    (async () => {
      try { item.resolve(await item.fn()); }
      catch (e) { item.reject(e); }
      finally {
        captchaEmAndamento--;
        const n = (captchaPorToken.get(item.token) || 1) - 1;
        if (n <= 0) captchaPorToken.delete(item.token); else captchaPorToken.set(item.token, n);
        avancarCaptcha();
      }
    })();
  }
}

function enfileirarCaptcha(token, fn) {
  return new Promise((resolve, reject) => {
    captchaFila.push({ token, fn, resolve, reject });
    avancarCaptcha();
  });
}

async function comCaptcha(fn, { token, debugCallback, humanCallback, rotulo, taskId }) {
  // tenta de cara sem captcha — a grande maioria entra de primeira.
  try {
    return await fn(null);
  } catch (e) {
    if (!pediuCaptcha(e)) throw e;
  }
  // plataforma pediu captcha → entra na fila (serializada por token) e re-tenta
  // até a tarefa ENTRAR de verdade ou esgotar as MAX_CAPTCHA tentativas.
  return enfileirarCaptcha(token, async () => {
    let cToken = null;
    for (let t = 0; ; t++) {
      try {
        return await fn(cToken);
      } catch (e) {
        if (!pediuCaptcha(e) || t >= MAX_CAPTCHA) throw e;
        console.log(`[captcha] pedido no ${rotulo} da tarefa ${taskId} (${t + 1}/${MAX_CAPTCHA}) — resolvendo um novo...`);
        cToken = await bypassCaptcha(token, debugCallback, humanCallback);
      }
    }
  });
}

// rotação de chave Groq entre tentativas: cada chave tem cota PRÓPRIA de TPM/TPD,
// então trocar de chave já "reseta" os tokens na hora — sem esperar o reset global.
// devolve null se só existe 1 chave (nada pra rotacionar).
function proximoGroq(idx) {
  const n = qtdChavesGroq();
  if (n <= 1) return null;
  return (((Number.isInteger(idx) ? idx : 0) + 1) % n);
}

// FALLBACK HEURÍSTICO: quando a IA falha (cota esgotada / shape inválido), tenta
// resolver a questão pelos gabaritos EMBUTIDOS do JSON da plataforma (sem gastar
// token). Só vale para tipos com gabarito interno (single/multi/true-false,
// fill-letters, cloud, order-sentences). Dissertativa NÃO entra: texto genérico
// não contorna o detector de IA e só gera nota NaN — melhor deixar pendente.
const TIPOS_HEURISTICOS = new Set([
  'single', 'single-choice', 'multi', 'multiple-choice', 'true-false',
  'fill-letters', 'cloud', 'order-sentences',
  // fill-words só entra quando há gabarito embutido nas lacunas (ver temGabarito)
  'fill-words',
]);

function tentarHeuristico(q) {
  if (!q || !TIPOS_HEURISTICOS.has(q.type)) return null;
  try {
    const mini = buildAnswers({ questions: [q] }, '');
    const r = mini && mini[q.id];
    if (!r) return null;
    // não usa chute aleatório puro: exige gabarito embutido (answer === true /
    // answer string / gabarito interno) pra não mandar resposta inventada.
    const temGabarito =
      (q.type === 'single' || q.type === 'single-choice' || q.type === 'multi' || q.type === 'multiple-choice' || q.type === 'true-false')
        ? Object.values(q.options || {}).some(o => o && typeof o.answer === 'boolean')
        : (q.type === 'fill-letters') ? typeof q.options?.answer === 'string'
        : (q.type === 'cloud') ? Array.isArray(q.options?.words) && q.options.words.length > 0
        : (q.type === 'order-sentences') ? Array.isArray(q.options?.sentences) && q.options.sentences.length > 0
        : (q.type === 'fill-words') ? Array.isArray(q.options?.phrase) && q.options.phrase.some(s => s && s.answer != null)
        : false;
    if (!temGabarito) return null;
    const validado = validateShape(q.type, r.answer, q);
    return validado.ok ? validado.answer : null;
  } catch {
    return null;
  }
}

// TEMPO-ALVO: sempre 1 minuto após responder todas as questões
// e já começa próxima atividade enquanto espera (mecanismo de agendamento mantido)
export function alvoDuracaoTarefa(draft) {
  return 60_000;
}

// ── PROTEÇÃO ANTI-NaN: rascunho contaminado ───────────────────
// resposta gravada com entrada SEM `answer` (info/media vazias de versões
// antigas, ou questão que cancelou no meio). o grader pontua por ENTRADA do
// mapa → score undefined → média da tarefa vira NaN. o PUT da plataforma FUNDE
// (não substitui) e não existe endpoint de limpar — essas tarefas NUNCA devem
// ser re-enviadas: exigem reset manual na plataforma.
export function rascunhoContaminado(aa) {
  if (!aa || typeof aa !== 'object') return false;
  for (const v of Object.values(aa)) {
    if (v && v.answer == null) return true;
  }
  return false;
}

export async function solveTask(task, opts = {}, agendar = null) {
  const { token, nick, draft = true, debugCallback = null, humanCallback = null, apiKeyIndex = null, groqIndex = null } = opts;

  if (isFinished(task)) {
    const err = new Error(`tarefa já finalizada (status=${task.answer_status})`);
    err.status = 0; throw err;
  }

  // ESCOPO (fonte única: foraDoEscopo no edusp.js): prova, redação e o que
  // pede token_code ficam de fora. prova/redação por decisão do dono; o
  // token_code porque o /apply voltaria 403 sem o código da escola.
  if (foraDoEscopo(task)) {
    const motivo = ehProva(task) ? 'prova'
      : exigeTokenCode(task) ? 'exige token_code (código da prova) — a plataforma bloqueia o apply sem ele'
      : 'redação (o bot não resolve dissertação)';
    const err = new Error(`fora do escopo do bot: ${motivo}`);
    err.status = exigeTokenCode(task) ? 403 : 0;
    err.foraEscopo = true;
    err.tokenCode = exigeTokenCode(task);
    throw err;
  }
  if (isExpired(task)) {
    console.log(`[solver] tarefa ${task.id} "${String(task.title || '').slice(0, 50)}" está VENCIDA — resolvendo mesmo assim`);
  }

  const target = resolveTarget(task, nick, opts);
  const full = await comCaptcha(
    (c) => taskApply(token, task.id, c, target, opts.tokenCode),
    { token, debugCallback, humanCallback, rotulo: 'apply', taskId: task.id },
  );

  // o alvo REAL vem da resposta do apply: a lista de tarefas nem sempre traz
  // publication_target (redações/essay caem no fallback `nick`, inválido).
  let alvoFinal = (() => {
    const v = full?.publication_target ?? full?.publicationTarget;
    if (typeof v === 'string' && isTargetValido(v)) return v;
    const pts = full?.publication_targets ?? full?.publicationTargets;
    if (Array.isArray(pts) && pts.length) {
      const prim = pts[0];
      const s = typeof prim === 'string' ? prim : (prim?.publication_target ?? prim?.publicationTarget);
      if (typeof s === 'string' && isTargetValido(s)) return s;
    }
    return target;
  })();

  // executed_on inválido (redação/essay sem publication_target cai no `nick`)
  // faz o grader voltar nota NaN. igual ao bot de referência, cai pro nome da
  // primeira sala do aluno: o apply já aceita `room_name=<nome da sala>`.
  if (!isTargetValido(alvoFinal)) {
    try {
      const rm = await rooms(token);
      const list = rm?.rooms || rm?.data || (Array.isArray(rm) ? rm : []);
      const nomeSala = list.find(r => r && typeof r.name === 'string' && r.name)?.name;
      if (typeof nomeSala === 'string' && nomeSala) {
        alvoFinal = nomeSala;
        console.log(`[solver] tarefa ${task.id}: target inválido, usando sala "${nomeSala}" como executed_on`);
      }
    } catch { /* sem sala válida, mantém o target original */ }
  }

  const inicioTarefa = Date.now();
  const answers = {};

  let answerId = task.answer_id || null;

  // REDAÇÃO: o apply da plataforma marca a tarefa como redação (is_essay ou com
  // questão do tipo essay). redação SEMPRE vai como rascunho (nunca 'submitted'),
  // mesmo com DEFAULT_SUBMIT_MODE=submitted — é o que não deixa nota NaN (igual
  // ao bot de referência saladopassado).
  const ehRedacao = (() => {
    if (full?.is_essay || full?.task_is_essay) return true;
    if (Array.isArray(full?.questions)) return full.questions.some(q => q && q.type === 'essay');
    return false;
  })();

  // tempo mínimo de execução exigido pela plataforma (vem no apply). se houver,
  // o duration reportado NUNCA fica abaixo dele (mesma regra do worker do site).
  const minExecSeg = (() => {
    const v = Number(full?.min_execution_time ?? full?.minExecutionTime ?? 0);
    return Number.isFinite(v) && v > 0 ? Math.ceil(v) : 60;
  })();

  // payload base — duration em SEGUNDOS (a API rejeita/corrompe em ms: mandar
  // milissegundos faz a plataforma ler "6 dias" de resolução e volta nota NaN).
  const makeBase = () => ({
    accessed_on: 'room',
    executed_on: alvoFinal,
    answers,
    duration: Math.max(minExecSeg, Math.round((Date.now() - inicioTarefa) / 1000)),
  });

  // CANCELAMENTO: apertou 🛑 no meio? salva o que já foi resolvido como
  // RASCUNHO — em vez de descartar tudo e deixar pendente. só envia se ao
  // menos 1 resposta existir (cancelar na 1ª questão não cria rascunho vazio);
  // em modo 'submitted' o parcial também vai como rascunho, nunca definitivo.
  const salvarRascunhoParcial = async (rotulo = 'erro') => {
    const n = Object.keys(answers).length;
    if (!n) return null;
    const payload = { ...makeBase(), status: 'draft' };
    const r = await comCaptcha(
      (c) => (answerId
        ? updateAnswer(token, task.id, answerId, payload, c)
        : submitAnswer(token, task.id, payload, c)),
      { token, debugCallback, humanCallback, rotulo: `rascunho (${rotulo})`, taskId: task.id },
    );
    answerId = r?.id || r?.answer_id || null;
    console.log(`[solver] tarefa ${task.id}: ${rotulo === 'cancelamento' ? '🛑 cancelamento' : `⚠️ erro no meio (${rotulo})`} — rascunho salvo na hora com ${n} resposta(s)`);
    return r;
  };

  // corpo da resolução — roda preso à chave exclusiva se apiKeyIndex foi dado.
  const resolverQuestoes = async () => {
    const qs = full.questions || [];
    const resolviveis = qs.filter(q => q.type !== 'info' && q.type !== 'media');
    let resolvidas = 0;

    for (const q of qs) {
      const id = q.id;
      const t = q.type;

      // QUESTÕES info/media NÃO SÃO RESPONDÍVEIS — não entram no payload.
      // confirmado em produção (inspeção das answers): mandar {question_id,
      // question_type} sem `answer` faz o grader embutir score=undefined e a
      // média da tarefa volta NOTA NaN (9/9 tarefas NaN tinham info/media;
      // 182/182 ok não tinham). o cliente web oficial também as omite.
      if (t === 'info' || t === 'media') {
        continue;
      }

      // SEM CHUTE: repete até a IA responder de verdade. a cada falha OU troca
      // pra outra chave Groq (cota própria = reset imediato) e tenta de novo.
      // esgotou? aborta a tarefa SEM enviar palpite — fica pendente pro próximo ciclo.
      // se os tokens travaram (rate limit 429/TPM), espera 1 min e tenta de novo.
      let validated = null;
      let groqAtual = groqIndex;
      const TOKEN_WAIT_MS = 60_000; // 1 min quando tokens travam
      for (let tentativa = 1; tentativa <= config.pace.maxQuestionAttempts; tentativa++) {
        if (typeof opts.deveCancelar === 'function' && opts.deveCancelar()) {
          const e = new Error('cancelado pelo usuário');
          e.cancelado = true;
          throw e;
        }
        let ai = null;
        let erroIA = null;
        try {
          const r = await solveQuestion(q, { tentativa, groqIndex: groqAtual, ehRedacao });
          ai = r ? r.answer : null;
        } catch (e) {
          ai = null;
          erroIA = e;
        }

        validated = validateShape(t, ai, q);
        if (validated.ok) break;

        if (tentativa < config.pace.maxQuestionAttempts) {
          // TODOS os provedores (Groq -> Gemini -> roteador) caíram nessa
          // chamada: esperar o "reset de token" não devolve cota nenhuma, e
          // trocar de chave Groq também não (a reserva já foi tentada). espera
          // curta e tenta de novo — a próxima tentativa pega cota renovada.
          if (erroIA?.todosProvedores) {
            console.warn(`[solver] questão ${id} (${t}): tentativa ${tentativa}/${config.pace.maxQuestionAttempts} — TODOS os provedores falharam (${String(erroIA.message || '').slice(0, 70)}), re-tentando em 15s...`);
            await delayCancelavel(15_000, opts);
            continue;
          }
          // detecta se o erro é de tokens/rate limit (429, TPM, TPD)
          const msgErro = String(erroIA?.message || '').toLowerCase();
          const ehRateLimit = msgErro.includes('429') || msgErro.includes('rate')
            || msgErro.includes('tokens') || msgErro.includes('tpm')
            || msgErro.includes('tpd') || msgErro.includes('per minute')
            || msgErro.includes('per day') || msgErro.includes('quota')
            || msgErro.includes('limit');

          // sozinho no bot + mais de 1 chave Groq: em vez de esperar o reset
          // global, usa a próxima chave (cota fresca) — as outras chaves não
          // estão sendo usadas por ninguém. acompanhado, mantém a espera cheia
          // pra não roubar a chave da tarefa de outra pessoa.
          const proximo = rodadasAtivas() <= 1 ? proximoGroq(groqAtual) : null;
          if (ehRateLimit && proximo != null && proximo !== groqAtual) {
            // tokens travaram mas tem outra chave livre — troca na hora
            console.warn(`[solver] questão ${id} (${t}): tentativa ${tentativa}/${config.pace.maxQuestionAttempts} — tokens travaram, trocando pra chave Groq #${proximo + 1}...`);
            groqAtual = proximo;
            await delayCancelavel(3000, opts);
          } else if (ehRateLimit) {
            // todos os tokens travados — espera 1 min e tenta de novo
            console.warn(`[solver] questão ${id} (${t}): tentativa ${tentativa}/${config.pace.maxQuestionAttempts} — tokens rate-limited, aguardando ${TOKEN_WAIT_MS / 1000}s pra resetar...`);
            await delayCancelavel(TOKEN_WAIT_MS, opts);
          } else if (proximo != null && proximo !== groqAtual) {
            // erro normal (shape inválido, etc.) — troca de chave
            console.warn(`[solver] questão ${id} (${t}): tentativa ${tentativa}/${config.pace.maxQuestionAttempts} falhou — trocando pra chave Groq #${proximo + 1} (cota própria, reset na hora)...`);
            groqAtual = proximo;
            await delayCancelavel(3000, opts);
          } else {
            // erro normal, só 1 chave — espera o reset padrão
            console.warn(`[solver] questão ${id} (${t}): tentativa ${tentativa}/${config.pace.maxQuestionAttempts} falhou — aguardando ${Math.round(config.pace.aiRetryMs / 1000)}s para resetar os tokens...`);
            await delayCancelavel(config.pace.aiRetryMs, opts);
          }
        }
      }

      if (!validated || !validated.ok) {
        // último recurso: heurístico com gabarito embutido (sem gastar token).
        // resolve a questão pela resposta que a própria plataforma vaza no JSON
        // quando a cota IA esgotou — em vez de abandonar a tarefa inteira.
        const h = tentarHeuristico(q);
        if (h != null) {
          const vh = validateShape(t, h, q);
          if (vh && vh.ok) {
            validated = vh;
            console.warn(`[solver] questão ${id} (${t}): IA falhou, mas gabarito embutido resolveu (heurístico) — prosseguindo`);
          }
        }
      }

      if (!validated || !validated.ok) {
        throw new Error(`questão ${id} (${t}): IA não respondeu após ${config.pace.maxQuestionAttempts} tentativas — progresso vira rascunho na hora, refaz no próximo ciclo`);
      }

      answers[id] = { question_id: id, question_type: tipoQuestao(q), answer: validated.answer };

      // progresso AO VIVO: avisa quantas questões já foram resolvidas nesta tarefa
      // (a UI do Discord usa isso pra não ficar em 0% durante a resolução).
      resolvidas++;
      try { opts.onQuestion?.(resolvidas, resolviveis.length); } catch { /* UI nunca derruba o solver */ }

      // pausa "humana" entre questões: dinâmica — sozinho acelera (3-4/min),
      // com mais gente volta ao ritmo base pra dividir a cota sem brigar.
      if (resolvidas < resolviveis.length) {
        const pausa = pausaEntreQuestoes();
        if (pausa > 0) {
          console.log(`[solver] tarefa ${task.id}: aguardando ${Math.round(pausa / 1000)}s antes da próxima questão (${rodadasAtivas() <= 1 ? 'ritmo solo' : 'ritmo compartilhado'})...`);
          await delayCancelavel(pausa, opts);
        }
      }
    }
  };

  try {
    if (apiKeyIndex != null) await withApiKey(apiKeyIndex, resolverQuestoes);
    else await resolverQuestoes();
  } catch (e) {
    // QUALQUER erro no meio da resolução (cancelamento, cota de IA esgotada,
    // shape inválido, modelo fora do ar...): salva o que JÁ foi respondido como
    // rascunho IMEDIATO e repassa o erro — nada do progresso da tarefa se perde.
    try { await salvarRascunhoParcial(e?.cancelado ? 'cancelamento' : 'erro'); }
    catch (e2) { console.error(`[solver] tarefa ${task.id}: falha ao salvar rascunho parcial após erro: ${e2?.message}`); }
    throw e;
  }

  // VERIFICAÇÃO PÓS-RESOLUÇÃO (auto-correção ANTES de enviar):
  // pega TODAS as perguntas + respostas da tarefa e confere com o Gemini,
  // preso à MESMA chave da tarefa (1 tarefa = 1 chave). se alguma estiver
  // errada, o Gemini devolve o gabarito e o bot se ajusta na hora.
  if (config.verify.enabled && !opts.skipVerify) {
    const verificar = async () => {
      const correcoes = await verifyAnswers(full.questions, answers, { groqIndex });
      if (correcoes && Object.keys(correcoes).length) {
        for (const qid of Object.keys(correcoes)) {
          const a = answers[qid];
          if (!a) continue;
          a.answer = correcoes[qid];
          console.log(`[solver] tarefa ${task.id}: questão ${qid} CORRIGIDA pelo verificador Gemini antes do envio`);
        }
      }
    };
    if (apiKeyIndex != null) await withApiKey(apiKeyIndex, verificar);
    else await verificar();
  }

  // TAXA DE ACERTOS ("erro de propósito"): com base no hitRate (%) definido pela
  // pessoa no painel, o bot ERRA DE PROPÓSITO um nº calculado de questões — mas
  // NUNCA nas de escrita (dissertativa), só nas de correção automática. o erro é
  // "bem inspirado" (alternativa/ordem plausível), então não fica parecendo chute.
  const hitRate = opts.hitRate;
  if (hitRate != null && Number.isFinite(Number(hitRate)) && !opts.skipHitRate) {
    const erros = intentionalMisses(full.questions, answers, hitRate);
    if (erros && Object.keys(erros).length) {
      const mudados = [];
      for (const qid of Object.keys(erros)) {
        const a = answers[qid];
        if (!a) continue;
        a.answer = erros[qid];
        mudados.push(qid);
        console.log(`[solver] tarefa ${task.id}: questão ${qid} marcada como ERRO de propósito (taxa ${hitRate}%)`);
      }
      try { opts.onMissed?.(task.id, mudados); } catch { /* relatório nunca derruba */ }
    }
  }

  // TEMPO-ALVO desta tarefa (sorteado UMA vez, no início):
  //   rascunho      → 10–15 min (piso 10 min + até 5 min aleatório)
  //   definitivo    → aleatório entre SUBMIT_MIN_MINUTES e SUBMIT_MAX_MINUTES
  //                   (padrão 10–15 min)
  // O tempo é SEMPRE cumprido (não existe mais instantSubmit) — é o que evita a
  // nota NaN: enviar rápido demais estoura o detector de resposta suspeita.
  // Acabou as questões ANTES do alvo? espera o resto (a IA fica LIVRE pra outra
  // tarefa — o slot não fica preso). Demorou MAIS que o alvo? envia na hora.
  const alvoMs = opts.instantSubmit ? 0 : alvoDuracaoTarefa(draft);

  const esperarAlvo = async () => {
    const decorrido = Date.now() - inicioTarefa;
    if (decorrido >= alvoMs) return;
    const faltaMin = (alvoMs - decorrido) / 60000;
    console.log(`[solver] tarefa ${task.id}: ${draft ? 'rascunho' : 'envio definitivo'} em ${faltaMin < 1 ? '<1' : Math.ceil(faltaMin)} min (tempo-alvo sorteado: ${Math.round(alvoMs / 60000)} min)...`);
    await delayCancelavel(alvoMs - decorrido, opts);
  };

  // a edusp rejeita um envio DIRETO como 'submitted' quando ainda não existe
  // rascunho (answer_id null). por isso garantimos primeiro um rascunho (POST)
  // e só então finalizamos (PUT).
  const criarRascunho = async () => {
    const created = await comCaptcha(
      (c) => submitAnswer(token, task.id, { ...makeBase(), status: 'draft' }, c),
      { token, debugCallback, humanCallback, rotulo: 'submit draft', taskId: task.id },
    );
    answerId = created?.id || created?.answer_id || null;
    return created;
  };

  // FASE FINAL da tarefa: espera o tempo-alvo que falta e envia. roda FORA do
  // slot do worker quando um agendador é passado (3º parâmetro) — assim a IA
  // continua resolvendo outras tarefas enquanto esta só "descansa o relógio".
  const concluir = async () => {
    try {
      await esperarAlvo();
    } catch (e) {
      if (e?.cancelado) {
        try { await salvarRascunhoParcial(); } catch { /* rascunho de cancelamento é best-effort */ }
      }
      throw e;
    }
    const status = draft || ehRedacao ? 'draft' : 'submitted';
    // redação: antes de salvar, roda o essay-check (mesmo fluxo do bot de
    // referência —— é o que evita a correção voltar com nota NaN).
    if (ehRedacao) {
      let essayTitulo = '';
      let essayTexto = '';
      for (const a of Object.values(answers)) {
        const v = a?.answer;
        if (typeof v === 'string') essayTexto = v;
        else if (v && typeof v === 'object') {
          if (typeof v.body === 'string' && !essayTexto) essayTexto = v.body;
          if (typeof v.title === 'string' && !essayTitulo) essayTitulo = v.title;
          else if (typeof v[0] === 'string' && !essayTexto) essayTexto = v[0];
        }
        if (essayTexto) break;
      }
      try {
        await comCaptcha(
          (c) => essayCheck(token, task.id, essayTitulo, essayTexto, c),
          { token, debugCallback, humanCallback, rotulo: 'essay-check', taskId: task.id },
        );
      } catch { /* best-effort (o essayCheck já trata o erro por dentro) */ }
    }
    // VERIFICAÇÃO PÓS-ENVIO: igual ao site — re-aplica e confere o status; se a
    // API gravou 'pending' (ou errou o estado), re-envia o MESMO payload UMA vez.
    // deixa rascunho pendente sem re-processar é outro caminho pra nota NaN.
    const verificarEnvios = async (payload, esperado) => {
      try {
        const ap = await comCaptcha(
          (c) => taskApply(token, task.id, c, alvoFinal),
          { token, debugCallback, humanCallback, rotulo: 'verifica pós-envio', taskId: task.id },
        );
        const statusLido = ap?.answer_status || ap?.status;
        if (statusLido && statusLido !== esperado) {
          console.warn(`[solver] tarefa ${task.id}: pós-envio status=${statusLido} (esperava ${esperado}) — re-enviando UMA vez...`);
          return comCaptcha(
            (c) => (answerId
              ? updateAnswer(token, task.id, answerId, payload, c)
              : submitAnswer(token, task.id, payload, c)),
            { token, debugCallback, humanCallback, rotulo: 're-envio pós-envio', taskId: task.id },
          );
        }
      } catch (e) {
        console.warn(`[solver] tarefa ${task.id}: verificação pós-envio indisponível (${e.message})`);
      }
      return null;
    };
    if (status === 'draft') {
      if (!answerId) {
        const criado = await criarRascunho();
        await verificarEnvios({ ...makeBase(), status: 'draft' }, 'draft');
        return criado;
      }
      // rascunho já existia (tarefa retomada): atualiza em vez de duplicar
      const payload = { ...makeBase(), status: 'draft' };
      const atualizado = await comCaptcha(
        (c) => updateAnswer(token, task.id, answerId, payload, c),
        { token, debugCallback, humanCallback, rotulo: 'envio final', taskId: task.id },
      );
      await verificarEnvios(payload, 'draft');
      return atualizado;
    }
    if (!answerId) await criarRascunho();
    const payload = { ...makeBase(), status: 'submitted' };
    const r = await comCaptcha(
      (c) => (answerId
        ? updateAnswer(token, task.id, answerId, payload, c)
        : submitAnswer(token, task.id, payload, c)),
      { token, debugCallback, humanCallback, rotulo: 'envio final', taskId: task.id },
    );
    await verificarEnvios(payload, 'submitted');
    return r;
  };

  // com agendador: entrega a conclusão e volta LIVRE pro pool imediatamente.
  try {
    if (typeof agendar === 'function') return await agendar(concluir);
    return await concluir();
  } catch (e) {
    // falha na fase final (envio): o que foi respondido continua como rascunho —
    // garante na hora em vez de perder tudo pro próximo ciclo.
    try { await salvarRascunhoParcial('erro'); }
    catch (e2) { console.error(`[solver] tarefa ${task.id}: falha ao salvar rascunho parcial no envio: ${e2?.message}`); }
    throw e;
  }
}

// resolve VÁRIAS tarefas em paralelo, UMA POR CHAVE DE IA.
//   - concorrência máx = número de chaves Gemini no .env (ex.: 10 chaves = 10 tarefas ao mesmo tempo)
//   - sobrou tarefa? fica na fila; assim que um slot/chave libera ("tokens voltaram"),
//     entra a próxima automaticamente.
// opts: mesmos do solveTask + onProgress(done, total, linha).
//       onTick(estado) — estado AO VIVO: { feito, total, ativas: [{ nome, feitas, totalQ }] }
//       chamado quando uma tarefa começa/termina E a cada questão resolvida.
// retorna array na ordem de entrada: [{ ok, result?, error? }, ...]
export async function solveTasksParallel(tasks, opts = {}) {
  const lista = tasks || [];
  const total = lista.length;
  // concorrência: por padrão 1 tarefa por chave de IA; quem chamar pode
  // limitar (ex.: concorrenciaMaxima: 2 pra espalhar melhor a carga).
  const limite = Number.isFinite(opts.concorrenciaMaxima) ? opts.concorrenciaMaxima : Infinity;
  const slots = Math.max(1, Math.min(apiKeyCount(), total, limite));
  const resultados = new Array(total);

  console.log(`[pool] ${total} tarefa(s) · ${slots} em paralelo`);

  let cursor = 0;
  let done = 0;

  // estado AO VIVO por slot (pra UI do Discord atualizar questão a questão)
  const ativas = new Map(); // slot -> { id, nome, feitas, totalQ }
  const tick = () => {
    try {
      opts.onTick?.({
        feito: done,
        total,
        ativas: [...ativas.values()].map(a => ({ ...a })),
      });
    } catch { /* UI nunca derruba o solver */ }
  };

  // conclusões ADIADAS: tarefas que já resolveram tudo e só esperam o tempo-alvo
  // (sorteado) pra enviar. ficam FORA dos slots — os workers seguem livres pra
  // resolver as próximas; os envios rodam todos em paralelo no fim.
  const PENDENTE = Symbol('pendente');
  const finais = [];

  const worker = async (slot) => {
    while (cursor < total) {
      // cancelamento: não pega MAIS tarefas da fila (as em andamento terminam
      // na questão atual e abortam sem enviar).
      if (typeof opts.deveCancelar === 'function' && opts.deveCancelar()) break;
      const pos = cursor++;
      const t = lista[pos];
      const nome = String(t?.title || t?.id || `#${pos}`).slice(0, 40);
      // opts da tarefa: chave exclusiva do slot + callback de captcha próprio.
      // as tarefas paralelas da MESMA rodada recebem chaves Groq DIFERENTES
      // (base + slot) pra dividir o TPM sem duas tarefas pisarem na mesma chave.
      const { onProgress, makeDebugCallback, makeHumanCallback, onTick, ...resto } = opts;
      const nGroq = qtdChavesGroq();
      const baseGroq = Number.isInteger(opts.groqIndex) ? opts.groqIndex : 0;
      const taskOpts = {
        ...resto,
        apiKeyIndex: slot,
        ...(nGroq > 1 ? { groqIndex: (baseGroq + slot) % nGroq } : {}),
        onQuestion: (feitas, totalQ) => {
          ativas.set(slot, { id: t?.id ?? pos, nome, feitas, totalQ });
          tick();
        },
      };
      if (typeof makeDebugCallback === 'function') taskOpts.debugCallback = makeDebugCallback(t);
      if (typeof makeHumanCallback === 'function') taskOpts.humanCallback = makeHumanCallback(t);
      try {
        ativas.set(slot, { id: t?.id ?? pos, nome, feitas: 0, totalQ: (t?.questions || []).filter(q => q.type !== 'info' && q.type !== 'media').length });
        tick();
        const r = await solveTask(t, taskOpts, (concluir) => {
          // fase final adiada: a tarefa só vai esperar o relógio + enviar.
          // devolvemos um marcador e o slot fica LIVRE na hora — é por isso
          // que "segurando envio" não trava mais as outras tarefas.
          finais.push({ pos, nome, concluir });
          return PENDENTE;
        });
        if (r === PENDENTE) continue; // conclusão fica pro fim; próxima tarefa!
        resultados[pos] = { ok: true, result: r };
        done++;
        console.log(`[pool] ✅ (${done}/${total}) "${nome}" concluída na chave #${slot}`);
        opts.onProgress?.(done, total, `✅ ${nome}`);
        opts.onResultado?.(pos, true, null);
      } catch (e) {
        resultados[pos] = { ok: false, error: e };
        done++;
        console.warn(`[pool] ❌ (${done}/${total}) "${nome}" falhou: ${e.message}`);
        opts.onProgress?.(done, total, `❌ ${nome} — ${String(e.message || '').slice(0, 60)}`);
        opts.onResultado?.(pos, false, e);
      } finally {
        ativas.delete(slot);
        tick();
      }
    }
  };

  await Promise.all(Array.from({ length: slots }, (_, s) => worker(s)));

  // todos os slots terminaram de RESOLVER. agora rodam os envios que ficaram
  // esperando o tempo-alvo — em paralelo, cada um no seu minuto sorteado.
  if (finais.length) {
    console.log(`[pool] questões resolvidas — ${finais.length} envio(s) agendado(s) pelo tempo-alvo...`);
    await Promise.all(finais.map(({ pos, nome, concluir }) =>
      concluir()
        .then((r) => {
          resultados[pos] = { ok: true, result: r };
          done++;
          console.log(`[pool] ✅ (${done}/${total}) "${nome}" enviada (tempo-alvo cumprido)`);
          opts.onProgress?.(done, total, `✅ ${nome}`);
          opts.onResultado?.(pos, true, null);
        })
        .catch((e) => {
          resultados[pos] = { ok: false, error: e };
          done++;
          console.warn(`[pool] ❌ (${done}/${total}) "${nome}" falhou no envio: ${e.message}`);
          opts.onProgress?.(done, total, `❌ ${nome} — ${String(e.message || '').slice(0, 60)}`);
          opts.onResultado?.(pos, false, e);
        })
    ));
  }

  return resultados;
}

// valida/normaliza a resposta da IA pro shape exato que a edusp aceita.
// retorna { ok: bool, answer }. ok=false => usar heurístico.
function validateShape(t, a, q) {
  const aIsArr = Array.isArray(a);
  const aIsObj = a && typeof a === 'object' && !aIsArr;

  if (a == null) return { ok: false };

  // escolha / true-false: objeto de booleans
  if (t === 'single' || t === 'single-choice' || t === 'multi' || t === 'multiple-choice' || t === 'true-false') {
    if (!aIsObj) return { ok: false };
    const obj = { ...a };
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'string') obj[k] = (obj[k].toLowerCase() === 'true');
      if (typeof obj[k] !== 'boolean') return { ok: false };
    }
    const trues = Object.values(obj).filter(v => v === true).length;
    if ((t === 'single' || t === 'single-choice') && trues !== 1) return { ok: false };
    if ((t === 'multi' || t === 'multiple-choice') && trues < 1) return { ok: false };
    return { ok: true, answer: obj };
  }

  // texto/text_ai/free-text = { 0: 'texto' } — prova real: tarefas avaliadas
  // 10/10 gravam assim; {title, body} em text_ai deixa o editor vazio.
  // redação de verdade (essay/reflection ou is_essay) exige {title, body}.
  if (t === 'text' || t === 'text_ai' || t === 'text-ai' || t === 'free-text' || t === 'essay' || t === 'reflection') {
    const ehEssay = ['essay', 'reflection'].includes(t)
      || ['essay', 'reflection'].includes(String(q?.rawType || '').trim());

    if (ehEssay) {
      // shape já pronto { title, body }? valida e corta nos limites.
      if (aIsObj && typeof a.title === 'string' && typeof a.body === 'string') {
        const titulo = a.title.trim();
        const corpo = a.body.trim();
        if (corpo.length >= 8) {
          return { ok: true, answer: { title: (titulo || 'Redação').slice(0, 300), body: corpo.slice(0, 8000) } };
        }
        return { ok: false };
      }
      // texto plano caiu aqui (ex.: IA mandou só o corpo): monta título a partir
      // do enunciado em vez de mandar {0: texto} (que não tem título → NaN).
      let txt = '';
      if (typeof a === 'string') txt = a.trim();
      else if (aIsObj) txt = String(a[0] ?? a.answer ?? a.text ?? a.content ?? '').trim();
      if (txt.length < 60 || txt === '...') return { ok: false };
      const titulo = String(q?.title || q?.name || 'Redação').replace(/<[^>]+>/g, '').trim().slice(0, 300) || 'Redação';
      return { ok: true, answer: { title: titulo, body: txt.slice(0, 8000) } };
    }

    let txt = '';
    let answer = a;
    if (typeof a === 'string') { txt = a; answer = { 0: a }; }
    else if (aIsObj) {
      // redação legada mandada como text_ai (tarefa is_essay): mantém {title, body}.
      if (typeof a.title === 'string' && typeof a.body === 'string' && a.body.trim().length >= 8) {
        return { ok: true, answer: { title: a.title.trim().slice(0, 300), body: a.body.trim().slice(0, 8000) } };
      }
      txt = String(a[0] ?? a.answer ?? a.text ?? a.content ?? '').trim();
      if (txt && a[0] == null) answer = { 0: txt };
    }
    if (!txt || txt === '...' || txt.length < 8) return { ok: false };
    return { ok: true, answer };
  }

  // cloud / order-sentences: array (o ai.js já normaliza)
  if (t === 'cloud' || t === 'order-sentences') {
    if (!aIsArr || !a.length) return { ok: false };
    return { ok: true, answer: a };
  }

  // fill-words: TODAS as lacunas precisam ser palavras exatas do banco (sem repetir).
  // faltou uma só? resposta inválida → solver re-tenta com a IA. nada de completar no chute.
  if (t === 'fill-words') {
    if (!aIsArr) return { ok: false };
    const pool = Array.isArray(q.options?.items) ? q.options.items : [];
    const phrase = Array.isArray(q.options?.phrase) ? q.options.phrase : [];
    const isBlank = s => (typeof s === 'string' && /^[_…\s]+$/.test(s))
      || (s && (s.type === 'select' || s.type === 'input' || s.type === 'blank' || s.type === 'gap' || s.answer != null));
    const blankIdxs = [];
    for (let i = 0; i < phrase.length; i++) if (isBlank(phrase[i])) blankIdxs.push(i);
    const N = blankIdxs.length;

    // NÃO reconheceu nenhuma lacuna: não existe resposta válida a montar. antes
    // isso caía no laço de zero voltas e devolvia {ok:true, answer:[]} — o bot
    // ENVIAVA array vazio (nota zero com certeza) e o solver aceitava como
    // sucesso. agora rejeita e deixa o heurístico/erro aparecerem no log.
    if (N === 0) {
      console.warn('[solver] fill-words: nenhuma lacuna reconhecida na phrase (estrutura inesperada) — checando options.phrase');
      return { ok: false };
    }

    // se a IA mandou a phrase inteira, extrai só as lacunas
    const entrada = (a.length === phrase.length && phrase.length !== N) ? blankIdxs.map(i => a[i]) : a.slice(0, N);
    if (entrada.length < N) {
      console.warn(`[solver] fill-words: IA devolveu ${entrada.length} preenchimento(s) p/ ${N} lacuna(s)`);
      return { ok: false };
    }

    if (pool.length) {
      // tolerante a acento/caixa: o modelo devolve "coração" e o banco tem
      // "coracao" (ou vice-versa) — antes o toLowerCase() não bastava e a
      // resposta era rejeitada, gastando as tentativas.
      const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const poolByNorm = new Map();
      for (const p of pool) { const k = norm(p); if (k && !poolByNorm.has(k)) poolByNorm.set(k, String(p)); }
      const usadas = new Set();
      const answer = new Array(N).fill(null);
      for (let k = 0; k < N; k++) {
        const key = norm(entrada[k] ?? '');
        const orig = key ? poolByNorm.get(key) : undefined;
        if (!orig || usadas.has(norm(orig))) {
          console.warn(`[solver] fill-words: "${entrada[k] ?? ''}" não está no banco (ou repetida) — banco: ${pool.map(p => `"${p}"`).join(', ').slice(0, 300)}`);
          return { ok: false }; // fora do banco/repetida
        }
        answer[k] = orig; usadas.add(norm(orig));
      }
      return { ok: true, answer };
    }

    // modo input livre (sem banco): aceita o que a IA escreveu, mas exige tudo preenchido
    const answer = entrada.slice(0, N).map(v => String(v ?? '').trim());
    if (answer.some(s => !s)) return { ok: false };
    return { ok: true, answer };
  }

  // fill-letters: SÓ aceita do tamanho exato pedido. nada de completar com 'A'.
  // formato = STRING simples (referência app.py) — objeto { answer } quebra a nota.
  if (t === 'fill-letters') {
    let palavra = '';
    if (typeof a === 'string') palavra = a;
    else if (aIsObj) palavra = String(a.answer ?? a[0] ?? a.word ?? a.text ?? a.value ?? '').trim();
    const n = Number(q.options?.letters) || 0;
    const limpa = palavra.replace(/[\s_·•\-]/g, '');
    if (!limpa) return { ok: false };
    if (n && limpa.length !== n) return { ok: false }; // tamanho errado → re-tenta
    return { ok: true, answer: limpa };
  }

  // tipo desconhecido: deixa o heurístico decidir
  return { ok: false };
}
