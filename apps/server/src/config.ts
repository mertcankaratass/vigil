/**
 * The configuration file (#69): thresholds and definitions, validated by `parseConfig` in `packages/core`.
 * `config/vigil.json` at the repository root unless `VIGIL_CONFIG` names another file. A missing or invalid file is
 * an error: the rules never run on built-in values.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, parseConfig, type VigilConfig } from "@vigil/core";
import { type Database, rows } from "./db.ts";

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

/** Canonical JSON representation with recursively sorted keys, independent of whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(",")}}`;
}

/** SHA-256 hash of configuration canonical form, hex. */
export function configHash(textOrObj: unknown): string {
  if (typeof textOrObj === "string") {
    try {
      const parsed = JSON.parse(textOrObj);
      return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
    } catch {
      return createHash("sha256").update(textOrObj).digest("hex");
    }
  }
  return createHash("sha256").update(canonicalJson(textOrObj)).digest("hex");
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
  const existing = await rows(db, "SELECT content_hash, content FROM config_versions WHERE version = $1", [version]);
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
  const result = await rows(
    db,
    "SELECT version, content_hash, content, created_at FROM config_versions ORDER BY created_at",
  );
  return result as unknown as StoredConfigVersion[];
}
