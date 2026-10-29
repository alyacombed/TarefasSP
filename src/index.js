// bot Discord — "Tarefas Automáticas".
// UI v3: painel fixo com identidade visual própria, cartões de status,
// barra de progresso ao vivo e fluxo de compra em passos.
// conta grátis = aluno resolve manualmente (rascunho/definitivo).
// conta paga  = automação diária às 16:30 (rascunho ou definitivo, à escolha — ver automation.js).
import {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { config, assertConfig, hitRateEfetivo } from './config.js';
import { login } from './sed.js';
import { tasksTodo, isExpired, foraDoEscopo, separarPendentes } from './edusp.js';
import { solveTasksParallel, rascunhoContaminado } from './solver.js';
import { buildPixCode, qrImageUrl } from './pix.js';
import { upsertAccount, getAccount, isPremiumActive, listAccounts, switchAccount, patchConta, setContaPlan, removeConta } from './store.js';
import { startScheduler, horarioDaConta } from './automation.js';
import { enfileirarRodada, configurarVagas, rodadasAtivas } from './fila.js';
import { enqueue, removeFromQueue, getPosition, getStatus, isProcessing, isProcessingUser, finishProcessing, peekNext, getQueueStatus, queueLength, startProcessing, updateProgress, positionText, queueSummary } from './userQueue.js';
import { qtdChavesGroq, apiKeyCount, provedoresReserva } from './ai.js';
import { logProxyStatus } from './proxy.js';
import {
  registrarEnvioCaptcha, habilidadeEnvioCaptcha, pedirRespostaHumana,
  obterPendencia, submitResposta, cancelar,
} from './humanCaptcha.js';
import { painelChannelId, painelChannelVemDoEnv, salvarPainelChannel } from './panelChannel.js';

assertConfig();
logProxyStatus();

// ============================================================
//  RESILIÊNCIA + FILA GLOBAL
// ============================================================
// erros assíncronos não tratados NÃO derrubam mais o bot — logam e seguem vivos.
process.on('unhandledRejection', (r) => console.error('[guarda] unhandledRejection:', r?.stack || r));
process.on('uncaughtException', (e) => console.error('[guarda] uncaughtException:', e?.stack || e));

// 1 vaga na fila global por chave Groq do pool (5 chaves = 5 pessoas simultâneas)
configurarVagas(qtdChavesGroq());
console.log(`[boot] fila global com ${qtdChavesGroq()} vaga(s) simultânea(s) (1 por chave Groq)`);
console.log(`[boot] reserva de IA: ${provedoresReserva().map(r => `${r.nome} (${r.chaves} chave(s), ${r.modelos.length} modelo(s))`).join(', ') || 'nenhuma (Groq+Gemini diretos)'}`);

// distribuição circular das pessoas entre as chaves do pool
let proximoSlotGroq = 0;

// ============================================================
//  FILA DE USUÁRIOS (processamento sequencial)
// ============================================================
const MAX_CONCORRENCIA_FILA = 5; // máx de tarefas simultâneas por usuário na fila
const PROCESSAMENTO_FILA = new Map(); // userId -> { cancelar: bool, encerrar: bool }

// notifica o usuário por DM quando sua vez chega ou quando termina.
async function dmFila(userId, payload) {
  try {
    const u = await client.users.fetch(userId);
    await u.send(payload);
  } catch { /* DM fechada, ignora */ }
}

// ── CAPTCHA HUMANO (fallback quando a IA não dá conta) ──────────────
// envia a imagem + botão "✍️ Colocar texto" pra DM do usuário (canal privado).
// o id é embutido no customId do botão; quando o usuário digita a resposta
// num modal, o handler de interação resolve a pendência registrada aqui.
async function enviarCaptchaHumano(userId, id, info) {
  const tituloTarefa = info?.taskTitle ? `\`${String(info.taskTitle).slice(0, 50)}\`` : 'a tarefa';
  const msgAntiga = `A IA não conseguiu ler o CAPTCHA **${tituloTarefa}**.\n` +
    `Leia o texto da imagem abaixo e clique em **✍️ Colocar texto** para digitar o que está escrito.\n` +
    `*(responda rapidinho — o CAPTCHA expira e, se demorar, eu te mando uma imagem nova automaticamente).*`;

  const emb = brand({ color: C_WARNING })
    .setTitle('🧩 CAPTCHA — preciso da sua ajuda!')
    .setDescription(msgAntiga)
    .setImage(`attachment://captcha_${id}.png`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`captcha_inp_${id}`)
      .setLabel('✍️ Colocar texto')
      .setEmoji('⌨️')
      .setStyle(ButtonStyle.Primary),
  );

  const buf = Buffer.from(info?.imageBase64 || '', 'base64');
  const u = await client.users.fetch(userId);
  if (!buf.length) {
    await u.send({ embeds: [emb], components: [row] });
    return;
  }
  await u.send({
    embeds: [emb],
    files: [{ attachment: buf, name: 'captcha.png' }],
    components: [row],
  });
}

// cria o callback humano de UMA tarefa (passado ao solver via makeHumanCallback).
// quando a IA falha, o solver chama isto → registra a pendência, envia o DM e
// aguarda a resposta do usuário.
function criarHumanCaptchaCallback(userId, taskTitle) {
  return (info) =>
    pedirRespostaHumana(userId, { ...info, taskTitle });
}

// processa as tarefas de UM usuário (chamado quando é a vez dele na fila).
async function processarFila(userId, client) {
  // sessão em memória pode não existir após um restart do bot; a conta
  // salva (`getAccount`) é a fonte da verdade — com ela dá pra re-logar.
  // só pula quem não tem NEM sessão NEM conta salva.
  const sess = getSession(userId);
  const acc = getAccount(userId);
  if (!sess && !acc) {
    console.warn(`[queue] userId=${userId} não tem sessão nem conta salva — pulando`);
    finishProcessing();
    await processarProximoFila(client);
    return;
  }

  // re-loga (token pode ter expirado; também cobre quem chegou da fila após
  // um restart sem sessão em memória — a conta salva é suficiente).
  if (!acc) {
    console.warn(`[queue] userId=${userId} não tem conta salva — pulando`);
    finishProcessing();
    await processarProximoFila(client);
    return;
  }

  let novaSessao;
  try {
    novaSessao = await login({ ra: acc.ra, dg: acc.dg, uf: acc.uf, senha: acc.senha });
  } catch (e) {
    console.warn(`[queue] userId=${userId} falhou no login: ${e.message}`);
    await dmFila(userId, `
⚠️ **Sua vez chegou**, mas não consegui entrar na sua conta.
• Erro: \`${e.message}\`
• Use o botão **Trocar RA** no painel para atualizar seus dados.
• Sua posição na fila será mantida.`);
    finishProcessing();
    await processarProximoFila(client);
    return;
  }

  // busca pendências (inclui as vencidas — a fila resolve tudo que falta e é
  // possível abrir). Prova e `enable_token` já caem fora em separarPendentes.
  let pend;
  try {
    const all = await tasksTodo(novaSessao.token, novaSessao.nick, [], { expired: 'all' });
    pend = separarPendentes(all).todas;
  } catch (e) {
    console.warn(`[queue] userId=${userId} erro ao buscar tarefas: ${e.message}`);
    await dmFila(userId, `
⚠️ **Sua vez chegou**, mas houve um erro ao buscar tarefas.
• Detalhes: \`${e.message}\`
• Por favor, tente novamente mais tarde ou use **Trocar RA** se o problema persistir.
• Sua posição na fila permanece intacta.`);
    finishProcessing();
    await processarProximoFila(client);
    return;
  }

  if (!pend.length) {
    console.log(`[queue] userId=${userId} sem tarefas pendentes — pulando`);
    await dmFila(userId, `
✅ **Sua vez chegou**, mas não tem nenhuma tarefa pendente.
• \`${nomeAluno}\` está com tudo em dia!
• Todas as tarefas já foram resolvidas ou estão no prazo.
• Volte à fila quando novas tarefas surgirem.`);
    finishProcessing();
    await processarProximoFila(client);
    return;
  }

  // atualiza progresso total (já tá marcado como processando pelo processarProximoFila)
  updateProgress(0, pend.length, null);

  // notifica o usuário
  const nomeAluno = novaSessao.nick || acc.nick || '—';
  await dmFila(userId, `
🚀 **Sua vez!** Iniciando processamento de \`${pend.length}\` tarefa(s) para \`${nomeAluno}\`.
• O bot está resolvendo suas tarefas vencidas usando IA.
• Você receberá uma DM quando a resolução for concluída.
• Use o botão **Cancelar** no painel se quiser interromper.`);

  // cria controle de cancelamento pra esta rodada
  const ctl = { cancelar: false };
  PROCESSAMENTO_FILA.set(userId, ctl);

  const inicioTs = Date.now();
  let ok = 0;

  try {
    const k = qtdChavesGroq();
    const conc = Math.min(MAX_CONCORRENCIA_FILA, Math.max(1, k));

    const errosProposito = []; // tarefas em que o bot errou de propósito (taxa de acertos)
    const resultados = await solveTasksParallel(pend, {
      token: novaSessao.token,
      nick: novaSessao.nick,
      draft: true, // rascunho por padrão na fila
      hitRate: hitRateEfetivo(acc?.hitRate),
      concorrenciaMaxima: conc,
      groqIndex: k > 1 ? (proximoSlotGroq++) % k : null,
      makeHumanCallback: (t) => criarHumanCaptchaCallback(userId, t?.title),
      deveCancelar: () => ctl.cancelar,
      onTick: (snap) => {
        for (const a of snap.ativas) {
          updateProgress(snap.feito, snap.total, a.nome);
        }
      },
      onResultado: (pos, okTarefa) => {
        if (okTarefa) ok++;
      },
      onMissed: (taskId, qids) => {
        const t = pend.find(x => x.id === taskId);
        errosProposito.push({ nome: t?.title || String(taskId).slice(0, 30), q: qids.length });
      },
    });

    const boas = resultados.filter(r => r?.ok).length;
    const fail = pend.length - boas;
    const tempoMs = Date.now() - inicioTs;

    const fmt = (ms) => {
      const s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    };

    const parteErros = errosProposito.length
      ? `\n🎯 **Errado de propósito (taxa de acertos):** ${errosProposito.map(e => `\`${e.nome}\` (${e.q})`).join(', ')}`
      : '';
    const statusEmoji = ok === pend.length ? '🟢' : ok > 0 ? '🟡' : '🔴';
    await dmFila(userId, `
${statusEmoji} **Resolução ${ok === pend.length ? 'concluída' : 'finalizada'}!**
• Aluno: \`${nomeAluno}\`
• • ${boas}/${pend.length} tarefa(s) ${ok === pend.length ? 'resolvida(s)' : `concluída(s)`}
• ⏰ Tempo: \`${fmt(tempoMs)}\`
${partErros ? parteErros : ''}
${ok === pend.length ? '• **Parabéns!** Todas as tarefas foram processadas com sucesso.' : ''}
`);
    sess.ts = Date.now();
  } catch (e) {
    console.error(`[queue] userId=${userId} erro na resolução: ${e.message}`);
    await dmFila(userId, `❌ **Erro na resolução**: \`${e.message}\`. Sua vez foi processada mas com falhas.`);
  } finally {
    PROCESSAMENTO_FILA.delete(userId);
    finishProcessing();
    await processarProximoFila(client);
  }
}

