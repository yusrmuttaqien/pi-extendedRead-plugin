/**
 * readExtended.ts — extendedRead tool implementation.
 *
 * Model-invoked tool that reads media files (images, audio, video) and returns
 * them as content blocks in the tool result. Mirrors the native `read` tool's
 * flow: resolve → stat → size cap → capability gate → dispatch → return.
 *
 * Images: in-memory via pi's processImage (Photon WASM + resize worker).
 * Audio/Video: ffmpeg → /tmp → base64. No resize.
 */

import { stat, readFile, unlink } from "node:fs/promises";
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

	// --- Unsupported ---
	return {
		content: [{ type: "text", text: `[extendedRead: unsupported format ${ext}]` }],
	};
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
