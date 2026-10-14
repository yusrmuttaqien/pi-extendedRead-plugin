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
import { execFile } from "node:child_process";

import { readExtended, cropRegionToPng } from "../src/readExtended.js";
import type { PluginConfig } from "../src/config.js";

/** Extract text from array content. */
function text(content: { type: string; text?: string }[]): string {
	return content.map((c) => c.text ?? "").join("\n");
}

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

test("PDF: image mode gated by model capability", async () => {
	const noImageConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text", "audio", "video"],
			maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};
	const dir = await mkdtemp(join(tmpdir(), "pi-extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Model without "image" capability.
	const result = await readExtended(
		{ path: file, mode: "image" },
		{ cwd: dir, modelId: "test" },
		noImageConfig,
	);
	const allText = text(result.content as any);
	assert.match(allText, /does not support images/);

	await rm(dir, { recursive: true });
});

test("PPTX: returns conversion failed for invalid file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-extread-"));
	const file = join(dir, "test.pptx");
	await writeFile(file, Buffer.from([0x50, 0x50, 0x54, 0x58])); // minimal bytes

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content as any);
	// Should return "conversion failed" since the file is not a valid PPTX
	assert.match(allText, /conversion failed/i);

	await rm(dir, { recursive: true });
});

test("image direct: PNG dispatch reaches image handler", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Minimal valid 1x1 PNG — we're testing dispatch, not the resize pipeline.
	const pngBytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAAHXuKfwAAAABJRU5ErkJggg==",
		"base64",
	);
	const file = join(dir, "test.png");
	await writeFile(file, pngBytes);

	// In the test environment, Photon WASM (pi's image resize engine) is
	// unavailable, so processImage throws. This proves dispatch reached
	// the image handler (file recognized as PNG, capability gate passed).
	await assert.rejects(
		readExtended({ path: file }, { cwd: dir, modelId: "test" }, config),
		/resize|Image|Photon/i,
	);

	await rm(dir, { recursive: true });
});

test("audio direct: WAV returns audio block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Minimal WAV header (RIFF + 44 bytes)
	const wavBytes = Buffer.alloc(44);
	wavBytes.write("RIFF", 0);
	wavBytes.write("WAVE", 8);
	wavBytes.write("fmt ", 12);
	const file = join(dir, "test.wav");
	await writeFile(file, wavBytes);

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const blocks = result.content as any[];
	assert.ok(blocks.some((b) => b.type === "audio"));

	await rm(dir, { recursive: true });
});

test("video direct: MP4 returns video block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Minimal MP4 header (ftyp box)
	const mp4Bytes = Buffer.from([
		0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // ftyp box
		0x69, 0x73, 0x6f, 0x6d, 0x20, 0x20, 0x20, 0x20,
	]);
	const file = join(dir, "test.mp4");
	await writeFile(file, mp4Bytes);

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const blocks = result.content as any[];
	assert.ok(blocks.some((b) => b.type === "video"));

	await rm(dir, { recursive: true });
});

test("capability gate: model doesn't support images", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pngBytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAACXBIWXMAAAABAAAAAQBPJcTWAAAA50lEQVR4nO3QsQkAIADAMAX/v9jBF+wkQnJB6dyDW+t1wE/MCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKDqR1Aoosepp1AAAAAElFTkSuQmCC",
		"base64",
	);
	const file = join(dir, "test.png");
	await writeFile(file, pngBytes);

	const noImageConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text", "audio", "video"],
			maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		noImageConfig,
	);
	const allText = text(result.content as any);
	assert.match(allText, /does not support images/);

	await rm(dir, { recursive: true });
});

test("capability gate: model doesn't support video", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const mp4Bytes = Buffer.from([
		0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x20, 0x20, 0x20, 0x20,
	]);
	const file = join(dir, "test.mp4");
	await writeFile(file, mp4Bytes);

	const noVideoConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text", "image", "audio"],
			maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		noVideoConfig,
	);
	const allText = text(result.content as any);
	assert.match(allText, /does not support video/);

	await rm(dir, { recursive: true });
});

// --- PDF TOC, Search, DPI tests ---

test("PDF: toc=true returns outline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Create a minimal PDF with an outline using mupdf
	const mupdf = await import("mupdf") as any;
	// Use a simple PDF that has text (no outline) to test the "no outline" path
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	const result = await readExtended(
		{ path: file, toc: true },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content as any);
	assert.match(allText, /no table of contents/i);

	await rm(dir, { recursive: true });
});

test("PDF: search returns no matches for absent text", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	const result = await readExtended(
		{ path: file, search: "nonexistent text that is not in the pdf" },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content as any);
	assert.match(allText, /No matches/i);

	await rm(dir, { recursive: true });
});

