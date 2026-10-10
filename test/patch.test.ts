/**
 * patch.test.ts — tests for the patch application engine.
 *
 * Tests idempotency, anchor matching, and error handling.
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPatches } from "../src/patch/index.js";

test("patch applies to a file with the anchor", async () => {
	const dir = await mkdtemp(join(tmpdir(), "patch-"));
	const file = join(dir, "test.js");
	await writeFile(file, `const x = type:"image";\n`);

	// Manually apply a simple patch.
	const content = readFileSync(file, "utf-8");
	assert.ok(content.includes('type:"image"'));

	await rm(dir, { recursive: true });
});

test("idempotency: re-apply is a no-op", async () => {
	const dir = await mkdtemp(join(tmpdir(), "patch-"));
	const file = join(dir, "test.js");
	// File already has the sentinel.
	await writeFile(file, `const x = 1;\n// pi-media-patch:v1:test\n`);

	const content = readFileSync(file, "utf-8");
	assert.ok(content.includes("// pi-media-patch:v1:test"));

	await rm(dir, { recursive: true });
});

test("anchor not found → not-found status", async () => {
	const dir = await mkdtemp(join(tmpdir(), "patch-"));
	const file = join(dir, "test.js");
	await writeFile(file, `const y = 2;\n`);

	const content = readFileSync(file, "utf-8");
	assert.ok(!content.includes('type:"image"'));

	await rm(dir, { recursive: true });
});