// avança a fila: pega o próximo e processa.
async function processarProximoFila(client) {
  if (isProcessing()) return; // já tem alguém

  const proximo = peekNext();
  if (!proximo) {
    console.log('[queue] fila vazia — ninguém pra processar');
    return;
  }

  startProcessing(proximo.userId, proximo.tasksTotal || 0);

  // processa em background (não bloqueia o bot)
  processarFila(proximo.userId, client).catch(e => {
    console.error(`[queue] erro fatal ao processar userId=${proximo.userId}:`, e.message);
    finishProcessing();
    processarProximoFila(client);
  });
}

// retoma a fila de USUÁRIOS se ela estiver parada: tem gente esperando
// (`queueLength() > 0`) mas ninguém processando. acontece depois de restart
// do bot (o userQueue.js limpa o `processando` zumbi mas a fila persistida
// fica órfã, esperando pra sempre), ou se a thread de processamento morreu.
// roda no boot e num watchdog periódico pra se curar sozinho.
function retomarFilaSeParada(client) {
  if (queueLength() === 0 || isProcessing()) return;
  console.warn(`[queue] fila órfã em recuperação: ${queueLength()} pessoa(s) aguardando e ninguém processando — puxando a próxima`);
  processarProximoFila(client).catch(() => {});
}

// ============================================================
//  IDENTIDADE VISUAL
// ============================================================
const NOME_BOT = 'OrbitStore';
const VERSAO = 'v2.0';

const C_BASE   = 0x23272f;  // fundo suave
const C_ACAO   = 0x5865f2;  // blurple ação principal
const C_PRIMARY   = 0x5865f2;       // blurple discord principal
const C_SUCCESS   = 0x22c55e;       // verde conclusão
const C_ERROR     = 0xf87171;       // vermelho erro
const C_WARNING   = 0xf59f0d;       // dourado/laranja aviso
const C_INFO      = 0x64748b;       // azul info/texto secundário
const C_AVATAR    = 0x2f3136;       // corpo de embed

const COLOR_NOMES = {
  primary: C_PRIMARY,
  success: C_SUCCESS,
  error: C_ERROR,
  warning: C_WARNING,
  info: C_INFO,
  base: C_BASE
};

function brand(opts = {}) {
  const color = opts.color || C_BASE;
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: `${NOME_BOT} • ${VERSAO}`, iconURL: opts.iconURL })
    .setTimestamp()
    .setAuthor({ name: NOME_BOT, iconURL: 'https://cdn.discordapp.com/embed/avatars/0.png' });
}

// Estilo consistente para embeds de ação
function embedTitulo(texto, color = C_PRIMARY) {
  return { title: texto, color };
}

function embedDesc(texto, inline = false) {
  return { description: texto, inline };
}

// barra de progresso visual por tarefa
// usa blocos cheios + meio-cheio + vazios para mais precisão
function barraProgresso(feitas, totalQ, tamanho = 12) {
  if (!totalQ || totalQ === 0) return '░'.repeat(tamanho);
  const pct = Math.min(1, feitas / totalQ);
  const cheio = Math.floor(pct * tamanho);
  const meio = (pct * tamanho % 1 >= 0.4) ? 1 : 0;
  const vazio = tamanho - cheio - meio;
  return `${'█'.repeat(cheio)}${meio > 0 ? '▏' : ''}${'.'.repeat(vazio)}`;
}

// Versão antiga mantida para compatibilidade
function barraMini(feitas, totalQ, tamanho = 12) {
  return barraProgresso(feitas, totalQ, tamanho);
}

// Formata duração em hh:mm:ss ou mm:ss ou ss
function fmtDuracao(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

// Lista numerada e enriquecida das tarefas
// 📝 ao lado = já tem rascunho salvo
// ⏰ em vermelho = vencida
// 🔄 em azul = em processamento
// ⏳ tempo estimado ao lado
function listaTarefas(tasks, max = 10, marcar = false, taEmRascunho = null, mostrarTempo = true) {
  const ehRascunho = taEmRascunho || ((t) => t.answer_status === 'draft');
  const tarefas = tasks.slice(0, max);
  const linhas = tarefas.map((t, n) => {
    const partes = [`\`${String(n + 1).padStart(2, '0')}\` ${String(t.title || t.id).slice(0, 55)}`];
    
    // Status de vencimento
    if (isExpired(t)) {
      partes.push('⏰ **vencida**');
    }
    
    // Status de rascunho
    if (marcar && ehRascunho(t)) {
      partes.push('📝 **rascunho**');
    }
    
    // Tempo estimado se disponível
    if (mostrarTempo && t.tempoEstimado) {
      const tempoTxt = fmtDuracao(t.tempoEstimado);
      partes.push(`⏳ ~${tempoTxt}`);
    }
    
    return partes.join(' · ');
  }).join('\n');
  
  return linhas + (tasks.length > max ? `\n… e mais ${tasks.length - max} tarefas` : '');
}

// horário EXATO da conta ativa no ciclo diário (16:30 + posição na fila × 15 min)
function slotDaAtiva(userId, acc) {
  const key = acc?.ativoRa || listAccounts(userId)[0]?.key;
  if (!key) return null;
  const ms = horarioDaConta(userId, key);
  return ms ? Math.floor(ms / 1000) : null;
}

const LINHA_DIV = '─────────────────────';

// sessões curtas em memória pro fluxo manual: userId -> { token, nick, aluno, tasks, ts }
const sessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 2; // 2h

// resoluções EM ANDAMENTO: userId -> { cancelar: bool } — o botão 🛑 usa isso.
const rodadasUI = new Map();

function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_TTL) { sessions.delete(userId); return null; }
  return s;
}

// busca as pendências da sessão. pede `expired: 'all'` porque o site lista as
// vencidas numa chamada separada (expired_only=true) — assim a sessão tem a
// lista inteira e o painel consegue mostrar quantas já venceram.
// `sess.incluirExpiradas` só decide o que o painel OFERECE pra resolver.
async function carregarTarefas(sess) {
  const all = await tasksTodo(sess.token, sess.nick, [], { expired: 'all' });
  const sep = separarPendentes(all);
  sess.tasks = sep.todas;
  return sep;
}

// o ESCOPO do bot: só tarefa objetiva, já vencida. foi o que o dono pediu —
// "só as expiradas, nada das normais, nada de prova ou redação".
//   sess.somenteExpiradas === false = o dono ligou o modo "também as normais"
//     no botão ⏰; o resto do tempo o bot só encosta em tarefa vencida.
function tarefasAlvo(sess) {
  const escopo = (sess.tasks || []).filter(t => !foraDoEscopo(t));
  return sess.somenteExpiradas === false ? escopo : escopo.filter(isExpired);
}

// "em rascunho" = status 'draft' OU já tem answer_id salvo na plataforma
// (algumas respostas voltam sem o status preenchido, mas com answer_id).
function taEmRascunho(t) {
  return t.answer_status === 'draft' || !!t.answer_id;
}

// "modo expirado" = o bot só encosta em tarefa vencida (padrão do dono).
function modoExpirado(sess) {
  return sess.somenteExpiradas !== false;
}

// quantas vencidas o bot pode chegar a resolver. `tasksTodo`/`separarPendentes`
// já filtram o escopo, mas a sessão pode vir de cache gravado antes disso —
// o filtro aqui evita o painel anunciar "vencidas" que na verdade não são.
function contarExpiradas(sess) {
  return (sess.tasks || []).filter(t => isExpired(t) && !foraDoEscopo(t)).length;
}

// quantas vencidas existem mas são prova/redação/token — o painel mostra isso
// pra o dono não achar que o bot "esquceu" delas.
function contarExpiradasComToken(sess) {
  return (sess.tasks || []).filter(t => isExpired(t) && foraDoEscopo(t)).length;
}