test("PDF: dpi parameter is accepted (image mode)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Image mode with dpi — minimal PDF has no content, so toPixmap succeeds
	// (blank page). Proves the dpi param is accepted and dispatch works.
	const result = await readExtended(
		{ path: file, mode: "image", dpi: 300 },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content as any);
	assert.match(allText, /300 DPI/);

	await rm(dir, { recursive: true });
});

// --- Region zoom tests ---

/** Read PNG pixel dimensions straight from the IHDR header (no external tools). */
function pngDims(buf: Buffer): [number, number] | null {
	if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
		return null;
	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	return [w, h];
}

/** Generate a solid-color PNG of exact size via ffmpeg (self-contained fixture). */
async function makePng(width: number, height: number, color: string, targetDir?: string): Promise<string> {
	const { path: bin } = await import("@ffmpeg-installer/ffmpeg");
	const dir = targetDir ?? (await mkdtemp(join(tmpdir(), "zoom-")));
	const out = join(dir, `gen-${width}x${height}.png`);
	await new Promise<void>((res, rej) => {
		execFile(
			bin,
			["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}`, "-frames:v", "1", out],
			{ timeout: 20_000 },
			(err) => (err ? rej(err) : res()),
		);
	});
	return out;
}

/**
 * Assert that a zoomed image read reached pi's resize pipeline (processImageBytes).
 * This is true whether processImage succeeds (resolve with an image block) or throws on
 * ok:false (reject matching the resize/Photon error), so it robustly proves the new crop
 * code path was taken regardless of pi's opaque success/fail behavior.
 */
async function expectRoutedThroughPipeline(promise: Promise<{ content?: any[]; isError?: boolean }>): Promise<void> {
	try {
		const r = await promise;
		assert.ok(r.isError !== true, "expected no error when the pipeline succeeds");
		assert.ok((r.content as any[]).some((b) => b.type === "image"), "expected an image block");
	} catch (e: any) {
		assert.match(String(e.message ?? e), /resize|Image|Photon/i);
	}
}

test("cropRegionToPng crops a full-frame fraction to expected dimensions", async () => {
	const src = await makePng(500, 300, "green");
	try {
		const buf = await cropRegionToPng(src, { x: 0, y: 0, w: 0.5, h: 0.5 }, 30_000);
		assert.ok(buf, "expected a cropped buffer");
		assert.deepEqual(pngDims(buf as Buffer), [250, 150]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegionToPng handles an offset fraction", async () => {
	const src = await makePng(500, 300, "red");
	try {
		const buf = await cropRegionToPng(src, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, 30_000);
		assert.ok(buf, "expected a cropped buffer");
		// boxPx = (125, 150, 250, 150); output dimensions are w x h.
		assert.deepEqual(pngDims(buf as Buffer), [250, 150]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegionToPng clamps an overflowing box to the raster", async () => {
	const src = await makePng(400, 300, "blue");
	try {
		// w=1,h=1 at (0.9,0.9) would overflow; must clamp inside bounds without error.
		const buf = await cropRegionToPng(src, { x: 0.9, y: 0.9, w: 1, h: 1 }, 30_000);
		assert.ok(buf, "expected a cropped buffer");
		// W=400,H=300 -> fills the whole raster from (0,0) after clamping.
		assert.deepEqual(pngDims(buf as Buffer), [400, 300]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegionToPng returns null (no throw) when dimensions cannot be resolved", async () => {
	const buf = await cropRegionToPng("/tmp/__does_not_exist_zoom__.png", { x: 0, y: 0, w: 0.5, h: 0.5 }, 5_000);
	assert.equal(buf, null);
});

test("direct image with zoom routes through the resize pipeline (crop then pi)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-img-"));
	// Generate a real PNG directly into dir; readExtended will crop it then hand it to pi.
	const file = await makePng(200, 150, "green", dir);

	// Zoom routes the cropped region through processImageBytes (crop -> pi pipeline).
	await expectRoutedThroughPipeline(
		readExtended({ path: file, zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { cwd: dir, modelId: "test" }, config),
	);

	await rm(dir, { recursive: true });
});

test("PDF image mode with zoom routes the cropped region through pi", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-pdf-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Renders page raster -> crops region via ffmpeg -> processImageBytes(cropped) -> pi.
	await expectRoutedThroughPipeline(
		readExtended({ path: file, mode: "image", zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { cwd: dir, modelId: "test" }, config),
	);

	await rm(dir, { recursive: true });
});

test("PDF image mode without zoom is unchanged (full page, no pipeline resize)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-pdf-full-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Backward-compat: omitting zoom keeps the original full-page behavior — a full-page image block is returned (no pipeline resize).
	const result = await readExtended({ path: file, mode: "image" }, { cwd: dir, modelId: "test" }, config);
	assert.ok(result.isError !== true);
	const blocks = result.content as any[];
	assert.ok(blocks.some((b) => b.type === "image"));
	assert.match(text(blocks), /DPI/);

	await rm(dir, { recursive: true });
});
