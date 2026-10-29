// camada edusp — turmas, tarefas, apply, submit.
// portado de js/api.js. token e nick passam por parâmetro (sem localStorage).
import { jfetch, httpRaw, pareceCloudflare, marcarCloudflare, bloqueadoCloudflare, aguardarCloudflare } from './http.js';
import { EDUSP, config } from './config.js';
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================
//  ARQUIVO DE CAPTCHAS RESOLVIDOS — toda vez que um captcha é
//  resolvido (IA ou humano), a imagem + resposta são gravadas na
//  pasta captchas/ com o formato já existente:
//      captcha.png  ->  Respostas captcha.txt:  captcha  = FPSUZ
//      captcha3.png ->                          captcha3 = 36GuM
//  serve pra conferir, treinar/refinar leituras ou debugar.
// ============================================================
const CAPTCHAS_DIR = join(import.meta.dirname, '..', 'captchas');
const RESPOSTAS_FILE = join(CAPTCHAS_DIR, 'Respostas captcha.txt');

// descobre o próximo índice livre (captcha.png = #0, captcha1.png = #1, ...)
function proximoIndiceCaptcha() {
  let n = 0;
  try {
    for (const f of readdirSync(CAPTCHAS_DIR)) {
      const m = /^captcha(\d*)\.png$/i.exec(f);
      if (m) {
        const i = m[1] === '' ? 0 : Number(m[1]);
        if (i >= n) n = i + 1;
      }
    }
  } catch { /* pasta ainda não existe */ }
  return n;
}

export function salvarCaptchaResolvido(imageBase64, answer, origem = 'ia') {
  try {
    if (!imageBase64 || !answer) return;
    if (!existsSync(CAPTCHAS_DIR)) mkdirSync(CAPTCHAS_DIR, { recursive: true });
    const n = proximoIndiceCaptcha();
    const lab = n === 0 ? 'captcha' : `captcha${n}`;
    const nome = n === 0 ? 'captcha.png' : `captcha${n}.png`;
    writeFileSync(join(CAPTCHAS_DIR, nome), Buffer.from(imageBase64, 'base64'));
    // a procedência vai junto da resposta: sem isso todo captcha ficava
    // registrado como "IA" e não dava pra saber QUAL leitor resolveu — foi o que
    // deixou o groq/lens invisíveis no histórico.
    const tag = String(origem || 'ia').trim() || 'ia';
    appendFileSync(RESPOSTAS_FILE, `${lab} = ${String(answer).trim()} (${tag})\n`, 'utf8');
    console.log(`[captcha-save] ${tag} resolveu e salvou ${nome} = "${answer}"`);
  } catch (e) {
    console.error(`[captcha-save] falha ao gravar captcha resolvido: ${e?.message}`);
  }
}

// headers de navegador real (mesmo padrão do client web oficial)
const BROWSER = {
  accept: 'application/json',
  'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  origin: 'https://saladofuturo.educacao.sp.gov.br',
  referer: 'https://saladofuturo.educacao.sp.gov.br/',
};

// headers edusp — token vai no x-api-key
function H(token, extra = {}) {
  return {
    ...BROWSER,
    'content-type': 'application/json',
    'x-api-realm': 'edusp',
    'x-api-platform': 'webclient',
    'x-api-key': token || '',
    ...extra,
  };
}

