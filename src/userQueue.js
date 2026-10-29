// fila persistente de USUÁRIOS — processa UM POR VEZ.
// salva em data/fila.json e sobrevive a restarts do bot.
// quem chega primeiro é processado primeiro (FIFO).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, '..', 'data', 'fila.json');

let data = {
  fila: [],            // [{ userId, nick, addedAt, tasksTotal }]
  processando: null,   // { userId, nick, startedAt, tasksDone, tasksTotal, currentTask } | null
  lastUpdated: null,
};

// ── persistência ──────────────────────────────────────────────

function load() {
  try {
    if (existsSync(QUEUE_FILE)) {
      const raw = readFileSync(QUEUE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      // valida estrutura básica
      if (Array.isArray(parsed.fila)) data.fila = parsed.fila;
      // um "processando" que sobreviveu a um restart é ZUMBI: o thread que o
      // executava morreu junto com o processo e nunca mais vai chamar
      // finishProcessing(). se mantiver, trava permanentemente esse usuário
      // ("Já processando..." sem nada rodando + cancelar diz que não há nada).
      // então descarta — os que estão na fila (aguardando) continuam válidos.
      if (parsed.processando && typeof parsed.processando === 'object') {
        console.warn(`[queue] processando ficou preso de uma sessão anterior (${parsed.processando.userId}) — limpando trava zumbi; quem estava na fila continua aguardando.`);
        data.processando = null;
      }
    }
  } catch {
    console.warn('[queue] arquivo fila.json corrompido ou inválido — iniciando fila vazia');
    data = { fila: [], processando: null, lastUpdated: null };
  }
}

function save() {
  try {
    const dir = dirname(QUEUE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    data.lastUpdated = Date.now();
    writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[queue] erro ao salvar fila.json:', e.message);
  }
}

// carrega na inicialização do módulo
load();

// ── API pública ───────────────────────────────────────────────

// adiciona um usuário na fila. retorna { position, status }.
// se já tá processando ou na fila, não duplica.
export function enqueue(userId, nick) {
  // já tá processando?
  if (data.processando && data.processando.userId === userId) {
    return { position: 0, status: 'processando' };
  }
  // já tá na fila?
  const idxFila = data.fila.findIndex(e => e.userId === userId);
  if (idxFila >= 0) {
    return { position: idxFila + 1, status: 'aguardando' };
  }

  data.fila.push({
    userId: String(userId),
    nick: nick || '—',
    addedAt: Date.now(),
    tasksTotal: 0,
  });
  save();

  console.log(`[queue] ${nick} (userId=${userId}) entrou na fila — posição ${data.fila.length}`);
  return { position: data.fila.length, status: 'aguardando' };
}

// remove um usuário da fila (cancelou ou saiu).
export function removeFromQueue(userId) {
  const antes = data.fila.length;
  data.fila = data.fila.filter(e => e.userId !== String(userId));
  const removed = data.fila.length < antes;
  if (removed) {
    save();
    console.log(`[queue] userId=${userId} removido da fila`);
  }
  return removed;
}

// retorna a posição de um usuário:
//   -1 = não tá na fila nem processando
//    0 = tá processando agora
//  1+ = posição na fila
export function getPosition(userId) {
  if (data.processando && data.processando.userId === String(userId)) return 0;
  const idx = data.fila.findIndex(e => e.userId === String(userId));
  return idx >= 0 ? idx + 1 : -1;
}

// retorna status de um usuário: 'processando' | 'aguardando' | 'ausente'
export function getStatus(userId) {
  const pos = getPosition(userId);
  if (pos === 0) return 'processando';
  if (pos > 0) return 'aguardando';
  return 'ausente';
}

// tem alguém processando agora?
export function isProcessing() {
  return data.processando !== null;
}

// é ESTE usuário que tá processando?
export function isProcessingUser(userId) {
  return data.processando && data.processando.userId === String(userId);
}

// pega o próximo da fila SEM remover (peek).
export function peekNext() {
  return data.fila[0] || null;
}

// marca um usuário como "processando" (remove da fila e preenche processando).
// se tasksTotal for dado, atualiza.
export function startProcessing(userId, tasksTotal = 0) {
  const idx = data.fila.findIndex(e => e.userId === String(userId));
  const entry = idx >= 0 ? data.fila[idx] : null;

  // remove da fila
  if (idx >= 0) data.fila.splice(idx, 1);

  data.processando = {
    userId: String(userId),
    nick: entry?.nick || '—',
    startedAt: Date.now(),
    tasksDone: 0,
    tasksTotal: tasksTotal || entry?.tasksTotal || 0,
    currentTask: null,
  };
  save();
  console.log(`[queue] ${data.processando.nick} (userId=${userId}) começou a processar (${tasksTotal} tarefas)`);
}

// atualiza progresso do processamento atual.
export function updateProgress(done, total, currentTask = null) {
  if (!data.processando) return;
  data.processando.tasksDone = done;
  data.processando.tasksTotal = total;
  if (currentTask != null) data.processando.currentTask = currentTask;
  // salva a cada 3 atualizações pra não spammar disco
  if (done % 3 === 0 || done === total) save();
}

// finaliza o processamento atual. retorna quem era (pra notificar).
export function finishProcessing() {
  const finished = data.processando;
  data.processando = null;
  save();
  if (finished) {
    console.log(`[queue] ${finished.nick} (userId=${finished.userId}) terminou de processar`);
  }
  return finished;
}

// retorna a fila completa + quem tá processando.
export function getQueueStatus() {
  return {
    fila: data.fila.map((e, i) => ({
      position: i + 1,
      userId: e.userId,
      nick: e.nick,
      addedAt: e.addedAt,
      waitTimeMs: Date.now() - e.addedAt,
    })),
    processando: data.processando ? {
      userId: data.processando.userId,
      nick: data.processando.nick,
      startedAt: data.processando.startedAt,
      tasksDone: data.processando.tasksDone,
      tasksTotal: data.processando.tasksTotal,
      currentTask: data.processando.currentTask,
      elapsedMs: Date.now() - data.processando.startedAt,
    } : null,
  };
}

// quantas pessoas tão na fila (esperando, não conta quem tá processando).
export function queueLength() {
  return data.fila.length;
}

// limpa a fila inteira (admin / debug).
export function clearQueue() {
  data.fila = [];
  data.processando = null;
  save();
  console.log('[queue] fila limpa');
}

// ── helpers pra UI do Discord ─────────────────────────────────

// texto legível da posição do usuário.
export function positionText(userId) {
  const status = getStatus(userId);
  if (status === 'processando') return '🚀 **Sua vez!** processando agora...';
  if (status === 'ausente') return null;
  const pos = getPosition(userId);
  const total = queueLength();
  const ahead = pos - 1;
  if (ahead === 0) return `✅ **Próxima(o)!** Você é a próxima pessoa da fila.`;
  return `🕒 **${pos}º na fila** — ${ahead} pessoa(s) na sua frente. Aguarde sua vez.`;
}

// resumo da fila pra embed do Discord.
export function queueSummary() {
  const s = getQueueStatus();
  const linhas = [];
  if (s.processando) {
    const pct = s.processando.tasksTotal
      ? Math.round((s.processando.tasksDone / s.processando.tasksTotal) * 100)
      : 0;
    linhas.push(`🚀 **${s.processando.nick}** processando — ${s.processando.tasksDone}/${s.processando.tasksTotal} tarefas (${pct}%)`);
  }
  for (const e of s.fila) {
    const espera = Math.round((Date.now() - e.addedAt) / 60_000);
    linhas.push(`⏳ **${e.nick}** — ${e.position}º na fila (esperando ${espera}min)`);
  }
  if (!linhas.length) return 'Ninguém na fila.';
  return linhas.join('\n');
}
