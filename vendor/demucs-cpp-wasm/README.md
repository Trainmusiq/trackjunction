# demucs.cpp (vendored, compilado a WASM)

Compilado desde [sevagh/demucs.cpp](https://github.com/sevagh/demucs.cpp) (MIT license, ver `LICENSE`), commit de julio 2026, con Emscripten 6.0.2. Motor de inferencia C++17 (Eigen3, sin dependencias de threading) para los modelos Demucs v4 Hybrid-Transformer (4 y 6 fuentes) y v3 Hybrid.

## Por qué este motor y no demucs-rs (WebGPU)

Ver `docs/especificacion.md` de este repo §3 (benchmark completo con evidencia propia). Resumen: demucs.cpp/WASM funciona en el 100% de navegadores modernos (WASM+SIMD, sin requisito de GPU) mientras que demucs-rs requiere WebGPU (~82% de cobertura global en jul 2026, con huecos reales en Android/Linux/OS viejos) sin fallback a CPU. El tier gratis de trackjunction prioriza alcance universal; la velocidad la resuelve el tier servidor (§C de la spec).

## Build modificado respecto al upstream

El `CMakeLists.txt` de `src_wasm/` en el upstream usa `ALLOW_MEMORY_GROWTH=1`, que en V8/Chrome recientes crea un `ArrayBuffer` **resizable** — y `TextDecoder.decode()` (usado internamente por el logging de Emscripten vía `UTF8ToString`) rechaza buffers resizable con `TypeError`. Esto se manifestó como un crash real al cargar el modelo, reproducido y diagnosticado en esta sesión.

**Fix aplicado:** memoria fija (`INITIAL_MEMORY=2048MB`, sin `ALLOW_MEMORY_GROWTH`) en vez de crecimiento dinámico. También se agregó `HEAPU8` y `HEAPF32` a `EXPORTED_RUNTIME_METHODS` (el build upstream solo exporta `FS`, insuficiente para copiar audio hacia/desde la memoria WASM desde JS).

Si se actualiza el vendor a una versión más nueva del upstream, verificar si este bug de `TextDecoder` + resizable buffer sigue existiendo (relacionado a un cambio de spec de ECMAScript, no algo que el proyecto vaya a arreglar solo).

## Verificación de seguridad (§11 — sin SharedArrayBuffer/hilos)

Verificado en 3 pasos, con evidencia real de esta sesión:
1. **Grep del JS compilado** por `SharedArrayBuffer`/`USE_PTHREADS`/`pthread_create`/`Atomics.`: cero coincidencias.
2. **Build flags** (`CMakeLists.txt` de este vendor): sin `-pthread`, sin `-s USE_PTHREADS=1`, sin `-s SHARED_MEMORY=1`.
3. **Prueba empírica en navegador real** (Chrome, sin headers COOP/COEP): `typeof SharedArrayBuffer === 'undefined'` (ni siquiera existe el global) y `Module.HEAPU8.buffer instanceof SharedArrayBuffer === false`. El módulo cargó y corrió una separación real sin necesitar `SharedArrayBuffer` en ningún momento.

No se necesitan headers COOP/COEP. Compatible con GitHub Pages sin configuración adicional (mismo patrón que rubberband-wasm en centrail).

## Benchmark real (esta sesión, este equipo — Apple Silicon)

30 segundos de audio real (mezcla de banda completa, "Pétalo de Sal"), modelo `htdemucs` 4-fuentes, en Chrome real vía `http.server` local:

- **104.8 s** para separar 30.0 s de audio → **3.49× tiempo real**, un solo hilo WASM (sin paralelismo de Workers todavía).
- Los 4 stems (drums/bass/other/vocals) tienen señal real verificada (energía > 0 en cada uno).
- Extrapolado a una canción de 2:43 (163.3 s, mismo archivo, medido también con PyTorch nativo más abajo): ≈ 9.5 min con un solo hilo WASM; con paralelismo de 8 Web Workers (patrón usado por freemusicdemixer.com, sin SharedArrayBuffer — cada Worker con su propia instancia WASM procesando un segmento distinto) el propio mantenedor reporta ~4.5× de mejora ⇒ estimado ≈ 2.1 min para el prototipo final con Workers.

## Pesos del modelo

Ver `vendor/demucs-weights/README.md`.
