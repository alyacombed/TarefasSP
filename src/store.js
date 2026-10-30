// persistência de contas em disco (data/accounts.json).
// a senha do aluno é cifrada com AES-256-GCM (node:crypto, sem dependência).
// o resto dos campos fica em claro pra facilitar depuração/relatório.
//
// schema por usuário (chave = userId do Discord):
//   { userId,
//     ra, dg, uf, senha(cifrada), nick, aluno,   <- conta ATIVA (automação usa estes)
//     ativoRa: 'ra-dg-uf',                        <- chave da conta ativa
//     contas: [ {ra, dg, uf, senha(cifrada), nick, aluno, addedAt}, ... ],  <- multi-RA
//     plan: 'free'|'premium', premiumUntil: ms|null,
//     autoMode: 'draft'|'submitted', autoExpired: bool (null = inclui as vencidas),
//     hitRate: 0-100,
//     createdAt, lastRun: ms|null, lastError: string|null }
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dir = dirname(fileURLToPath(import.meta.url));
// DATA_DIR pode ser apontado p/ outra pasta (testes usam temp e NUNCA
// encostam nos dados reais).
const DATA_DIR = process.env.DATA_DIR || join(__dir, '..', 'data');
const DB_PATH = join(DATA_DIR, 'accounts.json');

// chave de 32 bytes derivada do segredo do .env via PBKDF2.
const MASTER_SECRET = String(config.store.secret || 'lumen-secure-master-key-fallback-2026');

function deriveKey(salt) {
  return pbkdf2Sync(MASTER_SECRET, salt, 100_000, 32, 'sha256');
}

