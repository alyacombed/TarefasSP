// fetch com parse de JSON e mensagem de erro detalhada.
// portado do jfetch do site, sem o bridge/iframe (não existe CORS no servidor).
//
// TRANSPORTE POR HOST:
//   a SED passa direto pelo fetch do Node (não tem Cloudflare).
//   a edusp (edusp-api.ip.tv) é protegida por Cloudflare, que recusa o
//   fingerprint TLS do Node. pra edusp o curl é o transporte (sem navegador);
//   se o IP for desafiado, o circuito CF pausa em vez de abrir Chrome.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { proxify, proxyEnabled } from './proxy.js';

const exec = promisify(execFile);

// binário do curl (env CURL_BIN permite apontar pra um build com outro FPS).
const CURL_BIN = process.env.CURL_BIN || 'curl';

// ── circuito Cloudflare ──────────────────────────────────────────
// quando a API (não o site do captcha) volta a página de challenge do CF
// ("Just a moment..."), todo request seguinte é redirecionado pra mesma página
// → JSON.parse quebra com "Unexpected token '<'" e o erro vaza com o HTML
// GIGANTE no log. a resposta certa é PARAR de bater: um backoff global de 60s
// pra deixar o challenge expirar, com sucesso/io derrubando devagar.
//
// marcado só na PRIMEIRA detecção de cada incidente (repetir rápido durante a
// pausa só alimenta o bloqueio — mesmo princípio do backoff do Gemini).
let CF_BLOCK_UNTIL = 0;

// corpo de challenge do Cloudflare? página com título "Just a moment..." e o
// token `__cf_chl_tk` (nunca aparece em JSON legítimo da API).
export function pareceCloudflare(txt) {
  const s = String(txt || '').toLowerCase();
  return s.includes('just a moment') || s.includes('__cf_chl_tk');
}

export function bloqueadoCloudflare() {
  return Date.now() < CF_BLOCK_UNTIL;
}

export function marcarCloudflare() {
  if (bloqueadoCloudflare()) return CF_BLOCK_UNTIL;
  CF_BLOCK_UNTIL = Date.now() + 60_000;
  console.warn('[http] Cloudflare bloqueou a API (Just a moment) — pausa global de 60s pra esfriar...');
  return CF_BLOCK_UNTIL;
}

// espera o restante da pausa, no máximo `capMs` (pra um captcha não travar o
// passo todo de trás na fila). não lança.
export async function aguardarCloudflare(capMs = 15_000) {
  const restante = CF_BLOCK_UNTIL - Date.now();
  if (restante <= 0) return;
  const espera = Math.min(restante, capMs);
  console.warn(`[http] aguardando Cloudflare liberar (${Math.max(1, Math.round(espera / 1000))}s)...`);
  await new Promise(r => setTimeout(r, espera));
}

// ── transporte ───────────────────────────────────────────────────
// a SED (sem Cloudflare) segue no fetch do Node: mais leve e com keep-alive.
// a edusp fica no curl (sem navegador). se o IP tomar challenge do CF, o
// circuito global pausa; não existe fallback que abra Chrome.
//
// COM PROXY LIGADO tudo vai de curl: o fetch do Node normaliza o nome de TODO
// header pra minúsculo (undici/Fetch spec), e o Cloudflare do proxy trata nome
// minúsculo como fingerprint de bot -> devolve "Just a moment" mesmo com o IP
// brasileiro certo. curl preserva a forma canônica e passa.
function precisaCurl(url) {
  return /edusp-api\.ip\.tv/i.test(String(url || '')) || proxyEnabled();
}

// nome de header na forma canônica (X-Api-Key, Content-Type, User-Agent...).
// ver o comentário acima: é o que evita o challenge do CF no proxy.
function nomeHeaderCanonico(nome) {
  return String(nome).toLowerCase().replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}

// Headers padrão que emulam perfeitamente o Chrome real para evitar o WAF do Cloudflare
const DEFAULT_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

// camada crua de rede: devolve { status, text, isCloudflare, headerText }.
// NUNCA lança por status HTTP nem por challenge do CF (só por erro de rede
// mesmo, ex.: DNS). quem chama decide (jfetch lança erro tipado, o captcha
// marca o circuito).
export async function httpRaw(url, opts = {}) {
  if (!precisaCurl(url)) return fetchRaw(url, opts);
  return curlComFallback(url, opts);
}

