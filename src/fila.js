// fila GLOBAL de resolução com K VAGAS (semáforo FIFO): até K rodadas
// resolvem ao mesmo tempo — uma vaga por chave Groq do pool. quem chega
// quando todas as vagas estão ocupadas espera na fila e entra na ordem
// em que apertou. evita sobrecarregar IA/captcha sem serializar todo mundo.
let vagas = 1;
let rodando = 0;
const esperando = []; // { rotulo, posicao, iniciar }

// define quantas rodadas simultâneas (chamado no boot com o nº de chaves Groq).
export function configurarVagas(n) {
  const k = Math.max(1, Number(n) || 1);
  if (k === vagas) return;
  vagas = k;
  proxima(); // se aumentou, já acorda quem estava esperando
}

function proxima() {
  while (rodando < vagas && esperando.length) {
    const item = esperando.shift();
    rodando++;
    item.iniciar();
  }
  // re-numera quem ainda espera: posição GLOBAL (rodando ocupam 1..rodando)
  for (let i = 0; i < esperando.length; i++) esperando[i].posicao = rodando + i + 1;
}

// enfileira UMA rodada. devolve:
//   { resultado (promise), posicao (ordem global, 1-based), naFila (bool) }
// posicao <= nº de vagas => começou imediatamente ("é a sua vez").
export function enfileirarRodada(rotulo, fn) {
  const item = { rotulo };
  const resultado = new Promise((resolve, reject) => {
    item.iniciar = async () => {
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { rodando--; proxima(); }
    };
  });
  esperando.push(item);
  proxima();
  const naFila = esperando.includes(item);
  return { resultado, posicao: Math.max(1, item.posicao || rodando), naFila };
}

// quantas rodadas estão esperando vaga (não conta as que já rodam).
export function rodadasEsperando() {
  return esperando.length;
}

// quantas rodadas estão RODANDO agora (útil pra dividir as chaves entre elas).
export function rodadasAtivas() {
  return rodando;
}
