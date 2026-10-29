// solver via Google AI Studio (Gemini) — generativelanguage API.
// mesma interface do antigo (Groq): solveQuestion(q) -> { answer }.
// raciocínio por tipo (chain-of-thought) preservado.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { config } from './config.js';
import { processarVariantes } from './captchaImage.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// usar apenas gemini-3.6-flash, porém alternando as chaves de API.
const API_KEYS_BLOCKED_UNTIL = new Map();
let currentKeyIndex = 0;

// 503/500 do Gemini é sobrecarga do BACKEND (serviço), não da chave: martelar
// chave1→chave2→chave3 só gera spam de log e queima o orçamento do captcha.
// backoff GLOBAL (retry-after quando a API manda; senão exponencial 4s→30s)
// pausa TODAS as chamadas Gemini de uma vez; qualquer sucesso zera a sequência.
let GEMINI_OVERLOAD_UNTIL = 0;
let GEMINI_OVERLOAD_SEQ = 0;
function marcarSobrecarga(status, retryAfterSec = null) {
  // só um 503 que acontece FORA de um backoff em curso conta como incidente
  // novo — se N tarefas paralelas confirmarem o MESMO 503, só a PRIMEIRA re-arma
  // a espera. sem isso, cada confirmação empurra o prazo pra +base (até 30s) do
  // momento dela, e a fila inteira vive num backoff que NUNCA expira (o "freeze"
  // de minutos observado com Gemini 503 + 3 captchas em paralelo: "aguardando 4s"
  // seguido de silêncio total). o prazo é sempre re-agendado a partir de AGORA,
  // então expira sozinho e deixa o serviço tentar de novo.
  if (Date.now() < GEMINI_OVERLOAD_UNTIL) return GEMINI_OVERLOAD_UNTIL;
  const base = (Number.isFinite(retryAfterSec) && retryAfterSec > 0)
    ? Math.min(retryAfterSec * 1000, 10 * 60_000) // Retry-After é curto; teto de 10 min pra nunca travar o bot
    : Math.min(30_000, 4000 * 2 ** Math.min(GEMINI_OVERLOAD_SEQ, 3));
  GEMINI_OVERLOAD_UNTIL = Date.now() + base;
  GEMINI_OVERLOAD_SEQ++;
  return GEMINI_OVERLOAD_UNTIL;
}
// resposta boa ⇒ sobrecarga acabou: zera a sequência E o prazo (antes o sucesso
// só resetava o SEQ, e o UNTIL continuava armado segurando todo mundo até o fim).
function geminiOk() { GEMINI_OVERLOAD_SEQ = 0; GEMINI_OVERLOAD_UNTIL = 0; }
async function esperarSobrecarga(deadline = Infinity) {
  const alvo = Math.min(GEMINI_OVERLOAD_UNTIL, deadline);
  const ms = alvo - Date.now();
  if (ms > 0) {
    console.warn(`[ai] backend Gemini sobrecarregado — aguardando ${Math.max(1, Math.round(ms / 1000))}s (backoff global)...`);
    await new Promise(r => setTimeout(r, ms));
  }
}

// cascata de modelos: se o principal estiver sobrecarregado (503/429), tenta o próximo.
// o modelo do .env (GEMINI_MODEL) sempre tem prioridade; os demais são fallbacks flash.
const MODEL_CASCADE = [...new Set([
  config.gemini.model || 'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
])];

// ============================================================
//  POOL GROQ — várias contas (GROQ_API_KEY..GROQ_API_KEY5), cada uma com
//  limites PRÓPRIOS de TPM/TPD. pausa INDIVIDUAL por chave: quem bate 429
//  descansa sozinha; as demais continuam atendendo as outras pessoas.
// ============================================================
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const groqKeys = [...new Set([
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY2, process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY3, process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY4, process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY5, process.env.GROQ_API_KEY_5,
].filter(Boolean))];

const GROQ_BLOCKED_UNTIL = new Array(groqKeys.length).fill(0);
let groqCursor = 0;

export function qtdChavesGroq() { return groqKeys.length; }

// escolhe uma chave LIVRE: prefere a índice dado (pessoa "dona" da chave);
// senão round-robin entre as livres. devolve null se TODAS estão pausadas.
function escolherGroq(preferida = null) {
  const agora = Date.now();
  if (Number.isInteger(preferida) && preferida >= 0 && preferida < groqKeys.length && GROQ_BLOCKED_UNTIL[preferida] <= agora) return preferida;
  const n = groqKeys.length;
  for (let i = 0; i < n; i++) {
    const idx = (groqCursor + i) % n;
    if (GROQ_BLOCKED_UNTIL[idx] <= agora) { groqCursor = (idx + 1) % n; return idx; }
  }
  return null;
}

function proximoDesbloqueioGroq() {
  return groqKeys.length ? Math.min(...GROQ_BLOCKED_UNTIL) : Date.now();
}

// quanto tempo o bot aceita ESPERAR pelo Groq antes de escalar pra outro
// provedor. o padrão é 90s: acima disso (limite DIÁRIO que só volta à
// meia-noite, TPD de várias contas) esperar trava a tarefa inteira sem
// perspectiva — o certo é gastar Gemini/roteador AGORA e voltar pro Groq
// na próxima tarefa/ciclo, com a cota já renovada.
const GROQ_ESPERA_MAX_MS = Math.max(5, Number(process.env.GROQ_ESPERA_MAX_SEGUNDOS) || 90) * 1000;

// true = ainda vale a pena esperar o Groq. false = já escalate.
function valeEsperarGroq() {
  if (!groqKeys.length) return false;
  return proximoDesbloqueioGroq() - Date.now() <= GROQ_ESPERA_MAX_MS;
}

async function esperarGroqDisponivel() {
  const ms = Math.max(0, proximoDesbloqueioGroq() - Date.now());
  if (ms > 0) {
    console.log(`[ai] todas as ${groqKeys.length} chaves Groq pausadas — aguardando ${Math.round(ms / 1000)}s abrir janela (Gemini preservado)...`);
    await new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 3000)));
  }
}

// limite DIÁRIO (TPD)? a mensagem do groq cita "per day"/"TPD" ou pede horas.
function pareceLimiteDiario(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('per day') || m.includes('tpd') || /\b\d+\s*h\b/.test(m);
}
function proximaMeiaNoiteUTC() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 60_000;
}

// erro de COTA DIÁRIA do Gemini ("Resource has been exhausted (e.g. check quota)"):
// esse 429 não libera em 30s — a conta só volta depois da meia-noite do horário
// do Google. reconhecer evita o backoff inútil de 3s×N gastando o orçamento do captcha.
function pareceQuotaGemini(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('quota') || m.includes('resource has been exhausted');
}

// orçamento diário do compound-mini (reserva de pico; o free dele tem 250 req/dia)
let COMPOUND_USADOS = { dia: -1, n: 0 };
function podeCompound() {
  const dia = Math.floor(Date.now() / 86_400_000);
  if (COMPOUND_USADOS.dia !== dia) COMPOUND_USADOS = { dia, n: 0 };
  return COMPOUND_USADOS.n < config.groq.compoundDailyBudget;
}
function contaCompound() { COMPOUND_USADOS.n++; }

// modo "chave exclusiva": cada tarefa roda presa a UMA chave do Gemini, sem
// competir com as outras. resolve o problema de N tarefas paralelas queimarem
// a mesma chave ao mesmo tempo. solver.js envolve o loop de questões com
// withApiKey(idx, ...) e todo chat() daquela árvore de await usa só essa chave.
const keySlot = new AsyncLocalStorage();

export function apiKeyCount() {
  return Math.max(1, config.gemini.apiKeys.length);
}