// ---- cripto de campo (senha) ----
// formato guardado: "enc:v2:<salt b64>:<iv b64>:<tag b64>:<ciphertext b64>"
function encrypt(plain) {
  if (plain == null) return null;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(salt);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `enc:v2:${salt.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(stored) {
  if (stored == null) return null;
  if (typeof stored !== 'string') return stored;
  
  // Suporte a v2 (PBKDF2 por registro + IV dinâmico + AES-256-GCM)
  if (stored.startsWith('enc:v2:')) {
    try {
      const [, , saltb, ivb, tagb, ctb] = stored.split(':');
      const salt = Buffer.from(saltb, 'base64');
      const key = deriveKey(salt);
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
      d.setAuthTag(Buffer.from(tagb, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ctb, 'base64')), d.final()]).toString('utf8');
    } catch (e) {
      console.error('[store] Falha ao decifrar v2:', e.message);
      return null;
    }
  }

  // Suporte legado v1 (scrypt com salt fixo)
  if (stored.startsWith('enc:v1:')) {
    try {
      const legacyKey = scryptSync(MASTER_SECRET, 'lumen-salt-v1', 32);
      const [, , ivb, tagb, ctb] = stored.split(':');
      const d = createDecipheriv('aes-256-gcm', legacyKey, Buffer.from(ivb, 'base64'));
      d.setAuthTag(Buffer.from(tagb, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ctb, 'base64')), d.final()]).toString('utf8');
    } catch (e) {
      console.error('[store] Falha ao decifrar v1 legado:', e.message);
      return null;
    }
  }

  return stored; // texto puro antigo
}

// ---- carga/escrita ----
let db = null;            // { [userId]: account }
let saveTimer = null;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function load() {
  if (db) return db;
  try {
    const raw = readFileSync(DB_PATH, 'utf8');
    db = JSON.parse(raw) || {};
  } catch {
    db = {};
  }
  return db;
}

function flush() {
  ensureDir();
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// escrita com debounce pra não bater no disco a cada tecla.
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; try { flush(); } catch (e) { console.error('[store] falha ao salvar:', e.message); } }, 300);
}

// força gravação imediata (usar em pontos críticos: aprovar pagamento).
export function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { flush(); } catch (e) { console.error('[store] falha ao salvar:', e.message); }
}

// ---- API pública ----

// chave estável de uma conta: 'ra-dg-uf'
function contaKey(c) {
  return `${String(c.ra || '')}-${String(c.dg || '')}-${String(c.uf || '').toUpperCase()}`;
}

// garante entry.contas como array; migra formato antigo (só campos de topo)
// semeando a lista a partir da própria entrada. muta in place.
function normContas(e) {
  if (!e) return e;
  if (!Array.isArray(e.contas)) e.contas = [];
  // migração: usuário antigo tem ra nos campos de topo mas lista vazia/ausente.
  // o plano (que antes era do usuário) vira plano DA CONTA sembrada.
  if (!e.contas.length && e.ra != null) {
    e.contas.push({
      ra: e.ra, dg: e.dg, uf: e.uf, senha: e.senha,
      nick: e.nick, aluno: e.aluno, addedAt: e.createdAt || Date.now(),
      plan: e.plan || 'free',
      premiumUntil: e.premiumUntil ?? null,
      ...(e.autoMode ? { autoMode: e.autoMode } : {}),
      ...(e.autoExpired != null ? { autoExpired: e.autoExpired } : {}),
      ...(e.hitRate != null ? { hitRate: e.hitRate } : {}),
    });
    e.ativoRa = contaKey(e);
  }
  return e;
}

// devolve a conta com a senha JÁ DECIFRADA (pronta pra usar no login).
// os campos de topo refletem a CONTA ATIVA (espelhados em switch/upsert/set/patch).
export function getAccount(userId) {
  load();
  const a = db[String(userId)];
  if (!a) return null;
  return { ...a, senha: decrypt(a.senha) };
}

// todas as contas salvas do usuário (senhas decifradas + chave de cada uma).
export function listAccounts(userId) {
  load();
  const a = db[String(userId)];
  if (!a) return [];
  normContas(a);
  return a.contas.map(c => ({
    ...c,
    senha: decrypt(c.senha),
    key: contaKey(c),
  }));
}

// troca qual conta salva é a ATIVA. o plano/modo da escolhida sobe pros
// campos de topo pra continuar aparecendo no painel sem mudança nenhuma.
export function switchAccount(userId, key) {
  load();
  const e = db[String(userId)];
  if (!e) return null;
  normContas(e);
  const c = e.contas.find(x => contaKey(x) === String(key));
  if (!c) return null;
  Object.assign(e, {
    ra: c.ra, dg: c.dg, uf: c.uf, senha: c.senha,
    nick: c.nick, aluno: c.aluno, ativoRa: contaKey(c),
    plan: c.plan || 'free', premiumUntil: c.premiumUntil ?? null,
    autoMode: c.autoMode ?? null,
    autoExpired: c.autoExpired ?? null,
    hitRate: c.hitRate ?? null,
  });
  save();
  return getAccount(userId);
}

// cria/atualiza. recebe a senha em CLARO; guarda cifrada.
// preserva plan/premiumUntil/createdAt se a conta já existir.
// também mantém a lista `contas` em sync (mesmo RA atualiza; RA novo entra na lista)
// e torna a conta vinculada a ATIVA.
export function upsertAccount(acc) {
  load();
  const id = String(acc.userId);
  const prevRaw = db[id] || {};
  normContas(prevRaw);                       // migra formato antigo antes de espalhar
  const prev = { ...prevRaw };
  const senha = acc.senha != null ? encrypt(acc.senha) : prev.senha;
  db[id] = {
    ...prev,
    ...acc,
    userId: id,
    senha,
    plan: acc.plan || prev.plan || 'free',
    premiumUntil: acc.premiumUntil ?? prev.premiumUntil ?? null,
    createdAt: prev.createdAt || Date.now(),
  };

  // sincroniza na lista multi-RA
  const nova = { ra: acc.ra, dg: acc.dg, uf: acc.uf, senha, nick: acc.nick, aluno: acc.aluno, addedAt: Date.now() };
  const kNova = contaKey(nova);
  const idx = db[id].contas.findIndex(c => contaKey(c) === kNova);
  let alvo;
  if (idx >= 0) {
    // re-vínculo: atualiza dados mas PRESERVA plano/modo/histórico da conta
    db[id].contas[idx] = { ...db[id].contas[idx], ...nova, addedAt: db[id].contas[idx].addedAt || Date.now() };
    alvo = db[id].contas[idx];
  } else {
    alvo = { ...nova, plan: 'free', premiumUntil: null };
    db[id].contas.push(alvo);
  }
  db[id].ativoRa = kNova;                    // última vinculada/escolhida vira a ativa

  // espelha o estado da conta ativa pros campos de topo (painel continua igual)
  db[id].plan = alvo.plan || 'free';
  db[id].premiumUntil = alvo.premiumUntil ?? null;
  db[id].autoMode = alvo.autoMode ?? null;
  db[id].autoExpired = alvo.autoExpired ?? null;
  db[id].hitRate = alvo.hitRate ?? null;

  save();
  return getAccount(id);
}

// define o plano de UMA conta específica do usuário. grava na hora.
// se for a conta ativa, espelha pros campos de topo.
export function setContaPlan(userId, key, plan, untilMs = null) {
  load();
  const e = db[String(userId)];
  if (!e) return null;
  normContas(e);
  const c = e.contas.find(x => contaKey(x) === String(key));
  if (!c) return null;
  c.plan = plan;
  c.premiumUntil = untilMs;
  if (e.ativoRa === contaKey(c)) {
    e.plan = plan;
    e.premiumUntil = untilMs;
  }
  saveNow();
  return getAccount(userId);
}

// atualiza campos soltos de UMA conta (lastRun, lastError, autoMode…).
export function patchConta(userId, key, fields) {
  load();
  const e = db[String(userId)];
  if (!e) return null;
  normContas(e);
  const c = e.contas.find(x => contaKey(x) === String(key));
  if (!c) return null;
  Object.assign(c, fields);
  if (e.ativoRa === contaKey(c) && ('autoMode' in fields)) {
    e.autoMode = fields.autoMode ?? null;
  }
  if (e.ativoRa === contaKey(c) && ('autoExpired' in fields)) {
    e.autoExpired = fields.autoExpired ?? null;
  }
  if (e.ativoRa === contaKey(c) && ('hitRate' in fields)) {
    e.hitRate = fields.hitRate ?? null;
  }
  save();
  return getAccount(userId);
}

export function removeAccount(userId) {
  load();
  delete db[String(userId)];
  saveNow();
}

// remove UMA conta específica da lista multi-RA.
// se a removida era a ATIVA, a primeira restante sobe pra ativa
// (com espelho de plano nos campos de topo). se não sobrar nenhuma,
// o registro do usuário inteiro é apagado.
// NÃO mexe em sessões rodando — quem está logado continua até expirar.
export function removeConta(userId, key) {
  load();
  const e = db[String(userId)];
  if (!e) return false;
  normContas(e);
  const k = String(key);
  const idx = e.contas.findIndex(x => contaKey(x) === k);
  if (idx < 0) return false;
  e.contas.splice(idx, 1);
  if (!e.contas.length) {          // era a última: apaga tudo
    delete db[String(userId)];
    saveNow();
    return true;
  }
  if (e.ativoRa === k) switchAccount(userId, contaKey(e.contas[0]));
  else save();
  return true;
}

// true se o plano premium ainda está dentro da validade.
export function isPremiumActive(acc) {
  return !!acc && acc.plan === 'premium' && acc.premiumUntil && acc.premiumUntil > Date.now();
}

// todas as CONTAS DE ALUNO com premium ativo, prontas pra automação:
// [{ userId, key, ra, dg, uf, senha(decifrada), nick, aluno, autoMode, autoExpired, lastRun }]
export function allPremiumContas() {
  load();
  const out = [];
  for (const id of Object.keys(db)) {
    const e = db[id];
    normContas(e);
    for (const c of e.contas) {
      if (!isPremiumActive(c)) continue;
      out.push({
        userId: id,
        key: contaKey(c),
        ra: c.ra, dg: c.dg, uf: c.uf,
        senha: decrypt(c.senha),
        nick: c.nick, aluno: c.aluno,
        autoMode: c.autoMode ?? null,
        autoExpired: c.autoExpired ?? null,
        hitRate: c.hitRate ?? null,
        lastRun: c.lastRun ?? null,
      });
    }
  }
  return out;
}

// itera TODAS as contas de aluno de todos os usuários (inclusive premium
// vencido, pro sweep de expiração): [{ userId, key, plan, premiumUntil, nick }]
export function eachConta() {
  load();
  const out = [];
  for (const id of Object.keys(db)) {
    const e = db[id];
    normContas(e);
    for (const c of e.contas) {
      out.push({
        userId: id,
        key: contaKey(c),
        plan: c.plan || 'free',
        premiumUntil: c.premiumUntil ?? null,
        nick: c.nick,
      });
    }
  }
  return out;
}
