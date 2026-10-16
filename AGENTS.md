# AGENTS.md — working conventions for pi-extendedread-plugin

Every change has a model-facing surface (what the tool advertises to the LLM), a user/repo-facing surface (README, SPEC, config), and code. Keep all in sync; this file is the update matrix.

## Layout (one job per file)

```
src/index.ts        registerTool: promptSnippet, description, promptGuidelines, TypeBox parameters
src/readExtended.ts dispatch spine + format maps (IMAGE_DIRECT/CONVERT, AUDIO_*, VIDEO_*)
src/config.ts       config.json types + defaults; userConfigPath()
src/ffmpeg.ts       ffmpeg helpers: convert, crop, dims, probe (parseFfmpegProbe/probeMedia/renderProbeText), ZOOM_UNAVAILABLE_HINT
src/image.ts        processImageBytes (wraps pi's Photon pipeline)
src/region.ts       grid + locate math, renderTiles, validateTileParams, GRID_MAX_CELLS
src/pdf.ts          PDF text/pages/toc/search/image mode (+grid/locate on first page); PdfParams carries all params
src/pptx.ts         PPTX → PDF via @s8fy/pptx-converter, delegates to pdf.ts
src/patch/targets.ts  patch anchors; src/patch/index.ts applies them + /extended-read-patch
test/readExtended.test.ts  unit tests (pure parsers, tile math, routing)
```

Dependency DAG: `ffmpeg → image → region → pdf → pptx → readExtended`. No cycles. New code goes into the module that owns its job; a new concern gets its own file and an entry in SPEC §9.

## Update matrix — change type ⇒ files to touch

| Change | Must update |
| --- | --- |
| Tool param (add/rename/semantics) | `src/index.ts` schema **and** the param's description text; README per-modality tables (`Image reading`, `Video reading`, `PDF reading`) + Metadata probe section when relevant; SPEC §4 tool-definition table, §5 dispatch steps; tests. If semantics change in code: `src/readExtended.ts`/owning module. |
| Dispatch/routing behavior | owning module (usually `readExtended.ts`); SPEC §5 numbered steps verbatim; README rows describing the new behavior; routing tests. |
| New capability/format/modality | format maps in `readExtended.ts`; SPEC §1 goal bullets, §6 format matrix + pipeline subsection, §9 structure if a file is added; README intro capability list + modality table row(s); tests. Move the item out of SPEC §14 (Future work) when implemented. |
| Config knob | `src/config.ts` types+defaults, repo `config.json` **values and `$docs` entries** (self-documenting), SPEC §3 defaults block, README Configuration section; default/parse tests. |
| ffmpeg pipeline (probe/crop/convert) | `src/ffmpeg.ts`; SPEC §6 relevant subsection (+§7 wire format only if serialization changes); live smoke below. |
| grid/locate math or rendering | `src/region.ts` constants + compute functions; model-facing param descriptions in `src/index.ts` and `PdfParams` (state the 49-cell cap, overlap default); README rows for grid/locate (Image + PDF tables); SPEC §247 region-finding bullets; tile-math tests. |
| Pi patch target | `src/patch/targets.ts`; PATCHES.md table; SPEC §8 targets table; sentinel version bump on anchor change; `test/patch.test.ts`. |
| Model-facing text only (guidance) | six `promptGuidelines` bullets in `src/index.ts`; tool description + param descriptions carry mechanics. Do not add a skill — see steering rules below. |

## Canonical facts that must agree everywhere

- Size caps, dpi, maxPagesPerCall, ffmpegTimeoutMs: identical numbers in `src/config.ts` defaults, repo `config.json` values **and** its `$docs` text, SPEC §3 block, README Configuration section.
- `GRID_MAX_CELLS = 49`: `region.ts`, every param description that states the cap (grid and locate share it), SPEC region-finding bullets.
- Patch targets: one table lives in `src/patch/targets.ts`; copies must match in PATCHES.md, SPEC §8, README Pi patches section (same count of targets).
- `ZOOM_UNAVAILABLE_HINT` has a single source (`ffmpeg.ts`); import it, never re-inline the wording.
- Capability summary: README intro list == GitHub repo description == tool description. Update all three when modality support changes.

## After every change — checklist

```bash
npx tsc && npm test          # rebuild dist/ (pi loads from dist/, no restart needed); tests must pass
# cross-check the matrix rows you touched; docs-only commits need this too
git add -A && git commit -m "feat|fix|docs|chore: ..."   # conventional commits, push origin main
npm install                  # when deps change → package-lock.json lands in same/next commit
```

Live smoke for user-visible behavior (probe + region drill-down):

```bash
FF=$(node -p "require('@ffmpeg-installer/ffmpeg').path") && \
  $FF -f lavfi -i testsrc=size=320x240:rate=25:duration=1 -f lavfi -i sine=frequency=440:duration=1 -shortest /tmp/probe-smoke.mp4
# then in a pi session: extendedRead path=/tmp/probe-smoke.mp4 info=true  → expect format/duration/WxH/Audio lines, no media loaded
```

Tests accompany math, parsers and routing changes (node:test fixtures; see `parseFfmpegProbe` fixture strings). Output-shape changes get a live smoke run.

## Model-facing steering rules

Guidance must be unconditional: six short `promptGuidelines` bullets in `src/index.ts`, merged into the system prompt's Guidelines section whenever the tool is active. Mechanics stay in the tool/param descriptions (travel with every request as part of the schema). No shipped skill, no `"skills"` entry in package.json — do not reintroduce one; skills depend on the model choosing to load them. Keep bullets ≤6 and never restate a param's mechanics twice.

## Design constraints

Zero new heavy dependencies by default (bundled ffmpeg + mupdf WASM + Photon only). No CV/ML deps: region finding stays CPU tiling (`grid` for known layouts, `locate` coarse-to-fine with overlap). A detector power mode (CLIP via Transformers.js) is future work — needs explicit opt-in config.

## Git & PR flow

Commits land on `main`. Feature work can branch and merge via PR; `gh` CLI is unavailable here — use the GitHub API (`curl`) with a token from `git credential fill`. New features ship as `feat:`; docs-only follow-ups as `docs:`; lockfile refreshes as `chore:`.
