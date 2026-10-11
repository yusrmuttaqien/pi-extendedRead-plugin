/**
 * index.ts — plugin entry point.
 *
 * Registers the extendedRead tool and applies pi patches on activation.
 * Also exposes the /media-patch slash command for manual re-apply.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
			"PDF: text extraction (default) or page rendering to image. Use pages='1-5' for pagination. " +
			"PPTX: converts to PDF via LibreOffice, then uses the PDF pipeline. " +
			"For text files, use the native read tool.",
		promptSnippet: "Read media files",
		promptGuidelines: [
			"Use extendedRead to read media files (images, audio, video, PDF) the user references.",
			"Use the native read tool for text files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file (relative, absolute, or ~)" }),
			pages: Type.Optional(Type.String({ description: "Page selector for PDFs: '1', '1-5', '3,7,12' (default: '1')" })),
			mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image")], { description: "PDF mode: 'text' (default) or 'image'" })),
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

	// Register /media-patch slash command.
	pi.registerCommand("media-patch", {
		description: "Re-apply pi media patches (after pi updates)",
		handler: async (_args, ctx) => {
			const r = applyPatches(piRoot);
			const lines = r.map((x) => `  ${x.status}: ${x.id} — ${x.message}`);
			ctx.ui.notify(
				`pi-media-patch (pi v${version}):\n${lines.join("\n")}`,
				"info",
			);
		},
	});
}
