/**
 * targets.ts — PatchTarget definitions.
 *
 * Each target is a named, self-documenting unit: the exact anchor string
 * to find, the replacement, and the sentinel. When pi changes and a target
 * no longer matches, you update the anchor here and bump the version.
 */

export interface PatchTarget {
	/** Unique identifier for this patch target. */
	id: string;
	/** Resolves the actual file path given pi's install root. */
	file: (piRoot: string) => string;
	/** Exact string to find in the file (the anchor). */
	search: string;
	/** Replacement string. */
	replace: string;
	/** Sentinel comment inserted after the replacement. */
	sentinel: string;
}

const VERSION = "v1";

export const targets: PatchTarget[] = [
	// --- convertMessages: add audio/video block serialization ---
	{
		id: "convertMessages",
		file: (piRoot) =>
			locateBundle(piRoot), // glob openai-completions-*.js
		// Anchor: the existing image block detection in convertMessages.
		// We insert audio/video detection right after the image block handling.
		search: `type:"image"`,
		replace: `type:"image"|type:"audio"|type:"video"`,
		sentinel: `// pi-media-patch:${VERSION}:convertMessages`,
	},

	// --- compaction: add ESTIMATED_AUDIO_CHARS / ESTIMATED_VIDEO_CHARS ---
	{
		id: "compaction",
		file: (piRoot) => `${piRoot}/dist/core/compaction/compaction.js`,
		// Anchor: the existing ESTIMATED_IMAGE_CHARS constant.
		search: `ESTIMATED_IMAGE_CHARS`,
		replace: `ESTIMATED_IMAGE_CHARS,ESTIMATED_AUDIO_CHARS=1500,ESTIMATED_VIDEO_CHARS=5000`,
		sentinel: `// pi-media-patch:${VERSION}:compaction`,
	},

	// --- types: add AudioContent / VideoContent to the union ---
	{
		id: "types",
		file: (piRoot) => `${piRoot}/dist/core/extensions/types.d.ts`,
		// Anchor: the existing ImageContent type in the union.
		search: `TextContent | ImageContent`,
		replace: `TextContent | ImageContent | AudioContent | VideoContent`,
		sentinel: `// pi-media-patch:${VERSION}:types`,
	},
];

// --- Bundle location helper ---

import { globSync } from "node:fs";

function locateBundle(piRoot: string): string {
	const matches = globSync(`${piRoot}/dist/bundle/chunks/openai-completions-*.js`);
	if (matches.length === 0)
		throw new Error(
			`pi-media-patch: no openai-completions-*.js found in ${piRoot}/dist/bundle/chunks/`,
		);
	if (matches.length > 1)
		throw new Error(
			`pi-media-patch: multiple openai-completions-*.js found: ${matches.join(", ")}`,
		);
	return matches[0];
}
