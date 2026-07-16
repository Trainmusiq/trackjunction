// Orquestador de separación — Worker módulo (puede reutilizarse entre
// canciones: NO llama a modelDemixSegment directamente, solo coordina
// Workers clásicos de un solo uso (workers/chunk.worker.mjs) que sí lo
// hacen — así se evita el bug de no-determinismo de §11.6 sin perder la
// comodidad de un orquestador persistente).
//
// Modos:
// - "studio": sección de estudio, clip ya recortado a <=34s por la UI, una
//   sola llamada, bit-perfecto (sin trocear, ver docs/especificacion.md
//   §11.9). Hoy con el modelo de 4 stems; evolucionará a 6 stems en v2.1
//   (guitarra/piano) para aislar solos con más precisión — es el
//   diferenciador de este modo frente a los de canción completa.
// - "full": canción completa, troceo-con-descarte + Workers paralelos
//   (calidad medida, no bit-perfecta — ver §11.8, etiqueta honesta en UI).
// - "full": canción completa, troceo-con-descarte + Workers paralelos
//   (calidad medida, no bit-perfecta — ver §11.8, etiqueta honesta en UI).
// - "karaoke": igual que "full" pero el resultado expuesto es solo
//   vocals + instrumental (mezcla original - vocals), que hereda la
//   calidad del stem de voz (§11.10, pasa -80dB con margen).

import { planSegments } from "../engine/segment-plan.mjs?v=0.8.0";
import { mergeSegmentsDiscard } from "../engine/merge-segments-discard.mjs?v=0.8.0";
import { computeRefStats } from "../engine/ref-stats.mjs?v=0.8.0";
import { chooseWorkerPlan, DISCARD_SECS, SEGMENT_SECS_FALLBACK_TIERS } from "../engine/adaptive-workers.mjs?v=0.8.0";

function isOomError(err) {
  const msg = (err && err.message) || String(err);
  return /OOM|out of memory|memory access out of bounds/i.test(msg);
}

const STEM_NAMES = ["drums", "bass", "other", "vocals"];

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function runChunk(plan, left, right, sampleRate, weightsUrl, refStats) {
  return new Promise((resolve, reject) => {
    const leftBuf = left.buffer.slice(left.byteOffset, left.byteOffset + left.byteLength);
    const rightBuf = right.buffer.slice(right.byteOffset, right.byteOffset + right.byteLength);
    // Worker CLÁSICO a propósito (ver workers/chunk.worker.mjs) — sin
    // {type:"module"} — y de un solo uso: se crea y se termina, nunca se
    // reutiliza para otra llamada.
    const w = new Worker(new URL("./chunk.worker.mjs", import.meta.url));
    w.onmessage = (ev) => {
      // Ignorar mensajes que no sean el resultado final (ver chunk.worker.mjs:
      // demucs.js manda sus propios pings de progreso por el mismo canal).
      if (!ev.data || !ev.data.__final) return;
      w.terminate();
      if (ev.data.error) reject(new Error(ev.data.error));
      else resolve(ev.data);
    };
    w.onerror = (err) => { w.terminate(); reject(err); };
    w.postMessage(
      { plan, left: leftBuf, right: rightBuf, sampleRate, weightsUrl, refStats },
      [leftBuf, rightBuf]
    );
  });
}

async function processPlans(plans, left, right, sampleRate, weightsUrl, refStats, nParallel, onChunkDone) {
  const results = new Array(plans.length);
  let nextIndex = 0;
  let doneCount = 0;

  async function worker() {
    while (nextIndex < plans.length) {
      const myIndex = nextIndex++;
      const plan = plans[myIndex];
      const res = await runChunk(plan, left, right, sampleRate, weightsUrl, refStats);
      results[myIndex] = res;
      doneCount++;
      onChunkDone(doneCount, plans.length);
    }
  }

  const pool = [];
  for (let i = 0; i < nParallel; i++) pool.push(worker());
  await Promise.all(pool);
  return results;
}

