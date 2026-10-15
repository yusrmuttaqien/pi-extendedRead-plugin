/**
 * readExtended.ts — extendedRead tool implementation.
 *
 * Model-invoked tool that reads media files (images, audio, video, PDF) and
 * returns them as content blocks in the tool result. Mirrors the native `read`
 * tool's flow: resolve → stat → size cap → capability gate → dispatch → return.
 *
 * Images: in-memory via pi's processImage (Photon WASM + resize worker).
 * Audio/Video: ffmpeg → /tmp → base64. No resize.
 * PDF: mupdf (WASM) → text extraction or page rendering to PNG.
 */

import { stat, readFile, unlink, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

import { resolvePiRoot } from "./patch/index.js";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import type { PluginConfig } from "./config.js";
import { resolveModelConfig } from "./config.js";

// --- Format maps ---

const IMAGE_DIRECT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

const IMAGE_CONVERT: Record<string, string> = {
	heic: "png",
	heif: "png",
	tiff: "png",
	tif: "png",
	tga: "png",
	avif: "png",
};

const AUDIO_DIRECT: Record<string, string> = {
	wav: "audio/wav",
	mp3: "audio/mpeg",
	flac: "audio/flac",
	ogg: "audio/ogg",
	aiff: "audio/aiff",
	aif: "audio/aiff",
};

const AUDIO_CONVERT: Record<string, string> = {
	m4a: "mp3",
	aac: "mp3",
	wma: "mp3",
	opus: "mp3",
};

const VIDEO_DIRECT: Record<string, string> = {
	mp4: "video/mp4",
};

const VIDEO_CONVERT: Record<string, string> = {
	webm: "mp4",
	mkv: "mp4",
	mov: "mp4",
	avi: "mp4",
};

// --- Helpers ---

function expandTilde(path: string): string {
	return path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
}

function modalityOf(ext: string): "image" | "audio" | "video" | undefined {
	if (ext in IMAGE_DIRECT || ext in IMAGE_CONVERT) return "image";
	if (ext in AUDIO_DIRECT || ext in AUDIO_CONVERT) return "audio";
	if (ext in VIDEO_DIRECT || ext in VIDEO_CONVERT) return "video";
	return undefined;
}

function ffmpegConvert(
	inputPath: string,
	targetExt: string,
	timeoutMs: number,
): Promise<string> {
	const outputPath = join(tmpdir(), `pi-media-${process.pid}-${randomUUID()}.${targetExt}`);
	return new Promise((resolveP, rejectP) => {
		execFile(
			ffmpeg.path,
			["-y", "-i", inputPath, outputPath],
			{ timeout: timeoutMs },
			(err) => {
				if (err) rejectP(err);
				else resolveP(outputPath);
			},
		);
	});
}

/** Promisified execFile returning both streams (callback-style ffmpeg already available). */
function runCmd(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolveP, rejectP) => {
		execFile(binary, args, { timeout: 10_000 }, (err, stdout, stderr) => {
			if (err)
				rejectP(err);
			else
				resolveP({ stdout, stderr });
		});
	});
}

/** Extract an image's pixel dimensions via ffmpeg's probe output. Returns null on any failure (caller falls back to no-zoom). */
async function imageDims(inputPath: string): Promise<{ width: number; height: number } | null> {
	try {
		const { stderr } = await runCmd(ffmpeg.path, ["-hide_banner", "-i", inputPath, "-vframes", "1", "-f", "null", "-"]);
		return parseFfmpegDims(stderr);
	} catch {
		/* fall through to no-zoom */
	}
	return null;
}

/**
 * Parse "WxH" from ffmpeg's probe stderr. Anchored to the "Video:" stream descriptor line:
 * a bare \d+x\d+ also matches ffmpeg's memory pointer (e.g. "[png_pipe @ 0x137808200]"),
 * which appears first when ffmpeg prints the "not enough frames to estimate rate" warning
 * and would otherwise yield width=0 and a spurious null. Returns null if no valid
 * dimensions are present.
 */
