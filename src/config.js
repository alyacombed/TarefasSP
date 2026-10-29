// configuração central — lê do ambiente (.env)
// dotenv é opcional: se as variáveis já vierem do ambiente (hospedagem,
// docker, `export VAR=...`), o bot roda mesmo sem o pacote instalado.
try { await import('dotenv/config'); } catch { /* sem dotenv, usa env do sistema */ }

// junta todas as chaves de uma família (openrouter1..12, litellm1..5...):
// lê a base (FAMILIA), FAMILIA2..FAMILIA9 E FAMILIA1..FAMILIA20 (cobre os dois
// estilos de numeração que o pessoal usa no .env), sem duplicadas.
function lerChavesFamilia(nomeBase, max = 20) {
  const chaves = [];
  for (let i = 1; i <= max; i++) chaves.push(process.env[`${nomeBase}${i}`]);
  chaves.push(process.env[nomeBase]);
  return [...new Set(chaves.filter(Boolean))];
}

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID || null,
  },
  // Google AI Studio (Gemini) — pega a chave em https://aistudio.google.com/apikey
  gemini: {
    apiKeys: [
      process.env.GEMINI_API_KEY,
      process.env.GEMINI_API_KEY2,
      process.env.GEMINI_API_KEY3,
      process.env.GEMINI_API_KEY4,
      process.env.GEMINI_API_KEY5,
      process.env.GEMINI_API_KEY6,
      process.env.GEMINI_API_KEY7,
      process.env.GEMINI_API_KEY8,
      process.env.GEMINI_API_KEY9,
      process.env.GEMINI_API_KEY10
    ].filter(Boolean),
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  },
  // pool Groq: GROQ_API_KEY..GROQ_API_KEY5 = uma conta free por chave
  // (limites TPM/TPD individuais — ver ai.js). compound-mini é a reserva de
  // pico quando TODAS as chaves gpt-oss estão em pausa 429.
  groq: {
    overflowModel: process.env.GROQ_OVERFLOW_MODEL || 'groq/compound-mini',
    compoundDailyBudget: Number(process.env.GROQ_COMPOUND_DAILY_BUDGET) || 200, // free tem 250/dia; folga de segurança
  },

  // ============================================================
  //  RESERVA FINAL — qualquer gateway que fale a API da OpenAI
  //  (LiteLLM/router próprio, OpenRouter, Together, vLLM...). entra
  //  SÓ quando o Groq E o Gemini já falharam/esgotaram cota, então
  //  não faz sentido gastar cota aqui antes disso.
  //    ROUTER_BASE_URL = https://meu-litellm.com/v1
  //    ROUTER_API_KEY  = sk-...
  //    ROUTER_MODEL    = modelo1,modelo2   (cascata: tenta na ordem)
  //  (Routers aceitam o alias LITELLM_BASE_URL/LITELLM_API_KEY.)
  //  sem ROUTER_MODEL, tenta os apelidos mais comuns (LiteLLM responde
  //  rápido "model not found" e cai no próximo da lista).
  // ============================================================
  router: {
    baseUrl: String(process.env.ROUTER_BASE_URL || process.env.LITELLM_BASE_URL || '').trim().replace(/\/+$/, ''),
    apiKeys: [...new Set([
      ...lerChavesFamilia('ROUTER_API_KEY'),
      ...lerChavesFamilia('LITELLM_API_KEY'),
      process.env.ROUTER_API_2, process.env.ROUTER_API_3,
    ].filter(Boolean))],
    models: [...new Set(String(process.env.ROUTER_MODEL || process.env.LITELLM_MODEL || 'openai/gpt-oss-120b,groq/llama-3.3-70b-versatile,google/gemini-2.5-flash')
      .split(',').map(s => s.trim()).filter(Boolean))],
  },

  // OpenRouter: mesmo formato do router, base fixa. ROUTER_BASE_URL tem
  // prioridade sobre o base padrão quando as duas estiverem no .env.
  openRouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeys: [...new Set([...lerChavesFamilia('OPENROUTER_API_KEY')].filter(Boolean))],
    models: [...new Set(String(process.env.OPENROUTER_MODEL || 'deepseek/deepseek-r1-distill-llama-70b,openrouter/free')
      .split(',').map(s => s.trim()).filter(Boolean))],
  },

  // roteadores GRATUITOS nomeados — cada um entra sozinho na cascata de reserva
  // quando a chave dele aparece no .env (base fixa conhecida). o modelo vem de
  // <PREFIXO>_MODEL (ex.: NVIDIA_MODEL); sem ele, a lista default do provider
  // (que responde "model not found" rápido e o bot desce pro próximo sozinho).
  roteadoresExtras: (() => {
    const extra = (nome, baseUrl, apiKeyEnv, defaultModels) => {
      const chave = process.env[apiKeyEnv];
      const apiKeys = [...new Set([
        chave, process.env[`${apiKeyEnv}2`],
      ].filter(Boolean))];
      const models = [...new Set(String(process.env[`${nome.toUpperCase()}_MODEL`] || defaultModels)
        .split(',').map(s => s.trim()).filter(Boolean))];
      return { nome, baseUrl, apiKeys, models };
    };
    return [
      // NVIDIA NIM — 78+ modelos open (Nemotron, Llama, DeepSeek...), ~40 RPM, sem cartão.
      extra('nvidia', 'https://integrate.api.nvidia.com/v1', 'NVIDIA_API_KEY', 'nvidia/llama-3.3-70b-instruct,nvidia/nemotron-3-70b'),
      // GitHub Models — GPT-4o/Claude/Llama com o token do GitHub, sem cartão.
      extra('github', 'https://models.github.ai/inference', 'GITHUB_MODELS_TOKEN', 'gpt-4o-mini'),
      // Cerebras — gpt-oss em LPU (super rápido como o Groq), tier free.
      extra('cerebras', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY', 'gpt-oss-120b'),
      // SambaNova — Llama 3.3 405B, crédito inicial grátis.
      extra('sambanova', 'https://api.sambanova.ai/v1', 'SAMBANOVA_API_KEY', 'Meta-Llama-3.3-70B-Instruct'),
      // Mistral — tier free baixo (mistral-small), ainda assim uma rota de saída.
      extra('mistral', 'https://api.mistral.ai/v1', 'MISTRAL_API_KEY', 'mistral-small-latest'),
      // OVHcloud AI Endpoints — Qwen free, 2 RPM anônimo / mais com conta.
      extra('ovh', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', 'OVH_AI_API_KEY', 'qwen3.5-397b-a17b'),
    ];
  })(),

  // roteadores GENÉRICOS extras: qualquer gateway OpenAI-compatible além do
  // ROUTER_BASE_URL principal. mesma sintaxe, com número:
  //   ROUTER2_BASE_URL / ROUTER2_API_KEY / ROUTER2_MODEL   (idem 3..6)
  roteadoresCustom: (() => {
    const escolhidos = [];
    for (let n = 2; n <= 6; n++) {
      const base = String(process.env[`ROUTER${n}_BASE_URL`] || '').trim().replace(/\/+$/, '');
      const apiKeys = [...new Set([
        process.env[`ROUTER${n}_API_KEY`], process.env[`ROUTER${n}_API_KEY2`],
      ].filter(Boolean))];
      const models = [...new Set(String(process.env[`ROUTER${n}_MODEL`] || '')
        .split(',').map(s => s.trim()).filter(Boolean))];
      if (base && apiKeys.length) {
        escolhidos.push({
          nome: `roteador${n}`,
          baseUrl: base,
          apiKeys,
          models: models.length ? models : String(process.env.ROUTER_MODEL || process.env.LITELLM_MODEL || 'openai/gpt-oss-120b,groq/llama-3.3-70b-versatile,google/gemini-2.5-flash')
            .split(',').map(s => s.trim()).filter(Boolean),
        });
      }
    }
    return escolhidos;
  })(),

  // verificação PÓS-RESOLUÇÃO: antes de enviar, o bot pega TODAS as perguntas e
  // respostas da tarefa e manda (cada tarefa presa à SUA chave do Gemini) pro
  // Gemini conferir. Se alguma estiver errada, ele devolve o gabarito e o bot
  // se auto-corrige antes de enviar. VERIFY_ENABLED=false desliga.
  verify: {
    enabled: process.env.VERIFY_ENABLED !== 'false',
    temperature: Number(process.env.VERIFY_TEMPERATURE) || 0.1,
    // taxa de acertos padrão quando a pessoa não configurou no painel (0–100).
    // 100 = acerta tudo (comportamento padrão). DEFAULT_HIT_RATE no .env muda.
    defaultHitRate: (() => {
      const v = Number(process.env.DEFAULT_HIT_RATE);
      return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null; // null = usa 100
    })(),
  },

  sed: {
    apimKey: process.env.SED_APIM_KEY || 'd701a2043aa24d7ebb37e9adf60d043b',
  },
  // 'draft' não finaliza (seguro). 'submitted' é envio definitivo.
  defaultSubmitMode: process.env.DEFAULT_SUBMIT_MODE === 'submitted' ? 'submitted' : 'draft',

  // id do dono do script (permite /painel e aprovar/recusar pagamentos).
  ownerId: process.env.OWNER_ID || '1372615579407618209',
  // quem recebe a DM de "Já paguei" (conferência do PIX). também pode aprovar.
  // por padrão é o próprio dono; dá pra delegar via PAYMENTS_USER_ID no .env.
  paymentsUserId: process.env.PAYMENTS_USER_ID || '1372615579407618209',

  // quem MAIS pode usar /painel: qualquer membro com este cargo neste servidor.
  painelRoleId: process.env.PAINEL_ROLE_ID || '1476318705691529382',
  painelGuildId: process.env.PANEL_GUILD_ID || '1515188219157942343',
  // canal do painel fixo. SEM padrão fixo de propósito: o ID antigo
  // (1514679417408979147) era MENOR que o ID do servidor acima, ou seja, não
  // pertencia a esse servidor — aí toda vez que o bot ligava ele gastava uma
  // chamada e levava "Unknown Channel". agora o canal vem do .env ou é
  // aprendido na 1ª vez que o dono roda /painel no canal certo (panelChannel.js).
  panelChannelId: process.env.PANEL_CHANNEL_ID || null,

  // dados do PIX (pagamento manual, conferido pelo dono na Nubank).
  pix: {
    key: process.env.PIX_KEY || '9af572b1-a21a-4469-a72a-c50ad04a4477',
    name: process.env.PIX_NAME || 'Tarefas Automaticas',
    city: process.env.PIX_CITY || 'SAO PAULO',
    amount: process.env.PIX_AMOUNT || '10.00',
  },

  // plano premium: duração em dias. ciclo fixo: todo dia às 16:30.
  // staggerMinutes = espaçamento entre uma conta premium e a seguinte
  // (evita pico na API de IA se vários alunos assinarem).
  plan: {
    durationDays: Number(process.env.PLAN_DAYS) || 30,
    staggerMinutes: Number(process.env.AUTO_STAGGER_MINUTES) || 15,
  },

  // ritmo "humano" da resolução:
  //   questionDelayMs     = pausa ENTRE questões (descarrega a cota da chave de IA)
  //   submitMin/MaxMs     = tempo-alvo ALEATÓRIO de cada tarefa no envio DEFINITIVO:
  //                         cada tarefa SORTEIA seu tempo entre min e max (padrão 10–15
  //                         min), então as tarefas saem espalhadas, nunca todas juntas.
  //                         Se a IA demorar MAIS que o sorteado, envia assim que acabar.
  //   draftPiso/JitterMs  = rascunho: piso FIXO de 10 min + até 5 min aleatórios por
  //                         tarefa (10:00, 11:20, 14:47…) — propositalmente sem .env.
  //   aiRetryMs           = espera ao falhar numa questão (resetar cota) antes de re-tentar
  //   maxQuestionAttempts = máx. tentativas POR questão antes de desistir SEM chutar
  pace: {
    questionDelayMs: (Number(process.env.QUESTION_DELAY_SECONDS) || 60) * 1000,   // 1 min entre questões
    submitMinMs: (Number(process.env.SUBMIT_MIN_MINUTES) || Number(process.env.MIN_TASK_MINUTES) || 10) * 60_000, // definitivo: mínimo 10 min
    submitMaxMs: (Number(process.env.SUBMIT_MAX_MINUTES) || 15) * 60_000,          // definitivo: máximo 15 min
    draftPisoMs: (Number(process.env.DRAFT_MIN_MINUTES) || 10) * 60_000,            // rascunho: piso (default 10 min; DRAFT_MIN_MINUTES reduz)
    draftJitterMs: (Number(process.env.DRAFT_JITTER_MINUTES) || 5) * 60_000,        // rascunho: + até X min aleatório (default 5)
    aiRetryMs: (Number(process.env.AI_RETRY_SECONDS) || 60) * 1000,                // 1 min
    maxQuestionAttempts: Number(process.env.MAX_AI_RETRIES) || 8,                  // 8 basta; mais que isso só queima cota
  },

  // alvos extras de /tms/task/todo. o alvo que a API aceita para a turma
  // ("publication_target") NÃO é o id da sala: é um número opaco (ex.: 764)
  // que não aparece em /room/user, nem em /targets/categories, nem dá pra
  // colher das tarefas (verificado contra a API). quem manda o curl no site vê
  // a lista certa na aba de tarefas do site.
  //
  // IMPORTANTE: o número é DA CONTA. mandar o alvo de uma conta em outra não
  // vaza nada (a API filtra pelo token), mas faz a varredura voltar vazia e o
  // aluno fica "sem pendência" sem ser verdade. então:
  //   PUBLICATION_TARGETS           = alvo global (evite; só 1 conta)
  //   PUBLICATION_TARGETS_<NICK>    = alvo só daquela conta, ex.:
  //     PUBLICATION_TARGETS_00001119391234_SP=764,2089
  // o NICK vai com "_" no lugar de "-", em maiúsculas.
  edusp: (() => {
    const lista = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    const chave = (nick) => `PUBLICATION_TARGETS_${String(nick || '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    return {
      global: lista(process.env.PUBLICATION_TARGETS),
      porConta: new Proxy({}, {
        get: (_, nick) => lista(process.env[chave(nick)]),
        has: (_, nick) => !!process.env[chave(nick)],
      }),
    };
  })(),

  // segredo pra cifrar a senha no disco (data/accounts.json).
  store: {
    secret: process.env.STORE_SECRET || process.env.DISCORD_TOKEN || 'lumen-secure-master-key-fallback-2026',
  },

  // proxy opcional (IP do Brasil) — usado se a hospedagem ficar fora do país.
  // em branco / 'off' / 'direct' = tráfego direto (sem proxy). a ausência no
  // .env também = direto (ANTES o default silencioso mantinha o proxy ligado
  // mesmo com PROXY_URL vazio — por isso este computador BR ficava roteando
  // por um proxy compartilhado que o Cloudflare vive desafiando).
  proxyUrl: (() => {
    const v = String(process.env.PROXY_URL || '').trim().toLowerCase();
    if (!v || v === 'off' || v === 'direct' || v === 'none') return null;
    return process.env.PROXY_URL.trim();
  })(),
};

// hosts da API (mesmos do site)
export const EDUSP_HOST = 'edusp-api.ip.tv';
export const SED_HOST = 'sedintegracoes.educacao.sp.gov.br';
export const EDUSP = `https://${EDUSP_HOST}`;
export const SED = `https://${SED_HOST}`;

// resolve a taxa de acertos efetiva (0–100): config da pessoa > DEFAULT_HIT_RATE do
// .env > 100 (acerta tudo). nunca devolve null — sempre um número válido.
export function hitRateEfetivo(u) {
  if (u == null || u === '') {
    const d = config.verify.defaultHitRate;
    return Number.isFinite(d) ? d : 100;
  }
  const v = Number(u);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100;
}

export function assertConfig() {
  const missing = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.gemini.apiKeys || config.gemini.apiKeys.length === 0) missing.push('GEMINI_API_KEY');
  if (missing.length) {
    console.error('[lumen] faltam variáveis no .env:', missing.join(', '));
    process.exit(1);
  }
}
