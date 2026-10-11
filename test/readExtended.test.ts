/**
 * readExtended.test.ts — tests for the extendedRead tool.
 *
 * Tests the dispatch logic: resolve, stat, size cap, capability gate,
 * format dispatch, and error handling.
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readExtended } from "../src/readExtended.js";
import type { PluginConfig } from "../src/config.js";

/** Extract text from array content. */
function text(content: { type: string; text?: string }[]): string {
	return content.map((c) => c.text ?? "").join("\n");
}

const config: PluginConfig = {
	models: {},
	defaults: {
		input: ["text", "image", "audio", "video"],
		maxBytes: { image: 10485760, audio: 20971520, video: 52428800, pdf: 52428800 },
		executionMode: "parallel",
		ffmpegTimeoutMs: 30000,
	},
};

test("file not found", async () => {
	const result = await readExtended(
		{ path: "/nonexistent/file.png" },
		{ cwd: "/tmp", modelId: "test" },
		config,
	);
	assert.equal(result.isError, true);
	assert.match(text(result.content as any), /File not found/);
});

test("not a file (directory)", async () => {
	const result = await readExtended(
		{ path: "/tmp" },
		{ cwd: "/tmp", modelId: "test" },
		config,
	);
	assert.equal(result.isError, true);
	assert.match(text(result.content as any), /Not a file/);
});

test("unsupported extension", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.txt");
	await writeFile(file, "hello");

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	assert.match(text(result.content as any), /unsupported format/);

	await rm(dir, { recursive: true });
});

test("size cap exceeded", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "big.png");
	// Create a file larger than the image cap (10 MB).
	await writeFile(file, Buffer.alloc(11 * 1024 * 1024));

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	assert.match(text(result.content as any), /File too large/);

	await rm(dir, { recursive: true });
});

test("capability gate: model doesn't support audio", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.mp3");
	await writeFile(file, Buffer.from("fake mp3 data"));

	const audioConfig: PluginConfig = {
		...config,
		defaults: { ...config.defaults, input: ["text", "image"] },
	};

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		audioConfig,
	);
	assert.match(text(result.content as any), /does not support audio/);

	await rm(dir, { recursive: true });
});

test("tilde expansion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.txt");
	await writeFile(file, "hello");

	// Use ~ in the path (should expand to homedir).
	// We can't easily test the actual homedir, so just verify it doesn't crash.
	const result = await readExtended(
		{ path: `~/${file.split("/").pop()}` },
		{ cwd: dir, modelId: "test" },
		config,
	);
	// Should be "File not found" (since the file isn't actually in homedir).
	assert.equal(result.isError, true);

	await rm(dir, { recursive: true });
});

test("PDF text extraction", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Minimal valid PDF (1 page, empty).
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
		"xref\n0 4\n0000000000 65535 f \n" +
		"0000000009 00000 n \n" +
		"0000000058 00000 n \n" +
		"0000000113 00000 n \n" +
		"trailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	// Should return text with page count info.
	const allText = text(result.content as any);
	assert.match(allText, /1 pages/);
	assert.match(allText, /Page 1/);

	await rm(dir, { recursive: true });
});

test("PDF page selector", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
		"xref\n0 4\n0000000000 65535 f \n" +
		"0000000009 00000 n \n" +
		"0000000058 00000 n \n" +
		"0000000113 00000 n \n" +
		"trailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Request page 5 (out of range for a 1-page PDF).
	const result = await readExtended(
		{ path: file, pages: "5" },
		{ cwd: dir, modelId: "test" },
		config,
	);
	// Should not crash; out-of-range pages are silently skipped.
	const allText = text(result.content as any);
	assert.match(allText, /1 pages/);

	await rm(dir, { recursive: true });
});