export function parseFfmpegDims(stderr: string): { width: number; height: number } | null {
	const m = String(stderr).match(/Video:.*?(\d+)x(\d+)/);
	if (m && +m[1] > 0 && +m[2] > 0)
		return { width: +m[1], height: +m[2] };
	return null;
}

// Appended as a model-visible text block when zoom is requested but cropping fell back to the full frame.
const ZOOM_UNAVAILABLE_HINT = "zoom region unavailable — returning full page";

/** Crop a region of an image raster (any ffmpeg-decodable input) at normalized [x,y,w,h] fractions, returning the cropped PNG bytes. Returns null if dimensions can't be resolved. */
export async function cropRegionToPng(inputPath: string, zoom: { x: number; y: number; w: number; h: number }, timeoutMs: number): Promise<Buffer | null> {
	const dims = await imageDims(inputPath);
	if (!dims)
		return null;
	return cropRegionToPngWithDims(inputPath, zoom, dims, timeoutMs);
}

/** Crop a region given pre-computed pixel dimensions (skips the per-call ffmpeg probe). Returns null on failure. */
export async function cropRegionToPngWithDims(
	inputPath: string,
	zoom: { x: number; y: number; w: number; h: number },
	dims: { width: number; height: number },
	timeoutMs: number,
): Promise<Buffer | null> {
	const W = Math.max(1, Math.round(zoom.w * dims.width));
	const H = Math.max(1, Math.round(zoom.h * dims.height));
	const maxX = Math.max(0, dims.width - W);
	const maxY = Math.max(0, dims.height - H);
	const X = Math.min(Math.floor(zoom.x * dims.width), maxX);
	const Y = Math.min(Math.floor(zoom.y * dims.height), maxY);
	const outPath = join(tmpdir(), `pi-zoom-${process.pid}-${randomUUID()}.png`);
	try {
		await runCmd(ffmpeg.path, ["-y", "-i", inputPath, "-vf", `crop=${W}:${H}:${X}:${Y}`, outPath]);
		return await readFile(outPath);
	} finally {
		await unlink(outPath).catch(() => {});
	}
}

// --- Region-finding: grid (v1, computed regular partition) + locate (coarse-to-fine tiling) ---

export interface GridRegion { x: number; y: number; w: number; h: number }
export interface GridCell { row: number; col: number; bbox: GridRegion }
export interface LocateTile { row: number; col: number; bbox: GridRegion }

/**
 * Compute a regular `rows × cols` partition of a normalized region. Pure — no
 * I/O, so it's unit-testable without ffmpeg. Cell (r,c): x = region.x + c·(region.w/cols),
 * y = region.y + r·(region.h/rows). The model reads "row r, col c" directly from these.
 */
export function computeGridCells(region: GridRegion, rows: number, cols: number): GridCell[] {
	const cellW = region.w / cols;
	const cellH = region.h / rows;
	const cells: GridCell[] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			cells.push({
				row: r,
				col: c,
				bbox: {
					x: region.x + c * cellW,
					y: region.y + r * cellH,
					w: cellW,
					h: cellH,
				},
			});
		}
	}
	return cells;
}

/** Format a bbox as a ready-to-use zoom hint with 3-decimal precision. */
export function formatZoomHint(bbox: GridRegion): string {
	const r = (n: number) => Math.round(n * 1000) / 1000;
	return `{x:${r(bbox.x)},y:${r(bbox.y)},w:${r(bbox.w)},h:${r(bbox.h)}}`;
}

/**
 * Tile a region of an image into a `rows × cols` grid of sharp per-cell crops.
 * Probes dimensions once, then crops each cell at full source resolution, so each
 * cell stays under pi's per-image resize gate and reaches the model sharp.
 */
