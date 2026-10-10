/**
 * types.d.ts — ambient module declarations for pi's dist exports.
 *
 * These are runtime-only imports (pi's compiled JS). We declare the shapes
 * we use so TypeScript is happy without pi's full type surface.
 */

declare module "@earendil-works/pi-coding-agent/dist/utils/image-process.js" {
	export function processImage(
		bytes: Buffer,
		mimeType: string,
		options?: {
			autoResizeImages?: boolean;
			resizeOptions?: Record<string, unknown>;
		},
	): Promise<{ data: string; mimeType: string }>;
}