// roda fn usando APENAS a chave de índice idx (0..n-1). se ela bater 429,
// espera o cooldown dela em vez de cair na chave de outra tarefa.
export function withApiKey(idx, fn) {
  return keySlot.run(((idx % apiKeyCount()) + apiKeyCount()) % apiKeyCount(), fn);
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function safeJson(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch {}
  // tolerante: modelos às vezes embrulham o JSON em texto/explicação —
  // extrai o primeiro {...} ou [...] completo e tenta de novo.
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch {} }
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

// chamada bruta a um modelo Gemini. messages no formato {role,content} do estilo OpenAI;
// aqui convertemos pro formato do Gemini (system_instruction + contents).
async function geminiOne(model, apiKey, messages, opts = {}) {
  const sysMsg = messages.find(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role !== 'system');

  const body = {
    contents: userMsgs.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.max_tokens ?? 2048,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (sysMsg) body.system_instruction = { parts: [{ text: sysMsg.content }] };

  const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) {
    const retryAfter = r.headers.get('retry-after');
    const msg = (j && j.error && j.error.message) || `gemini ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.retryAfter = retryAfter ? Number(retryAfter) : null;
    throw err;
  }
  geminiOk(); // resposta boa ⇒ a sobrecarga do serviço acabou (reinicia o backoff)
  return j;
}

// extrai o texto da resposta do Gemini, no mesmo "formato" que o resto do código espera:
// { choices: [{ message: { content } }] }
function asChoice(j) {
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const content = parts.map(p => p.text || '').join('');
  return { choices: [{ message: { content } }] };
}

async function openAiCompatibleChat(baseUrl, apiKey, model, messages, opts = {}) {
  // raciocínio (gpt-oss) tem effort controlável por chamada (ver linha ~231).
  const ehGptOss = String(model).startsWith('openai/gpt-oss');
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 2048,
      // gpt-oss (raciocínio) + json_object = "Failed to validate JSON" frequente;
      // neles NÃO força o modo JSON — o safeJson tolerante extrai sozinho.
      ...(opts.json && !ehGptOss ? { response_format: { type: 'json_object' } } : {}),
      // razão de pensar: só sobe pra medium em respostas LONGAS (max_tokens >=
      // 2048: redação/texto). questões curtas (fill-letters com 100 tokens, etc.)
      // ficam SEMPRE low — medium só faz o raciocínio esgotar o orçamento e a
      // chamada voltar content VAZIO, queimando tentativa + chave à toa.
      ...(ehGptOss ? { reasoning_effort: opts.reasoning_effort ?? (opts.tentativa >= 2 && (opts.max_tokens ?? 0) >= 2048 ? 'medium' : (process.env.GROQ_REASONING_EFFORT || 'low')) } : {}),
    }),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) {
    const msg = (j && j.error && (j.error.message || j.error)) || `provider ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return j;
}

// FIM DE TOKENS: o provedor cortou a resposta no meio (finish_reason 'length').
// o conteúdo até vem preenchido, mas pela metade — pro solver isso é shape
// inválido (JSON cortado, sem a linha RESPOSTA:, texto truncado), que só gera
// tentativa queimada. marcar aqui deixa o chamador tratar como "resposta inútil"
// e escalating para outro provedor em vez de insistir no mesmo.
function respostaTruncada(res) {
  const f = res?.choices?.[0]?.finish_reason;
  return f === 'length' || f === 'max_tokens';
}

// gpt-oss (raciocínio) volta content VAZIO ou CORTADO quando gasta todo o
// max_tokens só "pensando" — frequente nas questões curtas (ex.: fill-letters
// com 100 tokens). em vez de declarar falha na hora (e queimar a rodada / cair
// pro Gemini à toa), re-tenta UMA vez na MESMA chave com orçamento folgado pra
// resposta sair, com o raciocínio forçado em low (a dúvida curta não precisa
// pensar muito). se ainda assim vier vazio/cortado, marca a resposta pra o
// chamador subir a cascata (Groq -> Gemini -> roteador).
async function openAiComRetryVazio(baseUrl, apiKey, model, messages, opts) {
  const ehRaciocinio = String(model).startsWith('openai/gpt-oss');
  const baseTokens = Number(opts.max_tokens) || 2048;
  const tenta = (extra) => openAiCompatibleChat(baseUrl, apiKey, model, messages, { ...opts, ...extra });
  const inutil = (r) => !String(r?.choices?.[0]?.message?.content || '').trim() || respostaTruncada(r);
  let res = await tenta({});
  if (ehRaciocinio && inutil(res)) {
    const folga = Math.min(12000, Math.max(4096, baseTokens * 4));
    console.warn(`[ai] gpt-oss ${respostaTruncada(res) ? 'truncou' : 'respondeu vazio'} no limite de ${baseTokens} tokens — re-tentando com ${folga}...`);
    res = await tenta({ reasoning_effort: 'low', max_tokens: folga });
  }
  res.__inutil = inutil(res);
  return res;
}

// chat preso a UMA chave (modo exclusivo por tarefa). se a chave bater 429,
// espera o cooldown dela e tenta de novo — não rouba a chave das outras tarefas.
async function chatPinned(pinIdx, messages, opts = {}) {
  const keys = config.gemini.apiKeys;
  const apiKey = keys[pinIdx % keys.length];
  const models = opts.model ? [opts.model] : MODEL_CASCADE;
  let ultimoErr = null;
  for (const modelo of models) {
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      const agora = Date.now();
      const bloqueadaAte = API_KEYS_BLOCKED_UNTIL.get(apiKey) || 0;
      if (bloqueadaAte > agora) {
        const espera = Math.min(bloqueadaAte - agora, 120_000);
        console.log(`[ai] chave #${pinIdx} em cooldown, aguardando ${Math.round(espera / 1000)}s...`);
        await new Promise(r => setTimeout(r, espera));
      }
      await esperarSobrecarga();
      try {
        return asChoice(await geminiOne(modelo, apiKey, messages, opts));
      } catch (e) {
        ultimoErr = e;
        if (e.status === 429) {
          API_KEYS_BLOCKED_UNTIL.set(apiKey, Date.now() + (e.retryAfter || 60) * 1000);
          continue;
        }
        if (e.status === 503 || e.status === 500) {
          marcarSobrecarga(e.status, e.retryAfter ?? null);
          continue;
        }
        break; // outro erro → próximo modelo da cascata
      }
    }
    if (!opts.model && models.length > 1 && ultimoErr) {
      console.warn(`[ai] chave #${pinIdx}: modelo ${modelo} indisponível (${ultimoErr.message}), tentando próximo...`);
    }
  }
  throw ultimoErr || new Error(`chave exclusiva #${pinIdx} falhou`);
}

// pausa GLOBAL de cota: quando uma chamada bate limite de tokens/req (ex.: TPM do
// Groq), TODAS as tarefas pausam por alguns segundos — as outras param de gastar
// pra sobrar cota pra tarefa atrasada re-tentar depois do reset da janela.
let QUOTA_PAUSE_UNTIL = 0;

function pausarQuota(ms) {
  QUOTA_PAUSE_UNTIL = Math.max(QUOTA_PAUSE_UNTIL, Date.now() + ms);
}

async function esperarQuota() {
  const ms = Math.max(0, QUOTA_PAUSE_UNTIL - Date.now());
  if (ms > 0) {
    console.log(`[ai] pausa global de cota: aguardando ${Math.round(ms / 1000)}s (outras tarefas pausadas pra sobrar token)...`);
    // jitter: se várias tarefas acordarem juntas, elas não disparam no mesmo instante
    await new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 4000)));
  }
}

// extrai "try again in Xs" / "retry in 1h2m30s" / "Xms" da mensagem de erro
function retrySegundos(msg) {
  const m = String(msg || '').match(/(?:try again in|retry in)\s*([^.\n]{0,40})/i);
  if (!m) return null;
  const seg = m[1];
  let total = 0, achou = false;
  const h = seg.match(/(\d+)\s*h(?![a-z])/i); if (h) { total += Number(h[1]) * 3600; achou = true; }
  const mi = seg.match(/(\d+)\s*m(?!s)(?![a-z])/i); if (mi) { total += Number(mi[1]) * 60; achou = true; }
  const s = seg.match(/(\d+(?:\.\d+)?)\s*s(?![a-z])/i); if (s) { total += Number(s[1]); achou = true; }
  const ms = seg.match(/(\d+(?:\.\d+)?)\s*ms/i); if (ms) { total += Number(ms[1]) / 1000; achou = true; }
  return achou ? Math.max(1, Math.ceil(total)) : null;
}

// ============================================================
//  RESERVA FINAL — ROTEADOR (LiteLLM / OpenRouter / qualquer gateway
//  compatível com /v1/chat/completions). roda SÓ depois de Groq e
//  Gemini falharem, então não compete cota com o resto. chaves
//  bloqueadas por cota (429) são puladas por cooldown próprio, e
//  enquanto TODAS estiverem fora de uso a chamada desiste na hora
//  (devolve null) em vez de dormir.
// ============================================================

// teto de espera pelo backoff de sobrecarga do Gemini antes de descer pro
// roteador. sem isso, um 503 de vários minutos segura a tarefa mesmo com
// reserva disponível do outro lado.
const GEMINI_ESPERA_MAX_MS = Math.max(5, Number(process.env.GEMINI_ESPERA_MAX_SEGUNDOS) || 45) * 1000;

// lista de provedores de reserva, já filtrada: só os que têm base+chave+modelo.
function provedoresRoteador() {
  const lista = [];
  const add = (nome, baseUrl, apiKeys, models) => {
    if (!baseUrl || !apiKeys.length || !models.length) return;
    lista.push({ nome, baseUrl: baseUrl.replace(/\/+$/, ''), apiKeys, models });
  };
  add('roteador', config.router.baseUrl, config.router.apiKeys, config.router.models);
  add('openrouter', config.openRouter.baseUrl, config.openRouter.apiKeys, config.openRouter.models);
  for (const r of [...(config.roteadoresExtras || []), ...(config.roteadoresCustom || [])]) {
    if (!r.baseUrl || !r.apiKeys.length || !r.models.length) continue;
    lista.push({ ...r, baseUrl: r.baseUrl.replace(/\/+$/, '') });
  }
  return lista;
}
const ROTEADORES = provedoresRoteador();
// cooldown por PAR (chave, modelo) e por chave inteira. num gateway/roteador a
// cota é quase sempre POR DEPLOYMENT (o modelo esbarrou no limite, a chave
// segue boa) — pausar a chave toda matava os outros modelos da cascata junto,
// que era o 429 de um modelo derrubando a reserva inteira. só uma mensagem de
// limite DIÁRIO/da conta pausa a chave de verdade.
const ROTEADOR_BLOQUEADO_ATE = new Map(); // "chave|modelo" -> timestamp
const ROTEADOR_CHAVE_ATE = new Map();    // chave -> timestamp

function parChaveModelo(chave, modelo) { return `${chave}|${modelo}`; }

export function provedoresReserva() {
  return ROTEADORES.map(p => ({ nome: p.nome, baseUrl: p.baseUrl, chaves: p.apiKeys.length, modelos: p.models }));
}