export async function gridRegion(
	inputPath: string,
	region: GridRegion,
	rows: number,
	cols: number,
	timeoutMs: number,
): Promise<(GridCell & { png: Buffer })[]> {
	const dims = await imageDims(inputPath);
	if (!dims)
		return [];
	const cells = computeGridCells(region, rows, cols);
	const out: (GridCell & { png: Buffer })[] = [];
	for (const cell of cells) {
		const png = await cropRegionToPngWithDims(inputPath, cell.bbox, dims, timeoutMs);
		if (png)
			out.push({ ...cell, png });
	}
	return out;
}

/** Cap to keep context bounded (7×7). Larger grids/tile-sets are rejected with a clear message. */
const GRID_MAX_CELLS = 49;

// --- Region-finding: locate (coarse-to-fine tiling with overlap) ---

/**
 * Compute a `rows × cols` tiling of a normalized region with overlap between
 * adjacent tiles. Unlike a regular grid partition, each tile extends into its
 * neighbor by `overlap` fraction of the base tile size, so a target near a
 * tile boundary is fully inside at least one tile.
 *
 * Tile (r,c) starts at (region.x + c·baseW, region.y + r·baseH) and has
 * dimensions baseW·(1+overlap) × baseH·(1+overlap), clamped to the region
 * boundary. Pure — no I/O, unit-testable without ffmpeg.
 */
export function computeLocateTiles(
	region: GridRegion,
	rows: number,
	cols: number,
	overlap: number,
): LocateTile[] {
	const baseW = region.w / cols;
	const baseH = region.h / rows;
	const tileW = baseW * (1 + overlap);
	const tileH = baseH * (1 + overlap);
	const tiles: LocateTile[] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const x = region.x + c * baseW;
			const y = region.y + r * baseH;
			const w = Math.min(tileW, region.x + region.w - x);
			const h = Math.min(tileH, region.y + region.h - y);
			tiles.push({ row: r, col: c, bbox: { x, y, w, h } });
		}
	}
	return tiles;
}

/**
 * Tile a region of an image into a `rows × cols` set of sharp per-tile crops
 * with overlap. Probes dimensions once, then crops each tile at full source
 * resolution, so each tile stays under pi's per-image resize gate and reaches
 * the model sharp.
 */
export async function locateRegion(
	inputPath: string,
	region: GridRegion,
	rows: number,
	cols: number,
	overlap: number,
	timeoutMs: number,
): Promise<(LocateTile & { png: Buffer })[]> {
	const dims = await imageDims(inputPath);
	if (!dims)
		return [];
	const tiles = computeLocateTiles(region, rows, cols, overlap);
	const out: (LocateTile & { png: Buffer })[] = [];
	for (const tile of tiles) {
		const png = await cropRegionToPngWithDims(inputPath, tile.bbox, dims, timeoutMs);
		if (png)
			out.push({ ...tile, png });
	}
	return out;
}

/** Render a locate tiling as interleaved text+image content blocks: one sharp tile + bbox + zoom hint per tile. */
async function renderLocate(
	inputPath: string,
	params: { rows?: number; cols?: number; overlap?: number; region?: GridRegion },
	config: PluginConfig,
): Promise<AgentToolResult["content"]> {
	const region = params.region ?? { x: 0, y: 0, w: 1, h: 1 };
	const rows = params.rows ?? 4;
	const cols = params.cols ?? 4;
	const overlap = params.overlap ?? 0.15;

	if (rows < 1 || cols < 1)
		return [{ type: "text", text: `locate: rows and cols must be >= 1 (got ${rows}×${cols})` }];
	if (rows * cols > GRID_MAX_CELLS)
		return [{ type: "text", text: `locate: ${rows}×${cols} = ${rows * cols} tiles exceeds the ${GRID_MAX_CELLS}-tile cap (7×7). Use a smaller tile count or a sub-region.` }];

	const tiles = await locateRegion(inputPath, region, rows, cols, overlap, config.defaults.ffmpegTimeoutMs);
	if (tiles.length === 0)
		return [{ type: "text", text: `locate: could not resolve image dimensions — no tiles produced` }];

	const blocks: AgentToolResult["content"] = [];
	for (const tile of tiles) {
		const { data, mimeType } = await processImageBytes(tile.png, "image/png");
		blocks.push({ type: "text", text: `tile (row ${tile.row}, col ${tile.col}) — bbox ${formatZoomHint(tile.bbox)} — To crop: zoom=${formatZoomHint(tile.bbox)}` });
		blocks.push({ type: "image", data, mimeType });
	}
	blocks.push({
		type: "text",
		text: `Locate: ${rows}×${cols} tiles (${Math.round(overlap * 100)}% overlap) over region ${formatZoomHint(region)}. Pick the tile containing your target, then use its zoom={...} to crop sharp. If the target is small within the tile, call locate again on that tile's region for a finer sub-tile.`,
	});
	return blocks;
}