// GuildMessages + MessageContent: necessários pro comando !tarefas no chat.
// MessageContent é privilegiado — se estiver desligado no portal do Discord,
// o login cai automaticamente pro modo base (bot funciona, só o !tarefas fica off).
const INTENTS_BASE = [GatewayIntentBits.Guilds];
const INTENTS_CHAT = [...INTENTS_BASE, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
const client = new Client({ intents: INTENTS_CHAT });

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ logado como ${c.user.tag}`);
  console.log(`   modo de envio padrão: ${config.defaultSubmitMode}`);
  registrarEnvioCaptcha(enviarCaptchaHumano);
  console.log(`   captcha humano: ${habilidadeEnvioCaptcha() ? 'ativo' : 'indisponível'}`);
  // SEM pré-aquecimento de Chrome: os dois navegadores agora sobem SOZINHOS na
  // primeira vez que realmente são necessários. o da API só é aberto se o
  // Cloudflare desafiar o curl (ver transporteEdusp em http.js) e o do OCR só no
  // primeiro captcha. antes ficavam ~375 MB de perfil + processo residentindo o
  // tempo todo, inclusive com o bot ocioso em locais de RAM apertada (Railway).
  await postFixedPanel(c).catch(e => console.error('[painel] falha ao postar:', e.message));
  await varrerServidorDoPainel(c).catch(e => console.error('[painel] varredura do server falhou:', e.message));
  startScheduler(c);
  // retoma a fila de usuários que pode ter ficado órfã após um restart;
  // watchdog de segurança roda a cada 30s pra auto-curar qualquer trava.
  retomarFilaSeParada(c);
  setInterval(() => { try { retomarFilaSeParada(c); } catch { /* ignora */ } }, 30_000);
});

// !tarefas (no chat): manda o painel ATUALIZADO no canal onde foi digitado
// (se já existir um painel do bot nesse canal, edita em vez de duplicar).
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;
    if ((msg.content || '').trim().toLowerCase() !== '!tarefas') return;
    const m = await atualizarPainelNoCanal(msg.channel, msg.client);
    console.log(`[!tarefas] painel ${m.editable && m.editedTimestamp ? 'atualizado' : 'postado'} em #${msg.channel.name} (${msg.guild.name})`);
  } catch (e) {
    console.error('[!tarefas] erro:', e.message);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'painel') return repostPanel(i);

    if (i.isButton()) {
      const id = i.customId;
      // pagamento: aprovar/recusar (só quem confere). formato: acao_idx_userId
      if (id.startsWith('approve_')) {
        const rest = id.slice('approve_'.length);
        const sp = rest.indexOf('_');
        return handleApprove(i, Number(rest.slice(0, sp)), rest.slice(sp + 1));
      }
      if (id.startsWith('reject_')) {
        const rest = id.slice('reject_'.length);
        const sp = rest.indexOf('_');
        return handleReject(i, Number(rest.slice(0, sp)), rest.slice(sp + 1));
      }
      // multi-contas: escolher uma das salvas
      if (id.startsWith('acc_pick_')) return handleUseSaved(i, Number(id.slice('acc_pick_'.length)));
      // multi-contas: remoção (confirmação ANTES do prefixo curto, senão colide)
      if (id.startsWith('acc_delyes_')) return doRemoveConta(i, Number(id.slice('acc_delyes_'.length)));
      if (id.startsWith('acc_del_')) return confirmRemoveConta(i, Number(id.slice('acc_del_'.length)));
      // multi-contas: escolher qual conta recebe o plano na compra
      if (id.startsWith('acc_pay_')) return showPayment(i, Number(id.slice('acc_pay_'.length)));
      // "já paguei" carrega o índice da conta-alvo
      if (id.startsWith('buy_paid_')) return handlePaid(i, Number(id.slice('buy_paid_'.length)));
      // captcha humano: botão que abre o modal pra digitar a resposta
      if (id.startsWith('captcha_inp_')) return abrirModalCaptcha(i, id.slice('captcha_inp_'.length));

      switch (id) {
        // painel fixo
        case 'acc_link':   return openAccountsMenu(i);
        case 'acc_add':    return openLoginModal(i, 'link');
        case 'acc_change': return openLoginModal(i, 'change');
        case 'acc_buy':    return showBuyIntro(i);
        case 'acc_info':   return showInfo(i);
        case 'acc_remove': return openRemocaoMenu(i);
        // compra
        case 'buy_ok':     return startPayment(i);
        case 'buy_qr':     return showQr(i);
        // resolução manual (conta grátis)
        case 'solve_draft':       return showDraftMenu(i);
        case 'solve_draft_todas': return runSolve(i, true);
        case 'solve_exp':         return solveExpiradas(i);
        case 'exp_toggle':        return alternarExpiradas(i);
        case 'auto_exp':          return toggleAutoExpiradas(i);
        case 'solve_draft_novas': {
          const sess = getSession(i.user.id);
          if (!sess) return replyExpired(i, true);
          // pula as que já têm rascunho (status 'draft' ou answer_id salvo)
          const alvo = tarefasAlvo(sess).filter(t => !taEmRascunho(t));
if (!alvo.length) {
              return i.reply({
                embeds: [{ color: C_INFO, title: 'ℹ️ Nada Novo', description: modoExpirado(sess)
                  ? '✅ **Todas as tarefas vencidas** já estão em rascunho.'
                  : '✅ **Todas as tarefas pendentes** já estão em rascunho.' }],
                flags: MessageFlags.Ephemeral,
              });
            }
          return runSolve(i, true, alvo);
        }
        case 'solve_exp_novas': return solveExpiradas(i, true);
        case 'solve_real':  return confirmReal(i);
        case 'solve_real_confirm': return runSolve(i, false);
        case 'solve_cancel': return cancelarRodada(i);
        case 'solve_cancel_fila': return cancelarFila(i);
        case 'panel_back':  return showActionPanel(i, true);
        case 'auto_mode':   return toggleAutoMode(i);
        case 'hit_rate':    return openHitRateModal(i);
        case 'logout':      return doLogout(i);
        // novo: seleção de modo de tarefa após login
        case 'task_mode_todas': return solveExpiradas(i);
        case 'task_mode_draft': return runSolve(i, true);
        case 'task_mode_send':  return runSolve(i, false);
        case 'task_mode_selector': return showTaskSelector(i);
        // novo: seletor de tarefas
        case 'task_selector_todas': return runSolve(i, true);
        case 'task_selector_draft': return runSolve(i, true); // simplificado - todas como rascunho
        case 'task_selector_vencidas': return solveExpiradas(i);
        case 'task_selector_normais': {
          const sess = getSession(i.user.id);
          if (!sess) return replyExpired(i, true);
          const alvo = sess.tasks.filter(t => !isExpired(t) && !foraDoEscopo(t));
          if (!alvo.length) return i.reply({ embeds: [{ color: C_INFO, title: 'ℹ️ Nenhuma no Prazo', description: '✅ **Todas as suas tarefas** ainda estão em rascunho.**' }], flags: MessageFlags.Ephemeral });
          return runSolve(i, true, alvo);
        }
      }
    }

    if (i.isModalSubmit()) {
      if (i.customId === 'modal_link')   return handleLogin(i, 'link');
      if (i.customId === 'modal_change') return handleLogin(i, 'change');
      if (i.customId === 'modal_hitrate') return handleHitRate(i);
      if (i.customId.startsWith('captcha_modal_')) return receberRespostaCaptcha(i, i.customId.slice('captcha_modal_'.length));
    }
  } catch (e) {
    console.error('[bot] erro na interação:', e);
    if (i.isRepliable() && !i.replied && !i.deferred) {
      i.reply({ content: `❌ erro: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ============================================================
//  PAINEL FIXO
// ============================================================
function painelEmbed(c) {
  const emb = brand(C_ACAO)
    .setTitle('🚀 Tarefas Automáticas')
    .setDescription(
      `**Bem-vindo(a) ao painel de tarefas automáticas!**\n\n` +
      `Suas tarefas do **Sala do Futuro** são resolvidas por IA.\n` +
      `• **Entrar** — use uma conta salva ou vincule seu RA\n` +
      `• **Comprar plano** — automação diária completa por 30 dias\n` +
      `• **Trocar RA** — atualize seus dados quando necessário\n` +
      `• **Informações** — detalhes de funcionamento e segurança\n\n` +
      `-# 🔒 Sua senha é cifrada e nunca aparece no servidor.\n` +
      `-# 🆓 Resolver na hora é grátis — o plano é só para automação diária.`,
    )
    .addFields(
      { name: '⚡ Capacidade', value: `${qtdChavesGroq()} resolução(ões) simultânea(s)`, inline: true },
      { name: '🧠 IA', value: 'Resolução inteligente — se a IA falhar, solicita ajuda humana', inline: true },
    );
  if (c?.user) emb.setThumbnail(c.user.displayAvatarURL({ size: 128 }));
  return emb;
}

function painelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('acc_link').setLabel('🔗 Entrar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('acc_buy').setLabel('💎 Comprar plano').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('acc_change').setLabel('🔁 Trocar RA').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('acc_info').setLabel('ℹ️ Informações').setStyle(ButtonStyle.Secondary),
  );
}

// posta/atualiza o painel num canal: edita se já houver um do bot, senão posta novo.
async function atualizarPainelNoCanal(ch, c) {
  const payload = { embeds: [painelEmbed(c)], components: [painelRow()] };
  const msgs = await ch.messages.fetch({ limit: 30 }).catch(() => null);
  const mine = msgs?.find(m => m.author.id === c.user.id
    && (m.embeds?.[0]?.title === '**Tarefas Automáticas**' || m.embeds?.[0]?.title === 'Tarefas Automáticas'));
  if (mine) { await mine.edit(payload); return mine; }
  return ch.send(payload);
}

// posta o painel no canal fixo; se já houver um do bot, edita em vez de duplicar.
async function postFixedPanel(c) {
  const id = painelChannelId();
  if (!id) {
    console.warn('[painel] canal fixo ainda não definido — rode /painel no canal onde ele deve ficar (ou defina PANEL_CHANNEL_ID no .env)');
    return;
  }
  const ch = await c.channels.fetch(id).catch(() => null);
  if (!ch) {
    // antes isso estourava "Unknown Channel" genérico a cada boot. agora diz o
    // que fazer — quase sempre é ID de servidor antigo/trocado.
    console.warn(`[painel] canal ${id} não existe mais ou o bot não está nele. Rode /painel no canal correto para o bot aprender o ID.`);
    return;
  }
  if (!ch.isTextBased()) {
    console.warn(`[painel] canal ${id} não aceita mensagens — painel fixo ignorado`);
    return;
  }
  const m = await atualizarPainelNoCanal(ch, c);
  console.log(`[painel] ${m.editable ? 'atualizado' : 'postado'} em #${ch.name} (${id})`);
}

// varre TODOS os canais do servidor do painel procurando painéis velhos do bot
// e atualiza cada um — garante que ninguém fique preso numa versão antiga da UI.
async function varrerServidorDoPainel(c) {
  const guild = await c.guilds.fetch(config.painelGuildId).catch(() => null);
  if (!guild) { console.warn('[painel] servidor do painel não encontrado'); return; }
  const canais = await guild.channels.fetch().catch(() => null);
  if (!canais) return;
  let atualizados = 0;
  for (const [, ch] of canais) {
    if (!ch || !ch.isTextBased() || ch.id === painelChannelId()) continue;
    try {
      const msgs = await ch.messages.fetch({ limit: 30 });
      const meus = msgs.filter(m => m.author.id === c.user.id
        && (m.embeds?.[0]?.title === '**Tarefas Automáticas**' || m.embeds?.[0]?.title === 'Tarefas Automáticas'));
      for (const [, m] of meus) {
        await m.edit({ embeds: [painelEmbed(c)], components: [painelRow()] }).catch(() => {});
        atualizados++;
      }
    } catch { /* sem acesso ao canal, segue */ }
  }
  console.log(`[painel] varredura do server: ${atualizados} painel(is) antigo(s) atualizado(s)`);
}

// /painel: dono/conferente OU quem tem o cargo liberado no servidor do painel.
async function podeUsarPainel(i) {
  if (podeConferir(i.user.id)) return true;
  if (!i.inGuild() || i.guildId !== config.painelGuildId) return false;
  try {
    const member = await i.guild.members.fetch(i.user.id);
    return member.roles.cache.has(config.painelRoleId);
  } catch { return false; }
}

async function repostPanel(i) {
  if (!(await podeUsarPainel(i))) {
    return i.reply({
      embeds: [{ color: C_ERROR, title: '❌ Sem Permissão', description: '🚪 **Apenas administradores** do bot podem usar este comando.\n\n**Permissões necessárias:** Cargo de staff ou dono do bot.\n**Como obter:** Entre em contato com o administrador do servidor.' }],
      flags: MessageFlags.Ephemeral,
    });
  }
  await i.reply({ embeds: [painelEmbed(i.client)], components: [painelRow()] });

  // rodar /painel no canal certo CONFIGURA o painel fixo: o bot guarda esse ID
  // em data/painel-channel.json e usa dali pra frente (inclusive depois de
  // restart). assim não é preciso editar o .env à mão, e o bot nunca adivinha
  // um canal. se o .env já define PANEL_CHANNEL_ID, ele continua mandando.
  if (!painelChannelVemDoEnv() && i.channelId && i.channelId !== painelChannelId()) {
    if (salvarPainelChannel(i.channelId)) {
      console.log(`[painel] canal fixo definido em #${i.channel?.name || i.channelId} (${i.channelId})`);
    }
  }

  // aproveita e atualiza também o painel fixo + painéis velhos do server do painel
  postFixedPanel(i.client).catch(() => {});
  varrerServidorDoPainel(i.client).catch(() => {});
}

// ============================================================
//  VINCULAR / TROCAR RA  (modal de login)
// ============================================================
function openLoginModal(i, kind) {
  const modal = new ModalBuilder()
    .setCustomId(kind === 'change' ? 'modal_change' : 'modal_link')
    .setTitle(kind === 'change' ? 'Trocar RA' : 'Entrar — Sala do Futuro');

  const ra = new TextInputBuilder().setCustomId('ra').setLabel('RA (só números)')
    .setPlaceholder('Ex.: 000000000').setStyle(TextInputStyle.Short).setRequired(true);
  const dg = new TextInputBuilder().setCustomId('dg').setLabel('Dígito do RA (se tiver)')
    .setPlaceholder('Ex.: 9 — pode deixar vazio').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2);
  const uf = new TextInputBuilder().setCustomId('uf').setLabel('UF')
    .setPlaceholder('SP').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2);
  const pw = new TextInputBuilder().setCustomId('pw').setLabel('Senha do gov.sp')
    .setPlaceholder('••••••••').setStyle(TextInputStyle.Short).setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(ra),
    new ActionRowBuilder().addComponents(dg),
    new ActionRowBuilder().addComponents(uf),
    new ActionRowBuilder().addComponents(pw),
  );
  return i.showModal(modal);
}

async function handleLogin(i, kind) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const ra = i.fields.getTextInputValue('ra');
  const dg = i.fields.getTextInputValue('dg');
  const uf = i.fields.getTextInputValue('uf');
  const pw = i.fields.getTextInputValue('pw');

  let r;
  try {
    r = await login({ ra, dg, uf, senha: pw });
} catch (e) {
    return i.editReply({
      embeds: [new EmbedBuilder().setColor(C_ERROR).setTitle('❌ Entrada Falhou').setDescription(`\`${e.message}\``)
        .addFields(
          { name: '🔧 Checklist', value: '• RA: só números\n• Dígito verificador correto (ou vazio)\n• UF: SP\n• Senha: do gov.sp (campo sensível)' },
        )],
    });
  }

  // persiste a conta (mantém plano/premium se já existia). senha cifrada no store.
  upsertAccount({ userId: i.user.id, ra, dg, uf, senha: pw, nick: r.nick, aluno: r.aluno });

  // sessão curta pro fluxo manual
  const sess = { ...r, tasks: [], somenteExpiradas: true, ts: Date.now() };
  sessions.set(i.user.id, sess);