// tenta cada provedor/modelo/chave até um responder. devolve null (nunca
// lança) quando não há provedor configurado ou todos falharam.
async function chatRoteador(messages, opts = {}) {
  if (!ROTEADORES.length) return null;
  const agora = () => Date.now();
  let ultimoErro = null;
  for (const p of ROTEADORES) {
    for (const modelo of p.models) {
      for (let i = 0; i < p.apiKeys.length; i++) {
        const key = p.apiKeys[i];
        if ((ROTEADOR_CHAVE_ATE.get(key) || 0) > agora()) continue;
        if ((ROTEADOR_BLOQUEADO_ATE.get(parChaveModelo(key, modelo)) || 0) > agora()) continue;
        try {
          const res = await openAiComRetryVazio(p.baseUrl, key, modelo, messages, opts);
          if (res?.__inutil) {
            ultimoErro = new Error(`${p.nome}/${modelo} respondeu ${respostaTruncada(res) ? 'truncado' : 'vazio'}`);
            continue;
          }
          console.log(`[ai] resposta veio do RESERVA ${p.nome}/${modelo} (chave #${i + 1})`);
          return res;
        } catch (e) {
          ultimoErro = e;
          if (e.status === 429) {
            const espera = retrySegundos(e.message) ?? 60;
            // só um indício EXPLÍCITO de cota da conta (per day/TPD) pausa a
            // chave inteira. "try again in 1h" é janela do MODELO no roteador:
            // tratar como chave mataria a cascata inteira por uma hora. a
            // janela por modelo expira em minutos e o modelo volta sozinho.
            const diario = pareceLimiteDiario(e.message);
            const alvo = Math.min(espera, 10 * 60_000) * 1000;
            if (diario) {
              ROTEADOR_CHAVE_ATE.set(key, agora() + alvo);
              console.warn(`[ai] reserva ${p.nome} chave #${i + 1} em limite DIÁRIO (${Math.round(espera / 60)}min) — pulando a chave`);
            } else {
              ROTEADOR_BLOQUEADO_ATE.set(parChaveModelo(key, modelo), agora() + alvo);
              console.warn(`[ai] reserva ${p.nome}/${modelo} sem cota (${espera}s) — tentando outro modelo...`);
            }
            continue;
          }
          if (e.status === 401 || e.status === 403) {
            // alguns roteadores (ex.: literouter) devolvem 403 pra MAIS DE UMA
            // coisa: "model not available"/"misspelled" e "rate limit exceed".
            // cada caso é um castigo diferente pra chave, então decide pela msg:
            const low = String(e.message || '').toLowerCase();
            if (low.includes('model') || low.includes('misspell') || low.includes('available')) {
              // modelo que não existe/escreveu errado: só pula pro próximo da
              // cascata, sem punir a chave (ela é válida).
              console.warn(`[ai] reserva ${p.nome} chave #${i + 1} recusou o modelo ${modelo} (${String(e.message).slice(0, 80)}) — próximo da cascata...`);
              break;
            }
            if (low.includes('rate limit') || low.includes('quota') || low.includes('429') || low.includes('too many')) {
              // rate limit em 403 (o literouter não usa 429): mesma regra do
              // 429 — cooldown POR MODELO se não for limite diário explícito.
              const espera = retrySegundos(e.message) ?? 60;
              const diario = pareceLimiteDiario(e.message);
              const alvo = Math.min(espera, 10 * 60_000) * 1000;
              if (diario) {
                ROTEADOR_CHAVE_ATE.set(key, agora() + alvo);
                console.warn(`[ai] reserva ${p.nome} chave #${i + 1} em limite DIÁRIO (${Math.round(espera / 60)}min) — pulando a chave`);
              } else {
                ROTEADOR_BLOQUEADO_ATE.set(parChaveModelo(key, modelo), agora() + alvo);
                console.warn(`[ai] reserva ${p.nome}/${modelo} sem cota (${espera}s) — tentando outro modelo...`);
              }
              continue;
            }
            // chave inválida/revogada de verdade: fora de uso até o restart do bot.
            ROTEADOR_CHAVE_ATE.set(key, agora() + 24 * 3600_000);
            console.warn(`[ai] reserva ${p.nome} chave #${i + 1} recusada (${e.status}) — ignorando nesta sessão`);
            continue;
          }
          console.warn(`[ai] reserva ${p.nome}/${modelo} falhou (${String(e.message).slice(0, 100)})`);
          break; // modelo ruim: vai pro próximo da cascata
        }
      }
    }
  }
  if (ultimoErro) console.warn(`[ai] nenhuma reserva respondeu (${ultimoErro.message})`);
  return null;
}

async function chat(messages, opts = {}) {
  const inicioEspera = Date.now();
  let ultimoErr = null;
  const model = opts.model || config.gemini.model || 'gemini-3.6-flash';
  
  if (opts.model && (!config.gemini.apiKeys || config.gemini.apiKeys.length === 0)) {
    return asChoice(await geminiOne(opts.model, config.gemini.apiKey || '', messages, opts));
  }

  // atalho de ÚLTIMO recurso: pula Groq e Gemini e vai DIRETO pro roteador
  // (LiteLLM/OpenRouter). usado pelos tipos de escrita quando nem o Groq nem
  // o Gemini entregaram texto utilizável — o roteador é a única cota que
  // ainda não foi tocada nessa questão.
  if (opts.reservaOnly) {
    const r = await chatRoteador(messages, opts);
    if (r) return r;
    throw ultimoErr || new Error('roteador de reserva indisponível');
  }

  // respeita pausa global de cota antes de qualquer tentativa
  await esperarQuota();

  // 1) GROQ PRINCIPAL — pool de chaves com pausa INDIVIDUAL por chave.
  //    Bateu TPM numa chave? só ela descansa e a chamada usa outra livre NA HORA
  //    (as demais pessoas não param). Todas bloqueadas? tenta o compound-mini
  //    (orçamento diário) e, sem orçamento, espera a janela abrir — preservando
  //    o Gemini só pra captcha/falha real. Com UMA chave: comportamento legado.
  if (!opts.geminiOnly && groqKeys.length) {
    const modeloGroq = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

    if (groqKeys.length === 1) {
      for (let rodada = 1; rodada <= 3; rodada++) {
        await esperarQuota();
        try {
          const res = await openAiComRetryVazio(GROQ_BASE, groqKeys[0], modeloGroq, messages, opts);
          if (res?.__inutil) {
            ultimoErr = new Error(`Groq ${respostaTruncada(res) ? 'truncou a resposta' : 'respondeu vazio'} (faltaram tokens)`);
            console.warn(`[ai] ${ultimoErr.message} — usando Gemini de reserva...`);
            break;
          }
          return res;
        } catch (e) {
          ultimoErr = e;
          if (e.status === 429) {
            const esperaBruto = retrySegundos(e.message) ?? 65;
            // limite DIÁRIO / TPD: esperar isso aqui congelaria TODAS as
            // tarefas (a pausa é global) por horas. escala pro Gemini/roteador
            // na hora e deixa o Groq descansar de verdade.
            if (pareceLimiteDiario(e.message) || esperaBruto * 1000 > GROQ_ESPERA_MAX_MS) {
              console.warn(`[ai] Groq bateu limite ${pareceLimiteDiario(e.message) ? 'DIÁRIO' : 'de tokens'} (${Math.round(esperaBruto / 60)}min) — sem esperar, usando Gemini de reserva...`);
              break;
            }
            pausarQuota(esperaBruto * 1000);
            console.warn(`[ai] Groq bateu o limite de tokens — pausando TODAS as tarefas por ${esperaBruto}s e re-tentando (rodada ${rodada}/3)...`);
            continue;
          }
          console.warn(`[ai] Groq falhou (${String(e.message).slice(0, 120)}); usando Gemini de reserva...`);
          break;
        }
      }
    } else {
      for (let rodada = 0; rodada < 6; rodada++) {
        const idx = escolherGroq(opts.groqIndex);
        if (idx == null) {
          if (podeCompound()) {
            contaCompound();
            console.log(`[ai] ${groqKeys.length} chaves gpt-oss pausadas — pico coberto por ${config.groq.overflowModel} (${COMPOUND_USADOS.n}/${config.groq.compoundDailyBudget} hoje)...`);
          try {
            const res = await openAiCompatibleChat(GROQ_BASE, groqKeys[groqCursor % groqKeys.length], config.groq.overflowModel, messages, opts);
            if (res?.__inutil) { ultimoErr = new Error('compound-minu respondeu vazio/truncado'); break; }
            return res;
          } catch (e) { ultimoErr = e; if (e.status === 429) break; }
        }
        // todas as chaves estão em pausa e a próxima janela tá longe demais
        // (cota DIÁRIA, várias contas no TPD): esperar trava a tarefa, então
        // escala na hora pro Gemini em vez de dormir.
        if (!valeEsperarGroq()) {
          console.warn(`[ai] Groq indisponível por mais de ${Math.round(GROQ_ESPERA_MAX_MS / 1000)}s (cota) — escalando pro Gemini agora`);
          break;
        }
        await esperarGroqDisponivel();
        continue;
      }
      try {
        const res = await openAiComRetryVazio(GROQ_BASE, groqKeys[idx], modeloGroq, messages, opts);
        // resposta VAZIA ou TRUNCADA (gpt-oss às vezes gasta todo o max_tokens
        // no raciocínio e volta sem conteúdo, ou cortado no meio) — sem isso o
        // problema caía no "erro normal" do solver e re-tentava SÓ nas chaves
        // Groq, nunca chegando ao Gemini (que hoje tem cota e resolve redação).
        if (res?.__inutil) {
          ultimoErr = new Error(`Groq ${respostaTruncada(res) ? 'truncou a resposta' : 'respondeu vazio'} (raciocínio comeu os tokens)`);
          console.warn(`[ai] chave #${idx + 1} ${ultimoErr.message} — caindo pro Gemini...`);
          throw ultimoErr;
        }
        return res;
      } catch (e) {

          ultimoErr = e;
          if (e.status === 429) {
            const espera = retrySegundos(e.message) ?? 60;
            const diario = pareceLimiteDiario(e.message) || espera > 1800;
            GROQ_BLOCKED_UNTIL[idx] = diario ? proximaMeiaNoiteUTC() : Date.now() + espera * 1000;
            console.warn(`[ai] chave #${idx + 1} ${diario ? 'BATEU O LIMITE DIÁRIO (volta ~00h UTC)' : `pausada por ${espera}s`} — seguindo nas outras chaves...`);
            continue;
          }
          // 503/500 = sobrecarga TRANSITÓRIA da chave (groq free vive caindo);
          // pausa só ela 20s e segue nas outras — em vez de abandonar pro Gemini
          // (que pode estar sem cota no dia). era o padrão que derrubou a
          // tarefa "Manifesto" com 8 tentativas em todas as 5 chaves.
          if (e.status === 503 || e.status === 500) {
            GROQ_BLOCKED_UNTIL[idx] = Date.now() + 20_000;
            console.warn(`[ai] chave #${idx + 1} sobrecarregada (${e.status}) — pausada 20s, seguindo nas outras...`);
            continue;
          }
          console.warn(`[ai] Groq chave #${idx + 1} falhou (${String(e.message).slice(0, 100)}); usando Gemini de reserva...`);
          break;
        }
      }
      // esgotou as 6 rodadas (raríssimo): cai pro Gemini abaixo como último recurso
    }
  }

  // modo exclusivo: tarefa presa a uma chave específica.
  const pin = keySlot.getStore();
  if (pin != null) {
    try { return await chatPinned(Number(pin), messages, opts); }
    catch (e) {
      ultimoErr = e;
      console.warn(`[ai] chave exclusiva #${pin} esgotou (${e.message}); cedendo pra rotação geral`);
      // cai na rotação global abaixo como último recurso
    }
  }

  if (pin == null) {
  // 2) GEMINI DE RESERVA — chaves do .env em cascata com os modelos.
  //    a espera pelo backoff global de 503 é LIMITADA: passado esse teto o
  //    Gemini entra na fila e a chamada desce pro roteador (senão uma queda
  //    de 10 min do backend segura a tarefa inteira mesmo com reserva viva).
  for (const modelo of (opts.model ? [opts.model] : MODEL_CASCADE)) {
    if (Date.now() < GEMINI_OVERLOAD_UNTIL && Date.now() - inicioEspera > GEMINI_ESPERA_MAX_MS) {
      console.warn('[ai] Gemini ainda sobrecarregado — descendo pro roteador de reserva');
      break;
    }
    await esperarSobrecarga(); // backend 503? espera o backoff global antes de tentar
    for (let i = 0; i < config.gemini.apiKeys.length; i++) {
      const keyIndex = (currentKeyIndex + i) % config.gemini.apiKeys.length;
      const apiKey = config.gemini.apiKeys[keyIndex];
      if ((API_KEYS_BLOCKED_UNTIL.get(apiKey) || 0) > Date.now()) continue;

      try {
        const res = await geminiOne(modelo, apiKey, messages, opts);
        currentKeyIndex = keyIndex; // Update the current key to the working one
        return asChoice(res);
      } catch (e) {
        ultimoErr = e;
        if (e.status === 429) {
          // cota DIÁRIA do Gemini só volta à meia-noite UTC: bloquear só
          // 60s fazia o loop re-tentar a mesma chave morta em toda chamada.
          const diario = pareceQuotaGemini(e.message);
          API_KEYS_BLOCKED_UNTIL.set(apiKey, diario ? proximaMeiaNoiteUTC() : Date.now() + (e.retryAfter || 60) * 1000);
          continue;
        }
        // sobrecarregado/instável: breve espera e tenta próxima chave/modelo
        if (e.status === 503 || e.status === 500) {
          // sobrecarga do serviço (não da chave): aciona o backoff global e sai
          // do loop de chaves — o próximo modelo espera ele no topo, sem girar.
          marcarSobrecarga(e.status, e.retryAfter ?? null);
          break;
        }
        if (e.status >= 400 && e.status < 500) continue;
      }
    }
    if (!opts.model && MODEL_CASCADE.length > 1 && ultimoErr) {
      console.warn(`[ai] modelo ${modelo} indisponível (${ultimoErr.message}), tentando próximo da cascata...`);
    }
  }
  }

  // 3) ROTEADOR / OPENROUTER — última linha. qualquer gateway compatível com a
  //    API da OpenAI (LiteLLM próprio, OpenRouter, Together, vLLM...). só entra
  //    depois de Groq E Gemini falharem, então não compete cota com eles.
  try {
    const r = await chatRoteador(messages, opts);
    if (r) return r;
  } catch (e) {
    ultimoErr = e;
  }

  const err = ultimoErr || new Error('todos os provedores de IA falharam');
  // marca: Groq, Gemini E reserva caíram. quem chama (solver) usa isso pra
  // NÃO hacer 60s de espera "pra resetar token" — esperar não devolve cota,
  // e a questão já passou por todos os provedores.
  err.todosProvedores = true;
  throw err;
}

