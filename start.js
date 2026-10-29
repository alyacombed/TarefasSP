// ponto de entrada para hospedagem (HidenCloud etc.).
// 1) registra os comandos do Discord (garante o /painel)
// 2) sobe o bot (src/index.js)
// 3) reinicia sozinho se o bot cair — essencial pra rodar 24h.
//
// na hospedagem, configure o comando de start como:  node start.js
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dir, 'src', 'index.js');
const REGISTER = join(__dir, 'src', 'register-commands.js');

// roda um script node e resolve quando ele terminar (code de saída).
function run(file, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [file], { stdio: 'inherit', cwd: __dir });
    p.on('error', (e) => { console.error('❌ erro ao iniciar', file, e.message); resolve(1); });
    p.on('close', (code) => resolve(code ?? 0));
  });
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

async function main() {
  // 1) registra comandos (não derruba o boot se falhar — só avisa)
  console.log('🔧 registrando comandos do Discord...');
  const reg = await run(REGISTER);
  if (reg !== 0) console.warn('⚠️ registro de comandos falhou (code ' + reg + '); seguindo mesmo assim.');

  // 2) loop de supervisão: sobe o bot e reinicia se cair
  let tentativas = 0;
  while (!stopping) {
    console.log('🚀 iniciando o bot (src/index.js)...');
    const code = await run(INDEX);
    if (stopping) break;

    // backoff simples: 3s, cresce até 30s pra não martelar em loop de crash
    tentativas++;
    const espera = Math.min(3000 * tentativas, 30000);
    console.log(`📴 bot finalizou (code ${code}). reiniciando em ${Math.round(espera / 1000)}s...`);
    await new Promise(r => setTimeout(r, espera));
    // se ficou estável por um tempo, zera o contador na próxima parada longa
    if (code === 0) tentativas = 0;
  }
  console.log('👋 encerrando supervisor.');
}

main();
