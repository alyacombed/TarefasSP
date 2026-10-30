// agendador da automação premium.
// roda TODO DIA às 16:30 (horário de Brasília): percorre as contas premium
// ativas, re-loga com a senha salva, busca as pendências e resolve no modo
// que o aluno escolheu (rascunho ou definitivo — acc.autoMode).
// tarefas vencidas entram por padrão (acc.autoExpired !== false).
// expirados são rebaixados a 'free'; falha de login avisa o aluno por DM.
import { config, hitRateEfetivo } from './config.js';
import { login } from './sed.js';
import { tasksTodo, isExpired, separarPendentes } from './edusp.js';
import { solveTasksParallel, rascunhoContaminado } from './solver.js';
import { allPremiumContas, eachConta, setContaPlan, patchConta, isPremiumActive } from './store.js';
import { enfileirarRodada, rodadasAtivas } from './fila.js';
import { qtdChavesGroq } from './ai.js';

// 16:30 em São Paulo = 19:30 UTC (Brasil é UTC-3 fixo desde o fim do horário
// de verão em 2019, então dá pra cravar em UTC sem biblioteca de timezone).
const CICLO_HORA_UTC = 19;
const CICLO_MIN_UTC = 30;
const DIA_MS = 24 * 3600_000;

// espaçamento entre uma conta premium e a seguinte: cada conta roda
// ESCALON_MS depois da anterior (16:30, 16:45, 17:00…) pra nunca duas
// resolverem juntas e estourar a cota da IA.
const ESCALON_MS = Math.max(1, config.plan.staggerMinutes) * 60_000;

// timestamp (ms) da PRÓXIMA 16:30 de Brasília a partir de agora.
export function proximaRodadaMs(agora = Date.now()) {
  const d = new Date(agora);
  const hojeAlvo = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), CICLO_HORA_UTC, CICLO_MIN_UTC, 0);
  return hojeAlvo > agora ? hojeAlvo : hojeAlvo + DIA_MS;
}

