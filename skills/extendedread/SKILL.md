---
name: extendedread
description: 'Use the extendedRead tool for media files beyond native read: heic/heif/tiff/tga/avif images, audio (wav/mp3/flac/m4a/opus), video (mp4/webm/mkv/mov/avi), PDF, PPTX. Covers region drill-down on large images (zoom, grid, locate tiling) and PDF pagination, TOC, search, and visual page rendering.'
---

# extendedRead

`extendedRead path="file"` returns content blocks the model can perceive: image, audio, video, or text. Native `read` handles plain text plus jpg/png/gif/webp/bmp; use extendedRead for everything else. Media modality is gated by model capabilities in config — if a modality is unsupported, the tool says so instead of failing silently.

## Large images: drill down before concluding

A downscaled full-frame view is readable for layout but NOT for fine detail (small text, faces, product photos). Do not answer from one blurry overview. Drill down with region parameters:

- **zoom='{x,y,w,h}'** — crop + magnify a normalized fraction of the image (0–1). Use when you know roughly where the target is.
- **grid='{rows,cols[,region]}'** — tile into sharp per-cell crops. Each cell carries its exact `zoom={...}` hint. Use for regular layouts: card grids, tables, dashboards. Pick a cell by eye, then zoom with that cell's hint.
- **locate='{rows,cols,overlap[,region]}'** — overlapping tiles (default 4×4, 15% overlap) so targets on tile edges are never split. Use when the target location is unknown. The model picks the tile containing the target; its bbox doubles as the next zoom call.

Workflow: overview → grid/locate to find a region → zoom for the final sharp crop of the exact subject. Cap 49 cells/tiles per call. Works on direct formats, converted formats, and PDF image mode.

## Audio and video

- `extendedRead path="clip.mp3"` — audio block; transcription-capable models hear it.
- `extendedRead path="demo.webm"` — transcoded to mp4 via ffmpeg, delivered as a video block.
- Converted formats (webm/mkv/mov/avi → mp4, wma/aac/ogg → mp3) are transparent: just pass the file.

## PDF

Default mode extracts text from page 1 and reports the total page count. Navigate with `pages`:

- `pages="5-10"`, `pages="3,7,12"` — targeted pages only; never read a long PDF all at once.
- `toc=true` — outline/TOC first when structure is unknown; it maps titles to page refs.
- `search='quarterly revenue'` — locate mentions before opening pages; returns matching pages with context.
- `mode="image"` (+ optional `dpi=300`) — render pages as PNG for charts, diagrams, scans. zoom/grid/locate work here too (first rendered page).

## PPTX

Pass the file directly: converted to PDF in-process, then read via the PDF pipeline. All PDF params apply. The free converter tier adds a cosmetic watermark; text extraction is unaffected.

## Failure handling

- Size cap exceeded or ffmpeg timeout → the tool reports it with the configured limit; do not retry blindly.
- zoom/grid/locate on a modality the model cannot see → hint tells you to switch approach (e.g., read PDF as text).
- Unreadable file → report honestly; check path, extension, and that ffmpeg is available.
