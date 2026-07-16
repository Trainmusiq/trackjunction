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

// Niveles de reintento cuando el motor aborta por falta de memoria (ver
// gotcha de CLAUDE.md: INITIAL_MEMORY=2048MB fijo, sin growth — confirmado
// que 35s anda y 40-45s+ revienta, medido en Chrome). El ceiling real puede
// ser más bajo en otros motores JS (overhead de glue code, tablas, stack
// distintos con la MISMA memoria WASM fija) — en vez de adivinar un número
// por navegador, se reintenta con franjas más chicas si la primera falla.
// Piso duro: cada franja necesita más ancho que 2×DISCARD_SECS (23.4s) para
// tener algo de interior útil — un tier por debajo de eso no reduce el
// riesgo de OOM (cada franja individual ya es angosta) y multiplica la
// cantidad de franjas de forma degenerada (cientos, para nada práctico).
// Verificado con una simulación: [34,24,16] producía 274 franjas para una
// canción de 274s en el segundo nivel — [34,30,26] da 42/106, razonable.
export const SEGMENT_SECS_FALLBACK_TIERS = [MAX_SAFE_SEGMENT_SECS, 30, 26];

// Descarte de bordes (no crossfade, ver docs/especificacion.md §11.8-§11.9):
// 2 strides internos del motor (2 × 5.85s ≈ 11.7s) por lado de cada costura
// interna — el margen validado empíricamente, usado con
// engine/merge-segments-discard.mjs en producción.
export const DISCARD_SECS = 11.7;

/**
 * @param {{durationSecs:number, hardwareConcurrency:number,
 *   deviceMemoryGB?: number, overlapSecs?: number, maxSegmentSecs?: number}}
 *   params overlapSecs aquí es el margen de descarte por lado (ver
 *   DISCARD_SECS) — el nombre se mantiene por compatibilidad con
 *   planSegments()/segment-plan.mjs, que no distingue entre "descartar" y
 *   "crossfade" (esa decisión la toma el merge que se use después).
 *   maxSegmentSecs permite reintentar con franjas más chicas si el motor
 *   abortó por memoria (ver SEGMENT_SECS_FALLBACK_TIERS).
 * @returns {{nSegments:number, nParallel:number, overlapSecs:number, reason:string}}
 */
export function chooseWorkerPlan({
  durationSecs, hardwareConcurrency, deviceMemoryGB, overlapSecs = DISCARD_SECS,
  maxSegmentSecs = MAX_SAFE_SEGMENT_SECS,
}) {
  const cores = Math.max(1, Math.floor(hardwareConcurrency || 1));

  // Piso de seguridad de memoria: ninguna franja (nominal + 2×overlap)
  // puede exceder maxSegmentSecs.
  const nSegments = Math.max(
    1,
    Math.ceil(durationSecs / Math.max(1, maxSegmentSecs - 2 * overlapSecs))
  );

  // Techo de RAM total disponible para instancias WASM simultáneas.
  // navigator.deviceMemory es una API de Chrome/Edge (0.25-8, con 8
  // significando "8 o más") — Firefox y Safari NO la implementan (por
  // diseño, para reducir fingerprinting) y devuelven undefined. Hallazgo
  // de esta sesión: asumir un valor pesimista (4GB) cuando no está
  // disponible colapsaba el paralelismo a 1 SIEMPRE, sin importar el
  // hardware real (4GB×0.5/2048MB = exactamente 1) — un M1 Max de 10
  // núcleos quedaba procesando en serie en Firefox. Fix: sin señal real de
  // RAM, no se inventa una — se confía en los núcleos (señal real, que
  // Firefox sí reporta) y el reintento por OOM (ver separate.worker.mjs)
  // es la red de seguridad si el equipo de verdad no da la RAM.
  let maxParallelForRam = nSegments;
  let ramReportada = false;
  if (deviceMemoryGB) {
    ramReportada = true;
    const usableRamMB = deviceMemoryGB * 1024 * MAX_MEMORY_FRACTION;
    maxParallelForRam = Math.max(1, Math.floor(usableRamMB / WASM_INSTANCE_MEMORY_MB));
  }

  // El paralelismo real nunca supera ni los núcleos, ni la RAM (si se
  // conoce), ni la cantidad de franjas que en verdad existen.
  const nParallel = Math.max(1, Math.min(cores, maxParallelForRam, nSegments));

  let reason;
  if (nSegments > cores * 3) {
    reason = `canción larga: ${nSegments} franjas de ~${maxSegmentSecs}s por límite de memoria del motor, procesadas de a ${nParallel} en paralelo`;
  } else if (ramReportada && maxParallelForRam < cores) {
    reason = `techo de RAM del equipo (${deviceMemoryGB}GB reportados, ${WASM_INSTANCE_MEMORY_MB}MB por instancia) — ${nParallel} en paralelo de ${cores} núcleos`;
  } else if (!ramReportada) {
    reason = `${nParallel} núcleos lógicos en paralelo (tu navegador no reporta RAM disponible)`;
  } else {
    reason = `${nParallel} núcleos lógicos en paralelo`;
  }

  return { nSegments, nParallel, overlapSecs, reason };
}
