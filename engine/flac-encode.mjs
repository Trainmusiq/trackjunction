// Encoder FLAC (vendor/libflacjs) — exportación §4.2: "mismo formato" cuando la
// entrada es FLAC, y "FLAC siempre disponible" para cualquier entrada.
//
// Copia vendorizada sin modificar desde centrail (ver docs/especificacion.md §8).

let flacPromise = null;

function loadFlac() {
  if (!flacPromise) {
    // FLAC_SCRIPT_LOCATION debe fijarse ANTES del import dinámico para que el
    // wrapper resuelva el .wasm relativo a esta carpeta (no a la URL del worker).
    self.FLAC_SCRIPT_LOCATION = new URL("../vendor/libflacjs/", import.meta.url).href;
    flacPromise = import("../vendor/libflacjs/libflac.min.wasm.js?v=1.1.1").then(() => new Promise((resolve) => {
      const Flac = self.Flac;
      if (Flac.isReady && Flac.isReady()) resolve(Flac);
      else Flac.onready = () => resolve(Flac);
    }));
  }
  return flacPromise;
}

/**
 * @param {{channelData: Float32Array[], sampleRate: number, bitDepth?: 16|24, compressionLevel?: number}} input
 * @returns {Promise<Uint8Array>}
 */
export async function encodeFlac(input) {
  const Flac = await loadFlac();
  return encodeFlacWith(Flac, input);
}

/**
 * Igual que encodeFlac(), pero con un objeto Flac ya cargado — para poder
 * inyectar un loader distinto del navegador (ej. en tests de Node, donde el
 * wrapper vendorizado necesita un shim de CommonJS en vez de fetch/import
 * dinámico). La lógica de codificación es la misma en ambos casos.
 * @param {*} Flac
 * @param {{channelData: Float32Array[], sampleRate: number, bitDepth?: 16|24, compressionLevel?: number}} input
 * @returns {Uint8Array}
 */
export function encodeFlacWith(Flac, { channelData, sampleRate, bitDepth = 16, compressionLevel = 5 }) {
  if (bitDepth !== 16 && bitDepth !== 24) {
    throw new Error(`Bit depth FLAC no soportado para exportar: ${bitDepth}`);
  }
  const channels = channelData.length;
  const frames = channelData[0].length;
  const maxVal = Math.pow(2, bitDepth - 1) - 1;
  const minVal = -Math.pow(2, bitDepth - 1);

  // float [-1,1] -> entero con signo, justificado a la derecha según bitDepth (§ doc de libflacjs)
  const interleaved = new Int32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let s = channelData[c][i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      let v = Math.round(s * maxVal);
      if (v > maxVal) v = maxVal; else if (v < minVal) v = minVal;
      interleaved[i * channels + c] = v;
    }
  }

  const chunks = [];
  const encoder = Flac.create_libflac_encoder(sampleRate, channels, bitDepth, compressionLevel, frames, false);
  if (!encoder) throw new Error("No se pudo crear el encoder FLAC");

  // ogg_serial_number = false: stream FLAC nativo, no envuelto en Ogg
  const initStatus = Flac.init_encoder_stream(encoder, (data) => chunks.push(data.slice()), null, false);
  if (initStatus !== 0) {
    Flac.FLAC__stream_encoder_delete(encoder);
    throw new Error(`Error inicializando el encoder FLAC (status ${initStatus})`);
  }

  const ok = Flac.FLAC__stream_encoder_process_interleaved(encoder, interleaved, frames);
  Flac.FLAC__stream_encoder_finish(encoder);
  Flac.FLAC__stream_encoder_delete(encoder);
  if (!ok) throw new Error("Error codificando FLAC");

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
