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

const config: PluginConfig = {
	models: {},
	defaults: {
		input: ["text", "image", "audio", "video"],
		maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
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
	assert.match(result.content as string, /File not found/);
});

test("not a file (directory)", async () => {
	const result = await readExtended(
		{ path: "/tmp" },
		{ cwd: "/tmp", modelId: "test" },
		config,
	);
	assert.equal(result.isError, true);
	assert.match(result.content as string, /Not a file/);
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
	assert.match(result.content as string, /unsupported format/);

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
	assert.match(result.content as string, /File too large/);

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
	assert.match(result.content as string, /does not support audio/);

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
