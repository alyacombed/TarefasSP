// gera o "copia e cola" do PIX (BR Code / EMV) e a URL de QR.
// padrão do Banco Central: campos TLV (id + tamanho 2 dígitos + valor) +
// CRC16-CCITT (0x1021, init 0xFFFF) no final.
import { config } from './config.js';

// monta um campo EMV: id (2) + length (2, zero-pad) + valor.
function tlv(id, value) {
  const v = String(value);
  const len = String(v.length).padStart(2, '0');
  return `${id}${len}${v}`;
}

// CRC16-CCITT (FALSE) — polinômio 0x1021, init 0xFFFF. devolve 4 hex maiúsculos.
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// remove acentos e limita tamanho (nome do recebedor e cidade têm limite no padrão).
function sanitize(s, max) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .toUpperCase().trim().slice(0, max);
}

// gera o payload copia-e-cola.
// opts: { key, amount('10.00'), name, city, txid }
export function buildPixCode(opts = {}) {
  const key = opts.key || config.pix.key;
  const amount = opts.amount != null ? Number(opts.amount).toFixed(2) : '10.00';
  const name = sanitize(opts.name || config.pix.name, 25) || 'RECEBEDOR';
  const city = sanitize(opts.city || config.pix.city, 15) || 'SAO PAULO';
  const txid = sanitize(opts.txid || '***', 25) || '***';

  // Merchant Account Information (id 26): GUI br.gov.bcb.pix (00) + chave (01)
  const mai = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);

  let payload =
    tlv('00', '01') +            // payload format indicator
    tlv('26', mai) +             // merchant account info (PIX)
    tlv('52', '0000') +          // merchant category code
    tlv('53', '986') +           // moeda BRL
    tlv('54', amount) +          // valor
    tlv('58', 'BR') +            // país
    tlv('59', name) +            // nome do recebedor
    tlv('60', city) +            // cidade
    tlv('62', tlv('05', txid));  // additional data: reference label

  payload += '6304';             // id+len do CRC, valor entra no cálculo
  return payload + crc16(payload);
}

// URL de imagem do QR (serviço público, sem dependência).
export function qrImageUrl(payload, size = 300) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(payload)}`;
}