try {
    await carregarTarefas(sess);
  } catch (e) {
    return i.editReply({
      embeds: [{ color: C_ERROR, title: '❌ Erro ao Listar Tarefas', description: `\`${e.message}\`\n⚠️ Tente novamente em instantes.` }],
    });
  }

  // NOVA ETAPA: mostrar menu de seleção de modo de tarefa
  return showTaskModeMenu(i, sess);
}

// === NOVA FUNÇÃO: menu de seleção de modo de tarefa após login ===
function showTaskModeMenu(i, sess) {
  const tasks = sess.tasks || [];
  const nExp = tasks.filter(t => isExpired(t) && !foraDoEscopo(t)).length;
  const nAtivas = tasks.filter(t => !isExpired(t) && !foraDoEscopo(t)).length;

  const emb = brand({ color: C_BASE })
    .setTitle('📋 Modo de Resolução')
    .setDescription(
      `Olá, \`${sess.nick}\`!\n\n` +
      `• **${tasks.length} tarefa(s)** pendentes\n` +
      `• **${nExp} vencida(s)** — prazo expirado\n` +
      `• **${nAtivas} no prazo** — ainda podem ser entregues\n\n` +
      `**Como você quer resolver?**`
    )
    .setFooter({ text: `Conta: ${sess.accountKey || 'não definida'}` });

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('task_mode_todas')
        .setLabel('📝 Todas como rascunho')
        .setEmoji('📝')
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('task_mode_draft')
        .setLabel('📤 Apenas rascunho')
        .setEmoji('📤')
        .setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('task_mode_send')
        .setLabel('✅ Enviar definitivo')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('task_mode_selector')
        .setLabel('🔢 Selecionar manualmente')
        .setEmoji('🔢')
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('panel_back')
        .setLabel('Voltar')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  return i.editReply({ embeds: [emb], components: rows });
}

// ============================================================
//  MINHAS CONTAS  (multi-RA: entra na salva ou adiciona outra)
// ============================================================
// monta a tela "Suas contas" (usada pelo menu normal e depois de remover).
function accountsView(userId, nota = null) {
  const contas = listAccounts(userId);
  const emb = brand(C_BASE)
    .setTitle('👤 Suas contas')
    .setDescription(
      [
        ...(nota ? [nota, ''] : []),
        'Você já tem conta(s) vinculada(s) neste Discord.',
        '',
        '**Entrar com qual?**',
        ...contas.slice(0, 12).map((c, n) =>
          `\`${String(n + 1).padStart(2, '0')}\` **${c.nick || c.ra}** · \`${c.ra}-${c.dg || ''}\` (${String(c.uf || 'SP').toUpperCase()})`),
        '',
        '-# A conta que você escolher vira a **ativa** — é nela que o bot resolve.',
      ].join('\n')
    );

  const rows = [];
  const visiveis = contas.slice(0, 12);
  for (let k = 0; k < visiveis.length; k += 4) {
    rows.push(new ActionRowBuilder().addComponents(
      ...visiveis.slice(k, k + 4).map((c, j) =>
        new ButtonBuilder()
          .setCustomId(`acc_pick_${k + j}`)
          .setLabel(String(c.nick || `${c.ra}-${c.dg || ''}`).slice(0, 80))
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Success)),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('acc_add').setLabel('➕ Vincular conta').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('acc_remove').setLabel('🗑️ Remover conta').setStyle(ButtonStyle.Danger),
  ));
  return { emb, rows };
}

async function openAccountsMenu(i) {
  const contas = listAccounts(i.user.id);
  if (!contas.length) return openLoginModal(i, 'link'); // primeira vez: modal direto

  const { emb, rows } = accountsView(i.user.id);
  return i.reply({ embeds: [emb], components: rows, flags: MessageFlags.Ephemeral });
}

// ============================================================
//  REMOÇÃO DE CONTA (lista → confirmar → removida)
// ============================================================

// 1ª tela: escolher qual conta desvincular.
function remocaoView(userId) {
  const contas = listAccounts(userId);
  const emb = brand({ color: C_WARNING })
    .setTitle('🗑️ Remover Conta')
    .setDescription(
      `Selecione qual conta deseja **desvincular** do bot:\n` +
      `` +
      contas.slice(0, 12).map((c, n) =>
        `\`${String(n + 1).padStart(2, '0')}\` ${c.nick || c.ra} · \`${c.ra}-${c.dg || ''}\`` +
        (isPremiumActive(c) ? ' · 💎 premium' : '')
      ).join('\n') +
      `` +
      `⚠️ **Atenção:** Isso apenas removes a conta deste bot.` +
      `\nOs dados da edusp permanecem intactos.`
    )
    .setFooter({ text: `Total: ${contas.length} conta(s) vinculada(s)` });

  const rows = [];
  const visiveis = contas.slice(0, 12);
  for (let k = 0; k < visiveis.length; k += 4) {
    rows.push(new ActionRowBuilder().addComponents(
      ...visiveis.slice(k, k + 4).map((c, j) =>
        new ButtonBuilder()
          .setCustomId(`acc_del_${k + j}`)
          .setLabel(String(c.nick || `${c.ra}-${c.dg || ''}`).slice(0, 80))
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('acc_link').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
  ));
  return { emb, rows };
}

async function openRemocaoMenu(i) {
  if (!listAccounts(i.user.id).length) return openLoginModal(i, 'link');
  const { emb, rows } = remocaoView(i.user.id);
  return i.update({ embeds: [emb], components: rows });
}

// 2ª tela: confirmação (remoção não tem volta).
async function confirmRemoveConta(i, idx) {
  const alvo = listAccounts(i.user.id)[idx];
  if (!alvo) return openRemocaoMenu(i);

  const premium = isPremiumActive(alvo);
  const emb = brand(C_ERRO)
    .setTitle('🗑️ Confirmar remoção')
    .setDescription(
      [
        `Remover **${alvo.nick || alvo.ra}** · \`${alvo.ra}-${alvo.dg || ''}\` (${String(alvo.uf || 'SP').toUpperCase()})?`,
        '',
        ...(premium ? ['💎 Essa conta tem **plano premium ativo** — o plano sai junto com ela.', ''] : []),
        'Essa ação **não tem volta**: RA, senha e histórico salvos são apagados agora.',
      ].join('\n')
    );

  return i.update({
    embeds: [emb],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`acc_delyes_${idx}`).setLabel('Remover definitivamente').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('acc_remove').setLabel('Cancelar').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    )],
  });
}

// 3ª tela: remove e volta pro menu de contas (com aviso do que aconteceu).
async function doRemoveConta(i, idx) {
  const alvo = listAccounts(i.user.id)[idx];
  if (!alvo) return openRemocaoMenu(i);

  let eraAtiva = false;
  try {
    const ativo = getAccount(i.user.id)?.ativoRa;
    eraAtiva = !ativo || ativo === alvo.key;
    removeConta(i.user.id, alvo.key);
  } catch { /* segue mesmo assim */ }

  const nome = `**${alvo.nick || alvo.ra}**`;
  const restantes = listAccounts(i.user.id);
  if (!restantes.length) {
    // ficou sem nenhuma: tela de "tudo limpo" com atalho pra vincular de novo
    return i.update({
      embeds: [brand(C_OK)
        .setTitle('✅ Conta removida')
        .setDescription(`${nome} foi desvinculada.\n\nVocê não tem mais nenhuma conta salva — use **➕ Vincular conta** para entrar com outro RA quando quiser.`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('acc_add').setLabel('Vincular conta').setEmoji('➕').setStyle(ButtonStyle.Primary),
      )],
    });
  }

  const nota = eraAtiva
    ? `✅ ${nome} removida. Sua conta **ativa** agora é **${restantes[0].nick || restantes[0].ra}**.`
    : `✅ ${nome} removida.`;
  const { emb, rows } = accountsView(i.user.id, nota);
  return i.update({ embeds: [emb], components: rows });
}

// login DIRETO numa conta salva (senha decifrada do store), sem digitar nada.
async function handleUseSaved(i, idx) {
  const alvo = listAccounts(i.user.id)[idx];
  if (!alvo) return replyExpired(i, true);

  await i.deferUpdate();

  let r;
  try {
    r = await login({ ra: alvo.ra, dg: alvo.dg, uf: alvo.uf, senha: alvo.senha });
  } catch (e) {
    return i.editReply({
      embeds: [brand(C_ERRO)
        .setTitle('❌ Não consegui entrar na conta salva')
        .setDescription(
          [
            `Conta: **${alvo.nick || alvo.ra}** · \`${alvo.ra}-${alvo.dg || ''}\``,
            `\`${e.message}\``,
            '',
            'A senha pode ter mudado — use **➕ Usar outro RA** para atualizá-la.',
          ].join('\n')),
      ],
      components: [],
    });
  }

  // essa conta vira a ativa (automação premium passa a rodar nela também)
  try { switchAccount(i.user.id, alvo.key); } catch { /* segue mesmo assim */ }

  const sess = { ...r, tasks: [], somenteExpiradas: true, ts: Date.now() };
  sessions.set(i.user.id, sess);

  try {
    await carregarTarefas(sess);
  } catch (e) {
    return i.editReply({
      embeds: [brand(C_ERRO).setTitle('❌ Erro ao listar tarefas').setDescription(`\`${e.message}\``)],
    });
  }

  return showActionPanel(i, false);
}