/** Render a grid as interleaved text+image content blocks: one sharp thumbnail + zoom hint per cell. */
async function renderGrid(
	inputPath: string,
	grid: { rows: number; cols: number; region?: GridRegion },
	config: PluginConfig,
): Promise<AgentToolResult["content"]> {
	const region = grid.region ?? { x: 0, y: 0, w: 1, h: 1 };
	if (grid.rows < 1 || grid.cols < 1)
		return [{ type: "text", text: `grid: rows and cols must be >= 1 (got ${grid.rows}×${grid.cols})` }];
	if (grid.rows * grid.cols > GRID_MAX_CELLS)
		return [{ type: "text", text: `grid: ${grid.rows}×${grid.cols} = ${grid.rows * grid.cols} cells exceeds the ${GRID_MAX_CELLS}-cell cap (7×7). Use a smaller grid or a sub-region.` }];
	const cells = await gridRegion(inputPath, region, grid.rows, grid.cols, config.defaults.ffmpegTimeoutMs);
	if (cells.length === 0)
		return [{ type: "text", text: `grid: could not resolve image dimensions — no cells produced` }];
	const blocks: AgentToolResult["content"] = [];
	for (const cell of cells) {
		const { data, mimeType } = await processImageBytes(cell.png, "image/png");
		blocks.push({ type: "text", text: `cell (row ${cell.row}, col ${cell.col}) — zoom=${formatZoomHint(cell.bbox)}` });
		blocks.push({ type: "image", data, mimeType });
	}
	blocks.push({
		type: "text",
		text: `Grid: ${grid.rows}×${grid.cols} over region ${formatZoomHint(region)}. Use any cell's zoom={...} above with the zoom param to crop it sharp.`,
	});
	return blocks;
}

// --- Main ---

export interface ExtendedReadParams {
	path: string;
	pages?: string;
	mode?: "text" | "image";
	/** PDF: return table of contents/outline. */
	toc?: boolean;
	/** PDF: search for text (case-insensitive). Returns matching pages with context. */
	search?: string;
	/** PDF: DPI for image mode (overrides config default). Range: 72–600. */
	dpi?: number;
	/** Crop + scale a rectangular region on any image — direct formats (png,jpg,gif,webp,bmp), converted formats (heic,tiff,tif,avif,...) and PDF image mode. Normalized [x,y,w,h] fractions 0–1 of the bounding box; omit for full frame. */
	zoom?: { x: number; y: number; w: number; h: number };
	/** Tile a region into a regular rows×cols grid of sharp per-cell crops, each with its exact normalized bbox + a ready-to-use zoom hint. */
	grid?: { rows: number; cols: number; region?: { x: number; y: number; w: number; h: number } };
	/** Coarse-to-fine tiling with overlap: tile a region into rows×cols sharp tiles, each extended into its neighbor by `overlap` fraction so targets on tile boundaries are fully inside at least one tile. */
	locate?: { rows?: number; cols?: number; overlap?: number; region?: { x: number; y: number; w: number; h: number } };
}

