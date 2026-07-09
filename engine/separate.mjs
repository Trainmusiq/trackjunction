// Separación de stems — motor demucs.cpp compilado a WASM (vendor/demucs-cpp-wasm),
// sin hilos/SharedArrayBuffer (verificado, ver vendor/demucs-cpp-wasm/README.md §11).
//
// Prototipo mínimo (etapa 2, sesión de apertura — pasos 1-3 del método,
// manual-continuidad.md §4): demuestra que el motor separa audio real
// correctamente y mide tiempo real. NO es el pipeline final: la integración a
// Worker (para no bloquear el hilo principal, patrón engine.worker.mjs de
// centrail) y el paralelismo por segmentos son trabajo de la sesión de
// construcción del pipeline v2.0, no de esta sesión.
//
// vendor/demucs-cpp-wasm/demucs.js es UMD (no ESM): expone `module.exports`
// en CommonJS y `var libdemucs` en scope global si se carga como script
// clásico. En un Worker de producción se carga con `importScripts()` y se usa
// `self.libdemucs`; en Node (para testear este wrapper) se usa `createRequire`.

import { createRequire } from "node:module";

let modulePromise = null;
let weightsPromise = null;

function loadLibdemucsFactory() {
  const isNode = typeof process !== "undefined" && process.versions?.node;
  if (isNode) {
    // El módulo asume contexto Worker para su logging (EM_JS -> postMessage);
    // en Node (solo para test/*.mjs, nunca en producción) se stubea como no-op.
    if (typeof globalThis.postMessage !== "function") globalThis.postMessage = () => {};
    const require = createRequire(import.meta.url);
    return require("../vendor/demucs-cpp-wasm/demucs.js");
  }
  if (typeof importScripts === "function") {
    // Worker: importScripts es síncrono y clásico, no ESM.
    importScripts(new URL("../vendor/demucs-cpp-wasm/demucs.js", import.meta.url).href);
    return self.libdemucs;
  }
  throw new Error(
    "separate.mjs solo soporta Node (testing) o Worker (importScripts). " +
    "Uso desde el hilo principal del navegador no está soportado — cargar dentro de un Worker."
  );
}

function loadModule() {
  if (!modulePromise) {
    modulePromise = Promise.resolve().then(() => loadLibdemucsFactory()()); // libdemucs() es async, devuelve el Module
  }
  return modulePromise;
}

function loadWeights(weightsSource) {
  if (!weightsPromise) {
    weightsPromise = typeof weightsSource === "string"
      ? fetch(weightsSource).then((r) => r.arrayBuffer())
      : Promise.resolve(weightsSource); // ya viene como ArrayBuffer/Uint8Array (ej. fs.readFileSync en tests)
  }
  return weightsPromise;
}

const STEM_NAMES_4 = ["drums", "bass", "other", "vocals"];

/**
 * @param {{channelData: Float32Array[], sampleRate: number, weights: string|ArrayBuffer|Uint8Array}} input
 * @param {(p:number, label?:string)=>void} [onProgress]
 * @returns {Promise<{stems: Record<string, Float32Array[]>, sampleRate: number}>}
 */
export async function separateStems({ channelData, sampleRate, weights }, onProgress) {
  onProgress?.(0.02, "cargando motor");
  const Module = await loadModule();

  onProgress?.(0.05, "cargando pesos del modelo");
  const weightsBuf = await loadWeights(weights);

  onProgress?.(0.15, "inicializando modelo");
  const weightsBytes = weightsBuf instanceof Uint8Array ? weightsBuf : new Uint8Array(weightsBuf);
  const weightsPtr = Module._malloc(weightsBytes.length);
  Module.HEAPU8.set(weightsBytes, weightsPtr);
  Module._modelInit(weightsPtr, weightsBytes.length);
  Module._free(weightsPtr);

  const left = channelData[0];
  const right = channelData.length > 1 ? channelData[1] : channelData[0];
  const N = left.length;
  const bytesPerFloat = 4;

  const inLeftPtr = Module._malloc(N * bytesPerFloat);
  const inRightPtr = Module._malloc(N * bytesPerFloat);
  Module.HEAPF32.set(left, inLeftPtr / bytesPerFloat);
  Module.HEAPF32.set(right, inRightPtr / bytesPerFloat);

  const outPtrs = [];
  for (let i = 0; i < 8; i++) outPtrs.push(Module._malloc(N * bytesPerFloat));

  onProgress?.(0.2, "separando (single-thread WASM, sin paralelismo todavía)");
  Module._modelDemixSegment(
    inLeftPtr, inRightPtr, N,
    outPtrs[0], outPtrs[1], outPtrs[2], outPtrs[3],
    outPtrs[4], outPtrs[5], outPtrs[6], outPtrs[7],
    0, 0, 0, 0,
    false
  );

  onProgress?.(0.95, "copiando resultados");
  const stems = {};
  for (let s = 0; s < 4; s++) {
    const l = Module.HEAPF32.slice(outPtrs[s * 2] / bytesPerFloat, outPtrs[s * 2] / bytesPerFloat + N);
    const r = Module.HEAPF32.slice(outPtrs[s * 2 + 1] / bytesPerFloat, outPtrs[s * 2 + 1] / bytesPerFloat + N);
    stems[STEM_NAMES_4[s]] = [l, r];
  }

  Module._free(inLeftPtr);
  Module._free(inRightPtr);
  for (const p of outPtrs) Module._free(p);

  onProgress?.(1, "listo");
  return { stems, sampleRate };
}