// curl com failover proxy → direto quando o proxy devolve challenge do CF.
async function curlComFallback(url0, opts = {}) {
  const metodo = String(opts.method || 'GET').toUpperCase();
  const prox = proxify(url0);
  const urls = [prox];
  if (prox !== url0) urls.push(url0); // direto = regra de roteamento real do .env

  try {
    let ultimo = null;
    for (const u of urls) {
      const r = await curlRaw(u, { ...opts, method: metodo });
      if (!r.isCloudflare) return r;
      if (u !== urls[urls.length - 1]) console.warn('[http] proxy devolveu challenge do CF — tentando direto...');
      ultimo = r;
    }
    return ultimo; // todos desafiaram — quem chama decide marcar o circuito
  } catch (e) {
    // curl indisponível? cai pro fetch do Node (que aí sim pode levar o 403
    // do CF — o circuito trata).
    if (e?.code === 'ENOENT') {
      console.warn(`[http] ${CURL_BIN} indisponível — usando fetch do Node (pode sofrer challenge do CF)`);
      return fetchRaw(url0, opts);
    }
    throw e;
  }
}

async function curlRaw(url, opts = {}) {
  const metodo = String(opts.method || 'GET').toUpperCase();
  const args = [
    '-sS', '-i', '--compressed',
    '--connect-timeout', '15',
    '--max-time', '90',
  ];
  if (opts.body != null) {
    args.push('--request', metodo === 'GET' ? 'POST' : metodo, '--data-binary', String(opts.body));
  } else if (metodo !== 'GET') {
    args.push('--request', metodo);
  }

  // Mescla headers default do navegador com os passados em opts.headers
  const headersMap = new Map();
  for (const [k, v] of Object.entries(DEFAULT_BROWSER_HEADERS)) {
    headersMap.set(nomeHeaderCanonico(k), v);
  }
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (v != null) headersMap.set(nomeHeaderCanonico(k), v);
  }

  for (const [k, v] of headersMap.entries()) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(String(url));

  let out;
  try {
    const r = await exec(CURL_BIN, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    out = r.stdout;
  } catch (e) {
    if (e?.code === 'ENOENT') throw e; // curl indisponível → deseja o fallback
    const err = new Error(`curl ${metodo} ${url} falhou: ${(e?.message || e).slice(0, 200)}`);
    err.cause_curl = e;
    throw err;
  }

  const sep = out.indexOf('\r\n\r\n');
  const head = sep >= 0 ? out.slice(0, sep) : '';
  const text = sep >= 0 ? out.slice(sep + 4) : out;
  const m = head.match(/^HTTP\/\S+[ ]?(\d{3})/m);
  const status = m ? Number(m[1]) : 0;
  return { status, headerText: head, text, isCloudflare: pareceCloudflare(text) || pareceCloudflare(head) };
}

// caminho antigo (undici) — usado pra SED e como fallback se curl faltar.
async function fetchRaw(url, opts = {}) {
  // se a API foi bloqueada agora pelo CF, espera a pausa (máx. 20s por chamada)
  // antes de disparar mais um request que só renovaria o challenge.
  if (bloqueadoCloudflare()) await aguardarCloudflare(20_000);
  const r = await fetch(proxify(url), opts);
  const text = await r.text();
  return { status: r.status, headerText: '', text, isCloudflare: pareceCloudflare(text) };
}

// busca e parse. lança com { status, body, url } em erro HTTP/shape inválido.
export async function jfetch(url, opts) {
  const r = await httpRaw(url, opts);

  // HTML de challenge ⇒ bloqueio, mesmo se o status for 200. erro LIMPO (sem o
  // megabyte de HTML no log) e status 0 (transitório) pra não confundir a
  // rotação de chave do SED (que reage a 401/403).
  if (r.isCloudflare) {
    marcarCloudflare();
    const err = new Error('Cloudflare bloqueou a API (Just a moment)');
    err.status = 0;
    err.cause = 'cloudflare_block';
    err.url = String(url);
    throw err;
  }

  let j = null;
  try { j = r.text ? JSON.parse(r.text) : null; } catch {}
  if (r.status < 200 || r.status >= 300) {
    let msg = `${r.status} ${r.statusText || ''}`.trim();
    if (j) {
      if (typeof j === 'string') msg = j;
      else if (j.message) msg = j.message;
      else if (j.error) msg = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
      else if (j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
      else if (Array.isArray(j.errors)) msg = j.errors.map(e => e.message || JSON.stringify(e)).join('; ');
      else msg = JSON.stringify(j).slice(0, 400);
    } else if (r.text) msg = r.text.slice(0, 400);
    const err = new Error(msg);
    err.status = r.status;
    err.body = j ?? r.text;
    err.url = String(url);
    throw err;
  }
  return j;
}