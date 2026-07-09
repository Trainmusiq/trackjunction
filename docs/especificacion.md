# trackjunction — Especificación del proyecto

**Ecosistema:** trainmusiq (ver `trainmusiq/trainmusiq` — roadmap.md, manual-continuidad.md, brief-diseno.md) · **Herramienta:** trackjunction — el empalme que divide la canción en vías: separación de stems + estudio (mute/solo, tempo, loops)
**Versión:** 0.2 · 9 de julio de 2026 (sesión de reevaluación de arquitectura de rendimiento, §10 — previa a la sesión de construcción del pipeline v2.0)
**Autor:** Juanma (Punta Arenas) con Claude
**Estado:** pre-etapa. Benchmark de motor hecho con evidencia propia (§3), prototipo mínimo funcional (§3), spec completa incluyendo la arquitectura cliente/servidor proyectada desde el día uno (§7), y ahora la cascada de rendimiento del cliente decidida y medida con evidencia propia (§10). **No construido todavía**: esta sesión tampoco abre la construcción del pipeline v2.0 (regla del método — spec antes de construir, no a medias).

**Nombre:** "trackjunction" — el empalme ferroviario que divide la canción en vías (stems); "track" es pista de audio Y vía férrea, doble sentido intencional.

---

## 1. Visión

trackjunction separa una canción en pistas individuales (voz, batería, bajo, resto — y guitarra/piano en el modo 6-stems) y ofrece un mini-estudio sobre esas pistas: mute/solo, cambio de tempo sin alterar el pitch, loops A-B, y **refinamiento de pitch por stem** reutilizando el motor de detección/corrección ya validado de centrail (excluyendo batería de la medición — resuelve estructuralmente el hallazgo de R bajo por percusión documentado en `especificacion.md` §3 de centrail).

**Filosofía (heredada del ecosistema, ver `trainmusiq/trainmusiq/CLAUDE.md`):** el tier gratis corre en el equipo del usuario, sin límite de uso, sin ads, sin subir el audio a ningún servidor — lento pero honesto (progreso real, nunca spinner). El tier de pago no vende "más stems" ni "mejor calidad" como principal gancho — vende **velocidad** (servidor GPU, segundos en vez de minutos) y features de cómputo pesado (modelos superiores, detección automática de instrumentos). Es la misma filosofía de centrail aplicada a un problema donde el cómputo es mucho más pesado.

