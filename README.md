# pi-extendedread-plugin

Pi extension: `extendedRead` tool for media files (images, audio, video) with native serialization.

Complements pi's native `read` tool (text + basic images) by adding:
- Extended image formats (heic, heif, tiff, tif, tga, avif)
- Audio (wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus)
- Video (mp4, webm, mkv, mov, avi)

## How it works

The model calls `extendedRead` with a file path. The tool:
1. Resolves the path (tilde expansion, relative/absolute).
2. Stats the file and enforces a per-modality size cap.
3. Gates on model capability (from `config.json`).
4. Dispatches by extension:
   - **Images:** in-memory via pi's Photon/resize pipeline (no temp file).
   - **Audio/Video:** ffmpeg → `/tmp` → base64 (converted to png/mp3/mp4 if needed).
5. Returns content blocks (`image`/`audio`/`video`) in the tool result.

pi's `convertMessages` serializes these blocks into the provider payload (`image_url`/`input_audio`/`input_video`). This requires a **patch** to pi's provider bundle, compaction, and type declarations — applied automatically on plugin load.

## Install

```bash
pi install git:https://github.com/yusrmuttaqien/pi-extendedread-plugin
```

## Configuration

Edit `config.json` in the plugin directory:

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
    "ffmpegTimeoutMs": 30000
  }
}
```

The `$docs` key in the file documents every setting.

## Pi patches

The plugin patches three files in pi's install:

| Target | File | Change |
|---|---|---|
| `convertMessages` | `dist/bundle/chunks/openai-completions-*.js` | Audio/video block serialization |
| `compaction` | `dist/core/compaction/compaction.js` | Size estimation for audio/video |
| `types` | `dist/core/extensions/types.d.ts` | `AudioContent`/`VideoContent` types |

Patches are idempotent (sentinel-checked) and versioned. After a pi update, run `/media-patch` to re-apply. See `PATCHES.md` for the maintenance checklist.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## Spec

Full design: [extendedRead-spec.md](https://github.com/yusrmuttaqien/pi-extendedRead-plugin/blob/main/SPEC.md)
