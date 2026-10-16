/**
 * index.ts — plugin entry point.
 *
 * Registers the extendedRead tool and applies pi patches on activation.
 * Exposes slash commands:
 *   /extended-read-patch — re-apply pi patches (after pi updates)
 *   /extended-read-config — regenerate config.json (backs up existing as .1, .2, …)

 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, executionMode } from "./config.js";
import { readExtended } from "./readExtended.js";
import { applyPatches, resolvePiRoot, piVersion } from "./patch/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, ".."); // src/ → plugin root

export default function activate(pi: ExtensionAPI) {
	const config = loadConfig(pluginDir);

	// Apply patches on load (idempotent).
	const piRoot = resolvePiRoot();
	const results = applyPatches(piRoot);
	const version = piVersion(piRoot);
	for (const r of results) {
		if (r.status === "patched") {
			console.log(`[pi-extendedread] patched: ${r.id} (pi v${version})`);
		} else if (r.status === "not-found") {
			console.warn(`[pi-extendedread] WARNING: ${r.message}`);
		}
	}

	// Register the tool.
	pi.registerTool({
		name: "extendedRead",
		label: "Extended Read",
		description:
			"Read a media file and return it as an attachment the model can perceive. " +
			"Images: png, jpg, jpeg, gif, webp, bmp, heic, heif, tiff, tif, tga, avif. " +
			"Audio: wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus. " +
			"Video: mp4, webm, mkv, mov, avi. " +
			"PDF: text extraction (default) or page rendering to image. Use pages='1-5' for pagination, toc=true for outline, search='query' to find text, dpi=N for resolution, zoom='{x,y,w,h}' to crop+scale a rectangular region on any image — direct or converted formats and PDF image mode. grid={rows,cols[,region]} tiles a region into a regular grid of sharp per-cell crops, each with its exact zoom={...} hint — use it to pinpoint a cell/subject in a large image whose full-page view is too downscaled to read. locate={rows,cols[,region,overlap]} does coarse-to-fine tiling with overlap: the tool tiles a region into overlapping tiles, the model picks the tile containing the target, then drills in with zoom. " +
			"Probe mode: info=true returns metadata only (size, duration, dimensions, audio streams) for image/audio/video without loading media — a first look on large video/audio; no ad-hoc ffprobe script needed. " +
			"PPTX: converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline. " +
			"For text files, use the native read tool.",
		promptSnippet: "Read media files",
		promptGuidelines: [
			"Use extendedRead to read media files (images, audio, video, PDF) the user references.",
			"Do not write ad-hoc scripts for actions the tool already provides: probe with info=true instead of parsing ffprobe/ffmpeg output, zoom/grid/locate for image regions, pages/toc/search for PDF navigation.",
			"For large images, drill down with zoom/grid/locate before answering from a downscaled full-frame view; every grid/locate result carries its next zoom hint.",
			"Never read a long PDF all at once: toc=true when structure is unknown, search='query' to locate mentions, pages='5-10' for targeted pages, mode='image' (+dpi) for charts and scans.",
			"Probe large video/audio with info=true first; drop info=true to load the file itself. Files over maxBytes return a size note — do not retry blindly.",
			"Use the native read tool for text files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file (relative, absolute, or ~)" }),
			pages: Type.Optional(Type.String({ description: "Page selector for PDFs: '1', '1-5', '3,7,12' (default: '1')" })),
			mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image")], { description: "PDF mode: 'text' (default) or 'image'" })),
			toc: Type.Optional(Type.Boolean({ description: "PDF: return table of contents/outline" })),
			search: Type.Optional(Type.String({ description: "PDF: search for text (case-insensitive), returns matching pages with context" })),
			dpi: Type.Optional(Type.Number({ description: "PDF: DPI for image mode (72-600, default from config)" })),
			info: Type.Optional(Type.Boolean({ description: "Metadata-only first look on ffmpeg-decodable media (image/audio/video): size, duration, dimensions, video codec, audio streams. No media loaded; use before deciding how to load a large file. No ad-hoc ffprobe script needed." })),
			zoom: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }, { description: "Crop + scale a rectangular region on any image — direct formats (png,jpg,gif,webp,bmp), converted formats (heic,tiff,tif,avif,...) and PDF image mode. Normalized [x,y,w,h] fractions 0–1 of the bounding box; omit for full frame." })),
			grid: Type.Optional(Type.Object({
				rows: Type.Number({ description: "Number of rows (>= 1)" }),
				cols: Type.Number({ description: "Number of columns (>= 1)" }),
				region: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }, { description: "Normalized [x,y,w,h] region to tile (default: full frame)" })),
			}, { description: "Tile a region of an image into a regular rows×cols grid of sharp per-cell crops, each returned with its exact normalized bbox + a ready-to-use zoom={...} hint. Works on direct formats (png,jpg,gif,webp,bmp), converted formats (heic,tiff,tif,avif,...) and PDF image mode. Use when you need a specific cell/region in a large image and the full-page view is too downscaled to identify it. Cap: 49 cells (7×7)." })),
			locate: Type.Optional(Type.Object({
				rows: Type.Optional(Type.Number({ description: "Number of tile rows (default 4)" })),
				cols: Type.Optional(Type.Number({ description: "Number of tile columns (default 4)" })),
				overlap: Type.Optional(Type.Number({ description: "Overlap fraction between adjacent tiles (default 0.15, range 0–0.5)" })),
				region: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }, { description: "Normalized [x,y,w,h] region to tile (default: full frame)" })),
			}, { description: "Coarse-to-fine tiling with overlap: tile a region into rows×cols sharp tiles, each extended into its neighbor by `overlap` fraction so targets on tile boundaries are fully inside at least one tile. Works on direct formats (png,jpg,gif,webp,bmp), converted formats (heic,tiff,tif,avif,...) and PDF image mode. Use when you need to find a specific object/region in a large image and the full-page view is too downscaled to identify it. The model picks the tile containing the target, then uses its zoom={...} hint to crop sharp. Cap: 49 tiles (7×7)." })),
		}),
		executionMode: executionMode(config),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const modelId = ctx.model?.id ?? "unknown";
			// Cast: our result includes audio/video blocks not in pi's type system
			return (await readExtended(
				params,
				{ cwd: ctx.cwd, modelId },
				config,
			)) as any;
		},
	});

	// Register /extended-read-patch slash command.
	pi.registerCommand("extended-read-patch", {
		description: "Re-apply pi patches (after pi updates)",
		handler: async (_args, ctx) => {
			const r = applyPatches(piRoot);
			const lines = r.map((x) => `  ${x.status}: ${x.id} — ${x.message}`);
			ctx.ui.notify(
				`extended-read-patch (pi v${version}):\n${lines.join("\n")}`,
				"info",
		);
		},
	});

	

	// Register /extended-read-config slash command.
	pi.registerCommand("extended-read-config", {
		description: "Regenerate config.json (backs up existing as .1, .2, …)",
		handler: async (_args, ctx) => {
			const { userConfigPath } = await import("./config.js");
			const configPath = userConfigPath();

			if (existsSync(configPath)) {
				// Find next available backup number
				let n = 1;
				while (existsSync(`${configPath}.${n}`)) n++;
				copyFileSync(configPath, `${configPath}.${n}`);
				ctx.ui.notify(
				`Config backed up to config.json.${n}\nRegenerating…`,
				"info",
			);
			} else {
				ctx.ui.notify("No existing config. Generating…", "info");
			}

			// Copy from plugin default
			copyFileSync(join(pluginDir, "config.json"), configPath);
			ctx.ui.notify(
				`Config regenerated at ${configPath}`,
				"info",
			);
		},
	});
}
