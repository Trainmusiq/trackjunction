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

// Techo DURO de paralelismo, independiente de cuánta RAM crea tener el
// equipo — hallazgo de la sesión de regresión (16 jul 2026): con una
// canción REAL (no sintética, un tema de 273.8s y un recorte real de 90s),
// nParallel=8, nParallel=3 Y nParallel=2 reventaron el proceso completo del
// navegador — no un error de JS capturable, un crash del tab/proceso (sin
// rastro en consola, sin stack trace, la página vuelve a su estado
// inicial). Solo nParallel=1 (serie estricta) corrió sin reventar en
// pruebas extendidas. Cada instancia WASM reserva 2048MB fijos MÁS los
// pesos del modelo (~84MB) MÁS los búferes de audio de entrada/salida — el
// techo de RAM calculado a partir de navigator.deviceMemory asume solo el
// primer número y puede ser optimista (algunos navegadores, incluido el
// usado para verificar este fix, no aplican el tope de 8GB que exige el
// spec y reportan la RAM real del equipo, ej. 32GB, permitiendo un
// nParallel que igual revienta). Punto de partida deliberadamente
// conservador (más lento, nunca revienta) — subir este número en el futuro
// exige la MISMA rigurosidad: canciones reales, navegadores reales, nunca
// sintéticos ni simulaciones (ver regla dura en CLAUDE.md).
export const MAX_PARALLEL_ABSOLUTE = 1;

// Cuando el navegador no reporta RAM (Firefox/Safari — ver más abajo), se
// asume este paralelismo conservador — de todos modos acotado por
// MAX_PARALLEL_ABSOLUTE arriba.
export const DEFAULT_PARALLEL_WHEN_RAM_UNKNOWN = 1;

// Niveles de reintento cuando el motor aborta por falta de memoria (ver
// gotcha de CLAUDE.md: INITIAL_MEMORY=2048MB fijo, sin growth — confirmado
// que 35s anda y 40-45s+ revienta, medido en Chrome con UNA sola instancia).
// Con el paralelismo ya en 1 por defecto, el único lever que queda para
// reintentar es el ancho de franja — reduce el trabajo INTERNO de cada
// instancia (aun con memoria fija, procesar menos audio real dentro de ese
// mismo presupuesto deja más margen antes de abortar). Piso duro de ancho:
// cada franja necesita más que 2×DISCARD_SECS (23.4s) para tener algo de
// interior útil — un tier por debajo de eso degenera (cientos de franjas
// para nada práctico, verificado con una simulación).
export const RETRY_TIERS = [
  { maxSegmentSecs: MAX_SAFE_SEGMENT_SECS, maxParallel: MAX_PARALLEL_ABSOLUTE },
  { maxSegmentSecs: 30, maxParallel: MAX_PARALLEL_ABSOLUTE },
  { maxSegmentSecs: 26, maxParallel: MAX_PARALLEL_ABSOLUTE },
];

// Descarte de bordes (no crossfade, ver docs/especificacion.md §11.8-§11.9):
// 2 strides internos del motor (2 × 5.85s ≈ 11.7s) por lado de cada costura
// interna — el margen validado empíricamente, usado con
// engine/merge-segments-discard.mjs en producción.
export const DISCARD_SECS = 11.7;

/**
 * @param {{durationSecs:number, hardwareConcurrency:number,
 *   deviceMemoryGB?: number, overlapSecs?: number, maxSegmentSecs?: number,
 *   maxParallel?: number}} params overlapSecs aquí es el margen de descarte
 *   por lado (ver DISCARD_SECS) — el nombre se mantiene por compatibilidad
 *   con planSegments()/segment-plan.mjs, que no distingue entre "descartar"
 *   y "crossfade" (esa decisión la toma el merge que se use después).
 *   maxSegmentSecs y maxParallel permiten reintentar más chico/más en serie
 *   si el motor abortó por memoria (ver RETRY_TIERS).
 * @returns {{nSegments:number, nParallel:number, overlapSecs:number, reason:string}}
 */
export function chooseWorkerPlan({
  durationSecs, hardwareConcurrency, deviceMemoryGB, overlapSecs = DISCARD_SECS,
  maxSegmentSecs = MAX_SAFE_SEGMENT_SECS, maxParallel = MAX_PARALLEL_ABSOLUTE,
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
  // significando "8 o más" por spec) — Firefox y Safari NO la implementan
  // (por diseño, para reducir fingerprinting) y devuelven undefined.
  // Hallazgo de la sesión de regresión: (a) asumir un valor pesimista (4GB)
  // sin la API colapsaba el paralelismo a 1 siempre — corregido con
  // DEFAULT_PARALLEL_WHEN_RAM_UNKNOWN; (b) confiar ciegamente en los
  // núcleos sin ningún tope de RAM (el fix de la sesión anterior) reventó
  // Firefox real; (c) incluso con deviceMemory reportado, algunos
  // navegadores no aplican el tope de 8GB del spec y devuelven la RAM real
  // del equipo (verificado: 32GB en el navegador de prueba), permitiendo un
  // nParallel que también revienta. Por eso MAX_PARALLEL_ABSOLUTE es un
  // techo duro que ninguna de estas señales puede superar.
  let maxParallelForRam = DEFAULT_PARALLEL_WHEN_RAM_UNKNOWN;
  let ramReportada = false;
  if (deviceMemoryGB) {
    ramReportada = true;
    const usableRamMB = deviceMemoryGB * 1024 * MAX_MEMORY_FRACTION;
    maxParallelForRam = Math.max(1, Math.floor(usableRamMB / WASM_INSTANCE_MEMORY_MB));
  }

  // El paralelismo real nunca supera ni los núcleos, ni la RAM (si se
  // conoce o se asume conservadoramente), ni la cantidad de franjas que en
  // verdad existen, ni el techo duro absoluto (o el override del nivel de
  // reintento actual, ver RETRY_TIERS).
  const nParallel = Math.max(1, Math.min(cores, maxParallelForRam, nSegments, maxParallel));

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
