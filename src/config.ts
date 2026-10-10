/**
 * config.ts — loads and exposes config.json.
 *
 * Reads the plugin's config.json (self-documenting, see §3 of the spec).
 * Exposes model capabilities and tuning knobs to the tool and patch modules.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface MaxBytes {
	image: number;
	audio: number;
	video: number;
}

export interface ModelConfig {
	input: string[];
	maxBytes?: MaxBytes;
}

export interface PluginConfig {
	models: Record<string, ModelConfig>;
	defaults: {
		input: string[];
		maxBytes: MaxBytes;
		executionMode: "parallel" | "sequential";
		ffmpegTimeoutMs: number;
	};
}

let cached: PluginConfig | undefined;

export function loadConfig(pluginDir: string): PluginConfig {
	if (cached) return cached;
	const raw = readFileSync(join(pluginDir, "config.json"), "utf-8");
	cached = JSON.parse(raw) as PluginConfig;
	return cached;
}

/** Resolve effective config for a given model ID. */
export function resolveModelConfig(
	config: PluginConfig,
	modelId: string,
): { input: string[]; maxBytes: MaxBytes } {
	const model = config.models[modelId];
	return {
		input: model?.input ?? config.defaults.input,
		maxBytes: {
			image: model?.maxBytes?.image ?? config.defaults.maxBytes.image,
			audio: model?.maxBytes?.audio ?? config.defaults.maxBytes.audio,
			video: model?.maxBytes?.video ?? config.defaults.maxBytes.video,
		},
	};
}

export function ffmpegTimeout(config: PluginConfig): number {
	return config.defaults.ffmpegTimeoutMs;
}

export function executionMode(config: PluginConfig): "parallel" | "sequential" {
	return config.defaults.executionMode;
}
