// Selección adaptativa de segmentación y paralelismo para la vía WASM sin
// WebGPU. Dos números distintos, que NO deben confundirse:
//
// - nSegments: en cuántas franjas se corta la canción. Lo decide solo la
//   duración total y el techo de memoria por franja (MAX_SAFE_SEGMENT_SECS)
//   — hallazgo de esta sesión: el motor OOM-ea con una sola franja larga
//   (ver docs/especificacion.md §11), así que nSegments es un piso de
//   seguridad, no una preferencia de velocidad.
//
// - nParallel: cuántas de esas franjas se procesan SIMULTÁNEAMENTE. Lo
//   decide navigator.hardwareConcurrency (núcleos) y la RAM disponible
//   (cada instancia WASM reserva INITIAL_MEMORY=2048MB fijos). Nunca puede
//   superar nSegments (no tiene sentido pedir más paralelismo que franjas).
//
// Si nSegments > nParallel, el orquestador procesa por tandas: nParallel
// franjas a la vez, hasta completar las nSegments — sigue siendo 100% CPU
// del usuario (o WebGPU si aplica en la vía 10.2), solo que no todas las
// franjas corren al mismo tiempo si el equipo no da para tanto RAM/núcleos.

export const MAX_SAFE_SEGMENT_SECS = 34;
export const WASM_INSTANCE_MEMORY_MB = 2048;
export const MAX_MEMORY_FRACTION = 0.5;

// Descarte de bordes (no crossfade, ver docs/especificacion.md §11.8-§11.9):
// 2 strides internos del motor (2 × 5.85s ≈ 11.7s) por lado de cada costura
// interna — el margen validado empíricamente, usado con
// engine/merge-segments-discard.mjs en producción.
export const DISCARD_SECS = 11.7;

/**
 * @param {{durationSecs:number, hardwareConcurrency:number,
 *   deviceMemoryGB?: number, overlapSecs?: number}} params overlapSecs aquí
 *   es el margen de descarte por lado (ver DISCARD_SECS) — el nombre se
 *   mantiene por compatibilidad con planSegments()/segment-plan.mjs, que no
 *   distingue entre "descartar" y "crossfade" (esa decisión la toma el
 *   merge que se use después).
 * @returns {{nSegments:number, nParallel:number, overlapSecs:number, reason:string}}
 */
export function chooseWorkerPlan({ durationSecs, hardwareConcurrency, deviceMemoryGB, overlapSecs = DISCARD_SECS }) {
  const cores = Math.max(1, Math.floor(hardwareConcurrency || 1));

  // Piso de seguridad de memoria: ninguna franja (nominal + 2×overlap)
  // puede exceder MAX_SAFE_SEGMENT_SECS.
  const nSegments = Math.max(
    1,
    Math.ceil(durationSecs / Math.max(1, MAX_SAFE_SEGMENT_SECS - 2 * overlapSecs))
  );

  // Techo de RAM total disponible para instancias WASM simultáneas.
  // navigator.deviceMemory en Chrome reporta un valor aproximado (0.25-8,
  // con 8 significando "8 o más") — si no está disponible, se asume un
  // equipo modesto (4GB) para degradar con gracia en vez de asumir
  // abundancia.
  const assumedRamGB = deviceMemoryGB || 4;
  const usableRamMB = assumedRamGB * 1024 * MAX_MEMORY_FRACTION;
  const maxParallelForRam = Math.max(1, Math.floor(usableRamMB / WASM_INSTANCE_MEMORY_MB));

  // El paralelismo real nunca supera ni los núcleos, ni la RAM, ni la
  // cantidad de franjas que en verdad existen.
  const nParallel = Math.max(1, Math.min(cores, maxParallelForRam, nSegments));

  let reason;
  if (nSegments > cores * 3) {
    reason = `canción larga: ${nSegments} franjas de ~${MAX_SAFE_SEGMENT_SECS}s por límite de memoria del motor, procesadas de a ${nParallel} en paralelo`;
  } else if (maxParallelForRam < cores) {
    reason = `techo de RAM del equipo (${assumedRamGB}GB asumidos, ${WASM_INSTANCE_MEMORY_MB}MB por instancia) — ${nParallel} en paralelo de ${cores} núcleos`;
  } else {
    reason = `${nParallel} núcleos lógicos en paralelo`;
  }

  return { nSegments, nParallel, overlapSecs, reason };
}
