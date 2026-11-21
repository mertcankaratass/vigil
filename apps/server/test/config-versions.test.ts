/**
 * Configuration versions in DuckDB (#187): table `config_versions` stores active thresholds with version, content hash,
 * raw content and creation time. Changing thresholds creates a new version and old findings keep the old one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { ConfigError, detectGrossMarginDeviation, type SignalObject } from "@vigil/core";
import { CONFIG, katmrFromGolden } from "../../../packages/core/test/helpers.ts";
import {
  configHash,
  DEFAULT_CONFIG_PATH,
  storeActiveConfig,
  storeConfigVersion,
  storedConfigVersions,
} from "../src/config.ts";
import { close, connect, loadFiling, rows } from "../src/db.ts";
import { writeFindings } from "../src/findings-store.ts";
import { CURRENT_VERSION, migrate, schemaVersion } from "../src/migrate.ts";
import { MIGRATIONS } from "../src/schema.ts";

const KATMR = 1651411;

describe("config_versions (#187)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vigil-cfg-ver-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("migration 9 adds config_versions table to a version 8 database", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const con = await instance.connect();
    await migrate(
      con,
      MIGRATIONS.filter((m) => m.version <= 8),
    );
    expect(await schemaVersion(con)).toBe(8);

    const applied = await migrate(con);
    expect(applied).toEqual([9]);
    expect(await schemaVersion(con)).toBe(CURRENT_VERSION);

    const cols = (
      await con.runAndReadAll(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'config_versions' ORDER BY ordinal_position",
      )
    )
      .getRowObjectsJS()
      .map((r) => String(r.column_name));
    expect(cols).toEqual(["version", "content_hash", "content", "created_at"]);
    con.closeSync();
    instance.closeSync();
  });

  test("connect stores active config at startup if new", async () => {
    const db = await connect(":memory:");
    try {
      const versions = await storedConfigVersions(db);
      expect(versions).toHaveLength(1);
      const active = versions[0];
      const text = readFileSync(DEFAULT_CONFIG_PATH, "utf8");
      expect(active?.version).toBe(CONFIG.version);
      expect(active?.content_hash).toBe(configHash(text));
      expect(active?.content).toBe(text);
      expect(active?.created_at).toBeDefined();
    } finally {
      close(db);
    }
  });

  test("reconnecting or re-storing the same config does not duplicate or overwrite", async () => {
    const dbPath = join(dir, "test.duckdb");
    const db1 = await connect(dbPath);
    const versions1 = await storedConfigVersions(db1);
    expect(versions1).toHaveLength(1);
    const created1 = versions1[0]?.created_at;
    close(db1);

    const db2 = await connect(dbPath);
    try {
      const versions2 = await storedConfigVersions(db2);
      expect(versions2).toHaveLength(1);
      expect(versions2[0]?.created_at).toEqual(created1);

      const res = await storeActiveConfig(db2);
      expect(res.stored).toBe(false);
      expect(res.version).toBe(CONFIG.version);
    } finally {
      close(db2);
    }
  });

  test("changing a threshold requires bumping version; same version with different content throws ConfigError", async () => {
    const db = await connect(":memory:");
    try {
      const text = readFileSync(DEFAULT_CONFIG_PATH, "utf8");
      const modified = JSON.parse(text);
      modified.s1_gross_margin.x_min_abs_delta_bps = 5000;
      const modifiedText = JSON.stringify(modified, null, 2);

      await expect(storeConfigVersion(db, modifiedText, modified.version)).rejects.toThrow(ConfigError);
      await expect(storeConfigVersion(db, modifiedText, modified.version)).rejects.toThrow(/different content hash/);
    } finally {
      close(db);
    }
  });

  test("changing a threshold creates a new version and old findings keep the old one", async () => {
    const db = await connect(":memory:");
    try {
      await loadFiling(db, katmrFromGolden());

      // 1. Finding computed and stored under initial config version
      const s1Initial = detectGrossMarginDeviation(katmrFromGolden(), CONFIG) as SignalObject;
      expect(s1Initial).toBeDefined();
      await writeFindings(db, [KATMR], [s1Initial], { configVersion: CONFIG.version });

      const initialFindings = await rows(db, "SELECT rule, disclosure_id, config_version FROM findings");
      expect(initialFindings).toHaveLength(1);
      expect(initialFindings[0]?.config_version).toBe(CONFIG.version);

      // 2. Thresholds changed with a new version
      const newVersion = "2027-01-01";
      const newConfig = {
        ...CONFIG,
        version: newVersion,
        s1_gross_margin: {
          ...CONFIG.s1_gross_margin,
          x_min_abs_delta_bps: 1500,
        },
      };
      const newConfigText = JSON.stringify(newConfig, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2);
      const storeRes = await storeConfigVersion(db, newConfigText, newVersion);
      expect(storeRes.stored).toBe(true);
      expect(storeRes.version).toBe(newVersion);

      // 3. Finding computed under new config version and stored
      const s1New = detectGrossMarginDeviation(katmrFromGolden(), newConfig) as SignalObject;
      await writeFindings(db, [KATMR], [s1New], { configVersion: newVersion });

      // 4. Old findings kept; new findings present alongside them
      const allFindings = await rows(
        db,
        "SELECT rule, disclosure_id, config_version FROM findings ORDER BY config_version",
      );
      expect(allFindings).toHaveLength(2);
      expect(allFindings.map((f) => f.config_version)).toEqual([CONFIG.version, newVersion]);

      // 5. Config versions table contains both versions
      const versions = await storedConfigVersions(db);
      expect(versions.map((v) => v.version)).toEqual([CONFIG.version, newVersion]);
    } finally {
      close(db);
    }
  });
});
