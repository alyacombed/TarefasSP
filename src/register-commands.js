// registra o slash command /painel.
// rode UMA vez (ou quando mudar os comandos): npm run register
// visível pra todos; QUEM pode executar é validado no index.js
// (dono/conferente ou cargo PAINEL_ROLE_ID no servidor PANEL_GUILD_ID).
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config, assertConfig } from './config.js';

assertConfig();

const commands = [
  new SlashCommandBuilder()
    .setName('painel')
    .setDescription('Reposta o painel de Tarefas Automáticas neste canal')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(config.discord.token);

// registra no servidor do painel por padrão (atualiza na HORA).
// só cai pro global se não houver nenhum server definido.
const alvoGuild = config.discord.guildId || config.painelGuildId;

try {
  if (alvoGuild) {
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, alvoGuild),
      { body: commands },
    );
    console.log('✅ /painel registrado no servidor', alvoGuild, '(instantâneo)');
  } else {
    await rest.put(
      Routes.applicationCommands(config.discord.clientId),
      { body: commands },
    );
    console.log('✅ /painel registrado globalmente (pode levar ~1h pra aparecer)');
  }
} catch (e) {
  console.error('❌ falha ao registrar comandos:', e);
  process.exit(1);
}
