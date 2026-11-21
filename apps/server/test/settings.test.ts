/**
 * Settings file tests (#195, decision 0008).
 * Checks schema defaults, file read/write, rejection of invalid values, and that KAP rate cannot be changed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DATA_DIR,
  readSettings,
  SettingsError,
  toApiSettings,
  validateSettings,
  writeSettings,
} from "../src/settings.ts";

describe("Settings (#195)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vigil-settings-"));
    file = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file returns default settings", () => {
    const s = readSettings(join(dir, "does-not-exist.json"));
    expect(s.data_dir).toBe(DEFAULT_DATA_DIR);
    expect(s.quarters).toEqual([]);
    expect(s.llm).toBeNull();
  });

  test("reads and writes valid settings file in data folder", () => {
    const stored = writeSettings(file, {
      data_dir: "my_data",
      quarters: ["2026-2", "2025_4"],
      llm: {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        api_key: "sk-ant-test",
      },
    });

    expect(stored.data_dir).toBe("my_data");
    expect(stored.quarters).toEqual(["2026-2", "2025-4"]);
    expect(stored.llm?.provider).toBe("anthropic");
    expect(stored.llm?.api_key).toBe("sk-ant-test");

    const read = readSettings(file);
    expect(read).toEqual(stored);

    const apiSettings = toApiSettings(read);
    expect(apiSettings.llm?.api_key_set).toBe(true);
    // ensure secret key itself is not present on ApiSettings
    expect((apiSettings.llm as unknown as Record<string, unknown>).api_key).toBeUndefined();
  });

  test("rejects unknown keys using strict allowlist (decision 0008, #195)", () => {
    expect(() => validateSettings({ kap_requests_per_second: 5 })).toThrow(/kap_requests_per_second/);
    expect(() => validateSettings({ kap_rate: 10 })).toThrow(/kap_rate/);
    expect(() => validateSettings({ custom_setting: "test" })).toThrow(/custom_setting/);
    expect(() =>
      validateSettings({
        llm: { provider: "anthropic", model: "claude-3-haiku", temperature: 0.5 },
      }),
    ).toThrow(/temperature/);
  });

  test("rejects invalid JSON or non-object structures", () => {
    writeFileSync(file, "not json");
    expect(() => readSettings(file)).toThrow(SettingsError);

    expect(() => validateSettings("hello")).toThrow(SettingsError);
    expect(() => validateSettings(null)).toThrow(SettingsError);
    expect(() => validateSettings([])).toThrow(SettingsError);
  });

  test("rejects invalid quarters format", () => {
    expect(() => validateSettings({ quarters: ["invalid"] })).toThrow(SettingsError);
    expect(() => validateSettings({ quarters: "2026-2" })).toThrow(SettingsError);
  });

  test("validates LLM providers and requirements", () => {
    // unknown provider
    expect(() =>
      validateSettings({
        llm: { provider: "invalid_provider", model: "x" },
      }),
    ).toThrow(/Bilinmeyen LLM/);

    // openai_compatible requires base_url
    expect(() =>
      validateSettings({
        llm: { provider: "openai_compatible", model: "gpt-4" },
      }),
    ).toThrow(/base_url zorunludur/);

    // ollama defaults base_url
    const ollama = validateSettings({
      llm: { provider: "ollama", model: "llama3" },
    });
    expect(ollama.llm?.base_url).toBe("http://127.0.0.1:11434");
  });
});
