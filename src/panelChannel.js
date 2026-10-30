// QUAL canal é o "painel fixo" (onde o bot publica e fica).
//
// precedência:
//   1. PANEL_CHANNEL_ID no .env  → autoritativo, sempre vence
//   2. data/painel-channel.json  → aprendido quando o dono roda /painel no
//                                  canal que ele quer usar (persiste restart)
//   3. nada definido             → o painel fixo é simplesmente pulado
//
// o ID que antes vivia no config.js apontava pra outro servidor (o ID era MENOR
// que o do servidor, o que é impossível pra um canal dele) e fazia o bot
// falhar com "Unknown Channel" a cada boot, sem forma de se corrigir sozinho.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ARQ = join(DIR, 'painel-channel.json');

function lerSalvo() {
  try {
    if (!existsSync(ARQ)) return null;
    const v = JSON.parse(readFileSync(ARQ, 'utf8'))?.channelId;
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

let salvo = lerSalvo();

// id do canal do painel, ou null se ainda não foi definido.
export function painelChannelId() {
  return config.panelChannelId || salvo;
}

// true quando veio do .env (não sobrescrevemos essa escolha via /painel).
export function painelChannelVemDoEnv() {
  return !!config.panelChannelId;
}

// registra o canal do painel. ignora ids que não parecem snowflake do Discord.
export function salvarPainelChannel(id) {
  const cid = String(id || '').trim();
  if (!/^\d{17,20}$/.test(cid)) return false;
  salvo = cid;
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(ARQ, JSON.stringify({ channelId: cid }, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[painel] não consegui gravar o canal do painel: ${e?.message}`);
    return false;
  }
}
