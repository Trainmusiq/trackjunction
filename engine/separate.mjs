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

import NodeModule from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let modulePromise = null;
let weightsPromise = null;

// Hallazgo de sesión (jul 2026): en Node ≥22 con package.json "type":"module",
// require() de un .js UMD sin `export` estático lo trata como ESM (interop
// require(esm)) y devuelve un namespace vacío en vez de ejecutar el UMD como
// CommonJS. Se fuerza la interpretación CJS compilando el archivo manualmente
// con la API interna de Module — solo importa en Node (testing); en un Worker
// de navegador esto no aplica (importScripts es siempre clásico).
function requireAsCJS(absPath) {
  const m = new NodeModule(absPath, null);
  m.filename = absPath;
  m.paths = NodeModule._nodeModulePaths(path.dirname(absPath));
  m._compile(fs.readFileSync(absPath, "utf8"), absPath);
  return m.exports;
}

function loadLibdemucsFactory() {
  const isNode = typeof process !== "undefined" && process.versions?.node;
  if (isNode) {
    // El módulo asume contexto Worker para su logging (EM_JS -> postMessage);
    // en Node (solo para test/*.mjs, nunca en producción) se stubea como no-op.
    if (typeof globalThis.postMessage !== "function") globalThis.postMessage = () => {};
    const demucsJsPath = fileURLToPath(new URL("../vendor/demucs-cpp-wasm/demucs.js", import.meta.url));
    return requireAsCJS(demucsJsPath);
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
 * @param {{channelData: Float32Array[], sampleRate: number, weights: string|ArrayBuffer|Uint8Array,
 *   refStats?: {mean:number, std:number}}} input refStats: estadísticas de
 *   normalización de la canción ENTERA (engine/ref-stats.mjs), a pasar
 *   cuando `channelData` es solo una FRANJA — si se omite, el motor
 *   (parcheado, ver vendor/demucs-cpp-wasm/README.md) calcula sus propias
 *   estadísticas sobre este buffer únicamente, correcto solo si
 *   `channelData` ya es la canción completa (hallazgo de sesión, ver
 *   docs/especificacion.md §11: cada franja normalizada con sus propias
 *   estadísticas locales difiere hasta ~32% de las de la canción completa,
 *   degradando la separación de forma audible).
 * @param {(p:number, label?:string)=>void} [onProgress]
 * @returns {Promise<{stems: Record<string, Float32Array[]>, sampleRate: number}>}
 */
export async function separateStems({ channelData, sampleRate, weights, refStats }, onProgress) {
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

  onProgress?.(0.2, "separando");
  // Firma completa de _modelDemixSegment tras el parche (ver vendor/demucs-cpp-wasm/README.md):
  // (left, right, N, left_0..right_3 [4 stems], left_4..right_6 [no usados,
  // el modelo de 4 fuentes solo llena 0-3], batch_mode_param,
  // use_external_ref, external_ref_mean, external_ref_std). use_external_ref
  // es un flag bool explícito (NO se usa NaN como sentinel: bajo -ffast-math,
  // ya presente en los flags de release, std::isnan() puede optimizarse para
  // devolver siempre false — un sentinel NaN no es fiable ahí, ver
  // vendor/demucs-cpp-wasm/README.md).
  const useExternalRef = refStats != null;
  const refMean = refStats?.mean ?? 0;
  const refStd = refStats?.std ?? 1;
  Module._modelDemixSegment(
    inLeftPtr, inRightPtr, N,
    outPtrs[0], outPtrs[1], outPtrs[2], outPtrs[3],
    outPtrs[4], outPtrs[5], outPtrs[6], outPtrs[7],
    0, 0, 0, 0, // left_4,right_4,left_5,right_5 (no usados, modelo de 4 fuentes)
    0, 0, // left_6,right_6 (no usados)
    false, // batch_mode_param
    useExternalRef, refMean, refStd
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