function optText(o) {
  if (o == null) return '';
  if (typeof o === 'string') return stripHtml(o);
  const cands = [o.value, o.text, o.label, o.content, o.title, o.statement, o.html];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return stripHtml(c);
    if (c && typeof c === 'object') {
      if (typeof c.pt === 'string') return stripHtml(c.pt);
      if (typeof c.default === 'string') return stripHtml(c.default);
    }
  }
  return stripHtml(JSON.stringify(o));
}

// resolve UMA questão -> { answer }. (shape final é validado em solver.js)
// callOpts: { tentativa (re-tentativa atual, p/ modo econômico), groqIndex (chave preferida) }
export async function solveQuestion(question, callOpts = {}) {
  const q = question || {};
  const type = q.type;
  const stmt = stripHtml(q.statement || q.question_statement || '');
  const chatBase = { tentativa: Number(callOpts.tentativa) || 1 };
  if (Number.isInteger(callOpts.groqIndex)) chatBase.groqIndex = callOpts.groqIndex;
  // re-tentativa = resposta ENXUTA (a tentativa detalhada já falhou; não queima token de novo)
  const modoDireto = chatBase.tentativa >= 2 ? '\n\n(MODO DIRETO: no máximo meia linha de análise e finalize JÁ com a linha final RESPOSTA/VERDICT.)' : '';

  if (type === 'info' || type === 'media') return { answer: null };

  // escolha única / múltipla
  if (type === 'single-choice' || type === 'single' || type === 'multiple-choice' || type === 'multi') {
    const opts = q.options || {};
    const keys = Object.keys(opts);
    if (!keys.length) return { answer: {} };
    const gabarito = keys.filter(k => opts[k] && opts[k].answer === true);
    if (gabarito.length) {
      const a = {}; for (const k of keys) a[k] = gabarito.includes(k);
      return { answer: a };
    }
    const items = keys.map(k => `${k}) ${optText(opts[k])}`).join('\n');
    const isSingle = (type === 'single-choice' || type === 'single');
    // ECONOMIA: justificativa curtíssima em vez de passo a passo longo 
    // corta a maior parte dos tokens de saída sem perder precisão.
    const sys = `Você é um especialista em provas escolares brasileiras. Resolva com rigor: em matemática faça as contas; em interpretação releia o texto. Justifique em NO MÁXIMO 1 linha curta por alternativa e conclua.`;
    const usr = `Enunciado: ${stmt}\n\nAlternativas:\n${items}\n\n${isSingle ? 'EXATAMENTE UMA está correta.' : 'UMA OU MAIS podem estar corretas.'}\n\nAo final, escreva OBRIGATORIAMENTE uma última linha exatamente neste formato:\nRESPOSTA: chave${isSingle ? '' : ' (ou chaves separadas por vírgula)'}\nusando apenas as chaves listadas (${keys.join(', ')}). NAO USE NEGRITO (**) NEM ASPAS NA RESPOSTA FINAL.${modoDireto}`;
    let correct = [];
    try {
      const j = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, temperature: 0.2, max_tokens: 1500 });
      const txt = j.choices?.[0]?.message?.content || '';
      const m = txt.match(/RESPOSTA:\s*([^\n]+)/gi);
      if (m && m.length) {
        let ultima = m[m.length - 1].replace(/RESPOSTA:\s*/i, '');
        ultima = ultima.replace(/[*`"']/g, ''); // remove markdown e aspas
        correct = ultima.split(/[,;\s]+/).map(s => s.trim()).filter(k => keys.includes(k));
      }
      // sem linha "RESPOSTA:" explícita => falha (sem varrer o texto procurando letra solta)
    } catch (e) {
      console.warn(`[ai] escolha: IA falhou (${e.message})`);
    }
    if (!correct.length) {
      console.warn(`[ai] escolha: modelo não devolveu resposta válida (sem chute, vai re-tentar)`);
      return { answer: null };
    }
    if (isSingle && correct.length > 1) correct = [correct[0]];
    const answer = {};
    for (const k of keys) answer[k] = correct.includes(k);
    return { answer };
  }

  // certo/errado por item
  if (type === 'true-false') {
    const opts = q.options || {};
    const keys = Object.keys(opts);
    if (!keys.length) return { answer: {} };
    const gabarito = keys.some(k => opts[k] && typeof opts[k].answer === 'boolean');
    if (gabarito) {
      const a = {}; for (const k of keys) a[k] = !!(opts[k] && opts[k].answer);
      return { answer: a };
    }
    const items = keys.map(k => `${k}) ${optText(opts[k])}`).join('\n');
    const sys = 'Você é um especialista em provas escolares brasileiras. Avalie cada afirmação como CERTA ou ERRADA. No máximo meia linha de análise por afirmação.';
    const usr = `Enunciado: ${stmt}\n\nAfirmações:\n${items}\n\nAnalise cada afirmação uma a uma. Ao final, escreva OBRIGATORIAMENTE uma última linha neste formato JSON:\nVERDICT: {"${keys[0]}": true, ...} com TODAS as chaves (${keys.join(', ')}), true=certa false=errada.${modoDireto}`;
    let verdict = null;
    try {
      const j = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, temperature: 0.2, max_tokens: 800 });
      const txt = j.choices?.[0]?.message?.content || '';
      const m = txt.match(/VERDICT:\s*(\{[^\n]*\})/i);
      if (m) verdict = safeJson(m[1]);
      if (!verdict) { const jm = txt.match(/\{[^{}]*\}/); if (jm) verdict = safeJson(jm[0]); }
    } catch (e) {
      console.warn(`[ai] true-false: IA falhou (${e.message})`);
      verdict = null;
    }
    if (!verdict) { console.warn('[ai] true-false: sem veredito do modelo (sem chute, vai re-tentar)'); return { answer: null }; }
    const answer = {};
    for (const k of keys) {
      const v = verdict[k] ?? verdict[String(k)];
      if (typeof v !== 'boolean') {
        console.warn(`[ai] true-false: veredito incompleto, faltou a chave ${k} (sem chute, vai re-tentar)`);
        return { answer: null };
      }
      answer[k] = v;
    }
    return { answer };
  }

  // cloud — ordenar palavras
  if (type === 'cloud') {
    const words = (q.options && (q.options.words || q.options.items || q.options.ids)) || [];
    const list = Array.isArray(words) ? words : Object.values(words);
    if (!list.length) return { answer: [] };
    const sys = 'Você é um especialista em provas escolares brasileiras de língua portuguesa. Ordene as palavras embaralhadas para formar uma frase coerente que responda ao enunciado. Responda APENAS JSON.';
    const usr = `Enunciado: ${stmt}\n\nPalavras embaralhadas (use TODAS, exatamente uma vez cada):\n${list.map((w, i) => `${i}) "${w}"`).join('\n')}\n\nRetorne JSON: {"ordem": ["palavra1", ...]} na ORDEM CORRETA. Use cada palavra exatamente como está (mesma capitalização e pontuação).`;
    let ordem = [];
    try {
      const j = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, json: true, temperature: 0.1, max_tokens: 1500 });
      const parsed = safeJson(j.choices?.[0]?.message?.content);
      if (parsed && Array.isArray(parsed.ordem)) ordem = parsed.ordem.map(String);
    } catch { /* ecoa */ }
    const pool = list.map(String);
    const usado = new Set();
    const final = [];
    for (const w of ordem) {
      const idx = pool.findIndex((p, i) => p === w && !usado.has(i));
      if (idx >= 0) { final.push(pool[idx]); usado.add(idx); continue; }
      const idxCi = pool.findIndex((p, i) => p.toLowerCase() === String(w).toLowerCase() && !usado.has(i));
      if (idxCi >= 0) { final.push(pool[idxCi]); usado.add(idxCi); continue; }
    }
    pool.forEach((p, i) => { if (!usado.has(i)) final.push(p); });
    return { answer: final };
  }

  // texto livre / dissertativa
  if (type === 'text' || type === 'text_ai' || type === 'text-ai' || type === 'free-text' || type === 'essay' || type === 'reflection') {
    const ctx = stmt || stripHtml(q.title || q.name) || 'Responda de forma reflexiva sobre o tema da aula.';
    // keywords/instruções precisam existir ANTES do bloco ehEssay (o usrEssay
    // da redação usa essas variáveis) — antes estavam só no texto curto, e a
    // redação crashava com ReferenceError (toda questão text_ai falhava).
    const keywords = Array.isArray(q.options?.ai_grading_keywords) ? q.options.ai_grading_keywords : [];
    // FORMATO por tipo: texto_ai/text/free-text = { 0: "texto" } — prova real:
    // tarefas avaliadas 10/10 gravam exatamente assim; mandar {title, body} num
    // text_ai deixa o editor da plataforma vazio (texto "não entra" na tarefa).
    // Redação de verdade (essay/reflection, ou tarefa marcada is_essay) exige
    // { title, body } — é o essay-check/grader que divide por essas chaves.
    const ehEssay = ['essay', 'reflection'].includes(type)
      || ['essay', 'reflection'].includes(String(q.rawType || '').trim())
      || callOpts?.ehRedacao === true;
    if (ehEssay) {
      const sysEssay = `Você é um aluno do ensino médio brasileiro escrevendo uma REDAÇÃO de prova online. Desenvolva o tema com introdução, desenvolvimento e conclusão, em 4 a 6 parágrafos coesos. Linguagem natural de estudante: simples, direta, sem floreios acadêmicos, sem bullet points, sem falar "em suma"/"portanto" repetidamente. Não copie nem repita o enunciado.`;
      const usrEssay = `Tema da redação: ${ctx}${keywords.length ? `\n\nConceitos que DEVEM aparecer: ${keywords.join(', ')}.` : ''}\n\nComece a resposta com o TÍTULO em uma única linha, depois uma linha em branco, depois os parágrafos.`;
      let text = '';
      for (let tentativa = 0; tentativa < 3; tentativa++) {
        try {
          const j = await chat([{ role: 'system', content: sysEssay }, { role: 'user', content: usrEssay }], { ...chatBase, temperature: 0.8, max_tokens: 4096 });
          text = (j.choices?.[0]?.message?.content || '').replace(/^["'`]+|["'`]+$/g, '').trim();
          if (text.length >= 120) break;
        } catch (e) {
          if (e.retryAfter && e.retryAfter < 30) await new Promise(r => setTimeout(r, e.retryAfter * 1000));
        }
      }
      if (!text || text.length < 60) {
        // Groq não entregou uma redação utilizável (raciocínio + 2048 tokens de
        // limite costuma truncar). penúltima cartada: Gemini EXCLUSIVO — a mesma
        // chave que tá resolvendo o captcha hoje, então tem cota.
        try {
          const jG = await chat([{ role: 'system', content: sysEssay }, { role: 'user', content: usrEssay }], { ...chatBase, temperature: 0.8, max_tokens: 2048, geminiOnly: true });
          text = (jG.choices?.[0]?.message?.content || '').replace(/^["'`]+|["'`]+$/g, '').trim();
          if (text.length >= 60) console.warn('[ai] redação: Groq não respondeu — Gemini de reserva assumiu');
        } catch (eG) { console.warn(`[ai] redação: Gemini de reserva falhou (${String(eG?.message || '').slice(0, 60)})`); }
      }
      if (!text || text.length < 60) {
        // última cartada: ROTEADOR (LiteLLM/OpenRouter). é a única cota que o
        // Groq e o Gemini ainda não tocaram nessa questão, então redigir por
        // ela é melhor do que deixar a tarefa pendente.
        try {
          const jR = await chat([{ role: 'system', content: sysEssay }, { role: 'user', content: usrEssay }], { ...chatBase, temperature: 0.8, max_tokens: 4096, reservaOnly: true });
          text = (jR.choices?.[0]?.message?.content || '').replace(/^["'`]+|["'`]+$/g, '').trim();
          if (text.length >= 60) console.warn('[ai] redação: Groq e Gemini falharam — ROTEADOR assumiu');
        } catch (eR) { console.warn(`[ai] redação: roteador falhou (${String(eR?.message || '').slice(0, 60)})`); }
      }
      if (!text || text.length < 60) {
        console.warn('[ai] redação: IA não produziu texto utilizável (sem chute, vai re-tentar)');
        return { answer: null };
      }
      const [titulo, ...resto] = text.split(/\n{2,}/).filter(s => s.trim());
      return { answer: { title: (titulo || 'Redação').slice(0, 300), body: (resto.join('\n\n') || text).slice(0, 8000) } };
    }
    const instructions = q.options?.ai_grading_instructions || '';
    const minChars = q.options?.min_text_count || 0;
    const maxChars = q.options?.max_text_count || 2000;
    const unit = q.options?.text_count_unit || 'char';
    const piso = Math.max(50, minChars);
    const teto = Math.min(200, maxChars);
    const targetChars = teto > piso ? Math.floor((piso + teto) / 2) : piso;

    const ctxLow = (ctx + ' ' + String(q.statement || '') + ' ' + String(q.title || '')).toLowerCase();
    const sinaisIngles = ['first conditional', 'second conditional', 'simple past', 'simple present', 'present perfect', 'present continuous', 'going to', 'phrasal verb', 'in english', 'write a sentence', 'write sentences', 'make sentences', 'complete the sentences', 'comparative', 'superlative', 'modal verb', 'reported speech', 'passive voice'];
    const sinaisEspanhol = ['en español', 'en espanol', 'pretérito', 'subjuntivo', 'escribe una', 'escribe un', 'condicional', 'presente de indicativo'];
    let idioma = 'pt';
    if (sinaisIngles.some(s => ctxLow.includes(s))) idioma = 'en';
    else if (sinaisEspanhol.some(s => ctxLow.includes(s))) idioma = 'es';
    const instrIdioma = idioma === 'en'
      ? ' ATENÇÃO: questão de INGLÊS. Escreva a resposta INTEIRA EM INGLÊS, com gramática correta, salvo se o enunciado pedir português.'
      : idioma === 'es'
      ? ' ATENCIÓN: pregunta de ESPAÑOL. Escribe la respuesta ENTERA EN ESPAÑOL, con gramática correcta.'
      : '';

    const sys = `Você é um estudante do ensino médio brasileiro fazendo uma prova online. Responde como quem bate a resposta rapidinho no teclado, um aluno esperto mas com preguiça de escrever. Resposta CURTA: 1-2 frases, sem enrolação, sem listar, sem título, sem repetir o enunciado, sem ficar justificando por alto. Vá direto à conclusão e à conta certa. Não use vocabulário rebuscado nem fórmulas decoradas demais - mostre a conta simples e pronto. Escreve como fala: curto, direto e com cara de gente, não de texto pronto.${instrIdioma}`;
    // varia o "jeito" de resposta ENTRE as questões da mesma tarefa: se todas
    // saírem com o mesmo tom, o detector de IA suspeita de texto pronto.
    const estilos = [
      'BEM SECO: so a resposta, do jeito que a pergunta quer, sem rodeio.',
      'DIGITANDO RAPIDO: comeca direto, ou com um "entao"/"bom", e termina logo.',
      'JEITO DE MENSAGEM: frase solta de conversa, pode usar "ne"/"tipo"/"ai".',
      'PRATICO: 1 frase so, sem explicar se a pergunta nao pedir explicacao.',
    ];
    const estilo = estilos[Math.floor(Math.random() * estilos.length)];

    let usr = `Pergunta: ${ctx}\n\n`;
    if (keywords.length) usr += `INCLUIR na resposta: ${keywords.map(k => `"${k}"`).join(', ')}.\n\n`;
    if (instructions) usr += `Criterios: ${stripHtml(instructions).slice(0, 800)}\n\n`;
    usr += `Exemplos de estilo (solto, curto e com cara de aluno):\n"a cada mes as reproducoes se quadriplicam, logo a razao e 4, logo e uma PG"\n"Sim, sempre. na PG a razao nao muda, entao b/a = c/b, logo b² = a·c. e isso que faz funcionar."\n\nAgora responda nesse mesmo estilo: 1 frase so (2 no maximo, so se a pergunta pedir explicacao), CURTA, direta, sem repetir o enunciado e SEM conectivo de texto pronto tipo "portanto", "dessa forma", "em resumo", "vale ressaltar".
MODO desta resposta:
${estilo}`;

    let text = '';
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      try {
        const j = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, temperature: 0.9, max_tokens: 1500 });
        text = (j.choices?.[0]?.message?.content || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^(resposta|r|texto|aluno|resp)\s*[:\-—]\s*/i, '').trim();
        if (keywords.length) {
          const lower = text.toLowerCase();
          const hits = keywords.filter(k => lower.includes(String(k).toLowerCase())).length;
          if (text.length >= Math.max(8, minChars) && hits >= Math.ceil(keywords.length * 0.7)) break;
        } else if (text.length >= Math.max(8, minChars)) break;
      } catch (e) {
        if (e.retryAfter && e.retryAfter < 30) await new Promise(r => setTimeout(r, e.retryAfter * 1000));
      }
    }
    if (!text || text.trim().length < 8) {
      // mesma limitação do gpt-oss (raciocínio estoura o max_tokens curto) —
      // antes de desistir, tenta Gemini exclusivo uma vez.
      try {
        const jG = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, temperature: 0.9, max_tokens: 500, geminiOnly: true });
        text = (jG.choices?.[0]?.message?.content || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^(resposta|r|texto|aluno|resp)\s*[:\-—]\s*/i, '').trim();
        if (text.trim().length >= 8) console.warn('[ai] texto: Groq não respondeu — Gemini de reserva assumiu');
      } catch (eG) { console.warn(`[ai] texto: Gemini de reserva falhou (${String(eG?.message || '').slice(0, 60)})`); }
    }
    if (!text || text.trim().length < 8) {
      // último recurso: ROTEADOR (LiteLLM/OpenRouter), com a mesma instrução
      // curta — inclusive os keywords de grading, senão a resposta de reserva
      // fica sem os termos que o corretor automático exige.
      try {
        const jR = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, temperature: 0.9, max_tokens: 1500, reservaOnly: true });
        text = (jR.choices?.[0]?.message?.content || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^(resposta|r|texto|aluno|resp)\s*[:\-—]\s*/i, '').trim();
        if (text.trim().length >= 8) console.warn('[ai] texto: Groq e Gemini falharam — ROTEADOR assumiu');
      } catch (eR) { console.warn(`[ai] texto: roteador falhou (${String(eR?.message || '').slice(0, 60)})`); }
    }
    if (!text || text.trim().length < 8) {
      console.warn('[ai] texto: IA não produziu resposta utilizável (sem chute, vai re-tentar)');
      return { answer: null };
    }
    if (maxChars && text.length > maxChars) text = text.slice(0, maxChars - 1) + '.';
    return { answer: { 0: text } };
  }

  // fill-letters
  if (type === 'fill-letters') {
    // gabarito embutido (quando a plataforma vaza) tem prioridade — não é chute.
    // referência (saladopassado/app.py) envia STRING simples, não { answer }.
    const embutido = typeof q.options?.answer === 'string' ? q.options.answer : '';
    if (embutido) return { answer: embutido };
    const sys = 'Responda APENAS com a palavra/sequencia que preenche, sem nada mais.';
    const usr = `Complete: ${stmt}`;
    try {
      const j = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, max_tokens: 100 });
      const text = String(j.choices?.[0]?.message?.content || '').trim();
      // gpt-oss às vezes vaza raciocínio junto ("A resposta é F4KR5"): extrai o
      // token alfanumérico, preferindo o que tem o tamanho EXATO da lacuna.
      const tokens = (text.match(/[A-Za-z0-9]+/g) || []).filter(t => /[A-Za-z0-9]/.test(t));
      const n = Number(q.options?.letters) || 0;
      const palavra = (n ? tokens.filter(t => t.length === n)[0] : undefined)
        || tokens.slice().sort((a, b) => b.length - a.length)[0] || '';
      if (!palavra) return { answer: null };
      return { answer: palavra };
    } catch { return { answer: null }; }
  }

  // order-sentences (gabarito embutido em options.sentences)
  if (type === 'order-sentences') {
    const sents = q.options?.sentences || [];
    const incs = q.options?.incorrects || [];
    const norm = s => stripHtml(String(s == null ? '' : (s.value ?? s.text ?? s))).toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '');
    const incById = new Map();
    for (const it of incs) if (it && it.id) incById.set(norm(it.value ?? it.text ?? it), it.id);
    const usados = new Set();
    const order = [];
    for (const s of sents) {
      const id = incById.get(norm(s));
      if (id && !usados.has(id)) { usados.add(id); order.push(id); }
      else {
        const livre = incs.find(it => it && it.id && !usados.has(it.id));
        if (livre) { usados.add(livre.id); order.push(livre.id); }
      }
    }
    for (const it of incs) if (it && it.id && !usados.has(it.id)) { order.push(it.id); usados.add(it.id); }
    return { answer: order };
  }

  // fill-words
  if (type === 'fill-words') {
    const phrase = q.options?.phrase || [];
    const pool = Array.isArray(q.options?.items) ? q.options.items : [];
    const isBlank = (slot) => (typeof slot === 'string' && /^[_…\s]+$/.test(slot))
      || (slot && (slot.type === 'select' || slot.type === 'input' || slot.type === 'blank' || slot.type === 'gap' || slot.answer != null));
    let blankIdx = 0;
    const blankPositions = [];
    const humanPhrase = phrase.map((slot) => {
      if (isBlank(slot)) { const m = `__SLOT_${blankIdx}__`; blankPositions.push(blankIdx); blankIdx++; return m; }
      return typeof slot === 'string' ? slot : (slot?.value ?? '');
    }).join('');
    let sys, usr;
    // IMPORTANTE: sempre que houver banco de palavras, mandar o banco no prompt —
    // o validador (validateShape) exige palavra EXATA do banco, então sem a lista
    // o modelo responde sinônimos fora do banco e a tentativa é rejeitada (era o
    // que fazia o fill-words gastar as 8 tentativas e virar rascunho).
    if (pool.length) {
      sys = 'Você é um especialista em provas escolares brasileiras. Preencha cada lacuna __SLOT_N__ com UMA das palavras do banco. Responda APENAS JSON.';
      usr = `Contexto: ${stmt}\n\nFrase com lacunas:\n${humanPhrase}\n\nBanco (use EXATAMENTE estas palavras, sem repetir):\n${pool.map((w, i) => `${i}) ${w}`).join('\n')}\n\nLacunas: ${blankPositions.length}\n\nRetorne JSON: {"fills": [...]} na ordem das lacunas.`;
    } else {
      sys = 'Você é um especialista em provas escolares brasileiras. Preencha cada lacuna __SLOT_N__ com a palavra correta. Responda APENAS JSON.';
      usr = `Contexto: ${stmt}\n\nFrase com lacunas:\n${humanPhrase}\n\nLacunas: ${blankPositions.length}\n\nRetorne JSON: {"fills": [...]} com uma palavra por lacuna, na ordem.`;
    }
    let fills = [];
    // o prompt pede {"fills":[...]}, mas o modelo às vezes devolve o array puro,
    // ou outra chave ("answer"/"palavras"/"respostas"). antes disso era tudo
    // descartado e a tentativa virava {answer:null} — o solver gastava as 8
    // tentativas com uma resposta que estava CORRETA na tela.
    const extraiArray = (o) => {
      if (Array.isArray(o)) return o;
      if (!o || typeof o !== 'object') return null;
      for (const k of ['fills', 'answer', 'answers', 'palavras', 'respostas', 'words', 'resposta']) {
        if (Array.isArray(o[k])) return o[k];
      }
      return null;
    };
    try {
      const j = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, json: true, temperature: 0.1, max_tokens: 1500 });
      const arr = extraiArray(safeJson(j.choices?.[0]?.message?.content));
      if (arr) fills = arr.map(s => String(s ?? '').trim()).filter(s => s.length > 0);
    } catch { /* solver.js re-tenta */ }
    if (!fills.length) {
      console.warn('[ai] fill-words: modelo não devolveu preenchimentos (sem chute, vai re-tentar)');
      return { answer: null };
    }
    // com banco: se o modelo devolveu palavra fora do banco, avisa no log (o
    // validateShape vai rejeitar e o solver re-tenta — assim dá pra ver por quê).
    if (pool.length) {
      const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const set = new Set(pool.map(norm));
      const fora = fills.filter(f => !set.has(norm(f)));
      if (fora.length) console.warn(`[ai] fill-words: ${fora.length} palavra(s) fora do banco (${fora.map(f => `"${f}"`).join(', ')}) — vai re-tentar`);
    }
    return { answer: fills };
  }

  return { answer: null };
}

