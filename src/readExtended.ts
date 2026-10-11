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

import { stat, readFile, unlink, mkdtemp, rm } from "node:fs/promises";
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

// --- Main ---

export interface ExtendedReadParams {
	path: string;
	pages?: string;
	mode?: "text" | "image";
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
		const bytes = await readFile(path);
		const { data, mimeType } = await processImageBytes(bytes, IMAGE_DIRECT[ext]);
		return {
			content: [
				{ type: "text", text: `Read image [${mimeType}]` },
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
			const bytes = await readFile(tmp);
			const { data, mimeType } = await processImageBytes(bytes, "image/png");
			return {
				content: [
					{ type: "text", text: `Read image [${mimeType}]` },
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

	// --- PPTX (convert to PDF via LibreOffice) ---
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
		const dpi = config.defaults.pdf?.defaultDpi ?? 150;

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
				text: `PDF: ${totalPages} pages. Read pages ${pageIndices.map((i) => i + 1).join(",")}. Use pages='N-M' for more, mode='image' to view visually.`,
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
						text: `PDF page ${i + 1} of ${totalPages}`,
					});
						blocks.push({
						type: "image",
						data: png.toString("base64"),
						mimeType: "image/png",
					});
				} finally {
					pixmap.destroy();
				}
			} finally {
				page.destroy();
			}
		}
			blocks.push({
				type: "text",
				text: `PDF: ${totalPages} pages. Read pages ${pageIndices.map((i) => i + 1).join(",")}. Use pages='N-M' for more.`,
			});
		}

		return { content: blocks };
	} finally {
		doc.destroy();
	}
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

// --- PPTX handling (convert to PDF via LibreOffice, then use PDF pipeline) ---

async function readPptx(
	path: string,
	params: ExtendedReadParams,
	config: PluginConfig,
	input: string[],
): Promise<AgentToolResult> {
	// Find soffice (LibreOffice)
	const { execFileSync } = await import("node:child_process");
	let sofficePath: string;
	try {
		sofficePath = execFileSync("which", ["soffice"], { encoding: "utf-8" }).trim();
	} catch {
		return {
			content: [
				{
					type: "text",
					text: "[extendedRead: PPTX requires LibreOffice (soffice) to be installed. Install it and try again.]",
				},
			],
		};
	}

	// Convert to PDF in a temp directory
	const tmpDir = await mkdtemp(join(tmpdir(), "pi-pptx-"));
	const baseName = path.replace(/\.pptx$/i, "");
	try {
		await execFile(
			sofficePath,
			[
				"-env:UserInstallation=file://" + tmpDir,
				"--headless",
				"--convert-to", "pdf",
				"--outdir", tmpDir,
				path,
			],
			{ timeout: 30000 },
		);
		const pdfPath = join(tmpDir, `${baseName.split("/").pop()}.pdf`);
		return await readPdf(pdfPath, params, config, input);
	} catch (e: any) {
		return {
			content: [
				{
					type: "text",
					text: `[extendedRead: PPTX conversion failed: ${e.message}]`,
				},
			],
		};
	} finally {
		await rm(tmpDir, { recursive: true }).catch(() => {});
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
