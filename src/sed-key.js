// auto-descoberta da chave da APIM da SED (api_key_bff).
// a SED rotaciona essa chave de tempos em tempos. em vez de capturar no
// devtools toda vez, lemos direto do bundle JS do app oficial do Sala do Futuro.
//
// no bundle ela vem dentro de um bloco de config:
//   "api_key_bff":"<32 hex>","api_url_bff":"https://sedintegracoes.../saladofuturobffapi"
// (as aspas chegam escapadas como \x22)
import { config } from './config.js';

const SF_BASE = 'https://saladofuturo.educacao.sp.gov.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CACHE_TTL = 1000 * 60 * 60 * 6; // revalida a cada 6h
// quando a descoberta falha, a chave do .env segura o bot por 30min antes de
// tentar de novo. era 60s: o bot repetia a mesma busca + o mesmo warning a cada
// minuto, o tempo todo, gastando requisição sem chance de dar certo.
const FALLBACK_TTL = 1000 * 60 * 30;

let cached = { key: null, ts: 0 };
let jaAvisou = false;

// extrai a chave do app oficial. devolve a string de hex ou null.
async function fetchKeyFromApp() {
  // 1) home -> acha o bundle app.<hash>.js
  const html = await (await fetch(`${SF_BASE}/`, { headers: { 'user-agent': UA } })).text();
  const bm = html.match(/\/js\/app\.[a-f0-9]+\.js/);
  if (!bm) throw new Error('bundle app.js não encontrado no HTML da SED');

  // 2) baixa o bundle e desescapa o \x22 -> " (o app oficial usa as duas formas)
  const js = await (await fetch(`${SF_BASE}${bm[0]}`, { headers: { 'user-agent': UA } })).text();
  const un = js.replace(/\\x22/g, '"').replace(/\\x27/g, "'");

  // 3) extrai api_key_bff. a SED mudou o tamanho da chave (32 hex) mais de uma
  // vez, então aceitar qualquer comprimento hex decente evita o
  // "api_key_bff não encontrada" só por causa do regex rigido.
  const km = un.match(/["']?api_key_bff["']?\s*[:=]\s*["']([a-f0-9]{16,64})["']/i)
    || un.match(/api[_-]?key[_-]?bff[^a-f0-9]{1,20}([a-f0-9]{16,64})/i);
  if (!km) throw new Error('api_key_bff não encontrada no bundle');
  return km[1];
}

// devolve a chave atual da SED.
// ordem: cache válido -> bundle oficial -> chave do .env (fallback).
// nunca lança: se a descoberta falhar, cai no fallback do config.
export async function getSedKey() {
  const agora = Date.now();
  if (cached.key && agora - cached.ts < CACHE_TTL) return cached.key;

  try {
    const key = await fetchKeyFromApp();
    cached = { key, ts: agora };
    if (key !== config.sed.apimKey) {
      console.log(`[lumen][sed-key] chave atualizada do app oficial: ...${key.slice(-6)}`);
    }
    jaAvisou = false;
    return key;
  } catch (e) {
    if (!jaAvisou) {
      jaAvisou = true;
      console.warn(`[lumen][sed-key] auto-fetch falhou (${e.message}); usando chave do .env por ${FALLBACK_TTL / 60000}min`);
    }
    cached = { key: config.sed.apimKey, ts: agora - CACHE_TTL + FALLBACK_TTL };
    return config.sed.apimKey;
  }
}

// força revalidação (ex.: se um login falhar com 401, dá pra tentar renovar).
export function invalidateSedKey() {
  cached = { key: null, ts: 0 };
}
