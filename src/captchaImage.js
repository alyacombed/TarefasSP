// pré-processamento de imagem do CAPTCHA — decodifica PNG com zlib do Node,
// gera variantes com contraste/escala/binarização pra IA "enxergar" melhor.
// sem dependência externa; se o PNG não for suportado, devolve só a original
// (fallback = comportamento atual, nada quebra).
import { inflateSync, deflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── CRC-32 (PNG usa o mesmo do zlib: polinômio refletido 0xEDB88320) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunkTipo(tipo, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tipoBuf = Buffer.from(tipo, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tipoBuf, data])));
  return Buffer.concat([len, tipoBuf, data, crc]);
}

// decodifica PNG → { width, height, gray }. null se não suportado.
export function decodePng(buf) {
  if (!buf || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;

  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null;

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const tipo = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (tipo === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (tipo === 'IDAT') {
      idat.push(data);
    } else if (tipo === 'PLTE') {
      palette = data;
    } else if (tipo === 'IEND') {
      break;
    }
    off += 8 + len + 4;
  }

  // só suportamos bitDepth 8 (o comum em captcha). interlace (1) não suportado.
  if (!width || !height || bitDepth !== 8) return null;

  // bytes por pixel conforme colorType: 0=gray,2=rgb,3=paleta,4=gray+alpha,6=rgba
  const bpp = colorType === 6 ? 4
    : colorType === 2 ? 3
    : colorType === 4 ? 2
    : 1;

  const stride = width * bpp;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (raw.length < height * (stride + 1)) return null;

  // desfiltra cada scanline (filtros 0–4 do PNG)
  const recon = Buffer.alloc(height * stride);
  const linha = (y) => recon.subarray(y * stride, (y + 1) * stride);
  const zero = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const head = y * (stride + 1);
    const filter = raw[head];
    const src = raw.subarray(head + 1, head + 1 + stride);
    const dst = linha(y);
    const prev = y > 0 ? linha(y - 1) : zero;

    for (let i = 0; i < stride; i++) {
      const x = i >= bpp ? dst[i - bpp] : 0;
      const up = prev[i];
      const ul = (i >= bpp && y > 0) ? prev[i - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = src[i]; break;
        case 1: val = src[i] + x; break;
        case 2: val = src[i] + up; break;
        case 3: val = src[i] + ((x + up) >> 1); break;
        case 4: {
          const p = x + up - ul;
          const pa = Math.abs(p - x), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          val = src[i] + (pa <= pb && pa <= pc ? x : pb <= pc ? up : ul);
          break;
        }
        default: return null;
      }
      dst[i] = val & 0xff;
    }
  }

  // extrai luminância (0-255) de cada pixel + canal verde (o captcha é texto
  // VERDE sobre fundo claro; o canal G isola o traço do ruído de cor).
  const gray = new Uint8Array(width * height);
  const green = new Uint8Array(width * height);
  const corLum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  let pi = 0;
  for (let y = 0; y < height; y++) {
    const row = linha(y);
    switch (colorType) {
      case 0: case 4:
        for (let x = 0; x < width; x++) {
          gray[pi] = row[x * bpp];
          green[pi] = gray[pi];
          pi++;
        }
        break;
      case 2: case 6:
        for (let x = 0; x < width; x++) {
          const o = x * bpp;
          gray[pi] = corLum(row[o], row[o + 1], row[o + 2]);
          green[pi] = row[o + 1];
          pi++;
        }
        break;
      case 3: {
        if (!palette) return null;
        for (let x = 0; x < width; x++) {
          const idx = row[x] * 3;
          gray[pi] = palette.length >= idx + 3 ? corLum(palette[idx], palette[idx + 1], palette[idx + 2]) : 255;
          green[pi] = palette.length >= idx + 3 ? palette[idx + 1] : 255;
          pi++;
        }
        break;
      }
      default: return null;
    }
  }

  return { width, height, gray, green };
}

