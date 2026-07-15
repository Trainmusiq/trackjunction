# trackjunction

**trainmusiq** — separación de stems, honesta sobre su propia calidad. Segunda herramienta del ecosistema [trainmusiq](https://github.com/Trainmusiq), tras [centrail](https://github.com/Trainmusiq/centrail).

**App en vivo:** https://trainmusiq.github.io/trackjunction/

trackjunction separa una canción en pistas (voz, batería, bajo, resto) 100% en tu navegador — pero a diferencia de cualquier otra herramienta del rubro, **medimos y publicamos qué tan exacta es cada vía de separación**, en vez de asumir que "separar en trozos" es gratis en calidad.

## La historia de por qué esto es distinto

Separar una canción completa de varios minutos en el navegador choca con un límite real de memoria del motor (no puede procesar más de ~35-40 segundos de una sola vez). La solución obvia — trocear la canción en pedazos — tiene una trampa: el motor de separación no fue diseñado para eso, y trocear ingenuamente degrada la calidad de forma medible.

En vez de ignorar el problema o esconderlo, lo medimos: comparamos, con evidencia real (no intuición), la separación troceada contra una separación de referencia sin trocear, en decibeles de diferencia — incluso repitiendo la prueba con material "hostil" (batería activa desde el segundo 0, con las costuras del troceo cayendo justo ahí, no en un silencio favorable) y con escucha dirigida sobre esas costuras exactas. El resultado completo — incluyendo un hallazgo que nos hizo descartar una primera solución y construir una mejor — está documentado en [`docs/especificacion.md`](docs/especificacion.md) §11.

**Por eso el selector de modos tiene una etiqueta de calidad medida en cada opción, no una promesa genérica.**

## Qué hace (los 3 modos)

1. **Fragmento** (elegís hasta 34 segundos sobre la forma de onda): el motor procesa el fragmento entero de una sola pasada, sin trocear. **Bit-perfecto garantizado** — no hay nada que medir, porque no hay ningún troceo de por medio.
2. **Canción completa** (4 stems): troceo con descarte de bordes + Workers en paralelo. **Calidad alta, medida y ratificada de oído.** La diferencia medida contra una separación de referencia sin trocear es de ~−50dB (peor caso, incluso con material hostil, batería activa justo en las costuras) — matemáticamente por debajo del umbral de -80dB que sí cumple karaoke, pero confirmado imperceptible en escucha dirigida y localizada sobre esas costuras.
3. **Karaoke / quitar voz** (canción completa): la mezcla original menos el stem de voz. Como la mezcla nunca se toca, la calidad de este modo depende solo de qué tan bien sale el stem de voz — **certificado: −82 a −87dB**, cumple el umbral de -80dB matemáticamente, sin necesitar ratificación de oído. Entrega dos salidas: instrumental y voz aislada.

Cada stem se descarga en WAV o FLAC. Mezclador con mute/solo por pista y reproducción sincronizada.

## Privacidad primero

**Tu audio nunca sale de tu equipo.** Todo corre en tu navegador — decodificar, separar, mezclar, exportar. Sin servidor, sin cuenta, sin subida de archivos.

## El tier servidor (próxima estación, condicionada a demanda real)

Un servidor GPU podría separar canciones completas de forma bit-perfecta en segundos (sin el límite de memoria del navegador). No lo construimos todavía — antes queremos saber si hay demanda real, no suponerla. Por eso hay un botón "canción completa bit-perfecta en segundos — próximamente" que cuenta interés real (sin cookies, sin identificar a nadie). Si el interés sostenido lo justifica, el tier servidor se construye — con un tope de uso justo y sin publicidad de terceros, nunca.

Si te interesa que llegue, dejá tu correo en la cajita de abajo — sin spam, doble confirmación, te borrás cuando quieras.

## Motor y arquitectura

- [demucs.cpp](https://github.com/sevagh/demucs.cpp) (MIT) compilado a WebAssembly, vendorizado en `vendor/demucs-cpp-wasm/` — con un parche propio de normalización externa (ver el README de esa carpeta) para que trocear una canción no cambie el marco de referencia del cálculo.
- Sin hilos, sin `SharedArrayBuffer` — verificado empíricamente, corre en GitHub Pages sin necesitar headers COOP/COEP.
- `workers/` — cada franja de audio se separa en un Worker nuevo, que nunca se reutiliza (evita un bug de no-determinismo del motor, documentado en la spec §11.6).
- Codecs WAV/FLAC vendorizados desde [centrail](https://github.com/Trainmusiq/centrail) (mismo motor, sin modificar).
- Sin build step: HTML/JS/CSS estático, cero dependencias en producción.

Especificación técnica completa, con la metodología y los números reales de cada medición: [`docs/especificacion.md`](docs/especificacion.md).

## Apoya el proyecto

trackjunction es gratis y siempre lo será para lo que corre en tu equipo. Si te sirvió, podés invitarnos un café en [Ko-fi](https://ko-fi.com/trainmusiq) ☕

## Licencia

[GNU GPL v3](LICENSE) — coherente con el motor vendorizado (demucs.cpp y sus pesos son MIT, compatible).

---

# trackjunction (English)

**trainmusiq** — stem separation, honest about its own quality. Second tool in the [trainmusiq](https://github.com/Trainmusiq) ecosystem, after [centrail](https://github.com/Trainmusiq/centrail).

**Live app:** https://trainmusiq.github.io/trackjunction/

trackjunction separates a song into stems (vocals, drums, bass, other) 100% in your browser — but unlike any other tool in this space, **we measure and publish how accurate each separation path actually is**, instead of assuming that "splitting into chunks" is free in terms of quality.

## The story behind why this is different

Separating a full multi-minute song in the browser runs into a real memory limit of the engine (it can't process more than ~35-40 seconds at once). The obvious fix — chunking the song into pieces — has a catch: the separation engine wasn't designed for that, and naive chunking measurably degrades quality.

Instead of ignoring or hiding the problem, we measured it: we compared, with real evidence (not intuition), chunked separation against a non-chunked reference separation, in decibels of difference — including repeating the test with "hostile" material (drums active from second 0, with the chunking seams landing right there instead of in a convenient silence) and directed listening right on those seams. The full result — including a finding that made us discard a first fix and build a better one — is documented in [`docs/especificacion.md`](docs/especificacion.md) §11.

**That's why the mode selector shows a measured quality label on each option, not a generic promise.**

## What it does (the 3 modes)

1. **Fragment** (pick up to 34 seconds on the waveform): the engine processes the whole fragment in a single pass, no chunking. **Bit-perfect guaranteed** — there's nothing to measure, because there's no chunking involved.
2. **Full song** (4 stems): edge-discard chunking + parallel Workers. **High quality, measured and ear-ratified.** The measured difference against a non-chunked reference separation is ~−50dB (worst case, even with hostile material, drums right at the seams) — mathematically below the -80dB bar karaoke meets, but confirmed imperceptible under directed listening right on those seams.
3. **Karaoke / remove vocals** (full song): the original mix minus the vocal stem. Since the mix itself is never touched, this mode's quality depends only on how good the vocal stem is — **certified: −82 to −87dB**, meets the -80dB bar mathematically, no ear ratification needed. Delivers two outputs: instrumental and isolated vocals.

Each stem downloads as WAV or FLAC. Mixer with per-stem mute/solo and synced playback.

## Privacy first

**Your audio never leaves your machine.** Everything runs in your browser — decoding, separating, mixing, exporting. No server, no account, no file upload.

## The server tier (next station, gated by real demand)

A GPU server could separate full songs bit-perfectly in seconds (no browser memory limit). We haven't built it yet — we want to know if there's real demand first, not assume it. That's why there's a "full song bit-perfect in seconds — coming soon" button that counts real interest (no cookies, no identifying anyone). If sustained interest justifies it, the server tier gets built — with a fair usage cap and never third-party ads.

If you want it to happen, drop your email below — no spam, double opt-in, unsubscribe anytime.

## Engine and architecture

- [demucs.cpp](https://github.com/sevagh/demucs.cpp) (MIT) compiled to WebAssembly, vendored in `vendor/demucs-cpp-wasm/` — with our own external-normalization patch (see that folder's README) so that chunking a song doesn't shift the computation's reference frame.
- No threads, no `SharedArrayBuffer` — empirically verified, runs on GitHub Pages with no COOP/COEP headers needed.
- `workers/` — every audio chunk is separated in a fresh Worker, never reused (avoids an engine non-determinism bug, documented in spec §11.6).
- WAV/FLAC codecs vendored from [centrail](https://github.com/Trainmusiq/centrail) (same engine, unmodified).
- No build step: static HTML/JS/CSS, zero production dependencies.

Full technical spec, with the methodology and real numbers behind every measurement: [`docs/especificacion.md`](docs/especificacion.md).

## Support the project

trackjunction is free, always, for whatever runs on your own machine. If it helped you, you can buy us a coffee on [Ko-fi](https://ko-fi.com/trainmusiq) ☕

## License

[GNU GPL v3](LICENSE) — consistent with the vendored engine (demucs.cpp and its weights are MIT, compatible).
