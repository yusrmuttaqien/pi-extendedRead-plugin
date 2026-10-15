/**
 * image.ts — image processing via pi's Photon pipeline.
 *
 * Wraps pi's processImage (WASM normalization + worker-thread resize) into a
 * single async call. Returns base64 data ready for content blocks.
 */

import { join } from "node:path";
import { resolvePiRoot } from "./patch/index.js";

/**
 * Process image bytes through pi's resize pipeline (Photon WASM + worker).
 * Returns { data: base64, mimeType } or throws on failure.
 */
export async function processImageBytes(
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