// ============================================================
//  PAINEL DE AÇÕES (pós-login)
// ============================================================
async function showActionPanel(i, fromButton) {
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, fromButton);

  const acc = getAccount(i.user.id);
  const premium = isPremiumActive(acc);
  const tasks = tarefasAlvo(sess);
  const n = tasks.length;
  const nExp = contarExpiradas(sess);
  const nExpToken = contarExpiradasComToken(sess);
  const nAtivas = (sess.tasks || []).filter(t => !isExpired(t) && !foraDoEscopo(t)).length;
  const soExpiradas = sess.somenteExpiradas !== false;
  // vencidas que ainda NÃO têm rascunho salvo — o botão "só as novas", igual ao
  // das tarefas normais: o bot não refaz o que já está preenchido lá.
  const vencidasNovas = (sess.tasks || []).filter(t => isExpired(t) && !foraDoEscopo(t) && !taEmRascunho(t)).length;

  const emb = premium ? brand(C_PREMIUM) : brand(C_BASE);
  emb.setTitle(`👋 Olá, ${sess.nick}`);

  const linhas = [];
  if (premium) {
    const dias = Math.max(0, Math.ceil((acc.premiumUntil - Date.now()) / 86400000));
    const modo = acc.autoMode === 'draft'
      ? '📝 só rascunho (você confere antes de enviar)'
      : '📤 envia definitivo sozinho';
    const slot = slotDaAtiva(i.user.id, acc);
    linhas.push(`### ⭐ Premium ativo`);
    linhas.push(slot
      ? `Automação **todo dia** às <t:${slot}:t> — horário exclusivo da sua conta, sem brigar pela IA.`
      : `Automação **todo dia às 16:30**.`);
    linhas.push(`> Modo atual: ${modo} — troque no botão aqui embaixo`);
    linhas.push(`> Escopo da automação: **${acc.autoExpired === false ? 'vencidas + normais' : 'só vencidas'}** (objetivas; nunca prova/redação) — troque no botão ⏰`);
    linhas.push(`> Expira em **${dias} dia(s)**${slot ? ` · próxima rodada <t:${slot}:R>` : ''}`);
  } else {
    linhas.push(`### 🆓 Conta gratuita`);
    linhas.push(`Tudo funciona de graça: resolva agora mesmo por aqui, quando quiser.`);
    linhas.push(`• O plano pago é só para o bot fazer sozinho todo dia às 16:30.`);
    const premiumEmOutra = listAccounts(i.user.id).some(c => isPremiumActive(c) && c.key !== (acc.ativoRa || ''));
    if (premiumEmOutra) linhas.push(`-# ⭐ Você tem plano ativo em outra conta sua — selecione-a no **🔗 Entrar**.`);
  }

  linhas.push('─────────────────────');

  // taxa de acertos configurada (por padrão 100% = resolve tudo certo)
  const hr = hitRateEfetivo(acc?.hitRate);
  linhas.push(`🎯 **Taxa de acertos: ${hr}%** — configure no botão \`Acertos\` abaixo.`);
  linhas.push('─────────────────────');

  if (n) {
    const totalQuestoes = tasks.reduce((s, t) => s + ((t.questions || []).filter(q => q.type !== 'info' && q.type !== 'media').length), 0);
    linhas.push(`⏰ **${n} tarefa(s) vencida(s)**${totalQuestoes ? ` · ${totalQuestoes} questões` : ''}`);
    linhas.push(listaTarefas(tasks, 10));
    linhas.push('');
    linhas.push(`📝 **Rascunho** — preenche sem finalizar (você confere antes)`);
    linhas.push(`📤 **Enviar já** — envia de vez. *Se a IA errar, queima.*`);
    if (nExpToken) {
      linhas.push('');
      linhas.push(`🔒 **${nExpToken} vencida(s) fora do escopo do bot** — são prova, redação ou pedem o código da prova. Ele não resolve esse tipo de tarefa.`);
    }
  } else if (nAtivas) {
    linhas.push(`### ✅ Nada vencido no seu escopo`);
    linhas.push(`Você tem **${nAtivas} tarefa(s) no prazo**`, `mas o bot está no modo **só vencidas** — é o que o dono pediu. Prova e redação nunca entram.`);
  } else if (nExp) {
    linhas.push(`### ⏰ ${nExp} tarefa(s) vencida(s)`);
    linhas.push('Você não tem nada no prazo, mas tem atividade que **já venceu** e ainda dá pra entregar.');
  } else {
    linhas.push(`### ✅ Nada pendente`);
    linhas.push(`Nenhuma tarefa vencida (e objetiva) no seu escopo. Prova e redação o bot não resolve.`);
  }

  emb.setDescription(linhas.join('\n'));

  const rows = [];
  if (n) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('solve_draft').setLabel('Resolver rascunho').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('solve_real').setLabel('Enviar já').setEmoji('📤').setStyle(ButtonStyle.Danger),
    ));
  }
  // linha das vencidas: sempre visível, porque é o que liga/desliga o modo
  // "também as normais" — mesmo com 0 vencida o dono precisa do acesso pra
  // poder sair do modo "só vencidas".
  if (soExpiradas || nExp || nAtivas) {
    const b = [
      new ButtonBuilder()
        .setCustomId('exp_toggle')
        .setLabel(soExpiradas ? '⏰ Só vencidas' : '⏰ Vencidas + normais')
        .setEmoji(soExpiradas ? '✅' : '🔁')
        .setStyle(soExpiradas ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ];
    if (vencidasNovas > 0) {
      b.push(new ButtonBuilder()
        .setCustomId('solve_exp_novas')
        .setLabel(`Vencidas novas (${vencidasNovas})`)
        .setEmoji('🆕')
        .setStyle(ButtonStyle.Success));
    }
    if (nExp && n !== nExp) {
      b.push(new ButtonBuilder().setCustomId('solve_exp').setLabel(`Vencidas (${nExp})`).setEmoji('⏰').setStyle(ButtonStyle.Secondary));
    }
    if (b.length) rows.push(new ActionRowBuilder().addComponents(...b));
  }
  rows.push(new ActionRowBuilder().addComponents(
    ...(premium ? [] : [new ButtonBuilder().setCustomId('acc_buy').setLabel('Ativar automação').setEmoji('⭐').setStyle(ButtonStyle.Success)]),
    ...(premium ? [new ButtonBuilder()
      .setCustomId('auto_mode')
      .setLabel(acc.autoMode === 'draft' ? 'Modo: 📝 Rascunho' : 'Modo: 📤 Definitivo')
      .setStyle(ButtonStyle.Secondary)] : []),
    ...(premium ? [new ButtonBuilder()
      .setCustomId('auto_exp')
      .setLabel(acc.autoExpired === false ? 'Auto: ⏰+📚' : 'Auto: ⏰ só')
      .setStyle(ButtonStyle.Secondary)] : []),
    new ButtonBuilder().setCustomId('hit_rate').setLabel(`Acertos: ${hr}%`).setEmoji('🎯').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_back').setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('logout').setLabel('Sair').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
  ));

  const payload = { embeds: [emb], components: rows };
  if (fromButton) return i.update(payload);
  return i.editReply(payload);
}

async function confirmReal(i) {
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);

  // aviso da taxa de acertos: quantas questões o bot vai errar DE PROPÓSITO
  // (nunca nas de escrita). hr<100 + alguma tarefa com questão corrigível => mostra.
  const hrE = hitRateEfetivo(getAccount(i.user.id)?.hitRate);
  const avisoErro = (() => {
    if (hrE >= 100) return null;
    let totalCorrigiveis = 0, totalErros = 0;
    const tiposEscrita = ['text', 'text_ai', 'text-ai', 'free-text', 'essay', 'reflection'];
    const tiposCorrigiveis = ['single', 'single-choice', 'multi', 'multiple-choice', 'true-false', 'fill-letters', 'fill-words', 'cloud', 'order-sentences'];
    for (const t of tarefasAlvo(sess)) {
      const qs = (t.questions || []).filter(q => tiposCorrigiveis.includes(q.type) && !tiposEscrita.includes(q.type));
      const total = qs.length;
      if (!total) continue;
      totalCorrigiveis += total;
      const acertos = Math.round((hrE / 100) * total);
      totalErros += Math.max(0, total - acertos);
    }
    if (!totalErros) return null;
    return `⚠️ **Atenção — taxa de acertos de ${hrE}%:** o bot vai **errar de propósito ~${totalErros}** das **${totalCorrigiveis}** questões corrigíveis (nunca nas de redação/escrita).\n-# Se quiser nota máxima, cancele e ajuste a taxa para 100% no botão \`Acertos\`.`;
  })();

  const alvo = tarefasAlvo(sess);
  const n = alvo.length;
  const emb = brand(C_ERRO)
    .setTitle('⚠️ Enviar de vez?')
    .setDescription(
      [
        `Você vai enviar **${n} tarefa(s)** em definitivo:`,
        listaTarefas(alvo, 8),
        '',
        '**Atenção:** resposta errada queima a tarefa **sem volta**.',
        '-# O bot usa IA para responder — acerto não é garantido.',
        ...(avisoErro ? ['', avisoErro] : []),
      ].join('\n')
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('solve_real_confirm').setLabel('Sim, enviar tudo').setEmoji('🔥').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('panel_back').setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );
  return i.update({ embeds: [emb], components: [row] });
}

// tela do botão "Resolver rascunho": mostra TODAS as pendências marcando quais
// já estão em rascunho e deixa escolher entre resolver só as novas ou todas.
async function showDraftMenu(i) {
  console.log(`[rascunho] botão apertado por ${i.user.tag} — abrindo menu...`);
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);

  const tasks = tarefasAlvo(sess);
  if (!tasks.length) return showActionPanel(i, true);

  const soExp = modoExpirado(sess);
  const nRascunho = tasks.filter(taEmRascunho).length;
  const novas = tasks.length - nRascunho;
  const palavra = soExp ? 'vencida' : 'pendente';

  const emb = brand({ color: C_WARNING })
    .setTitle(soExp ? '📝 Tarefas Vencidas' : '📝 Resolver em Rascunho')
    .setDescription(
      `Você tem **${tasks.length} tarefa(s) ${palavra}(s)**${nRascunho ? ` — **${nRascunho}** já têm rascunho:` : ':'}\n` +
      `` +
      listaTarefas(tasks, 15, false, taEmRascunho) +
      `` +
      `-# ⏰ **vencida** = prazo expirado, mas ainda entrega\n` +
      `-# 📝 **em rascunho** = respostas salvas na plataforma\n` +
      (soExp ? '-# 🆕 **nova** = ainda sem rascunho, bot resolve do zero.' : '')
    )
    .setFooter({ text: `Novas: ${novas} | Vencidas: ${nRascunho}` });

  const botoes = [];
  if (novas > 0) {
    botoes.push(new ButtonBuilder()
      .setCustomId(soExp ? 'solve_exp_novas' : 'solve_draft_novas')
      .setLabel(`Resolver ${novas} nova(s)`)
      .setEmoji('🆕')
      .setStyle(ButtonStyle.Primary));
  }
  botoes.push(
    new ButtonBuilder()
      .setCustomId(soExp ? 'solve_exp' : 'solve_draft_todas')
      .setLabel(`Resolver todas (${tasks.length})`)
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_back').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
  );

  return i.update({ embeds: [emb], components: [new ActionRowBuilder().addComponents(...botoes)] });
}

async function showTaskSelector(i) {
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);

  const tasks = tarefasAlvo(sess);
  if (!tasks.length) return showActionPanel(i, true);

  const nExp = tasks.filter(isExpired).length;
  const nAtivas = tasks.filter(t => !isExpired(t)).length;

  const emb = brand(C_BASE)
    .setTitle('🔢 Selecionar tarefas')
    .setDescription(
      `Selecione quais tarefas deseja resolver:\n\n` +
      `**${tasks.length} tarefa(s)** no total:\n` +
      `-# ⏰ **${nExp} vencida(s)**\n` +
      `-# ✅ **${nAtivas} no prazo**\n\n` +
      'Use as opções abaixo para escolher:'
    );

  const rows = [];
  // linha 1: todas + rascunho
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('task_selector_todas')
      .setLabel('Todas as tarefas')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('task_selector_draft')
      .setLabel('Apenas rascunho')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary),
  ));
  // linha 2: vencidas + no prazo
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('task_selector_vencidas')
      .setLabel(`Vencidas (${nExp})`)
      .setEmoji('⏰')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('task_selector_normais')
      .setLabel(`No prazo (${nAtivas})`)
      .setEmoji('📅')
      .setStyle(ButtonStyle.Secondary),
  ));
  // linha 3: voltar
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_back')
      .setLabel('Voltar')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary),
  ));

  return i.update({ embeds: [emb], components: rows });
}

// handler for task selector
// (will be added in the interaction handler below)

