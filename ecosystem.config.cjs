// PM2 — mantém o bot vivo: reinicia sozinho se cair e loga com timestamp.
//
// COMO USAR (uma vez só):
//   npm install -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save                <- lembra da lista de processos
//   pm2 startup             <- sobe o pm2 junto com o Windows (segue as instruções que ele imprimir)
//
// ÚTEIS NO DIA A DIA:
//   pm2 status              <- ver se está online
//   pm2 logs orbitstore     <- ver o console do bot ao vivo
//   pm2 restart orbitstore  <- reiniciar depois de mudar o .env/código
module.exports = {
  apps: [{
    name: 'orbitstore',
    script: 'src/index.js',
    autorestart: true,
    max_memory_restart: '500M',
    max_restarts: 50,
    restart_delay: 5000,
    time: true,
  }],
};
