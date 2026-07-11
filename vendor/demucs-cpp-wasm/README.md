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

## Parche de normalización externa (sesión de construcción v2.0, 11 jul 2026)

**Qué se tocó respecto al upstream** (además del fix de memoria de arriba), en el commit vendorizado de `sevagh/demucs.cpp`:

- `src/model.hpp`: `demucs_inference()` gana 3 parámetros nuevos con default: `bool use_external_ref = false, float external_ref_mean = 0.0f, float external_ref_std = 1.0f`.
- `src/model_apply.cpp`: cuando `use_external_ref` es `true`, usa `external_ref_mean`/`external_ref_std` en vez de calcular media/desviación internamente sobre el buffer recibido.
- `src_wasm/demucs.cpp`: `modelDemixSegment` gana los mismos 3 parámetros al final de su firma (`..., bool batch_mode_param, bool use_external_ref, float external_ref_mean, float external_ref_std)`), los reenvía a `demucs_inference`.

**Por qué:** el motor normaliza cada buffer que recibe por su propia media/desviación (downmix mono, ver comentario en `model_apply.cpp`) — correcto solo cuando el buffer es la canción completa. Al trocear una canción en franjas (obligatorio por el límite de memoria de arriba), cada franja normalizaba con SUS PROPIAS estadísticas locales, distintas a las de la canción completa. `engine/ref-stats.mjs` calcula las estadísticas una vez sobre toda la canción y `engine/separate.mjs` las pasa a través de este parche. Detalle completo, con números medidos, en `docs/especificacion.md` §11.

**Gotcha de compilación:** el primer intento usó `NaN` como sentinel ("no hay valor externo") en vez de un flag `bool` — **falló en runtime** (`RuntimeError: float unrepresentable in integer range`) porque `-ffast-math` (ya en `CMakeLists.txt` de este vendor) puede optimizar `std::isnan()` para que siempre devuelva `false`, haciendo que el código SIEMPRE tomara la rama de "usar valor externo" incluso con NaN de verdad. Se corrigió usando el flag `bool` explícito de arriba. **Cualquier parche futuro de este motor debe usar flags bool explícitos para esta clase de "¿hay un valor externo o no?", nunca detección de NaN**, mientras se mantenga `-ffast-math`.

**Cómo reconstruir** (toolchain en `.build-tools/` del repo, no versionado — ver regla dura #8 de `CLAUDE.md`):
```
source .build-tools/emsdk/emsdk_env.sh
cd .build-tools/demucs.cpp/build-wasm
emcmake cmake ../src_wasm -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=Release
emmake make -j4
cp demucs.js demucs.wasm ../../../vendor/demucs-cpp-wasm/
```
(`CMAKE_BUILD_TYPE=Release` es necesario para que se apliquen `-msimd128 -msse4.2` de `CMAKE_CXX_FLAGS_RELEASE` — sin esto, el build falla al incluir `<nmmintrin.h>` sin los flags de SSE habilitados.)

**⚠ Si se re-vendoriza desde upstream (nueva versión de `sevagh/demucs.cpp`), hay que reaplicar este parche a mano** — no es parte del repo upstream, se perdería silenciosamente en una actualización ingenua.

## ⚠ Bug no resuelto: no-determinismo entre llamadas repetidas (11 jul 2026)

**Confirmado (con y sin el parche de arriba, incluyendo en el WASM original sin parchear extraído de git):** llamar `modelDemixSegment` dos veces con el MISMO clip exacto, en la MISMA instancia WASM (sin recargar el módulo), da salidas DISTINTAS. Es decir, **el motor no es determinista entre llamadas repetidas de la misma sesión**. Esto es un bug pre-existente del motor vendorizado (o de cómo Emscripten/Eigen reutilizan memoria entre llamadas — no diagnosticado a nivel de código C++ por falta de tiempo).

**Implicancia:** no es seguro reutilizar una instancia WASM cargada ("warm start", ver `docs/especificacion.md` §10.3) para procesar múltiples canciones o franjas en la misma sesión — la segunda llamada en adelante puede dar resultado distinto (posiblemente incorrecto) al de una instancia recién cargada. Detalle completo y metodología de la prueba en `docs/especificacion.md` §11.4. **No usar warm start hasta resolver esto.**

## Pesos del modelo

Ver `vendor/demucs-weights/README.md`.
