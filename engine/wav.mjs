// Lectura/escritura WAV (PCM), sin dependencias — funciona en Node y en el navegador.
// Decodificación propia (§4.2): evita el resampleo/forzado a float32 de decodeAudioData,
// preservando el sample rate y la resolución (bit depth) originales del archivo.
//
// Copia vendorizada sin modificar desde centrail (mismo patrón que el motor de
// pitch, ver docs/especificacion.md §8) — actualizar manualmente si centrail
// mejora este archivo, con nota en ambos CLAUDE.md.

const WAV_FORMAT_PCM = 1;
const WAV_FORMAT_FLOAT = 3;

/**
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {{channelData: Float32Array[], sampleRate: number, bitDepth: number, format: 'wav'}}
 */
export function decodeWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const readTag = off => String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
  if (readTag(0) !== "RIFF" || readTag(8) !== "WAVE") {
    throw new Error("No es un archivo WAV válido (falta cabecera RIFF/WAVE)");
  }

  let sampleRate = 0, channels = 0, bitDepth = 0, formatTag = WAV_FORMAT_PCM;
  let dataOffset = -1, dataSize = 0;

  let pos = 12;
  while (pos + 8 <= u8.length) {
    const chunkId = readTag(pos);
    const chunkSize = dv.getUint32(pos + 4, true);
    const bodyOffset = pos + 8;
    if (chunkId === "fmt ") {
      formatTag = dv.getUint16(bodyOffset, true);
      channels = dv.getUint16(bodyOffset + 2, true);
      sampleRate = dv.getUint32(bodyOffset + 4, true);
      bitDepth = dv.getUint16(bodyOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      dataSize = chunkSize;
    }
    pos = bodyOffset + chunkSize + (chunkSize & 1); // los chunks se alinean a 2 bytes
  }

  if (dataOffset < 0) throw new Error("Archivo WAV sin chunk 'data'");

  const bytesPerSample = bitDepth / 8;
  const frames = Math.floor(dataSize / (bytesPerSample * channels));
  const channelData = Array.from({ length: channels }, () => new Float32Array(frames));

  let off = dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let sample;
      if (formatTag === WAV_FORMAT_FLOAT && bitDepth === 32) {
        sample = dv.getFloat32(off, true);
      } else if (bitDepth === 16) {
        sample = dv.getInt16(off, true) / 32768;
      } else if (bitDepth === 24) {
        const b0 = u8[off], b1 = u8[off + 1], b2 = u8[off + 2];
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v -= 0x1000000;
        sample = v / 8388608;
      } else if (bitDepth === 32) {
        sample = dv.getInt32(off, true) / 2147483648;
      } else if (bitDepth === 8) {
        sample = (u8[off] - 128) / 128;
      } else {
        throw new Error(`Bit depth WAV no soportado: ${bitDepth}`);
      }
      channelData[c][i] = sample;
      off += bytesPerSample;
    }
  }

  return { channelData, sampleRate, bitDepth: formatTag === WAV_FORMAT_FLOAT ? 32 : bitDepth, format: "wav" };
}

/**
 * @param {{channelData: Float32Array[], sampleRate: number, bitDepth?: 16|24|32}} input
 * @returns {Uint8Array}
 */
export function encodeWav({ channelData, sampleRate, bitDepth = 16 }) {
  const channels = channelData.length;
  const frames = channelData[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  const writeTag = (off, tag) => { for (let i = 0; i < 4; i++) u8[off + i] = tag.charCodeAt(i); };

  writeTag(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM entero
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  writeTag(36, "data");
  dv.setUint32(40, dataSize, true);

  let offset = 44;
  const clamp = s => (s > 1 ? 1 : s < -1 ? -1 : s);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = clamp(channelData[c][i]);
      if (bitDepth === 16) {
        dv.setInt16(offset, Math.round(s * 32767), true);
      } else if (bitDepth === 24) {
        const v = Math.round(s * 8388607);
        u8[offset] = v & 0xff; u8[offset + 1] = (v >> 8) & 0xff; u8[offset + 2] = (v >> 16) & 0xff;
      } else if (bitDepth === 32) {
        dv.setInt32(offset, Math.round(s * 2147483647), true);
      } else {
        throw new Error(`Bit depth WAV no soportado para exportar: ${bitDepth}`);
      }
      offset += bytesPerSample;
    }
  }
  return u8;
}
