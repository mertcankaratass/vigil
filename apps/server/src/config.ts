/**
 * The configuration file (#69): thresholds and definitions, validated by `parseConfig` in `packages/core`.
 * `config/vigil.json` at the repository root unless `VIGIL_CONFIG` names another file. A missing or invalid file is
 * an error: the rules never run on built-in values.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, parseConfig, type VigilConfig } from "@vigil/core";
import type { Database } from "./db.ts";

export interface StoredConfigVersion {
  version: string;
  content_hash: string;
  content: string;
  created_at: Date;
}

export const DEFAULT_CONFIG_PATH = join(import.meta.dir, "..", "..", "..", "config", "vigil.json");

/** The configuration file's path: `VIGIL_CONFIG` if set, otherwise `config/vigil.json`. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env.VIGIL_CONFIG || DEFAULT_CONFIG_PATH;
}

/** Read and validate the configuration file. Throws `ConfigError` if it is missing or invalid. */
export function loadConfig(path = configPath()): VigilConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read the configuration file ${path}: ${(e as Error).message}`);
  }
  return parseConfig(text, path);
}

/** SHA-256 hash of configuration text, hex. */
export function configHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Store the active configuration file in DuckDB `config_versions` if new (#187).
 * Reads the config file (from `options.path` or `configPath()`), validates it, and records it in `config_versions`.
 * Changing thresholds requires bumping `version`. If the same version is already stored with different content,
 * throws `ConfigError`.
 */
export async function storeActiveConfig(
  db: Database,
  options: { path?: string; now?: Date } = {},
): Promise<{ stored: boolean; version: string; hash: string }> {
  const path = options.path ?? configPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read the configuration file ${path}: ${(e as Error).message}`);
  }
  const config = parseConfig(text, path);
  return storeConfigVersion(db, text, config.version, options);
}

/** Store configuration text under its version in `config_versions` if not yet stored (#187). */
export async function storeConfigVersion(
  db: Database,
  text: string,
  version: string,
  options: { now?: Date } = {},
): Promise<{ stored: boolean; version: string; hash: string }> {
  const hash = configHash(text);
  const reader = await db.con.runAndReadAll("SELECT content_hash, content FROM config_versions WHERE version = $1", [
    version,
  ] as never);
  const existing = reader.getRowObjectsJS() as { content_hash: string; content: string }[];
  if (existing.length > 0) {
    const row = existing[0];
    if (row && row.content_hash !== hash) {
      throw new ConfigError(
        `config version ${version} was already stored with a different content hash (${row.content_hash} vs ${hash}); change the version when thresholds change`,
      );
    }
    return { stored: false, version, hash };
  }
  const now = (options.now ?? new Date()).toISOString().replace("Z", "");
  await db.con.run(
    "INSERT INTO config_versions (version, content_hash, content, created_at) VALUES ($1, $2, $3, $4::TIMESTAMP)",
    [version, hash, text, now] as never,
  );
  return { stored: true, version, hash };
}

/** All stored configuration versions ordered by creation time. */
export async function storedConfigVersions(db: Database): Promise<StoredConfigVersion[]> {
  const reader = await db.con.runAndReadAll(
    "SELECT version, content_hash, content, created_at FROM config_versions ORDER BY created_at",
  );
  return reader.getRowObjectsJS() as unknown as StoredConfigVersion[];
}
