# CLAUDE.md — trackjunction / trainmusiq

## Qué es este proyecto
trackjunction: separación de stems + estudio (mute/solo, tempo, loops), 100% client-side por defecto, deploy en GitHub Pages. Segunda herramienta del ecosistema trainmusiq (tras centrail). ANTES DE CUALQUIER TAREA: lee `docs/especificacion.md` (el qué técnico de esta herramienta) y, en el repo `trainmusiq/trainmusiq` (clonado en `/Users/juanma/Aat/Trainmusiq/docs/`), `roadmap.md` (el orden y porqué) y `manual-continuidad.md` (método y reglas de decisión) — no se duplican acá.

## Estado
Pre-etapa: benchmark de motor + prototipo mínimo + spec completa hechos (9 jul 2026, ver especificacion.md). El pipeline v2.0 (integración a Worker, paralelismo, mezclador, refinamiento de pitch por stem) **no está construido todavía** — es la próxima sesión.

## Reglas duras (no re-discutir; el porqué está en docs/especificacion.md)
1. **Sin dependencias con hilos/SharedArrayBuffer** (GitHub Pages no permite COOP/COEP). El motor vendorizado (demucs.cpp WASM) ya está verificado sin esto — si se actualiza el vendor, repetir la verificación de 3 pasos (grep + build flags + prueba empírica en navegador real).
2. **Vendorizar con versión fijada**: `vendor/demucs-cpp-wasm/` (motor) y `vendor/demucs-weights/` (pesos, MIT, ver su README) — licencia verificada compatible GPL v3.
3. **El motor de pitch de centrail se usa como copia vendorizada**, no repo común `trainmusiq/engine` (decisión con criterio en especificacion.md §8 — revisar si aparece una tercera herramienta que también lo necesite).
4. **Progreso honesto**: toda operación de separación reporta % real por segmento/Worker, nunca spinner indeterminado (mismo principio que centrail).
5. **Sin recursos de CDN externos**: todo auto-hosteado.
6. **Commits por hito**, mensajes descriptivos, push al cierre de cada hito.
7. **La fase servidor (§7 de la spec) está diseñada pero NO construida** — no empezar a implementar backend sin una sesión explícitamente dedicada a eso, y solo después de publicar el tier cliente (regla madre del ecosistema).

## Gotchas pagados (no volver a pagar)
- **`vendor/demucs-cpp-wasm` con `ALLOW_MEMORY_GROWTH=1` crashea** en Chrome reciente: `TextDecoder.decode()` rechaza el `ArrayBuffer` resizable que produce el memory growth dinámico. Fix aplicado: `INITIAL_MEMORY` fija (2048MB) en vez de growth. Ver `vendor/demucs-cpp-wasm/README.md`.
- **El build upstream de demucs.cpp solo exporta `FS`** en `EXPORTED_RUNTIME_METHODS` — insuficiente para copiar audio hacia/desde memoria WASM desde JS. Se agregó `HEAPU8`/`HEAPF32` al vendorizar.
- **`vendor/demucs-cpp-wasm/demucs.js` es UMD, no ESM**: no se puede `import()` como módulo ES directamente. En Node se carga con `createRequire`; en un Worker de producción, con `importScripts()`. Ver `engine/separate.mjs`.
- **El módulo asume contexto Worker para su logging** (llama a `postMessage` internamente) — en Node (solo para tests) hace falta un stub no-op de `postMessage` antes de cargarlo.

## Al cerrar cada sesión
Reportar: checklist de lo pedido con ✓/✗/⚠, commits hechos, y qué quedó pendiente con su porqué. Actualizar `docs/especificacion.md` si la realidad enseñó algo nuevo (hallazgos con fecha).