// horário exato em que UMA conta premium roda no próximo ciclo:
// base 16:30 + índice na fila ordenada × espaçamento. null se não for premium.
export function horarioDaConta(userId, key) {
  const contas = allPremiumContas()
    .sort((a, b) => `${a.userId}|${a.key}`.localeCompare(`${b.userId}|${b.key}`));
  const i = contas.findIndex(c => c.userId === String(userId) && c.key === String(key));
  if (i < 0) return null;
  return proximaRodadaMs() + i * ESCALON_MS;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// envia DM ao aluno (silencioso em caso de erro/DM fechada).
async function dm(client, userId, payload) {
  try {
    const u = await client.users.fetch(userId);
    await u.send(payload);
  } catch { /* DM fechada, ignora */ }
}

// processa UMA conta de aluno premium. devolve { ok, fail } ou lança em falha de login.
async function runAccount(client, acc) {
  // modo de envio da conta: 'draft' (padrão) ou 'submitted' (definitivo).
  const draft = acc.autoMode
    ? acc.autoMode !== 'submitted'
    : config.defaultSubmitMode !== 'submitted';

  // re-loga (token expira; precisamos da senha salva)
  let sess;
  try {
    sess = await login({ ra: acc.ra, dg: acc.dg, uf: acc.uf, senha: acc.senha });
  } catch (e) {
    patchConta(acc.userId, acc.key, { lastError: `login: ${e.message}`, lastRun: Date.now() });
    await dm(client, acc.userId,
      '⚠️ **Automação pausada** — não consegui entrar na sua conta da Sala do Futuro ' +
      '(senha alterada ou indisponível). Use **Trocar RA** no painel para revincular.');
    throw e;
  }

  // busca pendentes (mesmo filtro do fluxo manual). pede 'all' porque o site
  // lista as vencidas numa chamada separada (expired_only=true) — e aí dá pra
  // mostrar no DM quantas eram. ESCOPO do bot: só tarefa OBJETIVA e VENCIDA.
  //   acc.autoExpired === false = o dono ligou "também as normais" no painel.
  // prova e redação saem em separarPendentes (foraDoEscopo) — não adianta
  // queimar cota de IA com tarefa que o bot nem pode entregar.
  const tambemNormais = acc.autoExpired === false;
  const all = await tasksTodo(sess.token, sess.nick, [], { expired: 'all' });
  const sep = separarPendentes(all);
  const vencidasTodas = (all || []).filter(isExpired);
  const nBloqueadas = vencidasTodas.length - sep.expiradas.length;
  const pend = tambemNormais ? sep.todas : sep.expiradas;
  const nExpiradas = sep.expiradas.length;

  // ANTI-NaN: rascunho com entrada SEM `answer` (info/media vazias de versões
  // antigas do bot) NÃO pode ser tocado — o PUT da plataforma funde e nunca
  // limpa essas entradas, e enviar a tarefa assim faz o grader voltar NaN.
  // fica de fora do ciclo até alguém resetar a resposta manualmente.
  const contaminadas = pend.filter(t => rascunhoContaminado(t && t.answer_answers));
  const aResolver = pend.filter(t => !rascunhoContaminado(t && t.answer_answers));
  if (contaminadas.length) {
    console.warn(`[automation] ${sess.nick}: ${contaminadas.length} tarefa(s) com rascunho CONTAMINADO (resposta vazia salva por versão antiga) — NÃO enviadas; exigem limpeza manual na plataforma.`);
    try {
      await dm(client, acc.userId,
        `⚠️ **${contaminadas.length} tarefa(s)** estão com rascunho contaminado (resposta vazia salva por uma versão antiga do bot). Não enviei pra não virar **nota NaN** — resete/limpe a resposta na plataforma manualmente:\n\n` +
        contaminadas.map(t => `• \`#${t.id}\` ${String(t.title || '').slice(0, 60)}`).join('\n'));
    } catch { /* DM é best-effort */ }
  }

  // entra na MESMA fila global do modo manual. divisão dinâmica: rodando
  // sozinha (caso normal às 16:30) usa TODAS as chaves Groq em paralelo;
  // se alguém estiver resolvendo na mão, divide as chaves entre as rodadas.
  // cada tarefa paralela ganha uma chave Groq exclusiva dentro da rodada.
  const { resultado } = enfileirarRodada(
    `auto:${acc.nick || acc.userId}:${Date.now()}`,
    () => {
      const k = qtdChavesGroq();
      const conc = Math.max(1, Math.min(k, Math.round(k / Math.max(1, rodadasAtivas()))));
      return solveTasksParallel(aResolver, {
        token: sess.token, nick: sess.nick, draft,
        hitRate: hitRateEfetivo(acc.hitRate),
        concorrenciaMaxima: conc,
        groqIndex: k > 1 ? Math.floor(Math.random() * k) : null,
      });
    },
  );
  const resultados = await resultado;
  const ok = resultados.filter(r => r?.ok).length;
  const fail = aResolver.length - ok;

  patchConta(acc.userId, acc.key, { lastRun: Date.now(), lastError: null });
  if (aResolver.length) {
    const verbo = draft
      ? 'preenchida(s) em **RASCUNHO** (confira e envie por conta)'
      : 'enviada(s) em **DEFINITIVO**';
    const parteVencidas = tambemNormais && nExpiradas
      ? ` ⏰ (${nExpiradas} vencida(s) incluídas; o padrão do bot é só vencida)`
      : '';
    const parteBloqueio = nBloqueadas
      ? ` 🔒 ${nBloqueadas} fora do escopo do bot (provas / pedem código de acesso).`
      : '';
    await dm(client, acc.userId,
      `🤖 **Automação concluída** — \`${acc.nick || acc.ra}\`: ${ok}/${aResolver.length} tarefa(s) ${verbo}.${parteVencidas}${parteBloqueio}` +
      (fail ? ` (${fail} falharam; tento de novo amanhã às 16:30.)` : ''));
  }
  return { ok, fail };
}

// roda o dia inteiro de contas premium, UMA POR VEZ, escalonado:
// conta #1 no horário do ciclo, #2 ESPALHAMENTO depois, #3 mais ESPALHAMENTO…
// o await sequencial garante fisicamente que duas contas NUNCA resolvem
// juntas — mesmo se uma atrasar, a seguinte só começa quando ela terminar.
async function runCycle(client) {
  const contas = allPremiumContas()
    .sort((a, b) => `${a.userId}|${a.key}`.localeCompare(`${b.userId}|${b.key}`))
    .filter(c => !(c.lastRun && Date.now() - c.lastRun < 23 * 3600_000)); // anti-duplo-envio

  if (!contas.length) { console.log('[auto] ciclo: nenhuma conta premium pendente'); return; }
  const passo = Math.round(ESCALON_MS / 60000);
  console.log(`[auto] fila de hoje: ${contas.length} conta(s), espaçadas de ${passo} em ${passo} min`);

  const base = Date.now();
  for (let i = 0; i < contas.length; i++) {
    const acc = contas[i];
    const slot = base + i * ESCALON_MS;
    const espera = slot - Date.now();
    if (espera > 0) {
      console.log(`[auto] ${acc.nick || acc.userId}: vez em ${Math.round(espera / 60000)} min (fila #${i + 1})`);
      await delay(espera);
    } else {
      console.log(`[auto] ${acc.nick || acc.userId}: rodando agora (fila #${i + 1}, atrasada)`);
    }
    try {
      const r = await runAccount(client, acc);
      console.log(`[auto] ${acc.nick || acc.userId}: ${r.ok} ok, ${r.fail} erro`);
    } catch (e) {
      console.warn(`[auto] ${acc.nick || acc.userId}: falha — ${e.message}`);
    }
  }
}

// rebaixa contas vencidas pra free e avisa o aluno (uma vez por conta).
function expireSweep(client) {
  for (const c of eachConta()) {
    if (c.plan === 'premium' && c.premiumUntil && c.premiumUntil <= Date.now()) {
      setContaPlan(c.userId, c.key, 'free', null);
      dm(client, c.userId,
        `⌛ O plano da conta \`${c.nick || c.key}\` expirou. ` +
        'Para renovar a automação, use **Comprar** no painel.');
    }
  }
}

// inicia o agendador: dispara todo dia às 16:30 de Brasília.
export function startScheduler(client) {
  const passo = Math.round(ESCALON_MS / 60000);
  console.log(`[auto] scheduler iniciado — ciclo diário às 16:30 (Brasília), contas escalonadas de ${passo} em ${passo} min`);

  (async () => {
    for (;;) {
      const alvo = proximaRodadaMs();
      const espera = alvo - Date.now();
      console.log(`[auto] próximo ciclo: ${new Date(alvo).toISOString()} (em ${Math.round(espera / 60000)} min)`);
      await delay(espera + 500); // folga de 0.5s pra não disparar 1s antes

      try {
        expireSweep(client);
        await runCycle(client);
      } catch (e) {
        console.error('[auto] erro no ciclo:', e.message);
      }
    }
  })();

  // varredura de planos expirados a cada hora, independente do ciclo
  setInterval(() => { try { expireSweep(client); } catch { /* ignora */ } }, 3600_000);
}

// exporta pra teste manual / botão admin.
export { runCycle, runAccount, isPremiumActive };
