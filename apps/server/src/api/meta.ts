/**
 * GET /v1/meta endpoint (#216, docs/API.md).
 * Returns loaded quarters, file counts, quality summary, app version and config version.
 */
import type { Meta, Quality } from "@vigil/api-types";
import type { Hono } from "hono";
import pkg from "../../../../package.json";
import { loadConfig } from "../config.ts";
import { type Database, rows } from "../db.ts";

export interface MetaOptions {
  /** DuckDB database instance. If omitted, quarters list is empty. */
  db?: Database;
  /** Override the app version (default reads root package.json). */
  appVersion?: string;
  /** Override the config version (default reads config/vigil.json). */
  configVersion?: string;
}

export const APP_VERSION = pkg.version;

export async function fetchMeta(options: MetaOptions = {}): Promise<Meta> {
  const app_version = options.appVersion ?? APP_VERSION;
  let config_version = options.configVersion ?? "";
  if (!config_version) {
    try {
      config_version = loadConfig().version;
    } catch {
      config_version = "default";
    }
  }

  if (!options.db) {
    return {
      app_version,
      config_version,
      quarters: [],
    };
  }

  const query = `
    WITH report_quality AS (
      SELECT
        r.year || '-' || r.quarter AS quarter,
        r.disclosure_id,
        CASE
          WHEN r.fact_count = 0 THEN 'no_values'
          WHEN COUNT(CASE WHEN c.severity = 'blocking' AND c.status = 'fail' AND c.known_error IS NULL THEN 1 END) > 0 THEN 'fail'
          WHEN COUNT(CASE WHEN c.known_error IS NOT NULL THEN 1 END) > 0 THEN 'known_error'
          WHEN COUNT(CASE WHEN c.severity = 'blocking' AND c.status = 'pass' THEN 1 END) > 0 THEN 'pass'
          ELSE 'not_checked'
        END AS quality
      FROM reports r
      LEFT JOIN check_results c USING (disclosure_id)
      GROUP BY r.year, r.quarter, r.disclosure_id, r.fact_count
    )
    SELECT
      quarter,
      quality,
      COUNT(*) AS count
    FROM report_quality
    GROUP BY quarter, quality
    ORDER BY quarter
  `;

  const resultRows = await rows(options.db, query);
  const quartersMap = new Map<string, { files: number; quality: Partial<Record<Quality, number>> }>();

  for (const r of resultRows) {
    const q = String(r.quarter);
    const qual = String(r.quality) as Quality;
    const cnt = Number(r.count);

    let entry = quartersMap.get(q);
    if (!entry) {
      entry = { files: 0, quality: {} };
      quartersMap.set(q, entry);
    }
    entry.files += cnt;
    entry.quality[qual] = (entry.quality[qual] ?? 0) + cnt;
  }

  const quarters = Array.from(quartersMap.entries()).map(([quarter, data]) => ({
    quarter,
    files: data.files,
    quality: data.quality,
  }));

  return {
    app_version,
    config_version,
    quarters,
  };
}

export function metaRoutes(options: MetaOptions = {}) {
  return (v1: Hono) => {
    v1.get("/meta", async (c) => {
      const meta = await fetchMeta(options);
      return c.json(meta, 200);
    });
  };
}
