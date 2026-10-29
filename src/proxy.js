// roteia as chamadas de API por um proxy reverso com IP do Brasil.
// usado quando a hospedagem fica fora do país e a SED bloqueia IP estrangeiro.
//
// ATENÇÃO: este proxy NÃO é um túnel HTTP (CONNECT). É um reescritor de URL:
// você bate em  https://<proxy>/<host-de-destino>/<path>  e ele encaminha
// pro host real, saindo com IP brasileiro. Só repassa hosts da allowlist
// (sedintegracoes.educacao.sp.gov.br e edusp-api.ip.tv).
//
// liga/desliga pela env PROXY_URL (ex.: https://eclipse-proxy.exemplo.org).
// vazio = sem proxy (URL original, tráfego direto).
import { config } from './config.js';

// remove a barra final do proxy, se houver.
function base() {
  return String(config.proxyUrl || '').replace(/\/+$/, '');
}

export function proxyEnabled() {
  return !!base();
}

// transforma a URL de destino na URL que passa pelo proxy.
// ex.: https://edusp-api.ip.tv/room/user?x=1
//   -> https://<proxy>/edusp-api.ip.tv/room/user?x=1
// se o proxy estiver desligado, devolve a URL original sem tocar.
export function proxify(url) {
  const p = base();
  if (!p) return url;
  try {
    const u = new URL(String(url));
    // host + path + querystring, sem o esquema (o proxy decide o https final).
    return `${p}/${u.host}${u.pathname}${u.search}`;
  } catch {
    return url; // se não for URL válida, não mexe
  }
}

// log único no boot pra confirmar o estado.
export function logProxyStatus() {
  if (proxyEnabled()) console.log(`🌐 proxy BR ativo — APIs roteadas por ${base()}`);
  else console.log('🌐 proxy desligado — tráfego direto (defina PROXY_URL p/ rotear pelo Brasil)');
}