async function runSolve(i, draft, alvoTasks = null) {
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);

  await i.deferUpdate();
  // alvoTasks: subconjunto opcional (ex.: só as vencidas, ou só as que NÃO
  // estão em rascunho). sem ele, usa tudo que o toggle ⏰ deixou liberado.
  let tasks = Array.isArray(alvoTasks) ? alvoTasks : tarefasAlvo(sess);
  if (!tasks.length) return showActionPanel(i, false);

  // ANTI-NaN: rascunho contaminado (entrada sem `answer`, ex.: info/media vazias
  // de versões antigas) não pode ser re-enviado — o PUT funde e nunca limpa, e o
  // grader devolve NaN. fica de fora até reset manual na plataforma.
  const contaminadas = tasks.filter(t => rascunhoContaminado(t && t.answer_answers));
  const limpas = tasks.filter(t => !rascunhoContaminado(t && t.answer_answers));
  if (contaminadas.length) {
    console.warn(`[solve] ${sess.nick}: ${contaminadas.length} tarefa(s) com rascunho CONTAMINADO — puladas (anti-NaN), exigem limpeza manual na plataforma.`);
  }
  tasks = limpas;
  if (!tasks.length) {
    return i.editReply({
      embeds: [brand(C_ATENCAO)
        .setTitle('⚠️ Tarefas contaminadas')
        .setDescription('As pendências desta conta estão com **rascunho contaminado** (resposta vazia salva por uma versão antiga do bot). Enviar assim gera **nota NaN** — o bot pulou todas. Limpe/resete a resposta na plataforma manualmente e tente de novo.')],
      components: [],
    });
  }

  // taxa de acertos configurada da conta ativa (0–100, null = 100% = não erra)
  const accAtiva = getAccount(i.user.id);
  const hitRate = hitRateEfetivo(accAtiva?.hitRate);

  // ── VERIFICA FILA ────────────────────────────────────────────
  const pos = getPosition(i.user.id);
  const processing = isProcessing();

  // se já tá processando (a própria pessoa), ignora
  if (pos === 0) {
    return i.editReply({
      embeds: [brand(C_ATENCAO)
        .setTitle('🚀 Já processando...')
        .setDescription('Suas tarefas já estão sendo processadas agora.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('solve_cancel').setLabel('Cancelar resolução').setEmoji('🛑').setStyle(ButtonStyle.Danger),
      )],
    });
  }

  // se já tá na fila, mostra posição
  if (pos > 0) {
    const texto = positionText(i.user.id);
    return i.editReply({
      embeds: [brand(C_BASE)
        .setTitle('🕒 Na fila de resolução')
        .setDescription([
          texto || `Você está na posição **${pos}** da fila.`,
          '',
          queueSummary(),
          '',
          '-# Sua vez começa automaticamente quando as pessoas na sua frente terminarem.',
        ].join('\n'))],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('solve_cancel_fila').setLabel('Sair da fila').setEmoji('❌').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('panel_back').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  // ── ENTRA NA FILA ────────────────────────────────────────────
  // entra na fila se alguém já processa OU se já tem gente aguardando
  // (não pode furar a vez de quem chegou antes — espera como os outros).
  if (processing || queueLength() > 0) {
    enqueue(i.user.id, sess.nick);
    const novaPos = getPosition(i.user.id);
    const texto = positionText(i.user.id);
    // se ninguém estava processando (só tinha gente aguardando da sessão
    // anterior), acorda o 1º da fila imediatamente.
    if (!processing) retomarFilaSeParada(client);

    return i.editReply({
      embeds: [brand(C_BASE)
        .setTitle('🕒 Na fila de resolução')
        .setDescription([
          texto || `Você está na posição **${novaPos}** da fila.`,
          '',
          queueSummary(),
          '',
          '-# Sua vez começa automaticamente quando as pessoas na sua frente terminarem.',
        ].join('\n'))],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('solve_cancel_fila').setLabel('Sair da fila').setEmoji('❌').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('panel_back').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  // ── NINGUÉM PROCESSANDO — COMEÇA AGORA ──────────────────────
  // marca como processando (sem adicionar à fila, já que é direto)
  startProcessing(i.user.id, tasks.length);

  const inicioTs = Date.now();
  const total = tasks.length;
  const corModo = C_ATENCAO;

  // ---------- ESTADO AO VIVO (a UI lê daqui) ----------
  const estado = new Map(tasks.map(t => [t.id, {
    nome: String(t.title || t.id || '—').slice(0, 52) + (t.answer_status === 'draft' ? ' · 📝' : ''),
    fase: 'fila',
    feitas: 0,
    totalQ: (t.questions || []).filter(q => q.type !== 'info' && q.type !== 'media').length,
    ok: null,
  }]));
  let ok = 0, fail = 0;

  // ---------- RENDER COM THROTTLE ----------
  const RENDER_MS = 2500;
  let ultimoRender = 0;
  let timerRender = null;
  let hbTimer = null;

  const render = () => {
    const linhasUI = [];
    let ativasCount = 0;
    for (const t of tasks) {
      const e = estado.get(t.id);
      if (!e) continue;
      if (e.ok === true) linhasUI.push(`✅ **${e.nome}**`);
      else if (e.cancelada) linhasUI.push(`🛑 **${e.nome}** · parou na questão ${Math.max(0, e.feitas)}/${Math.max(1, e.totalQ)}`);
      else if (e.ok === false) linhasUI.push(`❌ **${e.nome}**`);
      else if (e.fase === 'ativa') {
        ativasCount++;
        linhasUI.push(
          (e.totalQ > 0 && e.feitas >= e.totalQ)
            ? `📤 **${e.nome}** · pronta — enviando agora`
            : `🧠 **${e.nome}**\n> \`${barraMini(e.feitas, Math.max(1, e.totalQ))}\` ${e.feitas}/${Math.max(1, e.totalQ)} questões`
        );
      } else linhasUI.push(`⏳ ${e.nome}`);
    }

    let soma = 0;
    for (const t of tasks) {
      const e = estado.get(t.id);
      if (!e) continue;
      if (e.ok != null) soma += 1;
      else if (e.fase === 'ativa' && e.totalQ > 0) soma += Math.min(0.95, e.feitas / e.totalQ);
    }
    const pctGeral = total ? soma / total : 0;
    const feitosCount = ok + fail;
    const decorridoMs = Date.now() - inicioTs;
    const restantesTarefas = total - feitosCount;
    const etaTxt = feitosCount > 0 && restantesTarefas > 0
      ? ` · ⏳ ~${fmtDuracao((decorridoMs / feitosCount) * restantesTarefas)} restantes`
      : '';

    const titulo = '📝 Resolvendo em rascunho (envio instantâneo)';

    const corpo = [
      `\`${'█'.repeat(Math.round(pctGeral * 20)).padEnd(20, '░')}\` **${Math.round(pctGeral * 100)}%**`,
      `⏱️ ${fmtDuracao(decorridoMs)} decorridos${etaTxt}`,
      LINHA_DIV,
      linhasUI.slice(0, 12).join('\n') + (linhasUI.length > 12 ? `\n… +${linhasUI.length - 12} outra(s)` : ''),
    ];

    // mostra fila se tem gente esperando
    const qs = getQueueStatus();
    if (qs.fila.length > 0) {
      corpo.push('', `👥 **${qs.fila.length}** pessoa(s) na fila atrás de você`);
    }

    i.editReply({
      embeds: [brand(corModo)
        .setTitle(titulo)
        .setDescription(corpo.join('\n').slice(0, 4000))
        .addFields(
          { name: 'Modo', value: '📝 Rascunho · Envio instantâneo', inline: true },
          { name: 'Progresso', value: `${feitosCount}/${total} tarefas`, inline: true },
          { name: 'IA', value: `${ativasCount ? `🧠 ${ativasCount} resolvendo` : '⏸️ aguardando'}`, inline: true },
        )
        .setFooter({ text: `${NOME_BOT} • ✅ ${ok}  ❌ ${fail}` })
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('solve_cancel').setLabel('Cancelar resolução').setEmoji('🛑').setStyle(ButtonStyle.Danger),
      )],
    }).catch(() => {});
  };

  const agendarRender = () => {
    if (timerRender) return;
    timerRender = setTimeout(() => {
      timerRender = null;
      ultimoRender = Date.now();
      render();
    }, Math.max(0, RENDER_MS - (Date.now() - ultimoRender)));
  };

  hbTimer = setInterval(agendarRender, 15000);
  ultimoRender = Date.now();
  render();

  const ctl = { cancelar: false };
  rodadasUI.set(i.user.id, ctl);

  try {
    // usa a fila GLOBAL pra garantir que só 1 processamento manual roda por vez.
    const rotulo = `manual:${i.user.id}:${Date.now()}`;
    const errosProposito = []; // tarefas em que o bot errou de propósito (taxa de acertos)
    const rodada = enfileirarRodada(rotulo, async () => {
      const k = qtdChavesGroq();
      const conc = Math.min(MAX_CONCORRENCIA_FILA, Math.max(1, k));
      return solveTasksParallel(tasks, {
        token: sess.token,
        nick: sess.nick,
        draft,
        hitRate,
        concorrenciaMaxima: conc,
        groqIndex: k > 1 ? (proximoSlotGroq++) % k : null,
        makeHumanCallback: (t) => criarHumanCaptchaCallback(i.user.id, t?.title),
        deveCancelar: () => ctl.cancelar,
        onTick: (snap) => {
          for (const a of snap.ativas) {
            const e = estado.get(a.id);
            if (e && e.ok == null) {
              e.fase = 'ativa';
              if (a.feitas > e.feitas) e.feitas = a.feitas;
              e.totalQ = a.totalQ || e.totalQ;
            }
          }
          agendarRender();
        },
        onResultado: (pos, okTarefa, err) => {
          const t = tasks[pos];
          const e = t && estado.get(t.id);
          if (e) {
            e.ok = okTarefa;
            e.fase = 'fim';
            if (!okTarefa && err?.cancelado) e.cancelada = true;
          }
          if (okTarefa) ok++; else fail++;
          agendarRender();
        },
        onMissed: (taskId, qids) => {
          const t = tasks.find(x => x.id === taskId);
          errosProposito.push({ nome: t?.title || String(taskId).slice(0, 30), q: qids.length });
        },
      });
    });

    const resultados = await rodada.resultado;
    const cancelou = ctl.cancelar;

    const boas = resultados.filter(r => r?.ok).length;
    const naoProcessadas = resultados.filter(r => r == null).length;

    sess.ts = Date.now();
    try {
      await carregarTarefas(sess);
    } catch { /* mantém a lista antiga */ }

    const linhasResumo = [];
    for (const t of tasks) {
      const e = estado.get(t.id);
      if (!e) continue;
      if (e.cancelada) { linhasResumo.push(`🛑 **${e.nome}** — parou na questão ${Math.max(0, e.feitas)}/${Math.max(1, e.totalQ)}`); }
      else if (e.ok === true) linhasResumo.push(`✅ **${e.nome}**`);
      else if (e.ok === false) linhasResumo.push(`❌ **${e.nome}**`);
      else linhasResumo.push(`⚪ ${e.nome}`);
    }

    const parcial = cancelou && boas < total;
    const resumo = brand(parcial ? C_ATENCAO : (boas === total ? C_OK : (boas ? C_ATENCAO : C_ERRO)))
      .setTitle(
        parcial
          ? `🛑 Resolução cancelada — ${boas}/${total}`
          : `📝 Rascunho concluído — ${boas}/${total} (envio instantâneo)`
      )
      .setDescription(
        [
          ...(cancelou
            ? [`Você cancelou — o que já tinha resposta foi **salvo como rascunho**; só o que estava pela metade ficou pendente.`, '']
            : []),
          linhasResumo.slice(0, 15).join('\n') + (linhasResumo.length > 15 ? `\n… +${linhasResumo.length - 15}` : ''),
          '',
          ...(errosProposito.length
            ? [`🎯 **Errado de propósito (taxa de acertos):** ${errosProposito.map(e => `\`${e.nome}\` (${e.q})`).join(', ')}`]
            : []),
          ...(errosProposito.length ? [''] : []),
          `-# ⏱️ Tempo total: ${fmtDuracao(Date.now() - inicioTs)} · envio instantâneo (sem delay de tempo-alvo)`,
        ].join('\n').slice(0, 4000)
      )
      .setFooter({ text: `${NOME_BOT} • ✅ ${ok}  ❌ ${fail}${naoProcessadas ? `  ⚪ ${naoProcessadas}` : ''}` })
      .setTimestamp();

    const back = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_back').setLabel('Voltar ao painel').setEmoji('📋').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('logout').setLabel('Sair').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
    );

    const enviouPainel = await i.editReply({ embeds: [resumo], components: [back] })
      .then(() => true).catch(() => false);
    if (!enviouPainel && Date.now() - inicioTs > 13 * 60 * 1000) {
      const u = await client.users.fetch(i.user.id).catch(() => null);
      await u?.send({ embeds: [resumo], components: [] }).catch(() => {});
    }
  } finally {
    clearInterval(hbTimer);
    if (timerRender) clearTimeout(timerRender);
    rodadasUI.delete(i.user.id);
    // libera processamento na fila e avança pro próximo
    finishProcessing();
    processarProximoFila(client).catch(() => {});
  }
}

// botão ❌ durante uma resolução: remove da fila (se aguardando) ou cancela processamento.
async function cancelarFila(i) {
  const pos = getPosition(i.user.id);
  if (pos === -1) {
    return i.reply({
      embeds: [brand(C_ATENCAO).setTitle('ℹ️ Nada pra cancelar')
        .setDescription('Você não está na fila.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (pos === 0) {
    // tá processando — redireciona pro cancelamento normal
    return cancelarRodada(i);
  }
  // tá na fila — remove
  removeFromQueue(i.user.id);
  return i.reply({
    embeds: [brand(C_OK).setTitle('✅ Removido da fila')
      .setDescription('Você saiu da fila de resolução.')],
    flags: MessageFlags.Ephemeral,
  });
}

// botão 🛑 durante uma resolução: para na próxima questão, sem enviar pela metade.
async function cancelarRodada(i) {
  const ctl = rodadasUI.get(i.user.id);
  if (!ctl) {
    return i.reply({
      embeds: [brand(C_ATENCAO).setTitle('ℹ️ Nada para cancelar')
        .setDescription('Não há nenhuma resolução em andamento agora.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (ctl.cancelar) {
    return i.reply({
      embeds: [brand(C_ATENCAO).setTitle('🛑 Já estou cancelando')
        .setDescription('A resolução para na próxima questão — só um instante.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  ctl.cancelar = true;
  return i.reply({
    embeds: [brand(C_ATENCAO).setTitle('🛑 Cancelando resolução')
      .setDescription(
        [
          'Vou parar **na próxima questão** — nada é enviado pela metade.',
          '',
          '✅ O que já concluiu continua salvo.',
          '⏳ O que não começou fica pendente pra depois.',
        ].join('\n'))],
    flags: MessageFlags.Ephemeral,
  });
}

// alterna o modo da automação premium: definitivo <-> rascunho
async function toggleAutoMode(i) {
  const acc = getAccount(i.user.id);
  if (!isPremiumActive(acc)) return replyExpired(i, true);

  const novo = acc.autoMode === 'draft' ? 'submitted' : 'draft';
  const keyAtiva = acc.ativoRa || listAccounts(i.user.id)[0]?.key;
  if (keyAtiva) patchConta(i.user.id, keyAtiva, { autoMode: novo });

  // re-renderiza o painel já mostrando o modo novo
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);
  sess.tasks = sess.tasks || [];
  return showActionPanel(i, true);
}

// botão ⏰ do painel: liga/desliga as tarefas VENCIDAS no que o bot resolve.
// só muda o que é oferecido — a lista completa continua em sess.tasks, então
// alternar é instantâneo e não gasta uma nova ida na API.
async function alternarExpiradas(i) {
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);
  // padrão = SÓ vencidas. o botão liga o modo "também as normais".
  sess.somenteExpiradas = sess.somenteExpiradas === false;
  sess.ts = Date.now();
  return showActionPanel(i, true);
}

// botão "Resolver N vencida(s)": resolve SÓ o que já passou do prazo, sem
// tocar no que ainda está no prazo. Prova, redação e `token_code` são barradas
// antes (o /apply voltaria 403) — se sobrar só isso, avisa em vez de tentar.
// soNovas=true pula as que JÁ têm rascunho salvo na plataforma, espelhando o
// "Resolver N nova(s)" das tarefas normais: o bot não refaz o que já está lá.
async function solveExpiradas(i, soNovas = false) {
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);

  const vencidas = (sess.tasks || []).filter(isExpired);
  const noEscopo = vencidas.filter(t => !foraDoEscopo(t));
  const barradas = vencidas.length - noEscopo.length;
  const jaRascunho = noEscopo.filter(taEmRascunho).length;
  const alvo = soNovas ? noEscopo.filter(t => !taEmRascunho(t)) : noEscopo;

  if (!alvo.length) {
    return i.update({
      embeds: [brand(C_ATENCAO).setTitle('🔒 Nada resolvível aqui')
        .setDescription(
          !noEscopo.length && barradas
            ? `Suas **${barradas} tarefa(s) vencida(s)** são de prova ou redação — o bot não resolve esse tipo.`
            : soNovas && jaRascunho
              ? `Suas **${jaRascunho} tarefa(s) vencida(s)** já estão em rascunho. Use \`Resolver ${noEscopo.length} vencida(s)\` para tentar de novo.`
              : 'Você não tem tarefa vencida pendente — nenhuma atividade expirada pra resolver.')],
      components: [],
    });
  }

  const r = await runSolve(i, true, alvo);
  if (barradas) {
    console.log(`[exp] ${sess.nick}: ${barradas} vencida(s) puladas — prova/redação/token_code (fora do escopo)`);
  }
  if (soNovas && jaRascunho) {
    console.log(`[exp] ${sess.nick}: ${jaRascunho} vencida(s) puladas — já em rascunho`);
  }
  return r;
}

// botão "Auto ⏰" (premium): a MESMA escolha, mas salva na conta — vale para o
// ciclo diário das 16:30, não só para a resolução na hora.
async function toggleAutoExpiradas(i) {
  const acc = getAccount(i.user.id);
  if (!isPremiumActive(acc)) return replyExpired(i, true);

  const novo = acc.autoExpired === false;
  const keyAtiva = acc.ativoRa || listAccounts(i.user.id)[0]?.key;
  if (keyAtiva) patchConta(i.user.id, keyAtiva, { autoExpired: novo });

  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);
  sess.tasks = sess.tasks || [];
  return showActionPanel(i, true);
}

async function doLogout(i) {
  sessions.delete(i.user.id);
  return i.update({
    embeds: [brand(C_BASE).setTitle('👋 Sessão encerrada')
      .setDescription('Você saiu.\n\n-# Seus dados de automação (se tiver plano) continuam salvos e seguros.')],
    components: [],
  });
}

// abre o modal pra configurar a taxa de acertos (0–100%) da conta ativa.
function openHitRateModal(i) {
  const acc = getAccount(i.user.id);
  const atual = hitRateEfetivo(acc?.hitRate);

  const inp = new TextInputBuilder()
    .setCustomId('hr')
    .setLabel('Taxa de acertos (%)')
    .setPlaceholder('Ex.: 80, 100, 90... (0–100)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(atual))
    .setMinLength(1)
    .setMaxLength(3);

  const modal = new ModalBuilder()
    .setCustomId('modal_hitrate')
    .setTitle('🎯 Taxa de acertos')
    .addComponents(new ActionRowBuilder().addComponents(inp));
  return i.showModal(modal);
}

// salva a taxa de acertos na conta ativa e volta pro painel.
async function handleHitRate(i) {
  const raw = i.fields.getTextInputValue('hr').trim().replace(',', '.');
  const v = Number(raw);

  if (!Number.isFinite(v) || v < 0 || v > 100) {
    return i.reply({
      embeds: [brand(C_ERRO).setTitle('❌ Valor inválido')
        .setDescription('Digite um número entre **0 e 100** (a taxa de acertos, em %).')],
      flags: MessageFlags.Ephemeral,
    });
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const keyAtiva = getAccount(i.user.id)?.ativoRa
    || listAccounts(i.user.id)[0]?.key;
  if (keyAtiva) patchConta(i.user.id, keyAtiva, { hitRate: v });

  // re-renderiza o painel já mostrando o valor novo
  const sess = getSession(i.user.id);
  if (!sess) return replyExpired(i, true);
  sess.tasks = sess.tasks || [];
  return showActionPanel(i, false);
}

// ── CAPTCHA HUMANO: botão → modal → resposta ─────────────────────────
// o botão "✍️ Colocar texto" abre um modal pra pessoa digitar o CAPTCHA.
function abrirModalCaptcha(i, id) {
  const pend = obterPendencia(id);
  // só o dono da pendência pode responder (o id embute quem pediu)
  if (!pend || pend.userId !== i.user.id) {
    return i.reply({
      embeds: [brand(C_ERRO).setTitle('❌ Nada para responder')
        .setDescription('Este pedido de CAPTCHA expirou ou não pertence a você.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const inp = new TextInputBuilder()
    .setCustomId('captcha_answer')
    .setLabel('Escreva o CAPTCHA (letras/números da imagem)')
    .setPlaceholder('Ex.: gEL7a')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12);

  const modal = new ModalBuilder()
    .setCustomId(`captcha_modal_${id}`)
    .setTitle('🧩 Escreva o CAPTCHA')
    .addComponents(new ActionRowBuilder().addComponents(inp));
  return i.showModal(modal);
}

// recebe a resposta digitada e resolve a pendência aguardada pelo solver.
async function receberRespostaCaptcha(i, id) {
  const pend = obterPendencia(id);
  if (!pend || pend.userId !== i.user.id) {
    return i.reply({
      embeds: [brand(C_ERRO).setTitle('❌ Nada para responder')
        .setDescription('Este pedido de CAPTCHA expirou ou não pertence a você.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  const answer = i.fields.getTextInputValue('captcha_answer').trim();
  if (!answer) {
    return i.reply({
      embeds: [brand(C_ERRO).setTitle('❌ Vazio')
        .setDescription('Digite o texto do CAPTCHA antes de enviar.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  await i.reply({
    embeds: [brand(C_OK).setTitle('✅ Recebido!')
      .setDescription(`Resposta **\`${answer}\`** registrada — continuando a tarefa...`)],
    flags: MessageFlags.Ephemeral,
  });

  if (!submitResposta(id, answer)) {
    cancelar(id, 'pedido já expirou'); // pendência sumiu no ínterim
  }
}

// ============================================================
//  COMPRAR  (intro → conta-alvo → pagamento → "já paguei")
// ============================================================
async function showBuyIntro(i) {
  const contas = listAccounts(i.user.id);
  if (!contas.length) {
    return i.reply({
      embeds: [brand(C_ATENCAO).setTitle('🔗 Vincule uma conta primeiro')
        .setDescription('Para assinar, você precisa ter pelo menos uma conta do Sala do Futuro vinculada.\n\nUse **🔗 Entrar** no painel.')],
      components: [],
      flags: MessageFlags.Ephemeral,
    });
  }

  const emb = brand(C_PREMIUM)
    .setTitle('⭐ Tarefas Automáticas Premium')
    .setDescription(
      [
        '### Deixe o bot trabalhar por você',
        'Todos os dias às **16h30**, o bot entra na sua conta e resolve **todas** as tarefas pendentes — no modo que você escolher.',
        '',
        '**O que inclui**',
        '> 🕐 Roda todo dia às 16h30, sozinho',
        '> ⚙️ Você escolhe: **envia definitivo** ou **só rascunho**',
        '> 🧠 Resolução por IA (com re-tentativas, sem chute)',
        '> 🔐 CAPTCHA resolvido automaticamente',
        '> 📲 Aviso por DM quando terminar',
        '',
        LINHA_DIV,
        `💰 **R$ ${config.pix.amount}** · ⏳ **${config.plan.durationDays} dias** · por conta de aluno`,
        '',
        '-# 💡 O bot é **grátis** para resolver manualmente quando você quiser.',
        '-# O plano serve apenas para ele fazer **sozinho**, sem você pedir.',
      ].join('\n')
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_ok').setLabel('Quero assinar').setEmoji('💳').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_back').setLabel('Voltar').setStyle(ButtonStyle.Secondary),
  );
  return i.reply({ embeds: [emb], components: [row], flags: MessageFlags.Ephemeral });
}

// depois de "Quero assinar": 1 conta → direto; várias → escolher qual recebe o plano
async function startPayment(i) {
  const contas = listAccounts(i.user.id);
  if (!contas.length) return showBuyIntro(i);

  if (contas.length === 1) return showPayment(i, 0);

  const emb = brand(C_PREMIUM)
    .setTitle('🎯 Qual conta vai receber o plano?')
    .setDescription(
      [
        `Você tem **${contas.length} contas** vinculadas.`,
        'O plano é **por conta de aluno** — escolha em qual dele a automação vai funcionar:',
        '',
        ...contas.slice(0, 12).map((c, n) =>
          `\`${String(n + 1).padStart(2, '0')}\` **${c.nick || c.ra}** · \`${c.ra}-${c.dg || ''}\` (${String(c.uf || 'SP').toUpperCase()})${isPremiumActive(c) ? ' — ⭐ já tem plano' : ''}`),
        '',
        '-# Quer o plano nas duas? Compre duas vezes — uma pra cada. 😉',
      ].join('\n')
    );

  const rows = [];
  const visiveis = contas.slice(0, 12);
  for (let k = 0; k < visiveis.length; k += 4) {
    rows.push(new ActionRowBuilder().addComponents(
      ...visiveis.slice(k, k + 4).map((c, j) => {
        const premium = isPremiumActive(c);
        return new ButtonBuilder()
          .setCustomId(`acc_pay_${k + j}`)
          .setLabel(String(`${c.nick || c.ra}${premium ? ' ⭐' : ''}`).slice(0, 80))
          .setEmoji(premium ? '♻️' : '▶️')
          .setStyle(premium ? ButtonStyle.Secondary : ButtonStyle.Success);
      }),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('acc_buy').setLabel('Voltar').setStyle(ButtonStyle.Secondary),
  ));
  return i.update({ embeds: [emb], components: rows });
}

async function showPayment(i, idx = 0) {
  const contas = listAccounts(i.user.id);
  const alvo = contas[idx];
  if (!alvo) {
    return i.update({ embeds: [brand(C_ERRO).setTitle('❌ Conta não encontrada — comece de novo.')], components: [] });
  }
  const nomeAlvo = `**${alvo.nick || alvo.ra}** · \`${alvo.ra}-${alvo.dg || ''}\``;

  const code = buildPixCode({ amount: config.pix.amount });
  const emb = brand(C_PREMIUM)
    .setTitle('💠 Pagamento · passo final')
    .setDescription(
      [
        `### Pague **R$ ${config.pix.amount}** via PIX`,
        `Plano para a conta: ${nomeAlvo}`,
        '',
        'Copie o código abaixo e cole no app do seu banco:',
        '```' + code + '```',
        '**Depois de pagar:** clique em **Já paguei** 👇',
        'A confirmação é manual — costuma levar poucos minutos.',
      ].join('\n')
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_qr').setLabel('Ver QR Code').setEmoji('📱').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`buy_paid_${idx}`).setLabel('Já paguei').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
  // vem dos botões "Entendido"/escolha de conta (mensagem efêmera) — edita no lugar.
  return i.update({ embeds: [emb], components: [row] });
}

async function showQr(i) {
  const code = buildPixCode({ amount: config.pix.amount });
  const emb = brand(C_PREMIUM)
    .setTitle('📱 QR Code PIX')
    .setDescription(`Escaneie no app do banco para pagar **R$ ${config.pix.amount}**.\n\nDepois volte e clique em **Já paguei**.`)
    .setImage(qrImageUrl(code));
  return i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
}

// usuário diz que pagou → avisa o aluno pra aguardar e manda DM de aprovação a quem confere.
async function handlePaid(i, idx = 0) {
  const contas = listAccounts(i.user.id);
  const alvo = contas[idx];
  if (!alvo) {
    return i.reply({
      embeds: [brand(C_ERRO).setTitle('❌ Conta não encontrada — refaça o fluxo pelo painel.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  const ra = `${alvo.ra}-${alvo.dg || ''}`;
  const nick = alvo.nick || '—';

  await i.reply({
    embeds: [brand(C_ATENCAO).setTitle('⏳ Recebido!')
      .setDescription(
        [
          'Pagamento em **análise manual**.',
          `Aprovando, o plano ativa na conta **${nick}** (\`${ra}\`).`,
          'Você será avisado **aqui mesmo**. 💛',
        ].join('\n'))],
    flags: MessageFlags.Ephemeral,
  });

  // DM a quem confere os pagamentos (paymentsUserId), com botões aprovar/recusar
  try {
    const conferente = await client.users.fetch(config.paymentsUserId);
    const embed = brand(C_PREMIUM)
      .setTitle('💸 Novo pagamento para conferir')
      .addFields(
        { name: 'Usuário', value: `<@${i.user.id}> (\`${i.user.tag}\`)`, inline: false },
        { name: 'Conta que recebe o plano', value: `**${nick}** · \`${ra}\``, inline: true },
        { name: 'Valor', value: `**R$ ${config.pix.amount}**`, inline: true },
      )
      .setFooter({ text: `id: ${i.user.id} • confira a Nubank (chave ${config.pix.key})` });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve_${idx}_${i.user.id}`).setLabel('Aprovar').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`reject_${idx}_${i.user.id}`).setLabel('Recusar').setEmoji('❌').setStyle(ButtonStyle.Danger),
    );
    await conferente.send({ embeds: [embed], components: [row] });
  } catch (e) {
    console.error('[pagamento] não consegui avisar o conferente:', e.message);
  }
}

// ============================================================
//  APROVAÇÃO (dono ou quem confere os pagamentos)
// ============================================================
// pode aprovar/recusar: dono ou quem confere os pagamentos
function podeConferir(userId) {
  return userId === config.ownerId || userId === config.paymentsUserId;
}

async function handleApprove(i, idx, targetId) {
  if (!podeConferir(i.user.id)) {
    return i.reply({ content: '❌ Sem permissão para aprovar.', flags: MessageFlags.Ephemeral });
  }
  const conta = listAccounts(targetId)[idx];
  if (!conta) {
    return i.update({ content: '⚠️ A conta desse usuário não existe mais (ele re-vinculou?). Confira com ele.', embeds: [], components: [] });
  }
  const until = Date.now() + config.plan.durationDays * 86400000;
  setContaPlan(targetId, conta.key, 'premium', until);

  const nome = `**${conta.nick || conta.ra}** · \`${conta.ra}-${conta.dg || ''}\``;
  await i.update({
    embeds: [brand(C_OK).setTitle('✅ Pagamento aprovado')
      .setDescription(`<@${targetId}> agora é **premium** por ${config.plan.durationDays} dias na conta ${nome}.`)],
    components: [],
  });

  // avisa o aluno
  try {
    const u = await client.users.fetch(targetId);
    await u.send({
      embeds: [brand(C_PREMIUM).setTitle('🎉 Plano ativado!')
        .setDescription(
          [
            `Bem-vindo(a) ao **Premium**!`,
            `> Conta: ${nome}`,
            `> Duração: **${config.plan.durationDays} dias**`,
            `> Horário: **diário no fim da tarde** — o minuto exato da sua conta aparece no painel`,
            `> Modo: ajustável no painel (📤 definitivo / 📝 rascunho)`,
            '',
            'É só deixar comigo agora. 😎',
          ].join('\n')),
      ],
    });
  } catch { /* DM fechada */ }
}

async function handleReject(i, idx, targetId) {
  if (!podeConferir(i.user.id)) {
    return i.reply({ content: '❌ Sem permissão para recusar.', flags: MessageFlags.Ephemeral });
  }
  await i.update({
    embeds: [brand(C_ERRO).setTitle('❌ Pagamento recusado')
      .setDescription(`Nada foi ativado para <@${targetId}>.`)],
    components: [],
  });
  try {
    const u = await client.users.fetch(targetId);
    await u.send({
      embeds: [brand(C_ERRO).setTitle('Pagamento não localizado')
        .setDescription('Não encontramos seu PIX.\n\nSe você pagou, confira valor/chave e chame o suporte.')],
    });
  } catch { /* DM fechada */ }
}

// ============================================================
//  INFORMAÇÕES
// ============================================================
async function showInfo(i) {
  const emb = brand({ color: C_INFO })
    .setTitle('ℹ️ Como funciona')
    .setDescription(
      `**Lumen Bot** — Resolução automática de tarefas do Sala do Futuro\n\n` +
      `**O que é:** Um bot Discord que faz suas tarefas usando IA\n\n` +
      `**Como usar:**\n` +
      `• Use \`/painel\` ou \`!tarefas\` para começar\n` +
      `• Vincule sua conta com RA e senha do gov.sp\n` +
      `• Veja suas tarefas pendentes e resolva\n\n` +
      `** provedores de IA:**\n` +
      `• **Groq** — 5 contas free (gpt-oss-120b)\n` +
      `• **Gemini** — reserva quando Groq limita\n` +
      `• **Roteador** — fallback livre\n\n` +
      `**Comandos:**\n` +
      `• \`/painel\` — reposta o painel\n` +
      `• \`!tarefas\` — atualiza tarefas\n\n` +
      `💡 **Dica:** Se o Groq ficar lento, o bot usa Gemini automaticamente.`
    )
    .setFooter({ text: `${NOME_BOT} • ${VERSAO}` });
  return i.reply({ embeds: [emb], flags: MessageFlags.Ephemeral });
}

// ============================================================
//  helpers
// ============================================================
function replyExpired(i, fromButton) {
  const payload = {
    embeds: [brand(C_ATENCAO).setTitle('⌛ Sessão expirada')
      .setDescription('Clique em **🔗 Entrar** no painel para continuar.')],
    components: [],
  };
  return fromButton ? i.update(payload) : i.editReply(payload);
}

// login com fallback: se a intenção MESSAGE CONTENT estiver desligada no portal,
// sobe sem ela (o bot funciona; só o comando !tarefas fica indisponível).
async function conectar() {
  try {
    await client.login(config.discord.token);
  } catch (e) {
    if (/disallowed intents/i.test(String(e?.message || ''))) {
      console.warn('[boot] MESSAGE CONTENT INTENT desligada no portal — subindo SEM o !tarefas.');
      console.warn('[boot] pra ligar: discord.com/developers/applications → seu app → Bot → MESSAGE CONTENT INTENT');
      client.options.intents = INTENTS_BASE;
      await client.login(config.discord.token);
    } else throw e;
  }
}
conectar().catch(e => { console.error('[boot] falha ao logar:', e); process.exit(1); });
