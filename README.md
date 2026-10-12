# pi-extendedread-plugin

Pi extension: `extendedRead` tool for media files (images, audio, video, PDF, PPTX) with native serialization.

Built with [llama.cpp](https://github.com/ggml-org/llama.cpp) for local multimodal inference. Media modality is gated by model capabilities in `config.json` — configure per-model support for images, audio, and video.

Complements pi's native `read` tool (text + basic images) by adding:
- Extended image formats (heic, heif, tiff, tif, tga, avif)
- Audio (wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus)
- Video (mp4, webm, mkv, mov, avi)
- **PDF** (text extraction + visual page rendering, with pagination)
- **PPTX** (converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline)

## How it works

The model calls `extendedRead` with a file path. The tool:
1. Resolves the path (tilde expansion, relative/absolute).
2. Stats the file and enforces a per-modality size cap.
3. Gates on model capability (from `config.json`).
4. Dispatches by extension:
   - **Images:** in-memory via pi's Photon/resize pipeline (no temp file).
   - **Audio/Video:** ffmpeg → `/tmp` → base64 (converted to png/mp3/mp4 if needed).
   - **PDF:** mupdf (WASM) → text extraction or page rendering to PNG.
   - **PPTX:** @s8fy/pptx-converter → PDF → mupdf pipeline (in-process WASM, no system dependency).
5. Returns content blocks (`image`/`audio`/`video`/`text`) in the tool result.

pi's `convertMessages` serializes these blocks into the provider payload (`image_url`/`input_audio`/`input_video`). This requires a **patch** to pi's provider bundle and compaction — applied automatically on plugin load.

## PDF reading

PDFs support two modes:

```
extendedRead path="doc.pdf"                  → text of page 1 + pagination hint
extendedRead path="doc.pdf" pages="5-10"     → text of pages 5-10
extendedRead path="doc.pdf" mode="image"     → PNG of page 1
extendedRead path="doc.pdf" mode="image" pages="3,7"  → PNG of pages 3 and 7
```

- **Text mode** (default): extracts text via mupdf's `toStructuredText`. Lightweight, works with any model.
- **Image mode**: renders pages to PNG at configurable DPI. For visual escalation (charts, diagrams, scanned docs).
- **Pagination**: the `pages` parameter accepts `"1"`, `"1-5"`, `"3,7,12"`. Default is page 1. The response includes total page count so the model can navigate.

## Install

```bash
pi install git:https://github.com/yusrmuttaqien/pi-extendedread-plugin
```

### PPTX support

PPTX files are converted to PDF using `@s8fy/pptx-converter` (in-process WASM engine). No system dependency required.

**Note:** The free (unlicensed) tier adds a demo watermark to PDF output. This is cosmetic and does not affect text extraction or model comprehension.

## Configuration

Config is generated to `~/.pi/agent/extensions/pi-extendedread/config.json` on first run. Edit that file to customize:

```json
{
  "models": {
    "my-av-model": {
      "input": ["text", "image", "audio", "video"],
      "maxBytes": { "video": 104857600 }
    }
  },
  "defaults": {
    "input": ["text", "image"],
    "maxBytes": { "image": 10485760, "audio": 20971520, "video": 52428800 },
    "executionMode": "parallel",
    "ffmpegTimeoutMs": 30000,
    "pdf": {
      "defaultDpi": 150,
      "maxPagesPerCall": 10
    }
  }
}
```

The `$docs` key in the file documents every setting.

## Pi patches

The plugin patches two files in pi's install:

| Target | File | Change |
|---|---|---|
| `convertMessages` | `dist/bundle/chunks/openai-completions-*.js` | Audio/video block serialization |
| `compaction` | `dist/core/compaction/compaction.js` | Size estimation for audio/video |

Patches are idempotent (sentinel-checked) and versioned. After a pi update, run `/extended-read-patch` to re-apply. See `PATCHES.md` for the maintenance checklist.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## Spec

Full design: [SPEC.md](https://github.com/yusrmuttaqien/pi-extendedread-plugin/blob/main/SPEC.md)