// re-encode em PNG grayscale 8-bit (filtro 0 por linha).
function encodeGrayPng(width, height, gray) {
  const stride = width;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    raw[off] = 0;
    for (let x = 0; x < width; x++) raw[off + 1 + x] = gray[y * stride + x] & 0xff;
  }
  const idat = deflateSync(raw, { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bitDepth
  ihdr[9] = 0;  // colorType grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIG,
    chunkTipo('IHDR', ihdr),
    chunkTipo('IDAT', idat),
    chunkTipo('IEND', Buffer.alloc(0)),
  ]);
}

// estica o contraste com base no histograma (1–99% dos pixels).
function contrastStretch(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  const p01 = Math.floor(total * 0.01);
  const p99 = Math.floor(total * 0.99);
  let lo = 0, acc = 0;
  for (; lo < 256; lo++) { acc += hist[lo]; if (acc >= p01) break; }
  acc = 0; let hi = 255;
  for (; hi >= 0; hi--) { acc += hist[hi]; if (acc >= total - p99) break; }
  if (hi - lo < 8) lo = 0, hi = 255;

  const out = new Uint8Array(gray.length);
  const range = hi - lo || 1;
  for (let i = 0; i < gray.length; i++) {
    const v = Math.round((gray[i] - lo) * 255 / range);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, best = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const entre = wB * wF * (mB - mF) * (mB - mF);
    if (entre > maxVar) { maxVar = entre; best = t; }
  }
  return best;
}

// upscale por vizinho mais próximo (mantém os traços do captcha nítidos).
function nearestNeighbor(gray, w, h, s) {
  const nw = w * s, nh = h * s;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = (y / s) | 0;
    const ro = y * nw;
    const so = sy * w;
    for (let x = 0; x < nw; x++) out[ro + x] = gray[so + ((x / s) | 0)];
  }
  return out;
}

// gera as variantes da imagem para a IA ler. retorna array de { base64, mimeType }.
// a primeira é SEMPRE a original (fallback). as demais têm processamento
// crescente — a ordem também serve de peso no desempate de leituras.
export function processarVariantes(base64, mimeType = 'image/png') {
  const saida = [{ base64, mimeType }];
  try {
    const dec = decodePng(Buffer.from(base64, 'base64'));
    if (!dec) return saida;
    const { width, height, gray, green } = dec;

    const contraste = contrastStretch(gray);

    // sempre "em cima" do contraste esticado (ajuda a separar traço de fundo)
    const variantes = [];
    // 1ª variante processada = DIVERGÊNCIA de cor: canal verde isolado + INVERTIDO
    // (traço verde vira ESCURO sobre claro, igual ao contraste) — filtra o ruído de
    // cor que a luminância mistura. peso 0 (lida primeiro no voto do Gemini).
    const verde = new Uint8Array(width * height);
    for (let i = 0; i < green.length; i++) verde[i] = 255 - green[i];
    variantes.push({ lum: nearestNeighbor(contrastStretch(verde), width, height, 3), w: width * 3, h: height * 3 });
    variantes.push({ lum: contrastStretch(gray), w: width, h: height });
    variantes.push({ lum: nearestNeighbor(contraste, width, height, 2), w: width * 2, h: height * 2 });
    variantes.push({ lum: nearestNeighbor(contraste, width, height, 3), w: width * 3, h: height * 3 });
    variantes.push({ lum: nearestNeighbor(contraste, width, height, 4), w: width * 4, h: height * 4 });
    variantes.push({ lum: nearestNeighbor(contraste, width, height, 5), w: width * 5, h: height * 5 });

    const t = otsuThreshold(contraste);
    const bin = new Uint8Array(width * height);
    for (let i = 0; i < bin.length; i++) bin[i] = contraste[i] >= t ? 255 : 0;
    variantes.push({ lum: nearestNeighbor(bin, width, height, 3), w: width * 3, h: height * 3 });

    for (const v of variantes) {
      saida.push({ base64: encodeGrayPng(v.w, v.h, v.lum).toString('base64'), mimeType: 'image/png' });
    }
  } catch (e) {
    console.warn(`[captcha-img] pré-processamento falhou (usa original): ${e.message}`);
  }
  return saida;
}