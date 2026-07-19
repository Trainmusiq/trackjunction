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

// Techo DURO de paralelismo — lo más alto verificado con evidencia real
// hasta hoy (sesión de cierre de OOM, 19 jul 2026, M1 Max/10 núcleos/32GB).
// La regresión del 16 jul (§14) diagnosticó mal la causa: no era el
// paralelismo lo que reventaba la memoria, era un bug real en
// workers/separate.worker.mjs — runChunk() nunca recortaba el audio al
// rango [readStart, readEnd) del plan, así que CADA franja (con
// cualquier nParallel) procesaba la canción ENTERA. Corregido eso, se
// probó nParallel=2, 3 y 4 con audio real (motor real, vía CLI directa
// sobre este mismo hardware) — los tres corrieron limpio, sin abortar,
// con memoria total muy por debajo de lo disponible (~7.4GB con
// nParallel=4 en una máquina de 32GB). No se probó más alto por economía
// de sesión — subir este número exige la MISMA rigurosidad (canciones
// reales, navegadores reales, ver regla dura #11 de CLAUDE.md). El techo
// real por sesión lo pone además el sondeo de memoria real (ver
// probeMemoryParallelCeiling más abajo), que nunca puede superar este
// valor.
export const MAX_PARALLEL_ABSOLUTE = 4;

// Niveles de reintento cuando el motor aborta por falta de memoria (ver
// gotcha de CLAUDE.md: INITIAL_MEMORY=2048MB fijo, sin growth — confirmado
// que 35s anda y 40-45s+ revienta con UNA instancia). Con el bug de recorte
// corregido, degradar el ANCHO de franja ya no es la única palanca —
// también se puede degradar nParallel antes de llegar a serie estricta
// (ver buildRetryTiers). Piso duro de ancho: cada franja necesita más que
// 2×DISCARD_SECS (23.4s) para tener algo de interior útil.
export function buildRetryTiers(probedParallelCeiling) {
  const p = Math.max(1, probedParallelCeiling || 1);
  const tiers = [{ maxSegmentSecs: MAX_SAFE_SEGMENT_SECS, maxParallel: p }];
  if (p > 1) tiers.push({ maxSegmentSecs: MAX_SAFE_SEGMENT_SECS, maxParallel: Math.max(1, Math.floor(p / 2)) });
  tiers.push({ maxSegmentSecs: 30, maxParallel: 1 });
  tiers.push({ maxSegmentSecs: 26, maxParallel: 1 });
  return tiers;
}

// Descarte de bordes (no crossfade, ver docs/especificacion.md §11.8-§11.9):
// 2 strides internos del motor (2 × 5.85s ≈ 11.7s) por lado de cada costura
// interna — el margen validado empíricamente, usado con
// engine/merge-segments-discard.mjs en producción.
export const DISCARD_SECS = 11.7;

// Sondeo de memoria real (Fase 3, sesión de cierre de OOM, 19 jul 2026) —
// reemplaza a navigator.deviceMemory, que puede mentir de dos formas
// distintas ya confirmadas: Firefox/Safari no la implementan (undefined
// por diseño, anti-fingerprinting) y algunos navegadores que SÍ la
// implementan no aplican el tope de 8GB del spec y devuelven la RAM real
// del equipo (32GB observados), lo que puede sugerir más paralelismo del
// que el navegador realmente puede sostener. En vez de preguntarle al
// navegador cuánta RAM "dice" tener, se le pide que RESERVE la memoria que
// cada instancia WASM necesitaría — lo que de verdad conceda (o rechace)
// es la señal real, no puede mentir de la misma forma.
//
// No se retienen referencias a los WebAssembly.Memory creados — se sueltan
// para que el GC las recoja apenas se termina de contar cuántas entraron.
// Sobre-compromiso (que el navegador conceda memoria que después no
// respalde de verdad) es una falla conocida de este tipo de sondeo en
// algunos motores — por eso el resultado se combina con
// MAX_PARALLEL_ABSOLUTE (el techo empírico verificado con audio real) como
// cinturón y tirantes: ninguna señal sola decide, el mínimo de ambas manda.
export function probeMemoryParallelCeiling(maxCandidate = MAX_PARALLEL_ABSOLUTE) {
  const pagesPerInstance = Math.round((WASM_INSTANCE_MEMORY_MB * 1024 * 1024) / 65536);
  let granted = 0;
  for (let k = 1; k <= maxCandidate; k++) {
    try {
      // eslint-disable-next-line no-unused-vars
      const mem = new WebAssembly.Memory({ initial: pagesPerInstance, maximum: pagesPerInstance });
      void mem;
      granted = k;
    } catch {
      break;
    }
  }
  return Math.max(1, granted);
}

/**
 * @param {{durationSecs:number, hardwareConcurrency:number,
 *   memoryProbeCeiling?: number, overlapSecs?: number, maxSegmentSecs?: number,
 *   maxParallel?: number}} params overlapSecs aquí es el margen de descarte
 *   por lado (ver DISCARD_SECS) — el nombre se mantiene por compatibilidad
 *   con planSegments()/segment-plan.mjs, que no distingue entre "descartar"
 *   y "crossfade" (esa decisión la toma el merge que se use después).
 *   memoryProbeCeiling viene de probeMemoryParallelCeiling() — cuántas
 *   instancias WASM el navegador concedió realmente en ESTA sesión.
 *   maxSegmentSecs y maxParallel permiten reintentar más chico/más en serie
 *   si el motor abortó por memoria (ver buildRetryTiers).
 * @returns {{nSegments:number, nParallel:number, overlapSecs:number, reason:string}}
 */
export function chooseWorkerPlan({
  durationSecs, hardwareConcurrency, memoryProbeCeiling, overlapSecs = DISCARD_SECS,
  maxSegmentSecs = MAX_SAFE_SEGMENT_SECS, maxParallel = MAX_PARALLEL_ABSOLUTE,
}) {
  const cores = Math.max(1, Math.floor(hardwareConcurrency || 1));

  // Piso de seguridad de memoria: ninguna franja (nominal + 2×overlap)
  // puede exceder maxSegmentSecs.
  const nSegments = Math.max(
    1,
    Math.ceil(durationSecs / Math.max(1, maxSegmentSecs - 2 * overlapSecs))
  );

  const probed = Math.max(1, memoryProbeCeiling || 1);

  // El paralelismo real nunca supera ni los núcleos, ni lo que el sondeo de
  // memoria real concedió, ni la cantidad de franjas que en verdad existen,
  // ni el techo duro absoluto (o el override del nivel de reintento
  // actual, ver buildRetryTiers).
  const nParallel = Math.max(1, Math.min(cores, probed, nSegments, maxParallel));

  let reason;
  if (nSegments > cores * 3) {
    reason = `canción larga: ${nSegments} franjas de ~${maxSegmentSecs}s por límite de memoria del motor, procesadas de a ${nParallel} en paralelo`;
  } else if (probed < cores) {
    reason = `techo de memoria real de tu navegador (sondeo concedió ${probed} instancia${probed === 1 ? "" : "s"} de ${WASM_INSTANCE_MEMORY_MB}MB) — ${nParallel} en paralelo de ${cores} núcleos`;
  } else {
    reason = `${nParallel} núcleos lógicos en paralelo`;
  }

  return { nSegments, nParallel, overlapSecs, reason };
}