// ============================================================
//  VERIFICAÇÃO PÓS-RESOLUÇÃO — auto-correção antes de enviar.
//
//  Depois de o bot responder TODAS as questões da tarefa, ele pega perguntas +
//  respostas e manda (preso à SUA chave do Gemini) conferir se acertou. O Gemini
//  responde "sim" se tudo certo; senão devolve o gabarito de cada questão errada
//  e o bot se ajusta ANTES do envio. devolve { [qid]: <answer corrigido> }.
// ============================================================

// chaves de verdade escolhidas pelo bot num objeto de booleans (choice/true-false)
function botKeys(a) {
  if (!a || typeof a !== 'object') return [];
  return Object.keys(a).filter(k => a[k] === true);
}

// resposta do bot em texto legível pro corretor — null para tipos sem gabarito
// determinístico (dissertativa/info), que a verificação pula.
function botAnswerText(t, q, a) {
  if (t === 'single' || t === 'single-choice' || t === 'multi' || t === 'multiple-choice') {
    const k = botKeys(a);
    return k.length ? `resposta do bot = ${k.join(', ')}` : null;
  }
  if (t === 'true-false') {
    if (!a || typeof a !== 'object') return null;
    const parts = Object.keys(a).map(k => `${k}) ${a[k] === true ? 'CERTA' : 'ERRADA'}`);
    return `resposta do bot = ${parts.join('; ')}`;
  }
  if (t === 'fill-letters') {
    const v = typeof a === 'string' ? a : String((a && (a.answer ?? a[0])) || '').trim();
    return v ? `resposta do bot = "${v}"` : null;
  }
  if (t === 'fill-words') return Array.isArray(a) && a.length ? `resposta do bot = ${a.map(s => `"${s}"`).join(', ')}` : null;
  if (t === 'cloud') return Array.isArray(a) && a.length ? `resposta do bot (ordem) = ${a.map(s => `"${s}"`).join(' → ')}` : null;
  if (t === 'order-sentences') return Array.isArray(a) && a.length ? `resposta do bot (ordem de ids) = ${a.join(', ')}` : null;
  return null; // dissertativa / info / media não entram
}

