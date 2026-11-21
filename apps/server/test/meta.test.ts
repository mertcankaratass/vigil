/**
 * GET /v1/meta test (#216).
 * Checks that the endpoint returns app_version, config_version, and matching quarter/quality statistics.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Meta } from "@vigil/api-types";
import { createApp } from "../src/api/app.ts";
import { APP_VERSION, metaRoutes } from "../src/api/meta.ts";
import { close, connect, type Database } from "../src/db.ts";

describe("GET /v1/meta (#216)", () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect(":memory:");
    // Setup test data: 2 reports in 2026-2, 1 report in 2025-4
    await db.con.run(`
      INSERT INTO companies (company_code) VALUES ('TEST1'), ('TEST2');
      INSERT INTO reports (
        disclosure_id, company_code, raw_ticker_group, year, quarter,
        consolidation_type, template_family, scale_unit, scale_multiplier,
        has_tms29_monetary_item, filepath, fact_count, loaded_at
      ) VALUES
        (101, 'TEST1', 'X', 2026, 2, 'C', 'standard', 'TL', 1, false, 'file1.xls', 50, now()),
        (102, 'TEST2', 'X', 2026, 2, 'C', 'standard', 'TL', 1, false, 'file2.xls', 40, now()),
        (103, 'TEST1', 'X', 2025, 4, 'C', 'standard', 'TL', 1, false, 'file3.xls', 0, now());

      -- Report 101: 1 pass check -> quality = 'pass'
      INSERT INTO check_results (
        disclosure_id, position, check_group, name, severity, status,
        left_value, right_value, left_source, right_source, tolerance, reason, known_error
      ) VALUES
        (101, 0, 'balance_sheet', 'chk1', 'blocking', 'pass', 10, 10, 'r1', 'r2', 0, NULL, NULL);

      -- Report 102: 1 fail check (blocking, not known error) -> quality = 'fail'
      INSERT INTO check_results (
        disclosure_id, position, check_group, name, severity, status,
        left_value, right_value, left_source, right_source, tolerance, reason, known_error
      ) VALUES
        (102, 0, 'balance_sheet', 'chk2', 'blocking', 'fail', 10, 20, 'r1', 'r2', 0, NULL, NULL);

      -- Report 103: fact_count = 0 -> quality = 'no_values'
    `);
  });

  afterAll(() => {
    close(db);
  });

  test("returns app_version, config_version, and loaded quarters from database", async () => {
    const app = createApp({ routes: [metaRoutes({ db })] });
    const res = await app.fetch(new Request("http://localhost/v1/meta"));
    expect(res.status).toBe(200);

    const data = (await res.json()) as Meta;
    expect(data.app_version).toBe(APP_VERSION);
    expect(typeof data.config_version).toBe("string");
    expect(data.config_version.length).toBeGreaterThan(0);

    expect(data.quarters).toHaveLength(2);

    const q2025_4 = data.quarters.find((q) => q.quarter === "2025-4");
    expect(q2025_4).toBeDefined();
    expect(q2025_4?.files).toBe(1);
    expect(q2025_4?.quality).toEqual({ no_values: 1 });

    const q2026_2 = data.quarters.find((q) => q.quarter === "2026-2");
    expect(q2026_2).toBeDefined();
    expect(q2026_2?.files).toBe(2);
    expect(q2026_2?.quality).toEqual({ pass: 1, fail: 1 });
  });

  test("supports options overrides and handles empty/missing db gracefully", async () => {
    const app = createApp({
      routes: [metaRoutes({ appVersion: "9.9.9", configVersion: "custom-v1" })],
    });
    const res = await app.fetch(new Request("http://localhost/v1/meta"));
    expect(res.status).toBe(200);

    const data = (await res.json()) as Meta;
    expect(data.app_version).toBe("9.9.9");
    expect(data.config_version).toBe("custom-v1");
    expect(data.quarters).toEqual([]);
  });
});
