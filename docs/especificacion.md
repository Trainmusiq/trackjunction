# trackjunction — Especificación del proyecto

**Ecosistema:** trainmusiq (ver `trainmusiq/trainmusiq` — roadmap.md, manual-continuidad.md, brief-diseno.md) · **Herramienta:** trackjunction — el empalme que divide la canción en vías: separación de stems + estudio (mute/solo, tempo, loops)
**Versión:** 0.1 · 9 de julio de 2026 (sesión de apertura de etapa — pasos 1-3 del método, manual-continuidad.md §4: benchmark, prototipo mínimo, esta especificación)
**Autor:** Juanma (Punta Arenas) con Claude
**Estado:** pre-etapa. Benchmark de motor hecho con evidencia propia (§3), prototipo mínimo funcional (§3), spec completa (este documento) incluyendo la arquitectura cliente/servidor proyectada desde el día uno (§7). **No construido todavía**: esta sesión no abre la construcción del pipeline v2.0 (regla del método — spec antes de construir, no a medias).

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