// valida e normaliza UMA correção do Gemini pro shape final (mesmo de validateShape).
function normalizeCorrection(t, q, c) {
  if (c == null || c === '') return null;
  try {
    // choice / true-false — objeto de booleans (ou string com as chaves)
    if (t === 'single' || t === 'single-choice' || t === 'multi' || t === 'multiple-choice' || t === 'true-false') {
      const opts = q.options || {};
      const keys = Object.keys(opts);
      if (!keys.length) return null;
      let obj = {};
      if (typeof c === 'string') {
        const picks = c.split(/[,;\s]+/).map(s => s.trim()).filter(k => keys.includes(k));
        if (!picks.length) return null;
        for (const k of keys) obj[k] = picks.includes(k);
      } else if (c && typeof c === 'object') {
        for (const k of keys) {
          const raw = c[k] ?? c[String(k)];
          if (typeof raw === 'boolean') obj[k] = raw;
          else if (typeof raw === 'string' && (raw.toLowerCase() === 'true' || raw.toLowerCase() === 'false')) obj[k] = raw.toLowerCase() === 'true';
          else return null;
        }
      } else return null;
      const trues = keys.filter(k => obj[k]).length;
      if ((t === 'single' || t === 'single-choice') && trues !== 1) return null;
      if ((t === 'multi' || t === 'multiple-choice') && trues < 1) return null;
      return obj;
    }
    // fill-letters — formato final é STRING simples (referência app.py)
    if (t === 'fill-letters') {
      let v = '';
      if (typeof c === 'string') v = c;
      else v = String(c.answer ?? c[0] ?? c.word ?? c.text ?? '').trim();
      const limpa = v.replace(/[\s_·•\-]/g, '');
      if (!limpa) return null;
      const n = Number(q.options?.letters) || 0;
      if (n && limpa.length !== n) return null;
      return limpa;
    }
    // fill-words — array com as lacunas na ordem
    if (t === 'fill-words') {
      if (!Array.isArray(c)) return null;
      const phrase = q.options?.phrase || [];
      const isBlank = s => (typeof s === 'string' && /^[_…\s]+$/.test(s))
        || (s && (s.type === 'select' || s.type === 'input' || s.type === 'blank' || s.type === 'gap' || s.answer != null));
      const N = phrase.filter(isBlank).length;
      const vals = c.slice(0, N).map(s => String(s ?? '').trim());
      if (N && vals.length < N) return null;
      const pool = Array.isArray(q.options?.items) ? q.options.items : [];
      if (pool.length) {
        const byLower = new Map(pool.map(p => [String(p).toLowerCase(), String(p)]));
        const usadas = new Set();
        const out = new Array(N).fill(null);
        for (let i = 0; i < N; i++) {
          const orig = byLower.get(vals[i].toLowerCase());
          if (!orig || usadas.has(orig.toLowerCase())) return null;
          out[i] = orig; usadas.add(orig.toLowerCase());
        }
        return out;
      }
      if (!vals.length || vals.some(s => !s)) return null;
      return vals;
    }
    // cloud — array de palavras na ordem correta
    if (t === 'cloud') {
      if (!Array.isArray(c) || !c.length) return null;
      return c.map(String);
    }
    // order-sentences — array de ids na ordem correta
    if (t === 'order-sentences') {
      if (!Array.isArray(c) || !c.length) return null;
      return c.map(String);
    }
  } catch { /* correção inválida → ignora */ }
  return null;
}

