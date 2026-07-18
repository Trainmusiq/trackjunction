// Worker de un solo chunk: instancia WASM fresca, UNA separación, termina.
// Nunca se reutiliza (§11.6: reutilizar la misma instancia para varias
// llamadas produce salidas no deterministas — el patrón "Worker nuevo por
// franja, nunca reutilizado" es justamente lo que evita ese bug).
//
// Gotcha de carga (ver engine/separate.mjs y CLAUDE.md): demucs.js es UMD y
// se carga con importScripts(), que NO existe en Workers tipo "module". Por
// eso este archivo se construye como Worker CLÁSICO (sin {type:"module"} en
// el `new Worker(...)` del orquestador) y usa import() dinámico en vez de
// `import` estático para obtener separateStems — import() dinámico funciona
// en cualquier contexto, y al ser un Worker clásico, importScripts() sigue
// disponible en el scope global cuando separate.mjs lo llama internamente.
//
// Mensaje de entrada: { plan, left: ArrayBuffer, right: ArrayBuffer,
//   sampleRate, weightsUrl, refStats }
// Mensaje de salida: { __final: true, plan, stems: {...} } o { __final: true, plan, error }
//
// Gotcha real (encontrado probando en navegador): demucs.js reporta SU
// PROPIO progreso interno llamando a `postMessage({msg:'PROGRESS_UPDATE',
// data:...})` directamente (pensado para un Worker de producción "de
// verdad" que escuche eso) — como corre DENTRO de este mismo Worker, esos
// mensajes salen por el mismo canal que el resultado final, y quien
// escucha (separate.worker.mjs) los recibiría TODOS mezclados. Por eso el
// mensaje final se marca con `__final: true` — separate.worker.mjs ignora
// cualquier mensaje sin esa marca en vez de resolver con el primero que
// llegue (que casi siempre es un ping de progreso de demucs.js, no el
// resultado real).

let separateStemsPromise = null;
function getSeparateStems() {
  if (!separateStemsPromise) {
    separateStemsPromise = import("../engine/separate.mjs?v=0.9.0").then((m) => m.separateStems);
  }
  return separateStemsPromise;
}

self.onmessage = async (ev) => {
  const { plan, left, right, sampleRate, weightsUrl, refStats } = ev.data;
  try {
    const separateStems = await getSeparateStems();
    const leftArr = new Float32Array(left);
    const rightArr = new Float32Array(right);
    const { stems } = await separateStems(
      { channelData: [leftArr, rightArr], sampleRate, weights: weightsUrl, refStats },
      () => {} // el progreso fino por chunk no se reporta — el orquestador reporta "chunk N de M"
    );
    const payload = {};
    const transferList = [];
    for (const [name, [l, r]] of Object.entries(stems)) {
      payload[name] = [l.buffer, r.buffer];
      transferList.push(l.buffer, r.buffer);
    }
    self.postMessage({ __final: true, plan, stems: payload }, transferList);
  } catch (err) {
    self.postMessage({ __final: true, plan, error: (err && err.message) || String(err) });
  }
};
