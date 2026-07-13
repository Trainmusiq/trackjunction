# libflacjs (vendored)

Vendored from [libflacjs](https://github.com/mmig/libflac.js) (npm `libflacjs` 5.4.0), unmodified, WASM build minificado (`libflac.min.wasm.js` + `libflac.min.wasm.wasm`).

Copyright (c) 2014-2019 DFKI GmbH. License: MIT (`LICENSE`).

Encoder/decoder de FLAC compilado con Emscripten, single-thread (sin `SharedArrayBuffer`/`pthread`, verificado — ver §11 de la especificación). Usamos solo el **encoder** (`Flac.create_libflac_encoder` / `Flac.FLAC__stream_encoder_*`); el decoder de este mismo archivo no se usa — `@wasm-audio-decoders/flac` (`vendor/wasm-audio-decoders-flac/`) ya cubre la decodificación.

Carga: expone el global `Flac` (patrón UMD/IIFE, funciona como import de efecto secundario en un worker módulo). Requiere fijar `self.FLAC_SCRIPT_LOCATION` **antes** de importarlo (vía `import()` dinámico) para que el `.wasm` se resuelva desde esta carpeta y no desde la URL del script que lo importa.
