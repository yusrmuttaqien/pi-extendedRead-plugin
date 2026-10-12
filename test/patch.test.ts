/**
 * patch.test.ts — tests for the patch engine.
 *
 * Verifies:
 *   1. A patch applies correctly to a file containing the anchor.
 *   2. Idempotency: re-applying is a no-op.
 *   3. Anchor not found → "not-found" status.
 *   4. Two targets in the same file apply independently.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { applyPatches } from "../src/patch/index.js";
import { targets } from "../src/patch/targets.js";

test("patch applies to a file with the anchor", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-media-patch-test-"));
	const t = targets.find((x) => x.id === "compaction")!;
	const filePath = join(dir, t.file);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `const ESTIMATED_IMAGE_CHARS = 4800;\n`);

	const result = applyPatches(dir);
	const r = result.find((x) => x.id === "compaction")!;
	assert.equal(r.status, "patched");

	const content = await readFile(filePath, "utf8");
	assert.ok(content.includes("ESTIMATED_AUDIO_CHARS"));
	assert.ok(content.includes("ESTIMATED_VIDEO_CHARS"));
	assert.ok(content.includes(t.sentinel));

	await rm(dir, { recursive: true });
});

test("idempotency: re-apply is a no-op", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-media-patch-test-"));
	const t = targets.find((x) => x.id === "compaction")!;
	const filePath = join(dir, t.file);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `const ESTIMATED_IMAGE_CHARS = 4800;\n`);

	const first = applyPatches(dir);
	const second = applyPatches(dir);
	assert.equal(first.find((x) => x.id === "compaction")!.status, "patched");
	assert.equal(second.find((x) => x.id === "compaction")!.status, "already-present");

	await rm(dir, { recursive: true });
});

test("anchor not found → not-found status", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-media-patch-test-"));
	const t = targets.find((x) => x.id === "compaction")!;
	const filePath = join(dir, t.file);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, "some other content\n");

	const result = applyPatches(dir);
	const r = result.find((x) => x.id === "compaction")!;
	assert.equal(r.status, "not-found");

	await rm(dir, { recursive: true });
});

test("two targets in same file apply independently", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-media-patch-test-"));
	const t1 = targets.find((x) => x.id === "convertMessages")!;
	const t2 = targets.find((x) => x.id === "convertMessagesBlocks")!;
	assert.equal(t1.file, t2.file, "both targets must be in the same file");
	const filePath = join(dir, t1.file);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(
		filePath,
		'hasImages=toolMsg.content.some(c=>c.type==="image")\n' +
			'isImageContentBlock(block)&&imageBlocks.push({type:"image_url",image_url:{url:`data:${block.mimeType};base64,${block.data}`}})\n',
	);

	const result = applyPatches(dir);
	const r1 = result.find((x) => x.id === "convertMessages")!;
	const r2 = result.find((x) => x.id === "convertMessagesBlocks")!;
	assert.equal(r1.status, "patched");
	assert.equal(r2.status, "patched");

	const content = await readFile(filePath, "utf8");
	assert.ok(content.includes('c.type==="image"||c.type==="audio"||c.type==="video"'));
	assert.ok(content.includes("input_audio"));
	assert.ok(content.includes("input_video"));

	await rm(dir, { recursive: true });
});

test("legacy sentinel recognized as already-present", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-media-patch-test-"));
	const t = targets.find((x) => x.id === "compaction")!;
	const filePath = join(dir, t.file);
	await mkdir(dirname(filePath), { recursive: true });
	// File already has the OLD sentinel (from a previous plugin version)
	await writeFile(
		filePath,
		`const ESTIMATED_IMAGE_CHARS = 4800;\nconst ESTIMATED_AUDIO_CHARS = 1500;\nconst ESTIMATED_VIDEO_CHARS = 5000;\n// pi-media-patch:v1:compaction`,
	);

	const result = applyPatches(dir);
	const r = result.find((x) => x.id === "compaction")!;
	assert.equal(r.status, "already-present");

	await rm(dir, { recursive: true });
});

test("new sentinel written on patch (not legacy)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-media-patch-test-"));
	const t = targets.find((x) => x.id === "compaction")!;
	const filePath = join(dir, t.file);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `const ESTIMATED_IMAGE_CHARS = 4800;\n`);

	const result = applyPatches(dir);
	assert.equal(result.find((x) => x.id === "compaction")!.status, "patched");

	const content = await readFile(filePath, "utf8");
	assert.ok(content.includes("// pi-extendedread:v1:compaction"));
	assert.ok(!content.includes("// pi-media-patch:v1:compaction"));

	await rm(dir, { recursive: true });
});

test("dynamic hash resolution: finds file with different hash", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-media-patch-test-"));
	const t = targets.find((x) => x.id === "convertMessages")!;
	// The target file has hash "OSRCWAAA" but we create it with a different hash
	const dirName = dirname(t.file);
	const baseName = t.file.slice(dirName.length + 1); // "openai-completions-OSRCWAAA.js"
	const prefix = baseName.replace(/-[A-Z0-9]{6,}\.js$/, ""); // "openai-completions"
	const altHash = "ZZZ99999";
	const altFile = join(dir, dirName, `${prefix}-${altHash}.js`);
	await mkdir(dirname(altFile), { recursive: true });
	await writeFile(
		altFile,
		'hasImages=toolMsg.content.some(c=>c.type==="image")\n',
	);

	const result = applyPatches(dir);
	const r = result.find((x) => x.id === "convertMessages")!;
	assert.equal(r.status, "patched");

	const content = await readFile(altFile, "utf8");
	assert.ok(content.includes('c.type==="image"||c.type==="audio"||c.type==="video"'));

	await rm(dir, { recursive: true });
});
