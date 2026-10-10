/**
 * index.ts — patch application engine.
 *
 * Locates pi's files, applies each PatchTarget (string replace + sentinel),
 * and reports per-target status. Idempotent: re-apply is a no-op if the
 * sentinel is already present.
 *
 * Applied automatically on plugin load. Also exposed as /media-patch
 * slash command for manual re-apply after pi updates.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

import { targets, type PatchTarget } from "./targets.js";

export interface PatchResult {
	id: string;
	status: "patched" | "already-present" | "not-found" | "error";
	message: string;
}

export function applyPatches(piRoot: string): PatchResult[] {
	const results: PatchResult[] = [];

	for (const target of targets) {
		try {
			const filePath = target.file(piRoot);
			if (!existsSync(filePath)) {
				results.push({
					id: target.id,
					status: "not-found",
					message: `File not found: ${filePath}`,
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

/** Resolve pi's install root from the pi-coding-agent package. */
export function resolvePiRoot(): string {
	const require = createRequire(import.meta.url);
	const pkgPath = require.resolve(
		"@earendil-works/pi-coding-agent/package.json",
	);
	// pkgPath is like /path/to/node_modules/@earendil-works/pi-coding-agent/package.json
	// Root is two levels up: /path/to/node_modules/@earendil-works/pi-coding-agent/
	const root = pkgPath.split("package.json")[0];
	return root;
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
