// Recombina las salidas de N Workers (cada uno separó su franja +
// solape, ver segment-plan.mjs) en los stems completos de la canción,
// con crossfade lineal (partición de unidad) en las zonas de solape.
//
// Para cada muestra de salida, la suma de los pesos de todos los Workers
// que la cubren es exactamente 1: fuera de una zona de solape, un solo
// Worker la cubre con peso 1; dentro de una zona de solape, un Worker
// baja linealmente de 1 a 0 mientras el vecino sube de 0 a 1 en el mismo
// tramo — mismo criterio (lineal, TRANSITION_POWER=1) que ya usa
// demucs.cpp internamente para sus propios segmentos (ver segment-plan.mjs).

function weightArray(length, fadeInSamples, fadeOutSamples) {
  const w = new Float32Array(length);
  w.fill(1);
  for (let k = 0; k < fadeInSamples; k++) w[k] = (k + 1) / (fadeInSamples + 1);
  for (let k = 0; k < fadeOutSamples; k++) w[length - 1 - k] = (k + 1) / (fadeOutSamples + 1);
  return w;
}

/**
 * @param {Array<{plan: object, stems: Record<string, Float32Array[]>}>} results
 *   uno por Worker, en cualquier orden — `plan` es el objeto de planSegments()
 *   correspondiente, `stems` es {nombre: [L, R]} recortado exactamente al
 *   rango [readStart, readEnd) de ese plan.
 * @param {number} totalSamples
 * @param {string[]} stemNames
 * @returns {Record<string, Float32Array[]>}
 */
export function mergeSegments(results, totalSamples, stemNames) {
  const merged = {};
  for (const name of stemNames) {
    merged[name] = [new Float32Array(totalSamples), new Float32Array(totalSamples)];
  }

  const sorted = [...results].sort((a, b) => a.plan.index - b.plan.index);

  for (const { plan, stems } of sorted) {
    const { readStart, readEnd, fadeInSamples, fadeOutSamples } = plan;
    const len = readEnd - readStart;
    const w = weightArray(len, fadeInSamples, fadeOutSamples);

    for (const name of stemNames) {
      const [srcL, srcR] = stems[name];
      const [dstL, dstR] = merged[name];
      for (let k = 0; k < len; k++) {
        const o = readStart + k;
        dstL[o] += w[k] * srcL[k];
        dstR[o] += w[k] * srcR[k];
      }
    }
  }

  return merged;
}
