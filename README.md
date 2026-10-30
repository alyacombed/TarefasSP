# Lumen Bot — Discord

Bot do Discord que loga na Sala do Futuro (SED/edusp) e resolve as tarefas
pendentes automaticamente via IA (Google AI Studio / Gemini). Sem interface web — tudo por
**embed + botão + modal**.

## Fluxo

```
/painel          -> posta um embed com o botão "Entrar"
[botão Entrar]   -> abre um modal com RA / dígito / UF / senha
[modal enviado]  -> login SED -> token edusp -> lista tarefas -> resolve -> relatório
```

A resposta com o progresso é **efêmera** (só quem clicou vê).

## Setup

```bash
cd bot
npm install
cp .env.example .env       # preencha os valores
npm run register           # registra o /painel (rode 1x)
npm start                  # liga o bot
```

### Variáveis (.env)

| var | o que é |
|-----|---------|
| `DISCORD_TOKEN` | token do bot (Developer Portal > Bot) |
| `DISCORD_CLIENT_ID` | Application ID |
| `DISCORD_GUILD_ID` | id do servidor (opcional; deixa o /painel instantâneo) |
| `GEMINI_API_KEY` | chave em aistudio.google.com/apikey |
| `STORE_SECRET` | chave mestre para criptografia de senhas salvas (AES-256-GCM + PBKDF2) |
| `GROQ_API_KEY` | (opcional) chave de fallback para resolução via Groq (Llama 3.3) |
| `OPENROUTER_API_KEY` | (opcional) chave de fallback via OpenRouter (DeepSeek / outros) |
| `ROUTER_BASE_URL` / `ROUTER_API_KEY` / `ROUTER_MODEL` | (opcional) reserva final em qualquer gateway compatível com a API da OpenAI (LiteLLM/router próprio, Together, vLLM). `ROUTER_MODEL` aceita vários modelos separados por vírgula (cascata) |
| `LITELLM_BASE_URL` / `LITELLM_API_KEY1..N` | (opcional) alias do roteador — Ex.: `https://api.literouter.com/v1` + chave do seu literouter. várias chaves = pool em round-robin |
| `PROXY_URL` | (opcional) proxy reverso se a VPS não for brasileira (deixe em branco se rodar em VPS BR) |
| `DEFAULT_SUBMIT_MODE` | `draft` (seguro) ou `submitted` (definitivo) |
| `NVIDIA_API_KEY`, `GITHUB_MODELS_TOKEN`, `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `MISTRAL_API_KEY`, `OVH_AI_API_KEY` | (opcionais) roteadores **gratuitos** extras na cascata de reserva — cada um entra sozinho quando a chave existe; modelo via `<PREFIXO>_MODEL` (ex.: `NVIDIA_MODEL`) |
| `ROUTER2_BASE_URL` / `ROUTER2_API_KEY` / `ROUTER2_MODEL` | (opcional) segundo roteador genérico, mesma sintaxe do `ROUTER_BASE_URL` (idem `ROUTER3..6`) |

### Cascata de IA (ordem de uso)

```
Groq (pool de chaves)  →  Gemini (cascata de chaves/modelos)  →  Roteador/LiteLLM + extras (NIM, GitHub, Cerebras…)  →  OpenRouter
```

A chamada sobe de degrau quando o anterior **não entrega resposta utilizável**:
erro de rede, cota/429, modelo sobrecarregado (500/503), resposta **vazia** ou
**truncada por falta de tokens** (`finish_reason: length` — o caso do
`gpt-oss`, que gasta todo o `max_tokens` no raciocínio e volta sem texto). Numa
questão de escrita (redação/texto), o resgate é explícito: Groq → Gemini
exclusivo → roteador.

O bot **não dorme** esperando cota que não volta em breve: se o Groq só
liberaria em horas (limite diário), ele escala para o Gemini/roteador na hora
(`GROQ_ESPERA_MAX_SEGUNDOS`, padrão 90s).

### Convidar o bot

No Developer Portal > OAuth2 > URL Generator, marque os escopos
`bot` e `applications.commands`. Não precisa de intents privilegiadas.

## 🛡️ Segurança de Senhas e Dados

- **Criptografia Forte (AES-256-GCM + PBKDF2)**: As senhas gravadas em `data/accounts.json` são encriptadas de ponta a ponta com chaves derivadas por PBKDF2 com salt dinâmico único de 128 bits por conta. Mesmo se o arquivo de dados for vazado do servidor, as senhas não podem ser lidas em texto puro.
- **Armazenamento de Sessões em Memória**: As sessões ativas do Discord expiram automaticamente em 2 horas.

## ☁️ Hospedagem em Servidor na Nuvem (VPS Brasil)

- Ao hospedar em uma VPS no Brasil (ex: Oracle Cloud São Paulo, AWS sa-east-1, Contabo BR, DigitalOcean BR ou Hetzner BR com IP BR):
  - Deixe a variável `PROXY_URL` **vazia** no `.env`.
  - As requisições para a SED e EDUSP serão feitas de forma **direta**, garantindo máxima velocidade e menor latência.
- Para manter o bot 24/7 rodando na VPS:
  ```bash
  npm install pm2 -g
  pm2 start start.js --name "lumen-bot"
  pm2 save
  pm2 startup
  ```

## Estrutura

```
src/
  config.js              env + hosts
  http.js                fetch + parse de erro
  sed.js                 login SED + troca token edusp
  edusp.js               turmas, tarefas, apply, submit
  heuristic.js           resolvedor sem IA (fallback por questão)
  ai.js                  solver via Gemini (chain-of-thought por tipo)
  sed-key.js             descobre a chave da APIM da SED no app oficial
  solver.js              apply -> IA -> valida shape -> envia
  register-commands.js   registra /painel
  index.js               bot (embed/botão/modal/loop)
```

Toda a lógica de rede e de montagem de respostas foi portada do site
original (`js/api.js`, `ai_proxy/server.js`), sem `localStorage` nem proxy
de CORS (desnecessários no servidor).