self.onmessage = async (ev) => {
  const { mode, left, right, sampleRate, weightsUrl, hardwareConcurrency, deviceMemoryGB } = ev.data;
  try {
    const leftArr = new Float32Array(left);
    const rightArr = new Float32Array(right);
    const totalSamples = leftArr.length;
    const durationSecs = totalSamples / sampleRate;

    let merged;

    if (mode === "studio") {
      post({ type: "progress", stage: "separando", pct: 0.05, resourceMessage: "Procesando la sección" });
      const plan = planSegments(totalSamples, sampleRate, 1)[0];
      const [result] = await processPlans([plan], leftArr, rightArr, sampleRate, weightsUrl, undefined, 1, () => {
        post({ type: "progress", stage: "separando", pct: 0.5 });
      });
      merged = {};
      for (const name of STEM_NAMES) {
        merged[name] = [new Float32Array(result.stems[name][0]), new Float32Array(result.stems[name][1])];
      }
    } else {
      // "full" o "karaoke": troceo-con-descarte + Workers paralelos.
      // Reintento con franjas más chicas si el motor aborta por memoria —
      // el ceiling de 34s está probado en Chrome (ver CLAUDE.md), pero
      // otros motores JS pueden tener menos margen con la MISMA memoria
      // WASM fija (glue code, tablas, stack distintos). Nunca reventar:
      // se avisa y se reintenta más chico antes de rendirse.
      post({ type: "progress", stage: "calculando estadísticas globales", pct: 0.02 });
      const refStats = computeRefStats([leftArr, rightArr]);

      let results, plans;
      for (let tier = 0; tier < SEGMENT_SECS_FALLBACK_TIERS.length; tier++) {
        const maxSegmentSecs = SEGMENT_SECS_FALLBACK_TIERS[tier];
        const plan = chooseWorkerPlan({
          durationSecs, hardwareConcurrency, deviceMemoryGB, overlapSecs: DISCARD_SECS, maxSegmentSecs,
        });
        plans = planSegments(totalSamples, sampleRate, plan.nSegments, DISCARD_SECS);

        post({
          type: "progress", stage: "separando", pct: 0.05,
          resourceMessage: `Usando ${plan.nParallel} núcleo${plan.nParallel === 1 ? "" : "s"} de tu CPU`,
          detail: tier === 0
            ? plan.reason
            : `memoria insuficiente con franjas de ~${SEGMENT_SECS_FALLBACK_TIERS[tier - 1]}s — reintentando con franjas de ~${maxSegmentSecs}s. ${plan.reason}`,
        });

        try {
          results = await processPlans(
            plans, leftArr, rightArr, sampleRate, weightsUrl, refStats, plan.nParallel,
            (done, total) => post({
              type: "progress", stage: "separando",
              pct: 0.05 + 0.85 * (done / total),
              detail: `franja ${done} de ${total}`,
            })
          );
          break;
        } catch (err) {
          const isLastTier = tier === SEGMENT_SECS_FALLBACK_TIERS.length - 1;
          if (!isOomError(err) || isLastTier) throw err;
        }
      }

      post({ type: "progress", stage: "combinando franjas", pct: 0.92 });
      const chunkResults = results.map((r) => ({
        plan: r.plan,
        stems: Object.fromEntries(STEM_NAMES.map((name) => [
          name, [new Float32Array(r.stems[name][0]), new Float32Array(r.stems[name][1])],
        ])),
      }));
      merged = mergeSegmentsDiscard(chunkResults, totalSamples, STEM_NAMES);

      if (mode === "karaoke") {
        post({ type: "progress", stage: "armando instrumental", pct: 0.97 });
        const [vocL, vocR] = merged.vocals;
        const instL = new Float32Array(totalSamples);
        const instR = new Float32Array(totalSamples);
        for (let i = 0; i < totalSamples; i++) {
          instL[i] = leftArr[i] - vocL[i];
          instR[i] = rightArr[i] - vocR[i];
        }
        merged = { vocals: merged.vocals, instrumental: [instL, instR] };
      }
    }

    post({ type: "progress", stage: "listo", pct: 1 });
    const transferList = [];
    const stemsOut = {};
    for (const [name, [l, r]] of Object.entries(merged)) {
      stemsOut[name] = [l.buffer, r.buffer];
      transferList.push(l.buffer, r.buffer);
    }
    post({ type: "done", stems: stemsOut, sampleRate }, transferList);
  } catch (err) {
    post({ type: "error", message: (err && err.message) || String(err) });
  }
};