export interface ExtendedReadContext {
	cwd: string;
	modelId: string;
}

export interface AgentToolResult {
	content: { type: string; text?: string; data?: string; mimeType?: string }[];
	details?: unknown;
	isError?: boolean;
}

export async function readExtended(
	params: ExtendedReadParams,
	ctx: ExtendedReadContext,
	config: PluginConfig,
): Promise<AgentToolResult> {
	// 1. Resolve
	const path = resolve(ctx.cwd, expandTilde(params.path));

	// 2. Stat
	let size: number;
	try {
		const s = await stat(path);
		if (!s.isFile())
			return {
				content: [{ type: "text", text: `Not a file: ${path}` }],
				isError: true,
			};
		size = s.size;
	} catch {
		return {
			content: [{ type: "text", text: `File not found: ${path}` }],
			isError: true,
		};
	}

	// 3. Size cap (per-modality)
	const ext = extname(path).toLowerCase().slice(1);
	const modality = modalityOf(ext);
	const modelCfg = resolveModelConfig(config, ctx.modelId);
	if (modality && size > modelCfg.maxBytes[modality]) {
		return {
			content: [
				{
					type: "text",
					text: `File too large (${size} > ${modelCfg.maxBytes[modality]} bytes for ${modality})`,
				},
			],
		};
	}

	// 4. Capability gate
	const input = modelCfg.input;

	// 5. Dispatch
	// --- Image direct ---
	if (ext in IMAGE_DIRECT) {
		if (!input.includes("image"))
			return {
				content: [{ type: "text", text: "Model does not support images" }],
			};
		if (params.grid)
			return { content: await renderGrid(path, params.grid, config) };
		if (params.locate)
			return { content: await renderLocate(path, params.locate, config) };
		let bytes: Buffer = await readFile(path);
		let mime = IMAGE_DIRECT[ext];
		const zoomHints: string[] = [];
		if (params.zoom) {
			const cropped = await cropRegionToPng(path, params.zoom, config.defaults.ffmpegTimeoutMs);
			if (cropped) {
				bytes = cropped;
				mime = "image/png";
			} else {
				zoomHints.push(ZOOM_UNAVAILABLE_HINT);
			}
		}
		const { data, mimeType } = await processImageBytes(bytes, mime);
		return {
			content: [
				{ type: "text", text: `Read image [${mimeType}]` },
				...zoomHints.map((h) => ({ type: "text" as const, text: h })),
				{ type: "image", data, mimeType },
			],
		};
	}

	// --- Image convertible ---
	if (ext in IMAGE_CONVERT) {
		if (!input.includes("image"))
			return {
				content: [{ type: "text", text: "Model does not support images" }],
			};
		const tmp = await ffmpegConvert(path, "png", config.defaults.ffmpegTimeoutMs);
		try {
			if (params.grid)
				return { content: await renderGrid(tmp, params.grid, config) };
			if (params.locate)
				return { content: await renderLocate(tmp, params.locate, config) };
			let bytes: Buffer = await readFile(tmp);
			const zoomHints: string[] = [];
			if (params.zoom) {
				const cropped = await cropRegionToPng(tmp, params.zoom, config.defaults.ffmpegTimeoutMs);
				if (cropped) {
					bytes = cropped;
				} else {
					zoomHints.push(ZOOM_UNAVAILABLE_HINT);
				}
			}
			const { data, mimeType } = await processImageBytes(bytes, "image/png");
			return {
				content: [
					{ type: "text", text: `Read image [${mimeType}]` },
					...zoomHints.map((h) => ({ type: "text" as const, text: h })),
					{ type: "image", data, mimeType },
				],
			};
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}

	// --- Audio direct ---
	if (ext in AUDIO_DIRECT) {
		if (!input.includes("audio"))
			return {
				content: [{ type: "text", text: "Model does not support audio" }],
			};
		const b64 = (await readFile(path)).toString("base64");
		return {
			content: [
				{ type: "text", text: `Read audio [${AUDIO_DIRECT[ext]}]` },
				{ type: "audio", data: b64, mimeType: AUDIO_DIRECT[ext] },
			],
		};
	}

	// --- Audio convertible ---
	if (ext in AUDIO_CONVERT) {
		if (!input.includes("audio"))
			return {
				content: [{ type: "text", text: "Model does not support audio" }],
			};
		const tmp = await ffmpegConvert(path, "mp3", config.defaults.ffmpegTimeoutMs);
		try {
			const b64 = (await readFile(tmp)).toString("base64");
			return {
				content: [
					{ type: "text", text: "Read audio [audio/mpeg]" },
					{ type: "audio", data: b64, mimeType: "audio/mpeg" },
				],
			};
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}

	// --- Video direct ---
	if (ext in VIDEO_DIRECT) {
		if (!input.includes("video"))
			return {
				content: [{ type: "text", text: "Model does not support video" }],
			};
		const b64 = (await readFile(path)).toString("base64");
		return {
			content: [
				{ type: "text", text: `Read video [${VIDEO_DIRECT[ext]}]` },
				{ type: "video", data: b64, mimeType: VIDEO_DIRECT[ext] },
			],
		};
	}

	// --- Video convertible ---
	if (ext in VIDEO_CONVERT) {
		if (!input.includes("video"))
			return {
				content: [{ type: "text", text: "Model does not support video" }],
			};
		const tmp = await ffmpegConvert(path, "mp4", config.defaults.ffmpegTimeoutMs);
		try {
			const b64 = (await readFile(tmp)).toString("base64");
			return {
				content: [
					{ type: "text", text: "Read video [video/mp4]" },
					{ type: "video", data: b64, mimeType: "video/mp4" },
				],
			};
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}

	// --- PDF ---
	if (ext === "pdf") {
		return readPdf(path, params, config, input);
	}

	// --- PPTX (convert to PDF via @s8fy/pptx-converter) ---
	if (ext === "pptx") {
		return readPptx(path, params, config, input);
	}

	// --- Unsupported ---
	return {
		content: [{ type: "text", text: `[extendedRead: unsupported format ${ext}]` }],
	};
}

// --- PDF handling (mupdf WASM) ---

async function readPdf(
	path: string,
	params: ExtendedReadParams,
	config: PluginConfig,
	input: string[],
): Promise<AgentToolResult> {
	const mupdf = await import("mupdf") as any;
	const buffer = await readFile(path);
	const doc = mupdf.Document.openDocument(buffer, "application/pdf");
	try {
		const totalPages = doc.countPages();
		const maxPages = config.defaults.pdf?.maxPagesPerCall ?? 10;
		let pageIndices = parsePageSelector(params.pages ?? "1", totalPages);
		if (pageIndices.length > maxPages) {
			pageIndices = pageIndices.slice(0, maxPages);
		}
		const mode = params.mode ?? "text";
		const dpi = params.dpi ?? config.defaults.pdf?.defaultDpi ?? 150;

		// --- TOC mode ---
		if (params.toc) {
			return readPdfToc(doc);
		}

		// --- Search mode ---
		if (params.search) {
			return readPdfSearch(doc, params.search, pageIndices, totalPages);
		}

		if (mode === "image" && !input.includes("image")) {
			return {
				content: [{ type: "text", text: "Model does not support images (required for PDF image mode)" }],
			};
		}

		const blocks: { type: string; text?: string; data?: string; mimeType?: string }[] = [];

		if (mode === "text") {
			// Text extraction
			for (const i of pageIndices) {
				const page = doc.loadPage(i);
				try {
					const stext = page.toStructuredText("preserve-whitespace");
					const text = stext.asText();
					stext.destroy();
					if (text.trim().length === 0) {
						blocks.push({ type: "text", text: `--- Page ${i + 1} ---\n[no text on this page — use mode='image' to view]` });
					} else {
						blocks.push({ type: "text", text: `--- Page ${i + 1} ---\n${text}` });
					}
				} finally {
					page.destroy();
				}
			}
			blocks.push({
				type: "text",
				text: `PDF: ${totalPages} pages. Read pages ${pageIndices.map((i) => i + 1).join(",")}. Use pages='N-M' for more, mode='image' to view visually, toc=true for outline, search='query' to find text.`,
			});
		} else {
			// Image rendering
			for (const i of pageIndices) {
				const page = doc.loadPage(i);
				try {
					const pixmap = page.toPixmap(
						mupdf.Matrix.scale(dpi / 72, dpi / 72),
						mupdf.ColorSpace.DeviceRGB,
					);
					try {
						const png = Buffer.from(pixmap.asPNG());
						blocks.push({
							type: "text",
							text: `PDF page ${i + 1} of ${totalPages} (${dpi} DPI)`,
						});
						if (params.zoom) {
							try {
								const tmpInput = join(tmpdir(), `pi-pdf-${process.pid}-${randomUUID()}.png`);
								await writeFile(tmpInput, png);
								const cropped = await cropRegionToPng(tmpInput, params.zoom, config.defaults.ffmpegTimeoutMs);
								await unlink(tmpInput).catch(() => {});
								if (cropped) {
									blocks.push({ type: "image", data: cropped.toString("base64"), mimeType: "image/png" });
								} else {
									blocks.push({ type: "text", text: ZOOM_UNAVAILABLE_HINT });
									blocks.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
								}
							} catch (e) {
								console.warn("[extendedRead] PDF crop failed, using full page:", e);
								blocks.push({ type: "text", text: ZOOM_UNAVAILABLE_HINT });
								blocks.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
							}
						} else {
							blocks.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
						}
					} finally {
						pixmap.destroy();
					}
				} finally {
					page.destroy();
				}
			}
			blocks.push({
				type: "text",
				text: `PDF: ${totalPages} pages. Read pages ${pageIndices.map((i) => i + 1).join(",")} at ${dpi} DPI. Use pages='N-M' for more, dpi=N to change resolution.`,
			});
		}

		return { content: blocks };
	} finally {
		doc.destroy();
	}
}

/** Extract and format the PDF outline/TOC. */
function readPdfToc(doc: any): AgentToolResult {
	const outline = doc.loadOutline();
	if (!outline || outline.length === 0) {
		return {
			content: [{ type: "text", text: "PDF has no table of contents/outline." }],
		};
	}
	const lines: string[] = ["PDF Outline:"];
	function walk(items: any[], depth: number) {
		for (const item of items) {
			const indent = "\t".repeat(depth);
			const pageRef = item.page != null ? ` [p.${item.page + 1}]` : "";
			lines.push(`${indent}- ${item.title ?? "(untitled)"}${pageRef}`);
			if (item.down && item.down.length > 0) {
				walk(item.down, depth + 1);
			}
		}
	}
	walk(outline, 0);
	lines.push("");
	lines.push("Use pages='N' to read a specific page, search='query' to find text.");
	return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** Search PDF pages for text, return matching pages with context. */
function readPdfSearch(
	doc: any,
	needle: string,
	pageIndices: number[],
	totalPages: number,
): AgentToolResult {
	const blocks: { type: string; text?: string }[] = [];
	let totalHits = 0;

	for (const i of pageIndices) {
		const page = doc.loadPage(i);
		try {
			const hits = page.search(needle);
			if (hits && hits.length > 0) {
				totalHits += hits.length;
				// Get surrounding context from structured text
				const stext = page.toStructuredText("preserve-whitespace");
				const text = stext.asText();
				stext.destroy();
				// Find the needle in text (case-insensitive) for context
				const lowerText = text.toLowerCase();
				const lowerNeedle = needle.toLowerCase();
				const idx = lowerText.indexOf(lowerNeedle);
				let context: string;
				if (idx >= 0) {
					const start = Math.max(0, idx - 60);
					const end = Math.min(text.length, idx + needle.length + 60);
					context = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
				} else {
					context = text.slice(0, 120) + (text.length > 120 ? "…" : "");
				}
				blocks.push({
					type: "text",
					text: `--- Page ${i + 1} (${hits.length} hit${hits.length === 1 ? "" : "s"}) ---\n${context}`,
				});
			}
		} finally {
			page.destroy();
		}
	}

	if (totalHits === 0) {
		blocks.push({
			type: "text",
			text: `No matches for "${needle}" in pages ${pageIndices.map((i) => i + 1).join(",")}.`,
		});
	} else {
		blocks.push({
			type: "text",
			text: `Search "${needle}": ${totalHits} hit${totalHits === 1 ? "" : "s"} across ${pageIndices.length} page${pageIndices.length === 1 ? "" : "s"}. Use pages='N' to read full page content.`,
		});
	}

	return { content: blocks };
}

/** Parse a page selector like "1", "1-5", "3,7,12" into zero-based indices. */
function parsePageSelector(selector: string, totalPages: number): number[] {
	const indices: number[] = [];
	for (const part of selector.split(",")) {
		const trimmed = part.trim();
		if (trimmed.includes("-")) {
			const [start, end] = trimmed.split("-").map((s) => parseInt(s, 10) - 1);
			for (let i = Math.max(0, start); i < Math.min(totalPages - 1, end); i++) {
				indices.push(i);
			}
		} else {
			const i = parseInt(trimmed, 10) - 1;
			if (i >= 0 && i < totalPages) indices.push(i);
		}
	}
	// Deduplicate and sort
	return [...new Set(indices)].sort((a, b) => a - b);
}

// --- PPTX handling (convert to PDF via @s8fy/pptx-converter, then use PDF pipeline) ---

async function readPptx(
	path: string,
	params: ExtendedReadParams,
	config: PluginConfig,
	input: string[],
): Promise<AgentToolResult> {
	const { pptxToPdf } = await import("@s8fy/pptx-converter");
	try {
		const pptxBuffer = await readFile(path);
		const result = await pptxToPdf(pptxBuffer);
		// Write PDF to temp file for readPdf
		const tmpDir = await mkdtemp(join(tmpdir(), "pi-pptx-"));
		const pdfPath = join(tmpDir, "converted.pdf");
		await writeFile(pdfPath, result.data);
		try {
			return await readPdf(pdfPath, params, config, input);
		} finally {
			await rm(tmpDir, { recursive: true }).catch(() => {});
		}
	} catch (e: any) {
		return {
			content: [
				{
					type: "text",
					text: `[extendedRead: PPTX conversion failed: ${e.message}]`,
				},
			],
		};
	}
}

// --- Image processing (in-memory, no /tmp) ---
// Reuses pi's processImage pipeline (Photon WASM + resize worker).
// Imported lazily to avoid hard dependency at module load.

async function processImageBytes(
	bytes: Buffer,
	mimeType: string,
): Promise<{ data: string; mimeType: string; hints?: string[] }> {
	// pi's processImage: normalize (Photon) → resize (worker) → base64
	// Returns { ok: true, data, mimeType, hints } or { ok: false, message }.
	// Use absolute path from pi's install root (not a package name —
	// the plugin's node_modules doesn't have pi as a dependency).
	const piRoot = resolvePiRoot();
	const { processImage } = await import(
		join(piRoot, "dist/utils/image-process.js")
	) as any;
	const result = await processImage(bytes, mimeType, {
		autoResizeImages: true,
	});
	if (!result.ok) {
		throw new Error(result.message ?? "Image processing failed");
	}
	return { data: result.data, mimeType: result.mimeType, hints: result.hints };
}
