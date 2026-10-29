// login SED + troca por token edusp.
// portado de js/api.js (sedLogin / eduspFromSedToken), sem proxy.
import { jfetch } from './http.js';
import { SED, EDUSP } from './config.js';
import { getSedKey, invalidateSedKey } from './sed-key.js';

function sedHeaders(apimKey, extra = {}) {
  return {
    'content-type': 'application/json',
    'accept': 'application/json, text/plain, */*',
    'ocp-apim-subscription-key': apimKey,
    'x-product-name': 'SalaDoFuturo',
    ...extra,
  };
}

// monta o "user" no formato que a SED espera: RA + dígito + UF, tudo junto e maiúsculo.
// ex.: ra=123456789 dg=X uf=sp  ->  "123456789XSP"
export function montarUser(ra, dg, uf) {
  return `${String(ra).trim()}${String(dg || '').trim()}${String(uf || '').trim()}`.toUpperCase();
}

// passo 1: autentica no SED (BFF do Sala do Futuro), cai pro legado se 404.
// usa a chave da APIM descoberta do app oficial; se tomar 401/403 (chave
// rotacionada), invalida o cache, re-descobre e tenta de novo uma vez.
export async function sedLogin(user, password) {
  const paths = [
    '/saladofuturobffapi/credenciais/api/LoginCompletoToken',
    '/credenciais/api/LoginCompletoToken',
  ];

  async function tentar(apimKey) {
    let last;
    for (const p of paths) {
      try {
        return await jfetch(`${SED}${p}`, {
          method: 'POST',
          headers: sedHeaders(apimKey),
          body: JSON.stringify({ user, senha: password }),
        });
      } catch (e) {
        last = e;
        if (e.status !== 404) throw e;
      }
    }
    throw last || new Error('SED indisponível');
  }

  let key = await getSedKey();
  try {
    return await tentar(key);
  } catch (e) {
    // 401/403 normalmente = chave da APIM rotacionou. re-descobre e tenta 1x.
    if (e.status === 401 || e.status === 403) {
      invalidateSedKey();
      const nova = await getSedKey();
      if (nova && nova !== key) return tentar(nova);
    }
    throw e;
  }
}

// passo 2: troca o token SED pelo auth_token da edusp.
export async function eduspFromSedToken(sedToken) {
  const j = await jfetch(`${EDUSP}/registration/edusp/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-realm': 'edusp',
      'x-api-platform': 'webclient',
    },
    body: JSON.stringify({ token: sedToken }),
  });
  if (j && j.auth_token) return j;
  throw new Error('edusp não devolveu auth_token');
}

// fluxo completo: RA/dg/uf/senha -> { token, nick, aluno }
export async function login({ ra, dg, uf, senha }) {
  const user = montarUser(ra, dg, uf);
  const sed = await sedLogin(user, senha);
  const sedToken = sed.token || sed.Token || sed.access_token;
  if (!sedToken) throw new Error('SED não devolveu token (RA ou senha incorretos?)');

  const ed = await eduspFromSedToken(sedToken);
  return {
    token: ed.auth_token,
    nick: ed.nick || ed.user || user.toLowerCase(),
    aluno: {
      nome: sed.name || sed.nome || sed.Nome || '',
      ra: String(ra).trim(),
      uf: String(uf || '').trim().toUpperCase(),
    },
  };
}
