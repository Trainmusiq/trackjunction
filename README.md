# trackjunction

Separación de stems (voz, batería, bajo, resto — guitarra y piano en el modo 6-stems) y mini-estudio (mute/solo, tempo, loops), 100% client-side por defecto. Segunda herramienta del ecosistema [trainmusiq](https://github.com/Trainmusiq), tras [centrail](https://github.com/Trainmusiq/centrail).

**Estado: pre-etapa.** Esta sesión de apertura hizo el benchmark de motor, un prototipo mínimo funcional y la especificación completa — ver [`docs/especificacion.md`](docs/especificacion.md). El pipeline completo (integración a Worker, mezclador, refinamiento de pitch por stem) todavía no está construido.

## Motor

[demucs.cpp](https://github.com/sevagh/demucs.cpp) (MIT) compilado a WebAssembly, vendorizado en `vendor/demucs-cpp-wasm/`. Sin hilos, sin `SharedArrayBuffer` — verificado empíricamente, corre en GitHub Pages sin necesitar headers COOP/COEP. Detalle de la decisión (vs. alternativas con WebGPU) en la especificación, §2-3.

## Probar el prototipo mínimo

```
node test/separate-file.mjs <archivo.wav PCM16> vendor/demucs-weights/ggml-model-htdemucs-4s-f16.bin [segundos]
```

## Licencia

GPL v3 (ver `LICENSE`) — coherente con el motor vendorizado (demucs.cpp es MIT, los pesos del modelo son MIT vía Meta/facebookresearch/demucs).
