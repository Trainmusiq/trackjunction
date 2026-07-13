// Recombina las salidas de N Workers por DESCARTE DE BORDES, en vez de
// crossfade (ver merge-segments.mjs para el esquema anterior).
//
// Fundamento (sesión de verificación, ver docs/especificacion.md §11.8):
// el diagnóstico de §11.6 mostró que el output del motor cerca del borde
// de CUALQUIER buffer que se le pase es distinto al que produciría una
// pasada monolítica sobre la canción completa (el campo receptivo del
// ventaneo interno cruza el borde y se mezcla con padding en vez de
// contexto real). La región INTERIOR de un buffer suficientemente ancho,
// lejos de sus propios bordes, no tiene ese problema — es indistinguible
// de la misma región procesada dentro de una canción completa.
//
// Cada Worker procesa una franja ANCHA (plan.readStart..readEnd, ver
// segment-plan.mjs con overlapSecs = descarte deseado) pero solo se
// CONSERVA su interior (plan.writeStart..writeEnd) — el margen de cada
// lado (fadeInSamples/fadeOutSamples) se descarta por completo, sin
// mezclar. Los bordes verdaderos de la canción (primer/último Worker)
// no descartan nada — conservan su padding natural, igual que una
// pasada monolítica.

/**
 * @param {Array<{plan: object, stems: Record<string, Float32Array[]>}>} results
 *   uno por Worker — `plan` es el objeto de planSegments() correspondiente,
 *   `stems` es {nombre: [L, R]} recortado exactamente al rango
 *   [readStart, readEnd) de ese plan.
 * @param {number} totalSamples
 * @param {string[]} stemNames
 * @returns {Record<string, Float32Array[]>}
 */
export function mergeSegmentsDiscard(results, totalSamples, stemNames) {
  const merged = {};
  for (const name of stemNames) {
    merged[name] = [new Float32Array(totalSamples), new Float32Array(totalSamples)];
  }

  const sorted = [...results].sort((a, b) => a.plan.index - b.plan.index);

  for (const { plan, stems } of sorted) {
    const { writeStart, writeEnd, fadeInSamples } = plan;
    const keepLen = writeEnd - writeStart;

    for (const name of stemNames) {
      const [srcL, srcR] = stems[name];
      const [dstL, dstR] = merged[name];
      // El interior conservado empieza en fadeInSamples dentro del buffer
      // propio del Worker (justo después de la zona descartada).
      dstL.set(srcL.subarray(fadeInSamples, fadeInSamples + keepLen), writeStart);
      dstR.set(srcR.subarray(fadeInSamples, fadeInSamples + keepLen), writeStart);
    }
  }

  return merged;
}