// confere todas as respostas da tarefa com o Gemini (chamado DENTRO de
// withApiKey da tarefa, então cada tarefa usa a SUA chave) e devolve as correções.
export async function verifyAnswers(questions, answers, opts = {}) {
  const chatBase = {};
  if (Number.isInteger(opts.groqIndex)) chatBase.groqIndex = opts.groqIndex;

  const bloco = [];
  for (const q of questions) {
    const a = answers[q.id];
    if (!a) continue;
    const bot = botAnswerText(q.type, q, a);
    if (bot == null) continue; // pula info/media/dissertativa
    const stmt = stripHtml(q.statement || q.question_statement || '');
    const optsQ = q.options || {};
    const keys = (q.type === 'single' || q.type === 'single-choice' || q.type === 'multi' || q.type === 'multiple-choice' || q.type === 'true-false')
      ? Object.keys(optsQ) : [];
    const gab = keys.filter(k => optsQ[k] && optsQ[k].answer === true);
    let blk = `\n[Questão ${q.id} — ${q.type}]\nEnunciado: ${stmt}\n`;
    if (keys.length) blk += `Alternativas:\n${keys.map(k => `${k}) ${optText(optsQ[k])}`).join('\n')}\n`;
    if (gab.length) blk += `(gabarito conhecido: ${gab.join(', ')})\n`;
    blk += `${bot}\n`;
    bloco.push(blk);
  }

  if (!bloco.length) return {};

  const sys = 'Você é um corretor de provas escolares brasileiras extremamente preciso. Receberá perguntas com a resposta marcada pelo bot. Confira se cada uma está CORRETA. Responda SOMENTE JSON, sem markdown, sem explicação.';
  const usr = `Confira cada questão abaixo e a resposta marcada pelo bot.\n\nResponda EXATAMENTE neste formato JSON:\n- se TODAS estiverem corretas: {"resultado":"sim"}\n- se ALGUMA estiver errada: {"resultado":"nao","correcoes":{"<id_questao>": <correção>}}\n\nFormato da <correção> por tipo:\n- single/single-choice → {"A":true,"B":false,...} com EXATAMENTE um true\n- multi/multiple-choice → {"A":true,"B":false,...} com UM OU MAIS true\n- true-false → {"A":true,"B":false,...} cobrindo todas as alternativas\n- fill-letters → {"answer":"palavra"}\n- fill-words → ["palavra1","palavra2",...] na ordem das lacunas (somente palavras do banco, sem repetir)\n- cloud → ["palavra1","palavra2",...] na ordem correta\n- order-sentences → ["id1","id2",...] na ordem correta\n\nInclua em "correcoes" APENAS as questões que o bot ERROU (nunca as corretas). Se houver "gabarito conhecido", use-o como verdade.\n\nQuestões:\n${bloco.join('\n')}`;

  try {
    const j = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { ...chatBase, json: true, temperature: config.verify.temperature, max_tokens: 1600 });
    const parsed = safeJson(j.choices?.[0]?.message?.content);
    if (!parsed) return {};
    if (parsed.resultado === 'sim') return {};
    const corr = parsed.correcoes || {};
    if (!Object.keys(corr).length) return {};
    const out = {};
    for (const q of questions) {
      const c = corr[q.id];
      if (c == null) continue;
      const norm = normalizeCorrection(q.type, q, c);
      if (norm != null) out[q.id] = norm;
    }
    if (Object.keys(out).length) {
      console.warn(`[ai] verificador Gemini: ${Object.keys(out).length} questão(ões) corrigida(s) antes do envio`);
    }
    return out;
  } catch (e) {
    console.warn(`[ai] verificador Gemini falhou (${e.message}); segue sem correção`);
    return {};
  }
}

// ============================================================
//  TAXA DE ACERTOS ("erro de propósito" pós-verificação)
//
//  Com base no hitRate configurado pela pessoa (0–100), o bot ERRA DE PROPÓSITO
//  um número calculado de questões — mas NUNCA as dissertativas (texto/escrita),
//  só as de correção automática. O erro é "bem inspirado": parece que o aluno
//  tentou e se confundiu (alternativa plausível, troca de ordem, item invertido…),
//  mantendo a resposta sempre válida pro shape da plataforma.
//
//  devolve { [qid]: <answer errado mas plausível> } — o chamador aplica.
// ============================================================

const TIPOS_CORRIGIVEIS = new Set([
  'single', 'single-choice', 'multi', 'multiple-choice', 'true-false',
  'fill-letters', 'fill-words', 'cloud', 'order-sentences',
]);
const TIPOS_ESCRITA = new Set([
  'text', 'text_ai', 'text-ai', 'free-text', 'essay', 'reflection',
]);

function ehCorrigivel(t) { return TIPOS_CORRIGIVEIS.has(t); }
function ehEscrita(t) { return TIPOS_ESCRITA.has(t); }

