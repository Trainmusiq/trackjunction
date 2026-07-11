// Plan de segmentación para separación en paralelo por Workers, preservando
// calidad idéntica a un único call de modelDemixSegment (principio A).
//
// demucs.cpp ya hace su propio overlap-add interno para audio largo, pero
// ese ventaneo interno arranca su grilla en la muestra 0 del buffer que se
// le pase — NO en tiempo absoluto de la canción (SEGMENT_LEN_SECS=7.8s,
// OVERLAP=0.25, TRANSITION_POWER=1.0/lineal, ver docs/especificacion.md
// §10-§11 y src/model.hpp del upstream). Hallazgo de esta sesión: si se
// corta la canción en franjas arbitrarias, cada Worker re-arranca esa
// grilla interna en SU propio punto de partida, que normalmente NO coincide
// con dónde habría arrancado un segmento interno en una sola llamada de
// referencia — el resultado difiere no solo en la costura externa, sino en
// toda la franja (grilla desalineada), muy por encima de lo audible.
//
// Fix: alinear el punto de lectura (readStart) de cada Worker (excepto el
// primero) a un múltiplo exacto del stride interno de demucs.cpp
// (stride = (1-OVERLAP) × SEGMENT_LEN_SECS = 5.85s). Así, el primer
// segmento interno que computa ese Worker arranca exactamente donde
// arrancaría un segmento interno en una llamada de referencia sobre la
// canción completa — mismo contenido, mismo resultado — y el crossfade
// externo (merge-segments.mjs) sólo tiene que disimular una costura mucho
// más pequeña, en vez de compensar una grilla entera desalineada.

export const DEMUCS_INTERNAL_SEGMENT_SECS = 7.8;
export const DEMUCS_INTERNAL_OVERLAP = 0.25;
export const DEMUCS_INTERNAL_STRIDE_SECS =
  (1 - DEMUCS_INTERNAL_OVERLAP) * DEMUCS_INTERNAL_SEGMENT_SECS; // 5.85s

/**
 * @param {number} totalSamples
 * @param {number} sampleRate
 * @param {number} nWorkers
 * @param {number} [overlapSecs=6.0] margen de solape a cada lado de cada
 *   franja nominal, usado para el crossfade externo y como colchón para
 *   que cualquier padding de cola del último segmento interno de un Worker
 *   quede dentro de la zona que se descarta en el merge. Debe superar al
 *   menos un stride interno (5.85s) — default 6.0s.
 * @returns {Array<{index:number, readStart:number, readEnd:number,
 *   writeStart:number, writeEnd:number, fadeInSamples:number,
 *   fadeOutSamples:number}>}
 */
export function planSegments(totalSamples, sampleRate, nWorkers, overlapSecs = 6.0) {
  if (nWorkers < 1) throw new Error("nWorkers debe ser >= 1");
  if (nWorkers === 1) {
    return [{
      index: 0,
      readStart: 0,
      readEnd: totalSamples,
      writeStart: 0,
      writeEnd: totalSamples,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    }];
  }

  const overlapSamples = Math.round(overlapSecs * sampleRate);
  const strideSamples = Math.round(DEMUCS_INTERNAL_STRIDE_SECS * sampleRate);
  const nominalLen = totalSamples / nWorkers;

  // writeStart/writeEnd nominales (reparto parejo) — el crossfade sigue
  // centrado ahí. readStart se ajusta por separado para alinear la grilla.
  const writeBoundaries = [0];
  for (let i = 1; i < nWorkers; i++) writeBoundaries.push(Math.round(i * nominalLen));
  writeBoundaries.push(totalSamples);

  const segments = [];
  for (let i = 0; i < nWorkers; i++) {
    const writeStart = writeBoundaries[i];
    const writeEnd = writeBoundaries[i + 1];

    let readStart;
    if (i === 0) {
      readStart = 0;
    } else {
      const desired = writeStart - overlapSamples;
      // snap hacia abajo al múltiplo de stride más cercano (grilla interna
      // anclada en la muestra 0 absoluta de la canción).
      readStart = Math.max(0, Math.floor(desired / strideSamples) * strideSamples);
    }
    const readEnd = i === nWorkers - 1 ? totalSamples : Math.min(totalSamples, writeEnd + overlapSamples);

    const fadeInSamples = writeStart - readStart; // 0 para el primer worker
    const fadeOutSamples = readEnd - writeEnd; // 0 para el último worker
    segments.push({ index: i, readStart, readEnd, writeStart, writeEnd, fadeInSamples, fadeOutSamples });
  }

  return segments;
}
