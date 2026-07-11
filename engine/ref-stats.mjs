// Estadísticas de normalización globales (mean/std del downmix mono),
// réplica exacta de la fórmula que demucs.cpp aplica internamente
// (src/model_apply.cpp, comentario "ref = wav.mean(0); wav = (wav -
// ref.mean()) / ref.std()"):
//
//   downmix[t] = (left[t] + right[t]) / 2   para cada muestra t
//   mean = promedio(downmix)
//   std  = desviación estándar de downmix, denominador N-1
//
// Hallazgo de sesión (ver docs/especificacion.md §11): cuando la canción se
// procesa en franjas independientes (Workers en paralelo, obligatorio por
// el techo de memoria del motor), cada franja calculaba ESTAS estadísticas
// sobre sí misma — hasta 32% de diferencia con las de la canción completa
// en material real, suficiente para degradar la separación de forma
// audible. Este módulo calcula las estadísticas UNA vez sobre toda la
// canción (barrido liviano, sin el modelo) para pasarlas idénticas a cada
// Worker — ver la vía externa del motor parcheado en
// vendor/demucs-cpp-wasm/README.md.

/**
 * @param {Float32Array[]} channelData [left, right] (o [mono] si 1 canal)
 * @returns {{mean:number, std:number}}
 */
export function computeRefStats(channelData) {
  const left = channelData[0];
  const right = channelData.length > 1 ? channelData[1] : channelData[0];
  const n = left.length;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += (left[i] + right[i]) / 2;
  const mean = sum / n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = (left[i] + right[i]) / 2 - mean;
    sumSq += d * d;
  }
  const std = Math.sqrt(sumSq / (n - 1));

  return { mean, std };
}