// embaralha um array in-place (Fisher-Yates) e devolve.
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// transforma a resposta CORRETA numa resposta ERRADA mas plausível, por tipo.
// a = answers[qid].answer (shape já validado). devolve o shape errado ou null.
function flipToWrong(t, q, a) {
  if (t === 'single' || t === 'single-choice') {
    const opts = q.options || {};
    const keys = Object.keys(opts);
    if (keys.length < 2 || !a || typeof a !== 'object') return null;
    const erradas = keys.filter(k => !a[k]); // opções que NÃO são a certa
    if (!erradas.length) return null;
    const escolhida = erradas[Math.floor(Math.random() * erradas.length)]; // aluno "se convenceu" de uma errada
    const obj = {}; for (const k of keys) obj[k] = (k === escolhida);
    return obj;
  }
  if (t === 'multi' || t === 'multiple-choice') {
    const opts = q.options || {};
    const keys = Object.keys(opts);
    if (keys.length < 2 || !a || typeof a !== 'object') return null;
    const certas = keys.filter(k => a[k]);
    const erradas = keys.filter(k => !a[k]);
    if (!certas.length || !erradas.length) return null;
    const obj = { ...a };
    // aluno marca uma errada a mais e esquece de marcar uma certa (plausível)
    obj[erradas[Math.floor(Math.random() * erradas.length)]] = true;
    obj[certas[Math.floor(Math.random() * certas.length)]] = false;
    return obj;
  }
  if (t === 'true-false') {
    if (!a || typeof a !== 'object') return null;
    const keys = Object.keys(a);
    if (!keys.length) return null;
    const k = keys[Math.floor(Math.random() * keys.length)];
    return { ...a, [k]: !a[k] }; // inverte um item
  }
  if (t === 'fill-letters') {
    // palavra certa com exatamente 1 letra trocada (erro de digitação plausível)
    const w = typeof a === 'string' ? a : String((a && (a.answer ?? a[0])) || '').trim();
    if (w.length < 2) return null;
    const letras = 'abcdefghijklmnopqrstuvwxyz';
    const i = Math.floor(w.length / 2); // letra do meio
    const alvo = w[i].toLowerCase();
    let nova = alvo;
    while (nova === alvo) nova = letras[Math.floor(Math.random() * letras.length)];
    const arr = w.split('');
    arr[i] = /[A-Z]/.test(w[i]) ? nova.toUpperCase() : nova;
    return typeof a === 'string' ? arr.join('') : { answer: arr.join('') };
  }
  if (t === 'fill-words') {
    if (!Array.isArray(a) || a.length < 2) return null;
    const arr = a.slice();
    const i = Math.floor(Math.random() * (arr.length - 1));
    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; // troca duas lacunas vizinhas
    return arr;
  }
  if (t === 'cloud') {
    if (!Array.isArray(a) || a.length < 2) return null;
    const arr = a.slice();
    const i = Math.floor(Math.random() * (arr.length - 1));
    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; // ordem errada (par vizinho)
    return arr;
  }
  if (t === 'order-sentences') {
    if (!Array.isArray(a) || a.length < 2) return null;
    const arr = a.slice();
    const i = Math.floor(Math.random() * (arr.length - 1));
    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; // ordem errada (par vizinho)
    return arr;
  }
  return null;
}

// decide quantas questões errar e quais, aplicando o erro plausível.
// hitRate em % (0–100). null/100 = não erra nada (tudo certo, sem mudança).
export function intentionalMisses(questions, answers, hitRate) {
  // ausência de config = default 100% (resolve tudo certo, nada muda)
  if (hitRate == null || hitRate === '') return {};
  const r = Number(hitRate);
  if (!Number.isFinite(r)) return {};
  const alvo = Math.max(0, Math.min(100, r));

  // só entram as corrigíveis (exclui dissertativa/escrita e info/media)
  const corrigiveis = [];
  for (const q of questions) {
    const a = answers[q.id];
    if (!a) continue;
    if (ehCorrigivel(q.type) && !ehEscrita(q.type) && a.answer != null) corrigiveis.push(q);
  }
  if (!corrigiveis.length) return {};

  const total = corrigiveis.length;
  const acertos = Math.round((alvo / 100) * total);          // nº de certas desejado
  const erros = Math.max(0, total - acertos);                // nº a errar
  if (erros <= 0) return {};

  const sorteadas = shuffle(corrigiveis.slice()).slice(0, erros);
  const out = {};
  for (const q of sorteadas) {
    const troca = flipToWrong(q.type, q, answers[q.id].answer);
    if (troca != null) out[q.id] = troca;
  }
  return out;
}

// ============================================================
//  CAPTCHA via GROQ (visão) — sem navegador, sem OCR local
// ============================================================
const CAPTCHA_OCR_TIMEOUT_MS = 40_000;

// tamanho esperado do CAPTCHA da edusp (FIXO em 5 caracteres). se a plataforma
// mudar, ajusta via CAPTCHA_LENGTH no .env (aceita 4-12).
const CAPTCHA_LEN = (() => {
  const v = Number(process.env.CAPTCHA_LENGTH);
  return Number.isInteger(v) && v >= 4 && v <= 12 ? v : 5;
})();

// alfabeto REAL do captcha da Edusp: só letras a-z e dígitos 2-9 — NUNCA 0
// (zero) nem 1 (um). instruir isso no prompt corta a "alucinação" de 0/O/1/l/I.
function charValido(ch) {
  return /[2-9a-zA-Z]/.test(ch);
}

const CAPTCHA_PROMPT = `Você é um leitor de CAPTCHA da plataforma Sala do Futuro (Edusp).

A imagem é um CAPTCHA de EXATAMENTE 5 caracteres. Os únicos caracteres possíveis são letras de A a Z e dígitos de 2 a 9. NUNCA aparecem 0 (zero), 1 (um) nem símbolos.

Leia os caracteres da esquerda para a direita, exatamente como aparecem na imagem.

REGRAS:
- Retorne APENAS os 5 caracteres, sem espaços, sem pontuação, sem aspas, sem explicação.
- 0 (zero) NÃO existe aqui — o que parece zero é a letra O.
- 1 (um) NÃO existe aqui — o que parece um pode ser l (letra L minúscula) ou I.
- Se um caractere estiver distorcido, faça a melhor leitura visual do formato do traço.
- O código tem SEMPRE 5 caracteres.

Saída: somente o código, sem nada mais.`;

// leitor Groq de visão: qwen3.6-27b lê imagens de graça (cota das MESMAS chaves
// Groq da resolução, então não queima cota Gemini). cada leitura = 1 candidata.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
const CAPTCHA_GROQ_TIMEOUT_MS = Number(process.env.CAPTCHA_GROQ_TIMEOUT_MS) || 22_000;
const CAPTCHA_GROQ_TENTATIVAS = Math.max(1, Math.min(4, Number(process.env.CAPTCHA_GROQ_TENTATIVAS) || 2));

// limpa a saída de qualquer leitor de OCR (só letras/dígitos, máx 12).
function limparLeituraOcr(raw) {
  return String(raw || '').trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
}

function timeoutReject(ms, rotulo) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${rotulo}`)), ms));
}

async function lerGroqVisao(base64, mime = 'image/png', deadline = Infinity) {
  if (!groqKeys.length || !base64) return null;
  if (Date.now() >= deadline) return null; // respeita o orçamento global
  const idx = escolherGroq();
  if (idx == null) return null;
  const chamar = async () => {
    const r = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${groqKeys[idx]}`,
      },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: CAPTCHA_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        }],
        temperature: 0,
        max_tokens: 128,
        // qwen3.6-27b pensa por padrão e vaza o raciocínio no content
        // ("thinkTheuser..."), estragando a leitura — força modo sem raciocínio.
        reasoning_effort: 'none',
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      const err = new Error(j?.error?.message || `groq-vision ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return limparLeituraOcr(j?.choices?.[0]?.message?.content || '') || null;
  };
  try {
    return await Promise.race([chamar(), timeoutReject(CAPTCHA_GROQ_TIMEOUT_MS, 'groq-vision')]);
  } catch (e) {
    if (e?.status === 429) {
      const espera = retrySegundos(e.message) ?? 60;
      const diario = pareceLimiteDiario(e.message) || espera > 1800;
      GROQ_BLOCKED_UNTIL[idx] = diario ? proximaMeiaNoiteUTC() : Date.now() + espera * 1000;
      console.warn(`[captcha-ocr] chave Groq #${idx + 1} ${diario ? 'BATEU LIMITE DIÁRIO (visão)' : `pausada ${espera}s (visão)`} — segue nas outras chaves`);
    } else if (e?.status === 503 || e?.status === 500) {
      GROQ_BLOCKED_UNTIL[idx] = Date.now() + 20_000;
      console.warn(`[captcha-ocr] Groq #${idx + 1} sobrecarregada (${e?.status}) — pausada 20s`);
    } else {
      console.warn(`[captcha-ocr] groq-vision indisponível (${e?.message})`);
    }
    return null;
  }
}

export async function solveCaptchaImage(base64Image, mimeType = 'image/png', cfg = {}) {
  if (!base64Image) throw new Error('CAPTCHA sem imagem');
  if (!groqKeys.length) throw new Error('Nenhuma chave Groq configurada para o CAPTCHA');

  const deadline = Date.now() + CAPTCHA_OCR_TIMEOUT_MS;
  const leituras = [];
  const vistas = new Set();
  let ultimoErro = null;

  // entrega já para o relay da edusp (onCandidata) e guarda para o retorno.
  const entregar = (val, origem) => {
    const v = limparLeituraOcr(val);
    if (!v || v.length !== CAPTCHA_LEN) return false;
    for (const ch of v) if (!charValido(ch)) return false;
    const chave = v.toLowerCase();
    if (vistas.has(chave)) return false;
    vistas.add(chave);
    leituras.push({ val: v, origem });
    console.log(`[captcha-ocr] candidata (${origem}): "${v}"`);
    if (cfg.onCandidata) { try { cfg.onCandidata(v, 100, origem); } catch { /* ignora */ } }
    return true;
  };

  const ler = async (b64, mime, rotulo) => {
    if (Date.now() >= deadline) return;
    const val = await lerGroqVisao(b64, mime, deadline);
    if (val) entregar(val, rotulo);
    else ultimoErro = ultimoErro || new Error('Groq retornou leitura vazia');
  };

  // 1ª leitura: imagem original (a que o Groq mais acerta).
  let tentativas = 1;
  await ler(base64Image, mimeType, 'groq');

  // Se ainda houver fôlego, lê variantes processadas (contraste/upscale/binário)
  // como 2ª/3ª candidatas — o relay da edusp verifica cada uma na hora.
  if (Date.now() < deadline && tentativas < CAPTCHA_GROQ_TENTATIVAS) {
    let variantes = [];
    try {
      variantes = processarVariantes(base64Image, mimeType);
    } catch (e) {
      console.warn(`[captcha-img] variantes falharam (${e?.message}) — usando só a original`);
    }
    // índices: 0 original, 1 contraste, 2 contraste2x, 3 contraste3x,
    // 4 contraste4x, 5 contraste5x, 6 binário3x. começa pelas mais legíveis.
    for (const i of [3, 6, 4, 2, 1, 5]) {
      if (Date.now() >= deadline || tentativas >= CAPTCHA_GROQ_TENTATIVAS) break;
      const v = variantes[i];
      if (!v?.base64) continue;
      tentativas++;
      await ler(v.base64, v.mimeType || 'image/png', `groq-var${i}`);
    }
  }

  if (!leituras.length) throw ultimoErro || new Error('Groq não conseguiu ler o CAPTCHA');
  return leituras.map(l => l.val);
}
