/**
 * ffmpeg.ts — low-level ffmpeg operations.
 *
 * Wraps @ffmpeg-installer/ffmpeg for format conversion, region cropping,
 * and dimension probing. All functions are async and return null/throw on
 * failure (caller decides fallback behavior).
 */

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

/** The bundled ffmpeg binary path. */
export const ffmpegPath: string = ffmpeg.path;

/** Appended as a model-visible text block when zoom is requested but cropping fell back to the full frame. */
export const ZOOM_UNAVAILABLE_HINT = "zoom region unavailable — returning full page";

/**
 * Convert an input file to a target format via ffmpeg.
 * Returns the output temp file path (caller must unlink).
 */
export function ffmpegConvert(
	inputPath: string,
	targetExt: string,
	timeoutMs: number,
): Promise<string> {
	const outputPath = join(tmpdir(), `pi-media-${process.pid}-${randomUUID()}.${targetExt}`);
	return new Promise((resolveP, rejectP) => {
		execFile(
			ffmpegPath,
			["-y", "-i", inputPath, outputPath],
			{ timeout: timeoutMs },
			(err) => {
				if (err) rejectP(err);
				else resolveP(outputPath);
			},
		);
	});
}

/** Promisified execFile returning both stdout and stderr. */
export function runCmd(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolveP, rejectP) => {
		execFile(binary, args, { timeout: 10_000 }, (err, stdout, stderr) => {
			if (err)
				rejectP(err);
			else
				resolveP({ stdout, stderr });
		});
	});
}

/**
 * Extract an image's pixel dimensions via ffmpeg's probe output.
 * Returns null on any failure (caller falls back to no-zoom).
 */
export async function imageDims(inputPath: string): Promise<{ width: number; height: number } | null> {
	try {
		const { stderr } = await runCmd(ffmpegPath, ["-hide_banner", "-i", inputPath, "-vframes", "1", "-f", "null", "-"]);
		return parseFfmpegDims(stderr);
	} catch {
		/* fall through to no-zoom */
	}
	return null;
}

/**
 * Parse "WxH" from ffmpeg's probe stderr. Anchored to the "Video:" stream
 * descriptor line: a bare \d+x\d+ also matches ffmpeg's memory pointer
 * (e.g. "[png_pipe @ 0x137808200]"), which appears first when ffmpeg prints
 * the "not enough frames to estimate rate" warning and would otherwise yield
 * width=0 and a spurious null. Returns null if no valid dimensions are present.
 */
export function parseFfmpegDims(stderr: string): { width: number; height: number } | null {
	const m = String(stderr).match(/Video:.*?(\d+)x(\d+)/);
	if (m && +m[1] > 0 && +m[2] > 0)
		return { width: +m[1], height: +m[2] };
	return null;
}

/**
 * Crop a region of an image raster (any ffmpeg-decodable input) at normalized
 * [x,y,w,h] fractions, returning the cropped PNG bytes. Returns null if
 * dimensions can't be resolved.
 */
export async function cropRegionToPng(
	inputPath: string,
	zoom: { x: number; y: number; w: number; h: number },
	timeoutMs: number,
): Promise<Buffer | null> {
	const dims = await imageDims(inputPath);
	if (!dims)
		return null;
	return cropRegionToPngWithDims(inputPath, zoom, dims, timeoutMs);
}

/**
 * Crop a region given pre-computed pixel dimensions (skips the per-call ffmpeg
 * probe). Returns null on failure.
 */
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
		await runCmd(ffmpegPath, ["-y", "-i", inputPath, "-vf", `crop=${W}:${H}:${X}:${Y}`, outPath]);
		return await readFile(outPath);
	} finally {
		await unlink(outPath).catch(() => {});
	}
}
