/**
 * targets.ts — patch target definitions.
 *
 * Each target specifies:
 *   - file: relative path within the pi package
 *   - search: unique anchor string to find
 *   - replace: replacement text
 *   - sentinel: comment marking a successfully applied patch
 *
 * Anchors are matched against the ACTUAL minified pi bundle (v0.85.0).
 */

export interface PatchTarget {
	id: string;
	file: string;
	search: string;
	replace: string;
	/** New sentinel written on patch. */
	sentinel: string;
	/** Old sentinels still recognized for idempotency (backward compat). */
	legacySentinels?: string[];
}

export const targets: PatchTarget[] = [
	{
		id: "convertMessages",
		file: "dist/bundle/chunks/openai-completions-OSRCWAAA.js",
		// Anchor 1: hasImages detection — add audio/video
		search: 'hasImages=toolMsg.content.some(c=>c.type==="image")',
		replace:
			'hasImages=toolMsg.content.some(c=>c.type==="image"||c.type==="audio"||c.type==="video")',
		sentinel: "// pi-extendedread:v1:convertMessages",
		legacySentinels: ["// pi-media-patch:v1:convertMessages"],
	},
	{
		id: "convertMessagesBlocks",
		file: "dist/bundle/chunks/openai-completions-OSRCWAAA.js",
		// Anchor 2: block extraction — map audio/video to correct types
		search:
			'isImageContentBlock(block)&&imageBlocks.push({type:"image_url",image_url:{url:`data:${block.mimeType};base64,${block.data}`}})',
		replace:
			'(block.type==="image"||block.type==="audio"||block.type==="video")&&imageBlocks.push(block.type==="image"?{type:"image_url",image_url:{url:`data:${block.mimeType};base64,${block.data}`}}:block.type==="audio"?{type:"input_audio",input_audio:{data:block.data}}:{type:"input_video",input_video:{data:block.data}})',
		sentinel: "// pi-extendedread:v1:convertMessagesBlocks",
		legacySentinels: ["// pi-media-patch:v1:convertMessagesBlocks"],
	},
	{
		id: "compaction",
		file: "dist/core/compaction/compaction.js",
		search: "const ESTIMATED_IMAGE_CHARS = 4800;",
		replace:
			"const ESTIMATED_IMAGE_CHARS = 4800;\nconst ESTIMATED_AUDIO_CHARS = 1500;\nconst ESTIMATED_VIDEO_CHARS = 5000;",
		sentinel: "// pi-extendedread:v1:compaction",
		legacySentinels: ["// pi-media-patch:v1:compaction"],
	},
];
