// CLI: separa un archivo WAV real en 4 stems con el motor vendorizado (Node,
// para probar engine/separate.mjs sin necesitar navegador). Prototipo mínimo
// de la sesión de apertura de etapa — ver docs/especificacion.md §3.
// Uso: node test/separate-file.mjs <archivo.wav> <pesos.bin> [segundos]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { separateStems } from "../engine/separate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function decodeWavPCM16(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt = null, dataOffset = 0, dataSize = 0;
  while (offset < bytes.length) {
    const id = String.fromCharCode(dv.getUint8(offset), dv.getUint8(offset + 1), dv.getUint8(offset + 2), dv.getUint8(offset + 3));
    const size = dv.getUint32(offset + 4, true);
    if (id === "fmt ") fmt = { channels: dv.getUint16(offset + 10, true), sampleRate: dv.getUint32(offset + 12, true), bitsPerSample: dv.getUint16(offset + 22, true) };
    if (id === "data") { dataOffset = offset + 8; dataSize = size; }
    offset += 8 + size + (size % 2);
  }
  const { channels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const nFrames = dataSize / (bytesPerSample * channels);
  const channelData = Array.from({ length: channels }, () => new Float32Array(nFrames));
  for (let i = 0; i < nFrames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = dv.getInt16(dataOffset + (i * channels + c) * bytesPerSample, true);
      channelData[c][i] = s / 32768;
    }
  }
  return { channelData, sampleRate };
}

async function main() {
  const [, , filePath, weightsPath, secondsArg] = process.argv;
  if (!filePath || !weightsPath) {
    console.error("Uso: node test/separate-file.mjs <archivo.wav PCM16> <pesos ggml.bin> [segundos a procesar]");
    process.exit(1);
  }
  console.log(`Decodificando ${filePath}...`);
  const { channelData, sampleRate } = decodeWavPCM16(fs.readFileSync(filePath));
  const totalSec = channelData[0].length / sampleRate;
  console.log(`   ${sampleRate} Hz, ${channelData.length} canal(es), ${totalSec.toFixed(1)} s`);

  const secLimit = secondsArg ? Number(secondsArg) : totalSec;
  const nSamples = Math.min(channelData[0].length, Math.round(secLimit * sampleRate));
  const clip = channelData.map((ch) => ch.slice(0, nSamples));
  console.log(`Procesando ${(nSamples / sampleRate).toFixed(1)} s...`);

  const weights = fs.readFileSync(weightsPath);

  const t0 = Date.now();
  const { stems } = await separateStems(
    { channelData: clip, sampleRate, weights: new Uint8Array(weights) },
    (p, label) => process.stdout.write(`\r   ${(p * 100).toFixed(0)}% — ${label}          `)
  );
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\n\n*** Separación completa en ${elapsed.toFixed(1)} s para ${(nSamples / sampleRate).toFixed(1)} s de audio (${(elapsed / (nSamples / sampleRate)).toFixed(2)}x tiempo real) ***\n`);

  for (const [name, [l]] of Object.entries(stems)) {
    let energy = 0;
    for (let i = 0; i < Math.min(l.length, 10000); i++) energy += Math.abs(l[i]);
    console.log(`   stem ${name}: energía muestra = ${energy.toFixed(2)} ${energy > 0.01 ? "(con señal, OK)" : "(sospechoso)"}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