**Pipeline integrado con centrail (el diferenciador #4 del roadmap):** cargar canción → diagnóstico de afinación (centrail) → separar en stems (trackjunction) → refinar pitch por stem excluyendo batería → temperar todos los stems a la misma referencia → exportar stems corregidos y/o mezcla re-sumada. Nadie en el mercado (Moises incluido) ofrece esto como un solo flujo.

## 2. Estado actual: qué está validado

### Benchmark de motor (9 jul 2026, con evidencia propia — no por reputación)

Se evaluaron 3 candidatos reales para separación de stems 100% en navegador:

| Candidato | Motor | Requiere | Threading/COOP | Licencia | Estado |
|---|---|---|---|---|---|
| **demucs.cpp** (elegido) | C++17/Eigen3 → WASM (Emscripten) | WASM+SIMD (universal, ~100% navegadores modernos) | Ninguno — verificado sin SharedArrayBuffer | MIT | Activo (último push dic 2024), 171★ |
| demucs-rs | Rust/Burn → WASM+WebGPU | WebGPU (~82% cobertura global jul 2026, huecos reales en Android/Linux/Safari-viejo) | WebGPU no necesita SharedArrayBuffer, pero **sin fallback a CPU** si no hay WebGPU | Apache 2.0 | Activo, con DAW plugin y CLI nativo |
| demucs-web (timcsy) | ONNX Runtime Web (WebGPU+WASM) | — | **Requiere SharedArrayBuffer + COOP/COEP explícitamente** (confirmado en su propia doc) | MIT | Descartado de entrada — GitHub Pages no permite configurar esos headers (regla dura §11) |

**Decisión: demucs.cpp, motivo principal es alcance universal, no velocidad máxima.** demucs-rs sería más rápido en hardware con WebGPU, pero excluiría de entrada ~15-20% de usuarios del tier gratis (los que menos probablemente puedan pagar un tier premium, además) — contradice la filosofía de "gratis funciona para todos, sin gimmicks". La velocidad la resuelve el tier servidor (§7), no forzar WebGPU en el cliente. Si en una sesión futura el dato de uso real muestra que la velocidad del tier gratis es la principal fricción, reevaluar con datos (no ahora, por diseño — regla de decisión del ecosistema: "decisiones técnicas con evidencia propia").

**Verificación de seguridad (regla dura §11, 3 pasos con evidencia):**
1. Grep del JS compilado por `SharedArrayBuffer`/`USE_PTHREADS`/`pthread_create`/`Atomics.`: cero coincidencias.
2. Build flags (`vendor/demucs-cpp-wasm/CMakeLists.txt.build-recipe`): sin `-pthread`, sin `-s USE_PTHREADS=1`, sin `-s SHARED_MEMORY=1`.
3. Prueba empírica **en un navegador real (Chrome, sin headers COOP/COEP)**: `typeof SharedArrayBuffer === 'undefined'` (ni existe el global) y `Module.HEAPU8.buffer instanceof SharedArrayBuffer === false`, con una separación real completa corriendo sin necesitarlo.

Detalle completo, incluyendo un bug real encontrado y su fix (resizable ArrayBuffer vs `TextDecoder` en Chrome reciente), en `vendor/demucs-cpp-wasm/README.md`.

### Prototipo mínimo (9 jul 2026)

`engine/separate.mjs` — wrapper del motor vendorizado, probado end-to-end (no solo compilado) contra audio real de `test/private/` en dos entornos independientes:

| Entorno | Audio real | Tiempo | Ratio vs tiempo real |
|---|---|---|---|
| Chrome real (navegador, sin COOP/COEP) | 30.0 s (mezcla de banda completa) | 104.8 s | 3.49× |
| Node (`test/separate-file.mjs`) | 10.0 s (mismo archivo) | 35.2 s | 3.52× |

Resultado consistente entre entornos (mismo motor WASM single-thread). Los 4 stems (drums/bass/other/vocals) tienen señal real verificada (energía > 0 en cada uno) — separación funcionalmente correcta, no solo "corre sin crashear".

**Extrapolación a una canción completa** (163.3 s / 2:43, mismo archivo real usado en los benchmarks de pitch de centrail): single-thread WASM ≈ 570 s (9.5 min). Con paralelismo de Web Workers (mismo patrón que `freemusicdemixer.com`: N Workers, cada uno con su propia instancia WASM procesando un segmento distinto — **sin SharedArrayBuffer**, cada Worker tiene memoria propia) el mantenedor de demucs.cpp reporta ~4.5× de mejora con 8 workers ⇒ estimado ≈ 127 s (2.1 min) para el pipeline final. Esto es mejor que la expectativa conservadora ya declarada en el roadmap ("advertir 10-20 min").

**Nota de honestidad:** el número de Workers/8 no está medido en este equipo — es el número publicado por el mantenedor de demucs.cpp para su propio hardware. Medirlo en este equipo es trabajo de la sesión de construcción del pipeline (implica escribir el orquestador de Workers, fuera del alcance de "prototipo mínimo").

### Comparación con GPU real (referencia para el costo del tier servidor, §7)

Mismo archivo real (163.3 s), modelo PyTorch nativo (no WASM) para tener un punto de referencia de lo que un servidor GPU puede lograr:

| Hardware | Tiempo | Ratio |
|---|---|---|
| GPU Apple Silicon (Metal/MPS, este equipo) | 21 s | 0.13× (7.8× más rápido que tiempo real) |
| CPU nativo multi-hilo (este equipo) | 62 s | 0.38× (2.6× más rápido que tiempo real) |
| WASM single-thread en navegador (medido arriba) | ~570 s (extrapolado) | 3.49× (más lento que tiempo real) |

Un GPU de servidor dedicado (RTX 4090/A10 en RunPod, etc.) debería igualar o superar el número de Apple Silicon MPS — se usa como base conservadora para el costo estimado en §7.

## 3. Algoritmo/motor

- **Modelo:** Demucs v4 Hybrid-Transformer (`htdemucs`, 4 fuentes: drums/bass/other/vocals). Pesos MIT (Meta/facebookresearch, vía conversión GGML de `Retrobear/demucs.cpp` en HuggingFace), vendorizados en `vendor/demucs-weights/`.
- **6-stems (`htdemucs_6s`, agrega guitarra y piano) es el default planeado para el release** (ver catálogo §6 del roadmap del ecosistema) — el prototipo de esta sesión usó el modelo 4-fuentes por simplicidad; agregar 6-fuentes es un cambio de qué archivo de pesos se carga, no de arquitectura.
- **API del motor** (`vendor/demucs-cpp-wasm/demucs.js` + `demucs.wasm`): `modelInit(bytes, size)` carga los pesos; `modelDemixSegment(left, right, length, ...8 punteros de salida, batchMode)` separa un buffer estéreo completo. Sin streaming/chunking interno — el "segmento" es toda la señal pasada en una llamada (el chunking por tiempo, si hace falta para archivos muy largos, es responsabilidad de quien llama).
- **Paralelismo (pendiente de implementar, v2.0):** un Worker por núcleo lógico disponible (`navigator.hardwareConcurrency`), cada uno con su propia instancia del módulo WASM procesando un segmento temporal distinto de la canción, resultados recombinados en el hilo principal. Sin SharedArrayBuffer en ningún punto (cada Worker es independiente).

## 4. Definición de "terminado" para v2.0 (release del pipeline)

*(criterios a cumplir en la sesión de construcción, no en esta sesión de apertura)*

- Separa una canción real de 3-5 minutos en 4 (o 6) stems dentro del navegador sin colgar la pestaña, con progreso honesto por Worker/segmento (nunca spinner).
- Refinamiento de pitch por stem (reutilizando el motor de centrail) mide de forma más consistente que el diagnóstico global en material con batería prominente — verificable con los mismos archivos de prueba reales usados para validar centrail (`test/private/`, R bajo documentado).
- Temperado unificado: todos los stems corregidos al mismo destino, exportables individualmente y como mezcla re-sumada.
- Mezclador básico funcional: mute/solo por stem, sin necesitar re-procesar.
- Progreso honesto de principio a fin (decodificación → separación por segmento → refinamiento de pitch → codificación de exports).
- Checklist de seguridad §11 del ecosistema repetido para esta versión vendorizada (ya hecho en esta sesión, repetir si se actualiza el vendor).

## 5. Roadmap de esta herramienta (detalle de v2.0, ver `trainmusiq/trainmusiq/roadmap.md` para el panorama completo del ecosistema)

Catálogo completo de features candidatas (banco de ideas, entran cuando su versión las abra — ver roadmap del ecosistema §6 para la versión canónica de esta lista, no duplicar edición):

- **6 stems como default**: guitarra y piano SIEMPRE separados (ahí vive la complejidad armónica de una banda).
- **Detección automática de instrumentos presentes**: elige el modelo correcto y evita "stems vacíos/fugados" — diferenciador directo vs. Moises (que no lo hace).
- **Separación de batería en componentes** (bombo/caja/toms/hi-hat/platillos — candidatos: LarsNet, StemGMD).
- **Presets de uso**: karaoke, rock, pop, electrónica (prioriza componentes de batería + sintes), sinfónico (por familias: cuerdas/vientos/metales — nunca prometer atriles individuales), cine/locución (diálogo/música/efectos).
- **Cambio de tempo programable** sin alterar pitch, por ratio o por BPM destino (requiere beat tracking — motor compartido con chordwagon cuando exista).
- **Loops A-B**, mute/solo por stem, export por stem.
- **Refinamiento de pitch por stem + temperado unificado** (integración directa con el motor de centrail, ver §8 sobre la decisión de cómo compartirlo).

**Regla de oro comunicable (heredada del roadmap):** se separa lo que suena distinto (timbre); lo idéntico no. Horizonte no prometible: instancias del mismo instrumento (guitarra 1 vs. guitarra 2 del mismo tipo).

## 6. Riesgos

- **Tiempo de separación en hardware modesto**: el número de esta sesión (3.49× tiempo real, single-thread) es en una Mac con Apple Silicon — un equipo Windows/Linux de gama baja podría ser sensiblemente más lento. Mitigación: expectativas claras en UI ("puede tardar según tu equipo") + el tier servidor existe precisamente para esto.
- **Memoria en archivos largos**: el prototipo de esta sesión no probó archivos de 5+ minutos completos en WASM (solo clips de 10-30s) — el bug de memoria resizable/OOM encontrado y corregido en esta sesión (ver vendor README) sugiere que el tuning de memoria fija necesita validarse con canciones completas antes del release. Pendiente para la sesión de construcción.
- **demucs.cpp upstream con actividad moderada** (último push dic 2024): si aparece un bug o se necesita una mejora, puede requerir parchear el fork vendorizado directamente en vez de esperar upstream — ya se hizo una vez en esta sesión (el fix de memoria), es un riesgo conocido y manejable, no bloqueante.
- **6-stems vs 4-stems**: el modelo de 6 fuentes no fue probado en esta sesión (se vendorizó y probó el de 4). Verificar antes del release que separa correctamente guitarra/piano y que el tamaño del archivo (~53MB) no rompe el mismo bug de memoria del modelo de 4 fuentes (~84MB) — probablemente no, al ser más chico, pero no asumido sin probar.

## 7. Arquitectura cliente/servidor (fase A) — proyectada completa desde el inicio

**Principio del roadmap del ecosistema, aplicado literalmente:** trackjunction se lanza con dos vías desde el día 1 de su anuncio — cómputo en el equipo del usuario (gratis, tier explicado en §1-§6) **y** servidor GPU on-demand para suscriptores. La fase A (servidor) **se construye al final** de la construcción de trackjunction (después de que el tier cliente esté publicado y validado con uso real — regla madre del ecosistema, no se salta el orden), pero su arquitectura se diseña completa **ahora**, para que construirla no requiera rediseñar nada.

### 7.1 Frontera cliente/servidor

La web estática (GitHub Pages, la misma para ambos tiers) decide en runtime qué camino tomar:

```
Usuario sube archivo
        │
        ▼
  ¿Tiene sesión premium activa? ──No──▶ Tier cliente (§1-§6, ya especificado)
        │ Sí
        ▼
  Tier servidor (esta sección)
```

El frontend nunca implementa lógica de negocio de pagos ni de cola — solo llama a una API REST simple (`POST /separate`, `GET /status/:jobId`, `GET /download/:jobId/:stem`) con un token de sesión. Toda la complejidad vive en el backend.

### 7.2 Flujo del servidor (upload → cola → GPU → descarga → retención cero)

```
1. Cliente:     POST /separate  (audio + token de sesión + modelo elegido)
                     │
2. API:         valida token, valida tamaño/formato, encola job
                     │ (job_id devuelto al cliente de inmediato)
                     ▼
3. Cola:        Redis/similar — job_id, ruta del archivo temporal, estado=queued
                     │
4. Worker GPU:  toma el job de la cola, corre demucs (PyTorch nativo, no WASM —
                el servidor SÍ puede usar el motor Python original sin las
                restricciones de navegador) sobre GPU dedicada
                     │ progreso real reportado a la cola (poll o WebSocket)
                     ▼
5. Resultado:   stems subidos a storage temporal (ej. S3/R2 con expiración
                automática — política de retención cero declarada al usuario)
                     │
6. Cliente:     poll GET /status/:jobId hasta status=done, luego
                GET /download/:jobId/:stem por cada stem (URLs firmadas,
                expiración corta, ej. 1 hora)
                     │
7. Limpieza:    job + archivos borrados del storage tras la expiración
                (automático, no manual) — "retención cero post-descarga"
                declarado como política de privacidad, no solo técnica.
```

**Principio de progreso honesto también en el servidor:** el poll de estado devuelve progreso real (segmento actual / total), igual que el cliente — la promesa de "sin spinners falsos" es transversal, no solo del tier gratis.

### 7.3 Componentes requeridos

| Componente | Responsabilidad | Candidato técnico | Notas |
|---|---|---|---|
| **Auth** | Sesión de usuario, verificación de suscripción activa | Passwordless (magic link) o OAuth (Google/GitHub) — evitar manejo propio de contraseñas | Mínimo de superficie de ataque; el ecosistema no necesita perfiles sociales, solo "¿esta sesión paga o no?" |
| **Pagos** | Suscripción mensual/anual, facturación internacional | **Merchant of Record** (Paddle o Lemon Squeezy) — ya recomendado en el roadmap del ecosistema | Ellos manejan IVA/impuestos internacionales; ideal para un desarrollador individual en Chile con audiencia mayoritariamente internacional |
| **Cola de jobs** | Desacoplar el upload de la disponibilidad de GPU, permitir escalar workers | Redis + una librería de colas simple (BullMQ si el backend es Node, RQ si es Python) | El backend de inferencia (PyTorch) es naturalmente Python — evaluar si el API wrapper es Python (FastAPI) o Node hablando con un worker Python separado |
| **Worker GPU** | Ejecutar la inferencia real | RunPod serverless GPU (empezar aquí, sin CAPEX) o PC propio con GPU + Cloudflare Tunnel (si el volumen lo justifica, decisión ya anotada en el roadmap) | Mismo motor Python `demucs` (PyTorch) usado para medir el benchmark de esta sesión — no hace falta WASM en el servidor, esa restricción es solo del navegador |
| **Storage temporal** | Guardar resultados entre "listo" y "descargado" | S3-compatible (R2 de Cloudflare, sin costo de egress, coherente con "gratis/barato mientras se pueda") | Expiración automática vía lifecycle policy, no borrado manual |
| **Rate limiting / validación de uploads** | Evitar abuso, archivos maliciosos | Límite de tamaño + tipo de archivo en el API, rate limit por sesión | Seguridad "de verdad" empieza acá (§11 del ecosistema) — no subestimar, presupuestar tiempo específico |

### 7.4 Plan de fases

| Fase | Qué incluye | Cuándo se construye |
|---|---|---|
| **Fase 0 (ya, este documento)** | Arquitectura completa proyectada, decisión de Merchant of Record anotada, decisión de motor servidor (PyTorch nativo, no WASM) | Sesión de apertura de etapa (hoy) |
| **Fase cliente (v2.0)** | Tier gratis completo: separación WASM en navegador, refinamiento de pitch por stem, mezclador básico | Próxima(s) sesión(es) — pipeline en el navegador, sin backend |
| **Fase A (v2.5, este documento la deja "construible sin rediseñar")** | Backend completo: auth, pagos, cola, worker GPU, storage — todo lo de §7.2-§7.3 | Después de que v2.0 esté publicado y validado con uso real (regla madre: no se abre/construye lo siguiente sin publicar lo anterior) |

### 7.5 Costo estimado por canción (GPU on-demand)

Basado en el número medido en esta sesión (GPU Apple Silicon: 21 s para una canción real de 2:43) como cota conservadora — un GPU de servidor dedicado (RTX 4090/A10 en RunPod) debería igualar o superar ese tiempo:

- Tiempo estimado de cómputo GPU por canción: **~15-25 s** (incluye margen para overhead de carga de modelo si no está "caliente").
- Tarifa típica de GPU serverless on-demand (RunPod/Vast.ai, gama RTX 4090/A10, jul 2026): **~USD 0.0003-0.0006 por segundo de cómputo**.
- **Costo estimado: USD 0.005-0.015 por canción** (medio centavo a centavo y medio de dólar), consistente con el rango ya anotado en el roadmap del ecosistema (USD 0.01-0.05/canción) — este cálculo lo confirma con un número medido, no solo una intuición.
- A la hipótesis de precio del fundador (USD 3/mes), el costo de cómputo por canción es una fracción mínima del ingreso incluso con uso intensivo (cientos de canciones/mes por usuario) — el modelo económico es viable en el margen de cómputo puro; el resto del costo de servir el tier premium es infraestructura fija (auth, storage, API), no marginal por canción.

**Nota de honestidad:** el número de tarifa de GPU serverless es de mercado general (no cotizado en vivo en esta sesión) — cotizar precios reales de RunPod/Vast.ai es trabajo de la sesión que abra la Fase A, junto con medir tiempo real en un GPU de servidor (no solo extrapolar desde Apple Silicon).

## 8. Decisión: motor de centrail compartido — copia vendorizada vs. repo común

**Decisión: copia vendorizada por ahora, no `trainmusiq/engine` todavía.**

Razones:
- El motor de centrail (`detect.mjs`, `correct.mjs`, `wav.mjs`) es pequeño (unos pocos cientos de líneas) y **el algoritmo de detección está congelado** (regla dura de centrail) — el riesgo de divergencia entre una copia y el original es bajo mientras esa regla se mantenga.
- Un repo común (`trainmusiq/engine`) agrega complejidad real hoy: versionado semántico entre repos, un paso de publish/link adicional, y una superficie más grande para romper cuando trackjunction todavía ni siquiera tiene su pipeline cliente construido. Es exactamente el tipo de abstracción prematura que la regla "actuar mínimo" del ecosistema pide evitar.
- **Revisar esta decisión cuando exista una tercera herramienta** que también necesite el motor de pitch (ej. si chordwagon terminara necesitando temperado) — ahí el costo de NO tener un repo común (tres copias divergiendo) empieza a superar el costo de mantenerlo. Con dos herramientas, vendorizar es más simple y honesto.

**Qué se copiaría exactamente (cuando se construya el pipeline v2.0):** `engine/detect.mjs`, `engine/correct.mjs`, `engine/wav.mjs` de centrail, sin modificar (mismo patrón que vendorizar una dependencia de terceros, aunque sea código propio) — actualizar la copia manualmente si centrail mejora esos archivos, con una nota en ambos CLAUDE.md señalando la duplicación intencional.

## 9. Seguridad

Ver `trainmusiq/trainmusiq/CLAUDE.md` para las reglas transversales (GPL v3, sin CDN externos, vendorizar con versión fijada, Dependabot). Específico de trackjunction:

- **Verificación WASM del motor de separación: hecha en esta sesión** (§2), repetir si se actualiza el vendor.
- **Los pesos del modelo (84 MB) están commiteados directo por ahora** — evaluar Git LFS o GitHub Release asset antes del release público, para no inflar el clone de cada colaborador (ver `vendor/demucs-weights/README.md`).
- **Cuando se construya la Fase A (servidor)**: ahí empieza la seguridad seria — el checklist completo de auth/uploads/pagos/rate-limiting de §7.3 no está implementado, solo diseñado. No subestimar el tiempo al abrir esa fase (regla ya anotada en el ecosistema).

## 10. Arquitectura de rendimiento de la separación — cascada de vías (sesión de reevaluación, 9 jul 2026)

**Motivo de esta sesión:** antes de construir el pipeline v2.0, reevaluar qué palancas de velocidad existen que **no** cuesten calidad, con evidencia medida en este equipo (Apple M1 Max, 10 núcleos, 32 GB RAM, Chrome 149, macOS) — no solo por reputación. Esta sección no reabre la decisión de motor del §2 (demucs.cpp sigue siendo la base universal); añade capas de velocidad sobre esa base y evalúa WebGPU como vía adicional, no como reemplazo.

### 10.0 Principios rectores (inviolables, declarados para esta sesión)

**A. La calidad de separación es sagrada.** Ninguna palanca de esta sección reduce cálculo (sin modelos livianos, sin cuantización con pérdida, sin menos pasadas). Todas las vías usan el modelo de máxima calidad — `htdemucs_ft` (fine-tuned) o la arquitectura Hybrid-Transformer v4 completa sin cuantizar — en todas partes. Las únicas palancas válidas son: repartir el mismo cálculo entre más unidades de ejecución (núcleos, GPU) o vectorizarlo (SIMD), nunca reducirlo.

**B. Transparencia de recursos.** El usuario siempre ve qué motor lo acelera, de qué depende, y si está disponible (ver §10.5 para el copy exacto de cada vía) — mismo principio de progreso honesto ya vigente (regla dura #4).

### 10.1 Resumen de evidencia medida en este equipo

| Palanca | Método de medición | Resultado | Estado |
|---|---|---|---|
| SIMD en WASM | Disassembly de `demucs.wasm` vendorizado (`wabt`, 7471 opcodes `v128`/`i8x16`/etc., 0 menciones thread/atomic) | **Ya incluido** en el build actual — el benchmark de 3.49-3.70x del §2 YA es con SIMD | ✓ confirmado, sin acción pendiente |
| Segment-parallel Web Workers | `worker_threads` de Node, cada uno con su propia instancia WASM, audio real de 5s/segmento | N=2: 1.94x · N=4: 3.35x · N=8: 4.78x (ver 10.3) | ✓ medido con audio real, sin SharedArrayBuffer |
| Warm start (reutilizar modelo entre canciones) | `modelInit` medido por separado de `modelDemixSegment`, dos "canciones" seguidas en el mismo proceso | `modelInit`: 155-273ms · separación 5s: ~18-22s → overhead ≈1.1% del total de una canción | ✓ medido, real pero menor |
| coi-serviceworker (COOP/COEP sin control de servidor) | Servidor estático plano (`python3 -m http.server`, sin headers custom — mismas condiciones que GitHub Pages) + Chrome real | `crossOriginIsolated` pasa de `false` a `true`, `SharedArrayBuffer` queda disponible, tras el reload automático del script | ✓ confirmado empíricamente — pero ver 10.4, no se usa en v2.0 |
| WebGPU disponible en este equipo | `navigator.gpu.requestAdapter()` en Chrome real | Adapter obtenido correctamente | ✓ confirmado (este equipo puede usar la vía WebGPU) |
| Benchmark real de demucs-rs (WebGPU) end-to-end | Se intentó en la demo pública (`nikhilunni.github.io/demucs-rs`) con un clip sintético (no se subió audio real/con copyright a un servicio de terceros) | **Bloqueado por sandbox de la sesión** (no se pudo adjuntar el archivo al `<input type=file>`) | ⚠ no medido — pendiente para la sesión de construcción, con carga manual del usuario |
| Build WASM con pthreads reales (hilos compartidos dentro de una instancia) | Investigación del upstream `sevagh/demucs.cpp` | El propio `src_wasm/CMakeLists.txt` upstream **no tiene flags de pthread** — no existe una base de la que partir, y no hay `emcc`/`emsdk` instalado en este equipo | ⚠ no intentado — ver 10.4, decisión de no perseguirlo por ahora |

### 10.2 Vía WebGPU — demucs-rs

- **Repo:** [nikhilunni/demucs-rs](https://github.com/nikhilunni/demucs-rs) (Rust + Burn). **Licencia: Apache 2.0** — compatible con GPL v3 (permisiva, se puede incorporar código Apache 2.0 en un proyecto GPL v3).
- **Modelos disponibles: `htdemucs` (4 stems), `htdemucs_6s` (6 stems), `htdemucs_ft` (fine-tuned, 333 MB, mejor calidad)** — arquitecturas originales de Meta portadas a Rust, **no cuantizadas**. Para cumplir el principio A, la vía WebGPU debe cargar `htdemucs_ft` (o `htdemucs_6s` cuando se adopte 6-stems), nunca la variante base si hay una de mayor calidad disponible.
- **Verificación de threading (bundle JS de producción, grep directo):** 0 menciones de `SharedArrayBuffer`, `pthread`, `Atomics.` — la paralelización es 100% GPU (WebGPU compute), no requiere COOP/COEP. Confirmado `hasWebgpu: true` en el bundle.
- **Sin fallback a CPU** (ya documentado en §2) — si `navigator.gpu` no existe o `requestAdapter()` devuelve `null`, esta vía no aplica y se cae a 10.3. El frontend debe detectar esto en runtime, nunca asumir.
- **Cobertura de navegadores (refinada esta sesión, jul 2026):** ~82-85% global. El hueco principal ya no es Safari (Safari 26+ lo soporta por defecto) sino **Firefox, que sigue con WebGPU deshabilitado por defecto** a mediados de 2026 — más huecos reales en Android <12 y GPUs sin soporte Vulkan/Metal/D3D12 adecuado.
- **Nota de honestidad:** este equipo SÍ tiene WebGPU funcional (adapter obtenido en Chrome real), pero el benchmark de tiempo real end-to-end de demucs-rs **no se pudo medir en esta sesión** — el sandbox de la herramienta de navegador no permite adjuntar archivos que no fueron compartidos explícitamente por el usuario con la sesión, y no correspondía subir audio real con copyright a un servicio de terceros para una prueba sintética. **Pendiente para la sesión de construcción**: medir con el usuario subiendo un archivo de prueba manualmente.

### 10.3 Vía WASM sin WebGPU — segment-parallel Web Workers (SIMD ya incluido)

**Este es el hallazgo central de la sesión:** el "multi-threading" que de verdad conviene no es hilos compartidos dentro de una instancia WASM (que requeriría COOP/COEP + una reconstrucción no trivial del motor, ver 10.4) sino **N Workers independientes, cada uno con su propia instancia WASM y su propia copia de memoria, procesando un segmento de tiempo distinto de la canción** — exactamente el patrón ya proyectado en §3 ("un Worker por núcleo lógico... sin SharedArrayBuffer en ningún punto"), ahora medido con audio real en vez de asumido.

**Metodología:** `worker_threads` de Node (equivalente a Web Workers del navegador para este propósito — misma ausencia de memoria compartida), cada worker carga el mismo `demucs.wasm`+pesos vendorizados, corre `modelInit` y separa un segmento de 5s de audio real (`5 Pétalo de Sal_440Hz.wav`, cross-repo desde `Centrail/test/private/`, nunca commiteado ni referenciado en código).

| N workers en paralelo | Audio total procesado | Wall time real | Tiempo secuencial equivalente (N × baseline) | Speedup medido |
|---|---|---|---|---|
| 1 (baseline) | 5s | 18.7s | — | 1.0x |
| 2 | 10s | 19.2s | 37.4s | **1.94x** |
| 4 | 20s | 22.3s | 74.7s | **3.35x** |
| 8 | 40s | 31.2s | 149.4s | **4.78x** |

El número de 4.78x a 8 workers **confirma y supera** el 4.5x que el roadmap tenía anotado como "número del mantenedor de demucs.cpp, no medido en este equipo" (§2) — ahora es evidencia propia. La caída de retorno entre N=4 y N=8 es consistente con el hardware: el M1 Max de este equipo tiene 10 núcleos lógicos (8 rendimiento + 2 eficiencia); a 8 workers ya se satura casi toda la capacidad de cómputo real.

**SIMD:** confirmado por disassembly (`wabt`) que el `demucs.wasm` vendorizado actual ya contiene 7471 opcodes SIMD (`v128.*`, `i8x16`, etc.) y cero menciones de threading — el build recipe (`CMakeLists.txt.build-recipe`) ya tenía `-msimd128 -msse4.2` en `CMAKE_CXX_FLAGS_RELEASE` desde que se vendorizó. **No hay una "recompilación con SIMD" pendiente: ya está aplicada**, y el número base de 3.49-3.70x tiempo real del §2 ya la incluye. Recompilar sin SIMD para aislar la ganancia sería el único experimento adicional posible, pero no aporta una decisión nueva (SIMD se queda, sin downside).

**Zero SharedArrayBuffer/COOP/COEP necesarios para esta vía** — funciona en GitHub Pages sin ningún cambio de configuración, hoy mismo.

**Advertencia de calidad (principio A) para la sesión de construcción:** `modelDemixSegment` no hace streaming/chunking interno — trata cada buffer pasado como una unidad completa (§3). Cortar la canción en segmentos de tiempo duros y arbitrarios entre Workers **puede degradar la calidad en los bordes de cada segmento** (el modelo pierde contexto temporal alrededor del corte) si no se implementa con solape (overlap) y crossfade entre segmentos adyacentes — igual que hace el propio Demucs en su chunking nativo. Esto no es opcional bajo el principio A: la implementación real (fuera de alcance de esta sesión) debe usar segmentos con solape suficiente (varios segundos de contexto compartido) y recombinar con crossfade, no un corte seco.

**Warm start (pesos cargados una vez, reutilizados entre canciones):** medido con dos "canciones" seguidas en el mismo proceso — `modelInit` (parseo de 84MB de pesos hacia el modelo) toma 155-273ms, frente a ~18-22s de separación por segmento de 5s → **el overhead de re-inicializar es ≈1.1% del total de una canción real, y cae a fracciones de 1% en una canción completa de minutos**. Es una palanca real pero menor: vale la pena mantener el Worker/modelo vivo entre canciones de una misma sesión (evita pagar ese ~1% N veces), pero no es donde está la ganancia grande — esa es la paralelización por segmentos (arriba). Nota adicional: el `initMs` promedio sube levemente con más workers en paralelo (214ms→230ms→235ms→273ms para N=1,2,4,8) — contención de CPU esperable al inicializar N modelos a la vez, no un problema de fondo.

### 10.4 coi-serviceworker + pthreads reales — investigado, decisión: no perseguir para v2.0

Se confirmó empíricamente (servidor estático plano sin headers custom, mismas condiciones que GitHub Pages) que [gzuidhof/coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT, compatible GPL v3) **sí logra `crossOriginIsolated: true` y `SharedArrayBuffer` disponible** tras el reload automático de primera visita, sin necesitar control de headers del servidor. Esto técnicamente abriría la puerta a un build de `demucs.cpp` con hilos compartidos reales (pthreads de Emscripten) dentro de una sola instancia WASM.

**Pero no se persigue esta vía para v2.0**, por dos razones con evidencia:
1. **No existe una base de la que partir:** el propio `src_wasm/CMakeLists.txt` del upstream `sevagh/demucs.cpp` no tiene ningún flag de pthread (`USE_PTHREADS`, `SHARED_MEMORY`, etc.) — habría que portar Eigen/OpenMP a WASM+pthreads desde cero, algo frágil y no documentado por nadie que lo haya hecho para este proyecto específico. Tampoco hay `emcc`/`emsdk` instalado en este equipo para siquiera empezar a intentarlo esta sesión.
2. **No hace falta:** la vía de 10.3 (Workers independientes por segmento, sin memoria compartida) ya logra un speedup casi lineal (4.78x a 8 workers) con muchísimo menor riesgo de ingeniería y sin tocar el motor vendorizado. El techo real de esta vía coincide con los núcleos disponibles, igual que tendría el pthread real — no hay ganancia adicional obvia que justifique el riesgo.

**Se deja documentado y confirmado como técnicamente viable** por si una sesión futura encuentra un techo real en 10.3 que amerite revisar esto (p.ej. si Eigen ya trae un backend de threading portable a WASM en una versión futura del upstream).

### 10.5 Cascada final de rendimiento (decisión)

Todas las vías cargan **el mismo modelo de máxima calidad** (`htdemucs_ft` o equivalente Hybrid-Transformer v4 sin cuantizar) — la cascada decide *dónde* corre el cálculo, nunca *cuánto* cálculo se hace.

```
¿navigator.gpu existe y requestAdapter() devuelve un adaptador? ──Sí──▶ Vía WebGPU (demucs-rs, htdemucs_ft)
        │ No
        ▼
¿Web Workers disponibles? (prácticamente 100% de navegadores modernos)
        │ Sí ──▶ Vía WASM segment-parallel (N = navigator.hardwareConcurrency workers,
        │         SIMD ya incluido, sin COOP/COEP) — degrada con gracia a N=1 si hardwareConcurrency
        │         no está disponible o reporta 1, misma calidad
        ▼
Tier servidor (§7, pago, para quien quiera velocidad garantizada sin depender del hardware propio)
```

No hay una "vía estándar de un núcleo" separada de la vía WASM: es el mismo código con N=1, degradación automática y transparente, sin perder calidad.

### 10.6 Mensajes de transparencia de recursos (UI, copy definitivo para la sesión de construcción)

Siguiendo la regla de copy (#8: sincero, directo, afectivo, disuasivo no imperativo, detalle técnico secundario):

- **Vía WebGPU:** "Usando la GPU de tu equipo — la vía más rápida." *(detalle expandible: "WebGPU activo, modelo htdemucs_ft, sin reducir calidad.")*
- **Vía WASM multi-núcleo:** "Sin GPU compatible; usando los N núcleos de tu equipo." *(detalle expandible: "Workers en paralelo, mismo modelo que la vía GPU — más lento pero misma calidad de separación. Más rápido con más núcleos.")*
- **Vía WASM single-thread** (degradación automática si N=1): "Procesando en un núcleo — puede tardar. Mismo modelo, misma calidad." *(sin urgencia ni disculpa — informa y sigue.)*
- **Tier servidor (si está activo):** "Procesando en nuestro servidor — minutos se vuelven segundos." *(no se ofrece como "más calidad", solo como velocidad — coherente con §1.)*

### 10.7 % de usuarios estimado por escalón

- **WebGPU (~82-85% de navegadores modernos globalmente, jul 2026)** — pero condicionado a que el usuario tenga un navegador con WebGPU habilitado por defecto (Chrome/Edge/Safari 26+/Opera/Samsung Internet); Firefox (aún deshabilitado por defecto a mediados de 2026) es el hueco más grande hoy, no Safari como se pensaba en el §2 original.
- **WASM segment-parallel (el resto, ~15-18%)** — prácticamente todos con multi-núcleo real hoy en día (hardware de un solo núcleo es marginal en 2026), así que casi nadie cae al single-thread puro salvo casos extremos (dispositivos muy limitados, o `hardwareConcurrency` no expuesto).
- **Tier servidor** — no es parte de esta cascada gratuita, es una elección explícita del usuario (suscripción), independiente del hardware que tenga.

**Nota de honestidad:** el % exacto de Firefox con WebGPU habilitado manualmente (flag) vs. la mayoría con default off no se midió con datos de uso propios — es un estimado de cobertura global de mercado (caniuse.com, jul 2026), no de la audiencia real de trackjunction (que no existe todavía, pre-lanzamiento). Revisar con datos reales cuando haya usuarios.

### 10.8 Confirmación: ninguna vía toca la calidad (principio A)

- **WebGPU:** mismo modelo (`htdemucs_ft`), mismos cálculos, ejecutados en GPU — la GPU no aproxima ni reduce el cómputo, lo paraleliza a nivel de hardware.
- **WASM segment-parallel:** mismo modelo, mismos cálculos exactos, repartidos entre Workers por segmento de tiempo (paralelismo de datos, no de algoritmo) — con la advertencia de overlap/crossfade de 10.3, que es un requisito de implementación para preservar calidad, no una concesión a la velocidad.
- **SIMD:** vectoriza las mismas operaciones aritméticas de punto flotante — ya estaba presente desde el vendorizado original junto con `-ffast-math` (flag preexistente, no introducida en esta sesión), sin cambio de precisión adicional.
- **Warm start:** no toca el cálculo en absoluto, solo evita repetir el parseo de pesos.
- **Ninguna vía usa un modelo reducido, cuantizado con pérdida, ni menos pasadas.** La única variable entre vías es *dónde* y *con cuánta paralelización* corre el mismo cálculo.

### 10.9 Seguridad y GitHub Pages — verificación de esta sesión

- Vía WebGPU (demucs-rs): sin `SharedArrayBuffer`/`pthread`/`Atomics` en el bundle de producción (grep directo confirmado) — no necesita COOP/COEP.
- Vía WASM segment-parallel: sin cambios respecto a la verificación de seguridad ya hecha en §2 (motor vendorizado sin hilos) — Workers independientes no comparten memoria, no necesitan COOP/COEP.
- **No se adopta coi-serviceworker para v2.0** (ver 10.4) — nada nuevo que romper en GitHub Pages ni superficie de ataque adicional (un service worker interceptando todas las requests sí sería una superficie a vigilar si se adoptara en el futuro).
- Nada de lo investigado en esta sesión requiere configuración de servidor ni headers especiales en GitHub Pages.