// resolve um CAPTCHA de imagem da edusp e devolve o token já VALIDADO.
//
// FLUXO:
//  1. pede um challenge (imagem + challengeId) — sempre FRESCO, no momento do uso.
//  2. a IA tenta ler. se ler, verifica. se acertar → token pronto.
//  3. se a IA não lê: tenta novamente com imagem fresca, sem parar, até acertar.
//     NÃO há fallback humano — o bot persiste até resolver sozinho.
//
// retorna { token, challengeId } OU lança erro apenas em Cloudflare bloqueio.
export async function bypassCaptcha(token, debugCallback = null, humanCallback = null, opts = {}) {
  const { solveCaptchaImage } = await import('./ai.js');
  const MAX_ATTEMPTS = 0; // 0 = infinite (retry until success, cancelable via opts.deveCancelar)

  // headers para captcha (usa proxy se configurado)
  const captchaHeaders = {
    'content-type': 'application/json',
    'x-api-realm': 'edusp',
    'x-api-platform': 'webclient',
    'x-api-key': token || '',
  };

  // valida uma resposta para um challenge. devolve { valid, token } ou lança
  // em erro HTTP (ex.: context_mismatch 401). se o Cloudflare começar a
  // bloquear a API, reconhece a página de challenge e lança erro LIMPO.
  async function verificar(challengeId, answer) {
    await aguardarCloudflare(15_000);
    const verifyPayload = {
      type: "image",
      realm: "edusp",
      payload: { challengeId, answer }
    };
    console.log(`[captcha] Enviando verify:`, JSON.stringify(verifyPayload));
    const raw = await httpRaw(`${EDUSP}/captcha/verify`, {
      method: 'POST',
      headers: captchaHeaders,
      body: JSON.stringify(verifyPayload)
    });
    const rawText = raw.text;
    if (raw.isCloudflare || pareceCloudflare(rawText)) {
      marcarCloudflare();
      const err = new Error('Cloudflare bloqueou a API no verify (Just a moment)');
      err.status = 0;
      err.cause = 'cloudflare_block';
      throw err;
    }
    let verify;
    try { verify = JSON.parse(rawText); } catch { verify = { message: rawText }; }
    if (raw.status < 200 || raw.status >= 300) {
      console.error(`[captcha] Detalhes do erro:`, String(rawText).slice(0, 250));
      const err = new Error(verify?.message || verify?.error || `verify ${raw.status}`);
      err.status = raw.status;
      err.cause = verify?.errors?.[0]?.cause || verify?.errors?.[0]?.field || '';
      throw err;
    }
    console.log(`[captcha] verify response:`, JSON.stringify(verify));
    return verify;
  }

  // pede um challenge novo e devolve o objeto já validado.
  async function obterChallenge() {
    await aguardarCloudflare(15_000);
    const raw = await httpRaw(`${EDUSP}/captcha/challenge`, {
      method: 'POST',
      headers: captchaHeaders,
      body: JSON.stringify({ realm: "edusp" })
    });
    const rawText = raw.text;
    if (raw.isCloudflare || pareceCloudflare(rawText)) {
      marcarCloudflare();
      const err = new Error('Cloudflare bloqueou a API no challenge (Just a moment)');
      err.status = 0;
      err.cause = 'cloudflare_block';
      throw err;
    }
    let ch;
    try { ch = JSON.parse(rawText); } catch { ch = null; }
    if (!ch || (raw.status < 200 || raw.status >= 300)) throw new Error(ch?.message || `challenge ${raw.status}`);
    if (!ch || !ch.challengeId || !ch.challenge?.image) {
      console.error(`[captcha] Resposta inesperada:`, JSON.stringify(ch).slice(0, 500));
      throw new Error('Falha ao obter desafio do CAPTCHA');
    }
    return ch;
  }

  // normaliza a resposta (mesma regra do caminho da IA: so letras e digitos)
  // e gera variantes de caixa - captchas costumam ser case-insensitive e isso
  // evita "respondi certo e deu errado" so por causa de Maiuscula/Minuscula.
  function normalizarResposta(raw) {
    const s = String(raw || '').trim().replace(/[^A-Za-z0-9]/g, '');
    return s.slice(0, 12);
  }

  function variantesDeCaixa(s) {
    if (!s) return [];
    const cap = s[0].toUpperCase() + s.slice(1).toLowerCase();
    return [...new Set([s, cap, s.toLowerCase(), s.toUpperCase()])];
  }

  // tenta o verify com a resposta limpa e, se a plataforma disser errado, com
  // as variantes de caixa (o MESMO challenge ainda esta vivo -> retry aceito).
  // devolve o token validado ou null; lanca com o ultimo erro (context_mismatch
  // = challenge expirou, que a resposta certa JAMAIS valida).
  //
  // DETALHE (observado em produção): a edusp costuma voltar context_mismatch
  // no PRIMEIRO verify de um challenge e aceitar a resposta certa num verify
  // seguinte (ajuizado/demo: "6GQ24" -> mismatch, "6gq24" -> valid ✓). por isso
  // um context_mismatch não é imediatamente terminal: esperamos uma pausa com
  // jitter (~0.6–1.2s) e retentamos a MESMA resposta uma vez antes de trocar de
  // variante. também há jitter entre variantes pra não dar rajada de bot.
  const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));
  const isCtxMismatch = (e) => /context_mismatch/i.test(e?.cause || e?.message || '');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // tenta UMA candidata (com as variantes de caixa) num challenge e DEVOLVE o
  // resultado em vez de "matar" no primeiro erro:
  //   { token }                 -> resposta aceita (captcha resolvido)
  //   { erro }                  -> nada validou (inclui context_mismatch expirado)
  // o RELAY fica por conta do chamador: recusou uma candidata? o próximo texto
  // entra no MESMO challengeId. isso só é seguro porque a edusp NÃO invalida o
  // challenge ao errar — ela só renova a imagem quando o usuário clica em
  // "gerar nova imagem" no site (observado em produção). o único estado que
  // invalida é context_mismatch (challenge expirado).
  async function validarCandidata(challengeId, base) {
    const respostas = variantesDeCaixa(normalizarResposta(base));
    for (const ans of respostas) {
      let verify = null;
      let erro = null;
      try {
        verify = await verificar(challengeId, ans);
      } catch (e) {
        erro = e;
      }
      if (erro && !verify) {
        // resposta recusada de verdade ("Wrong answer"/verification_failed):
        // esta candidata não serve — para as variantes dela e deixa o relay
        // tentar a PRÓXIMA candidata no mesmo challenge.
        if (!isCtxMismatch(erro)) return { erro };
        // context_mismatch = challenge "dormindo" (1º verify acorda, o 2º
        // aceita) — espera com jitter e retenta a MESMA resposta uma vez.
        await sleep(jitter(600, 1200));
        try { verify = await verificar(challengeId, ans); }
        catch (e2) { return { erro: e2 }; }
      }
      const token = verify?.token || verify?.captchaToken;
      if (verify?.valid && token) {
        console.log(`[captcha] resolveu com "${ans}"`);
        return { token };
      }
      await sleep(jitter(400, 900));
    }
    return { erro: new Error('candidata não validou em nenhuma variante de caixa') };
  }
  // quantos textos DIFERENTES tentamos por imagem antes de trocar (teto anti-loop)
  const MAX_CANDIDATAS_POR_IMAGEM = 6;
  // tempo que seguimos "pescando" candidatas para UMA imagem (o challenge expira
  // sozinho depois de um tempo; não adianta esperar eternamente).
  const JANELA_CANDIDATAS_MS = 35_000;

  let tentativa = 1;
  while (true) {
    // permite cancelamento a cada nova tentativa
    if (typeof opts?.deveCancelar === 'function' && opts.deveCancelar()) {
      throw new Error('cancelado pelo usuário');
    }
    console.log(`[captcha] Tentativa ${tentativa} (imagem fresca)...`);

    // 1. Pede o desafio (via proxy se configurado)
    let challenge;
    try {
      challenge = await obterChallenge();
    } catch (e) {
      if (e.cause === 'cloudflare_block') throw e; // CF bloqueando: para a rodada, não martela
      console.error(`[captcha] Erro ao pedir /captcha/challenge:`, e.message);
      tentativa++;
      await new Promise(r => setTimeout(r, 3000));
      continue; // tenta de novo com desafio fresco
    }

    console.log(`[captcha] challengeId:`, challenge?.challengeId);
    console.log(`[captcha] tem imagem:`, !!(challenge?.challenge?.image));

    // 2. RELAY: o leitor Groq (visão) lê a imagem e cada leitura é enviada ao
    //    verify ASSIM QUE CHEGA — sem esperar os outros fecharem a votação.
    //    recusou? o PRÓXIMO texto entra no MESMO challengeId (a edusp não renova a
    //    imagem no erro; só no botão "gerar nova imagem"). só trocamos de imagem
    //    quando o challenge expira (context_mismatch) ou a janela de candidatas fecha.
    const vistos = new Set();
    let filaFechada = false;
    const fila = (() => {
      const buf = [];
      const esperas = [];
      return {
        fechar() { filaFechada = true; for (const r of esperas.splice(0)) r(null); },
        empurrar(v) { if (filaFechada) return; const r = esperas.shift(); if (r) r(v); else buf.push(v); },
        proxima() {
          if (buf.length) return Promise.resolve(buf.shift());
          if (filaFechada) return Promise.resolve(null);
          return new Promise(res => esperas.push(res));
        },
      };
    })();

    try {
      const solver = solveCaptchaImage(challenge.challenge.image, 'image/png', {
        onCandidata: (val, _peso, nome) => {
          const chave = String(val).toLowerCase();
          if (filaFechada || vistos.has(chave)) return;
          vistos.add(chave);
          console.log(`[captcha] relay: candidata "${val}" (${nome || 'ia'}) pronta — verificando...`);
          fila.empurrar({ val: String(val), origem: nome || 'ia' });
        },
      });
      void solver.catch((e) => console.error(`[captcha] Erro ao ler imagem com IA:`, e.message)).finally(() => fila.fechar());
    } catch (e) {
      console.error(`[captcha] Erro ao ler imagem com IA:`, e.message);
      fila.fechar();
    }

    // 3. consome as candidatas conforme chegam e verifica cada uma em relé.
    let morreu = false;
    let verifies = 0;
    const janelaFim = Date.now() + JANELA_CANDIDATAS_MS;
    while (!morreu && verifies < MAX_CANDIDATAS_POR_IMAGEM && Date.now() < janelaFim) {
      const item = await Promise.race([
        fila.proxima(),
        new Promise(r => setTimeout(r, Math.max(janelaFim - Date.now(), 1))).then(() => null),
      ]);
      if (!item) break;
      const cand = item.val;
      verifies++;
      const res = await validarCandidata(challenge.challengeId, cand);
      if (res.token) {
        console.log(`[captcha] ✅ resolvido pelo leitor "${item.origem}"! ("${cand}")`);
        salvarCaptchaResolvido(challenge.challenge.image, cand, item.origem);
        return { token: res.token, challengeId: challenge.challengeId };
      }
      if (res.erro?.cause === 'cloudflare_block') throw res.erro;
      if (isCtxMismatch(res.erro)) {
        console.warn(`[captcha] challenge expirou/dormiu — trocando de imagem...`);
        morreu = true;
        break;
      }
      console.log(`[captcha] candidata "${cand}" recusada — relay: próxima...`);
    }

    // 4. esgotou as candidatas da IA → tenta novamente com uma imagem NOVA
    //    (sem chamar humano). o bot persiste indefinidamente até resolver.
    tentativa++;
    if (typeof opts?.deveCancelar === 'function' && opts.deveCancelar()) {
      throw new Error('cancelado pelo usuário');
    }
    console.log(`[captcha] Tentando novamente com uma imagem nova...`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // unreachable, mas TypeScript reclama
  throw new Error(`Falha ao resolver CAPTCHA`);
}

export async function rooms(token) {
  return jfetch(`${EDUSP}/room/user?list_all=true&with_cards=true`, { headers: H(token) });
}

// extrai os publication_target das turmas do aluno.
// é daqui que saem os targets reais (ex.: "r0b9ad69f836066c6d-l"); o nick
// sozinho NÃO é um target válido e faz a busca de tarefas voltar vazia.
// os alvos numéricos de turma (764, 2089…) vêm do .env e são POR CONTA — ver
// config.edusp.porConta. mandá-los na conta errada não vaza nada (a API filtra
// pelo token) mas esvazia a varredura, então ficam amarrados ao nick.
export async function roomTargets(token, nick) {
  const out = new Set();
  for (const t of config.edusp.porConta[nick] || []) out.add(t);
  for (const t of config.edusp.global) out.add(t);
  try {
    const rm = await rooms(token);
    const list = rm?.rooms || rm?.data || (Array.isArray(rm) ? rm : []);
    for (const r of list) {
      if (!r) continue;
      if (r.name) out.add(String(r.name));
      if (r.publication_target) out.add(String(r.publication_target));
      if (r.target) out.add(String(r.target));
      if (r.code) out.add(String(r.code));
      if (r.id) out.add(String(r.id));
      const grp = r.group_name || r.group;
      if (grp) out.add(String(grp));
    }
  } catch {
    // sem /room/user ainda vale o override: melhor 1 alvo conhecido que 0.
  }
  return [...out];
}

// quantos itens cada página do /todo traz.
const LIMITE_PAGINA = 100;
// as vencidas formam listas bem mais longas que as ativas, então os buckets
// de expiração varrem mais páginas (o modo antigo ficava só nos 100 primeiros).
const MAX_PAGINAS_EXPIRADAS = 3;

// os dois flags de vencimento são INVERSOS entre si e o site usa os dois:
//   skip → expired_only=false&filter_expired=true   só o que ainda vale
//   only → expired_only=true&filter_expired=false   SÓ o que já venceu
//   all  → expired_only=false&filter_expired=false  os dois
function _expiry(p, modo) {
  if (modo === 'only') {
    p.set('expired_only', 'true');
    p.set('filter_expired', 'false');
    return;
  }
  p.set('expired_only', 'false');
  p.set('filter_expired', modo === 'all' ? 'false' : 'true');
}

function _todoUrl(base, nick, extraTargets = [], opts = {}) {
  const u = new URL(base);
  const p = u.searchParams;
  _expiry(p, opts.expired);
  p.set('with_answer', 'true');
  p.set('with_apply_moment', 'true');
  p.set('limit', String(LIMITE_PAGINA));
  p.set('offset', String(Math.max(0, opts.offset || 0) * LIMITE_PAGINA));
  if (opts.includeDrafts !== false) {
    // `answer_statuses` no PLURAL e repetido. testado contra a API:
    //  · o singular `answer_status` é IGNORADO — devolve exatamente a mesma
    //    lista que não mandar filtro nenhum (82 tarefas já finalizadas junto);
    //  · 'null' é valor INVÁLIDO e derruba a requisição inteira com 400
    //    ("does not match any of the allowed types"). O enum é
    //    [array, draft, pending, finished, submitted].
    p.append('answer_statuses', 'draft');
    p.append('answer_statuses', 'pending');
    p.append('answer_statuses', 'submitted');
  }
  if (nick) p.append('publication_target', nick);
  for (const t of extraTargets) p.append('publication_target', t);
  if (opts.categoryParentId != null) p.set('category_parent_id', String(opts.categoryParentId));
  if (opts.isExam != null) p.set('is_exam', String(!!opts.isExam));
  if (opts.isEssay != null) p.set('is_essay', String(!!opts.isEssay));
  return u;
}

async function listCategories(token, nick, extraTargets = [], opts = {}) {
  const u = new URL(`${EDUSP}/tms/task/targets/categories`);
  const p = u.searchParams;
  // em 'skip' já pede tudo (permissivo) — assim as categorias de um target
  // nunca somem só porque a atividade delas venceu.
  _expiry(p, opts.expired === 'only' ? 'only' : 'all');
  if (nick) p.append('publication_target', nick);
  for (const t of extraTargets) p.append('publication_target', t);
  try {
    const r = await jfetch(u, { headers: H(token) });
    return Array.isArray(r) ? r : (r?.categories || r?.data || []);
  } catch {
    return [];
  }
}

// pega TODAS as tarefas pendentes varrendo buckets (cru, provas, redações).
// mesma estratégia do site, que descobriu os category_parent_id na marra.
//
// opts.expired: 'skip' (padrão, só o que ainda vale) | 'only' (só as vencidas,
// expired_only=true) | 'all' (as duas — faz as duas varreduras e une).
export async function tasksTodo(token, nick, extraTargets = [], opts = {}) {
  const modo = opts.expired || 'skip';
  // 'all' NÃO faz duas varreduras: expired_only=false&filter_expired=false já
  // devolve vencidas E ativas na mesma resposta (verificado na API) — fazer as
  // duas passadas só dobraria as requisições pro navegador/browser-fetch.
  const modos = [modo];

  // os targets reais vêm das turmas do aluno. sem eles a API devolve vazio.
  const rTargets = await roomTargets(token, nick);
  const cats = await listCategories(token, nick, [...extraTargets, ...rTargets], { expired: modo });
  const numTargets = new Set(rTargets);
  const parentIds = new Set();
  for (const c of cats) {
    if (c && c.parent_id != null) parentIds.add(c.parent_id);
    if (c && c.id != null && /^\d+$/.test(String(c.id))) numTargets.add(String(c.id));
    const pts = c?.publication_target || c?.publication_targets || c?.targets;
    if (Array.isArray(pts)) for (const t of pts) {
      const s = typeof t === 'string' ? t : (t?.publication_target || t?.id);
      if (s) numTargets.add(String(s));
    }
  }
  const allTargets = [...new Set([...extraTargets, ...numTargets])];

  const buckets = [];
  buckets.push({ label: 'cru-zero', opts: { ...opts, includeDrafts: false } });
  buckets.push({ label: 'cru-status', opts: { ...opts } });
  // NÃO há bucket is_exam: prova está fora do escopo (ver ehProva). os pids
  // descobertos continuam servindo pro sweep de redação, que é outro filtro.
  const examPids = new Set(parentIds);
  examPids.add(19); examPids.add(18); examPids.add(20);
  for (const pid of examPids) {
    buckets.push({ label: `essay pid=${pid}`, opts: { ...opts, categoryParentId: pid, isEssay: true } });
  }
  buckets.push({ label: 'essay-noPid', opts: { ...opts, isEssay: true } });

  const seen = new Set();
  const out = [];
  for (const m of modos) {
    for (const b of buckets) {
      // pagina enquanto a página vier cheia. o bucket SEM filtro de status
      // (cru-zero) fica em 1: ele varre o arquivo inteiro de vencidas (100+
      // já respondidas) e paginar isso só queima requisição à toa.
      const maxPag = opts.maxPages
        ?? (b.opts.includeDrafts === false ? 1 : (m === 'skip' ? 1 : MAX_PAGINAS_EXPIRADAS));
      for (let pag = 0; pag < maxPag; pag++) {
        let list;
        try {
          const u = _todoUrl(`${EDUSP}/tms/task/todo`, nick, allTargets, {
            ...b.opts, expired: m, offset: pag,
          });
          const r = await jfetch(u, { headers: H(token) });
          list = Array.isArray(r) ? r : (r?.tasks || r?.exams || []);
        } catch (e) {
          console.warn(`[edusp] bucket ${b.label} (${m}) falhou: ${e?.message}`);
          break;
        }
        for (const t of list) {
          if (!t || !t.id || seen.has(t.id)) continue;
          if (ehProva(t)) continue;   // prova nunca entra (ver ehProva)
          seen.add(t.id);
          if (b.opts.isEssay) t._is_essay = true;
          if (b.opts.categoryParentId != null) t._category_parent_id = b.opts.categoryParentId;
          // `expired_only=true` JÁ É o filtro do servidor, então marca na
          // mesma hora: nem toda resposta traz task_expired/expire_at.
          if (m === 'only' || isExpired(t)) t._expired = true;
          out.push(t);
        }
        if (!list.length || list.length < LIMITE_PAGINA) break; // última página
      }
    }
  }

  // Só o publication_target de sala (r<hex>-l) é descobrível em /room/user.
  // As turmas numéricas que o site manda (ex.: 764, 2089) NÃO aparecem em
  // lugar nenhum da API — se elas faltarem, a varredura volta só com
  // tarefas já finalizadas e o aluno fica "sem pendência" sem ser verdade.
  if (!out.some(t => !isFinished(t))) {
    console.warn(`[edusp] ${nick}: nenhum bucket devolveu tarefa em aberto (${out.length} Bragg, todas finalizadas). ` +
      `Provável publication_target de turma faltando — os alvos numéricos que o site usa não vêm de /room/user.`);
  }
  return out;
}

// prova (exam) NUNCA entra no escopo do bot. duas razões, uma técnica e uma
// de escolha do dono:
//  · técnica — a lista de "Prova de Recuperação" vem inteira com
//    `enable_token = true`, e o /apply responde 403 {"field":"token_code"}
//    sem o código que a escola entrega junto com a prova. são insolúveis.
//  · escopo — o dono não quer o bot fazendo prova.
// vale pra TODO bucket, então os buckets is_exam também saem do sweep.
export function ehProva(t) {
  return !!t && t.is_exam === true;
}

// redação/disertação também está fora do escopo. o dono resolve essas na mão:
// a IA erra a estrutura argumentativa e o professor penaliza mais que por
// multiple choice. o bot só pega o que é objetivo.
//
// CUIDADO com `is_objective`: ele NÃO significa "é redação". medido na conta
// real, 59 das 74 tarefas vencidas vieram com is_objective=false e continuam
// sendo quiz normal ("Tarefa 3: Science for society III", 10-13 questões).
// o único sinal confiável de redação é `is_essay` — as 3tasks com essay=true
// eram de fato Dissertação. usar is_objective aqui jogava fora 59 quizzes.
export function ehRedacao(t) {
  return !!t && (t.is_essay === true || t.isEssay === true);
}

// REGRA DE ESCOPO, fonte única da verdade. o bot só resolve tarefa OBJETIVA:
// fora prova, fora redação, fora o que pede token_code (apply daria 403).
export function foraDoEscopo(t) {
  return ehProva(t) || ehRedacao(t) || exigeTokenCode(t);
}

// tarefa com `enable_token = true` (quase toda prova de recuperação vencida)
// só abre com o token_code que a escola passa. sem ele a API responde
// 403 {"field":"token_code","cause":"Invalid token code"}.
export function exigeTokenCode(t) {
  return !!t && (t.enable_token === true || t.enableToken === true);
}

// o apply aceita `token_code` na query. é o mesmo código que a pessoa digita
// na tela "qual o código da prova?" do site.
export async function taskApply(token, id, captcha = null, target = null, tokenCode = null) {
  const extra = captcha ? { 'x-captcha-token': captcha.token } : {};
  const qs = target ? `&room_name=${target}` : '';
  const code = tokenCode ? `&token_code=${encodeURIComponent(tokenCode)}` : '';
  return jfetch(`${EDUSP}/tms/task/${id}/apply?preview_mode=false${qs}${code}`, { 
    headers: H(token, extra) 
  });
}

export async function submitAnswer(token, id, payload, captcha = null) {
  const extra = captcha ? { 'x-captcha-token': captcha.token } : {};
  return jfetch(`${EDUSP}/tms/task/${id}/answer`, {
    method: 'POST', 
    headers: H(token, extra), 
    body: JSON.stringify(payload),
  });
}

export async function updateAnswer(token, taskId, answerId, payload, captcha = null) {
  const extra = captcha ? { 'x-captcha-token': captcha.token } : {};
  return jfetch(`${EDUSP}/tms/task/${taskId}/answer/${answerId}`, {
    method: 'PUT', 
    headers: H(token, extra), 
    body: JSON.stringify(payload),
  });
}

// redação: a plataforma tem um endpoint /essay-check que precisa ser chamado
// com {title, body} ANTES do envio (mesmo fluxo do bot de referência) — sem ele
// a redação pode ser salva, mas a correção volta com nota NaN. é best-effort:
// se falhar, segue o envio normal (só loga).
export async function essayCheck(token, taskId, title, body, captcha = null) {
  const extra = captcha ? { 'x-captcha-token': captcha.token } : {};
  try {
    const r = await jfetch(`${EDUSP}/tms/task/${taskId}/essay-check`, {
      method: 'POST',
      headers: H(token, extra),
      body: JSON.stringify({ title, body }),
    });
    console.log(`[edusp] essay-check ok (task ${taskId})`);
    return r;
  } catch (e) {
    console.warn(`[edusp] essay-check falhou (${e?.message}) — segue o envio`);
    return null;
  }
}

// resolve o publication_target correto (ordem de prioridade do site)
export function resolveTarget(task, nick, opts = {}) {
  if (opts && opts.target) return opts.target;
  if (task.publication_target) return task.publication_target;
  const pts = task.publication_targets || task.publicationTargets;
  if (Array.isArray(pts) && pts.length) {
    const first = pts[0];
    if (typeof first === 'string') return first;
    if (first && first.publication_target) return first.publication_target;
  }
  return nick;
}

export function isFinished(t) {
  return t.answer_status === 'finished' || t.answer_status === 'submitted';
}

// tarefa vencida. a API sinaliza de formas diferentes dependendo do bucket,
// então olha os flags E as datas. `_expired` é o mais confiável: é o que o
// tasksTodo carimba quando a resposta veio de expired_only=true.
export function isExpired(t) {
  if (!t) return false;
  if (t._expired) return true;
  if (t.task_expired || t.expired || t.is_expired || t.expired_task) return true;
  const d = t.expire_at || t.expired_at || t.expiration_date || t.expire_date;
  if (d) {
    const dt = new Date(d).getTime();
    if (Number.isFinite(dt)) return dt < Date.now();
  }
  return false;
}

// tudo que o bot ainda pode mexer, já dentro do ESCOPO (só objetivo, sem
// prova/redação/token), separado entre o que ainda vale e o que JÁ VENCEU.
// o dono pediu "só as expiradas": quem filtra por prazo é `tarefasAlvo`, não
// esta função — aqui o corte é só de escopo.
export function separarPendentes(tasks) {
  const todas = [];
  for (const t of tasks || []) {
    if (!t || !t.id) continue;
    if (isFinished(t)) continue;
    if (foraDoEscopo(t)) continue;   // prova, redação e token_code fora
    todas.push(t);
  }
  return {
    todas,
    expiradas: todas.filter(t => isExpired(t)),
    ativas: todas.filter(t => !isExpired(t)),
  };
}
