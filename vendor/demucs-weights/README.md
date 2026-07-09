# Pesos del modelo Demucs (formato GGML, vendorizados)

`ggml-model-htdemucs-4s-f16.bin` (84 MB) — modelo `htdemucs` (4 fuentes: drums, bass, other, vocals), pre-convertido a formato GGML por [Retrobear/demucs.cpp en HuggingFace](https://huggingface.co/datasets/Retrobear/demucs.cpp), a partir de los pesos originales de [facebookresearch/demucs](https://github.com/facebookresearch/demucs) (Meta, MIT license — repo archivado pero la licencia no caduca).

**Licencia:** MIT (heredada de facebookresearch/demucs). Compatible con GPLv3.

**Pendiente antes de producción (v2.0):** este archivo de 84 MB está commiteado directo por simplicidad del prototipo. Evaluar antes del release: (a) Git LFS, o (b) hospedarlo como asset de un GitHub Release de este mismo repo (self-hosted, no CDN de terceros — cumple §11) y hacer fetch en runtime, para no inflar el clone del repo a cada colaborador. El modelo de 6 fuentes (`htdemucs_6s`, agrega guitarra y piano — default planeado para trackjunction, ver especificacion.md) pesa ~53 MB y se agregaría con el mismo criterio.
