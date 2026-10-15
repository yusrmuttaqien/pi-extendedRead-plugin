/**
 * region.ts — region-finding tools: grid (regular partition) + locate (coarse-to-fine tiling with overlap).
 *
 * Both tools tile a region of an image into sharp per-cell/per-tile crops,
 * each carrying its exact normalized bbox as a ready-to-use zoom hint. The
 * model picks the tile/cell containing its target, then drills in with zoom.
 *
 * Pure math functions (computeGridCells, computeLocateTiles) are I/O-free and
 * unit-testable without ffmpeg.
 */

import type { PluginConfig } from "./config.js";
import { cropRegionToPngWithDims, imageDims } from "./ffmpeg.js";
import { processImageBytes } from "./image.js";

// --- Types ---

export interface GridRegion { x: number; y: number; w: number; h: number }
export interface GridCell { row: number; col: number; bbox: GridRegion }
export interface LocateTile { row: number; col: number; bbox: GridRegion }

/** Cap to keep context bounded (7×7). Larger grids/tile-sets are rejected with a clear message. */
export const GRID_MAX_CELLS = 49;

// --- Grid (v1, computed regular partition) ---

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

// --- Locate (coarse-to-fine tiling with overlap) ---

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

// --- Render (interleaved text+image content blocks) ---

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

/** Shared tile-rendering loop: process each tile's PNG through pi, interleave text label + image block. */
async function renderTiles(
	tiles: { row: number; col: number; bbox: GridRegion; png: Buffer }[],
	label: (t: { row: number; col: number; bbox: GridRegion }) => string,
	summary: string,
): Promise<ContentBlock[]> {
	const blocks: ContentBlock[] = [];
	for (const tile of tiles) {
		const { data, mimeType } = await processImageBytes(tile.png, "image/png");
		blocks.push({ type: "text", text: label(tile) });
		blocks.push({ type: "image", data, mimeType });
	}
	blocks.push({ type: "text", text: summary });
	return blocks;
}

/** Shared validation for grid/locate params. Returns an error block or null if valid. */
function validateTileParams(rows: number, cols: number, prefix: string, noun: string): ContentBlock[] | null {
	if (rows < 1 || cols < 1)
		return [{ type: "text", text: `${prefix}: rows and cols must be >= 1 (got ${rows}×${cols})` }];
	if (rows * cols > GRID_MAX_CELLS)
		return [{ type: "text", text: `${prefix}: ${rows}×${cols} = ${rows * cols} ${noun}s exceeds the ${GRID_MAX_CELLS}-${noun} cap (7×7). Use a smaller ${noun} count or a sub-region.` }];
	return null;
}

/** Render a grid as interleaved text+image content blocks: one sharp thumbnail + zoom hint per cell. */
export async function renderGrid(
	inputPath: string,
	grid: { rows: number; cols: number; region?: GridRegion },
	config: PluginConfig,
): Promise<ContentBlock[]> {
	const region = grid.region ?? { x: 0, y: 0, w: 1, h: 1 };
	const invalid = validateTileParams(grid.rows, grid.cols, "grid", "cell");
	if (invalid) return invalid;
	const cells = await gridRegion(inputPath, region, grid.rows, grid.cols, config.defaults.ffmpegTimeoutMs);
	if (cells.length === 0)
		return [{ type: "text", text: `grid: could not resolve image dimensions — no cells produced` }];
	return renderTiles(
		cells,
		(c) => `cell (row ${c.row}, col ${c.col}) — zoom=${formatZoomHint(c.bbox)}`,
		`Grid: ${grid.rows}×${grid.cols} over region ${formatZoomHint(region)}. Use any cell's zoom={...} above with the zoom param to crop it sharp.`,
	);
}

/** Render a locate tiling as interleaved text+image content blocks: one sharp tile + bbox + zoom hint per tile. */
export async function renderLocate(
	inputPath: string,
	params: { rows?: number; cols?: number; overlap?: number; region?: GridRegion },
	config: PluginConfig,
): Promise<ContentBlock[]> {
	const region = params.region ?? { x: 0, y: 0, w: 1, h: 1 };
	const rows = params.rows ?? 4;
	const cols = params.cols ?? 4;
	const overlap = params.overlap ?? 0.15;

	const invalid = validateTileParams(rows, cols, "locate", "tile");
	if (invalid) return invalid;

	const tiles = await locateRegion(inputPath, region, rows, cols, overlap, config.defaults.ffmpegTimeoutMs);
	if (tiles.length === 0)
		return [{ type: "text", text: `locate: could not resolve image dimensions — no tiles produced` }];

	return renderTiles(
		tiles,
		(t) => `tile (row ${t.row}, col ${t.col}) — bbox ${formatZoomHint(t.bbox)} — To crop: zoom=${formatZoomHint(t.bbox)}`,
		`Locate: ${rows}×${cols} tiles (${Math.round(overlap * 100)}% overlap) over region ${formatZoomHint(region)}. Pick the tile containing your target, then use its zoom={...} to crop sharp. If the target is small within the tile, call locate again on that tile's region for a finer sub-tile.`,
	);
}
