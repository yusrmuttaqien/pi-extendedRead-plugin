/**
 * index.ts — patch application engine.
 *
 * Locates pi's files, applies each PatchTarget (string replace + sentinel),
 * and reports per-target status. Idempotent: re-apply is a no-op if the
 * sentinel is already present.
 *
 * Applied automatically on plugin load. Also exposed as /extended-read-patch
 * slash command for manual re-apply after pi updates.
 */

import { readFileSync, writeFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { targets, type PatchTarget } from "./targets.js";

export interface PatchResult {
	id: string;
	status: "patched" | "already-present" | "not-found" | "error";
	message: string;
}

/**
 * Resolve a target file path. If the path contains a hashed filename
 * (e.g. "openai-completions-OSRCWAAA.js"), search for files matching
 * the pattern (e.g. "openai-completions-*.js") in the same directory.
 * This survives pi updates that change chunk hashes.
 */
function resolveTargetFile(piRoot: string, targetFile: string): string | null {
	const direct = join(piRoot, targetFile);
	if (existsSync(direct)) return direct;

	// Try dynamic resolution: split into dir + basename, search for pattern match
	const dir = dirname(targetFile);
	const base = targetFile.slice(dir.length + 1); // basename
	// Check if basename looks like it has a hash suffix (e.g. "name-HASH.js")
	const hashPattern = base.match(/^(.+)-([A-Z0-9]{6,})\.js$/);
	if (hashPattern) {
		const prefix = hashPattern[1];
		const absDir = join(piRoot, dir);
		if (existsSync(absDir)) {
			const files = readdirSync(absDir);
			const match = files.find(
				(f) => f.startsWith(prefix + "-") && f.endsWith(".js"),
			);
			if (match) return join(absDir, match);
		}
	}
	return null;
}

export function applyPatches(piRoot: string): PatchResult[] {
	const results: PatchResult[] = [];

	for (const target of targets) {
		try {
			const filePath = resolveTargetFile(piRoot, target.file);
			if (!filePath) {
				results.push({
					id: target.id,
					status: "not-found",
					message: `File not found: ${join(piRoot, target.file)}`,
				});
				continue;
			}

			const content = readFileSync(filePath, "utf-8");

			// Idempotency check: sentinel already present?
			if (content.includes(target.sentinel)) {
				results.push({
					id: target.id,
					status: "already-present",
					message: `Sentinel found in ${filePath}`,
				});
				continue;
			}

			// Apply patch: find anchor, replace, insert sentinel.
			const idx = content.indexOf(target.search);
			if (idx === -1) {
				results.push({
					id: target.id,
					status: "not-found",
					message: `Anchor not found in ${filePath}. Pi update may have changed the code.`,
				});
				continue;
			}

			const patched =
				content.slice(0, idx) +
				target.replace +
				content.slice(idx + target.search.length) +
				`\n${target.sentinel}`;

			writeFileSync(filePath, patched, "utf-8");
			results.push({
				id: target.id,
				status: "patched",
				message: `Patched ${filePath}`,
			});
		} catch (err) {
			results.push({
				id: target.id,
				status: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return results;
}

/** Resolve pi's install root by walking up from pi's entry point. */
export function resolvePiRoot(): string {
	// pi's entry point is process.argv[1] (e.g. .../pi-coding-agent/dist/cli.js)
	const entry = process.argv[1];
	if (entry) {
		// Resolve symlinks (bin/pi → lib/node_modules/.../dist/bundle/cli.js)
		let realEntry = entry;
		try { realEntry = realpathSync(entry); } catch {}
		// Try both the real path and the original
		for (const start of [dirname(realEntry), dirname(entry)]) {
			let dir = start;
			for (let i = 0; i < 10; i++) {
				const candidate = join(
					dir,
					"node_modules",
					"@earendil-works",
					"pi-coding-agent",
				);
				if (existsSync(join(candidate, "package.json"))) return candidate;
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		}
	}
	throw new Error(
		"Cannot find @earendil-works/pi-coding-agent package root",
	);
}

/** Read pi's version from its package.json. */
export function piVersion(piRoot: string): string {
	try {
		const pkg = readFileSync(`${piRoot}/package.json`, "utf-8");
		return (JSON.parse(pkg) as { version: string }).version;
	} catch {
		return "unknown";
	}
}
