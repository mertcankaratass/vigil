/**
 * Structured logging and log rotation tests (#196).
 * Checks JSON formatting, log rotation at size limit, and redaction of secrets/personal paths.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, sanitize } from "../src/logger.ts";

describe("Logger (#196)", () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vigil-logs-"));
    logFile = join(dir, "vigil.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes structured JSON lines with level, time, module and message", () => {
    const logger = new Logger({ logPath: logFile, module: "test-module" });
    logger.info("Application starting", { port: 8787 });

    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8").trim();
    const parsed = JSON.parse(content);

    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("test-module");
    expect(parsed.message).toBe("Application starting");
    expect(parsed.details).toEqual({ port: 8787 });
    expect(typeof parsed.time).toBe("string");
    expect(new Date(parsed.time).getTime()).toBeGreaterThan(0);
  });

  test("rotates log files keeping exactly maxFiles backups when size limit is exceeded", () => {
    // Small limit to trigger rotation quickly
    const logger = new Logger({
      logPath: logFile,
      maxBytes: 150,
      maxFiles: 3,
      module: "rotate-test",
    });

    for (let i = 0; i < 30; i++) {
      logger.info(`Message number ${i} to fill bytes and trigger rotation`);
    }

    expect(existsSync(logFile)).toBe(true);
    expect(existsSync(`${logFile}.1`)).toBe(true);
    expect(existsSync(`${logFile}.2`)).toBe(true);
    expect(existsSync(`${logFile}.3`)).toBe(true);
    expect(existsSync(`${logFile}.4`)).toBe(false);

    // Ensure rotated backup files contain valid JSON lines
    for (const f of [`${logFile}.1`, `${logFile}.2`, `${logFile}.3`]) {
      const backupContent = readFileSync(f, "utf-8");
      const lines = backupContent.trim().split("\n");
      expect(lines.length).toBeGreaterThan(0);
      expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
    }
  });

  test("redacts API keys, bearer tokens, passwords, personal paths, and keeps harmless fields", () => {
    const customSecret = "super-secret-custom-key-123";
    const logger = new Logger({
      logPath: logFile,
      module: "security",
      secrets: [customSecret],
    });

    logger.error(`Failed to connect with secret ${customSecret}`, {
      api_key: "sk-ant-live-supersecret123456",
      gemini_key_in_msg: "AIzaSyA_test_123456789012345678901234",
      groq_key_in_msg: "gsk_test1234567890abcdef1234567890",
      token: "secret-token-value",
      password: "adminpassword",
      authorization: "Bearer my-jwt-token-xyz12345",
      path: "C:\\Users\\admin\\data\\file.json",
      normal_info: "safe-value",
      author: "Jane Doe",
      token_count: 120,
    });

    const content = readFileSync(logFile, "utf-8");
    expect(content).not.toContain(customSecret);
    expect(content).not.toContain("sk-ant-live");
    expect(content).not.toContain("AIzaSyA_test");
    expect(content).not.toContain("gsk_test123456");
    expect(content).not.toContain("secret-token-value");
    expect(content).not.toContain("adminpassword");
    expect(content).not.toContain("my-jwt-token-xyz12345");
    expect(content).not.toContain("C:\\Users\\admin");

    const parsed = JSON.parse(content.trim());
    expect(parsed.message).toContain("[REDACTED_SECRET]");
    expect(parsed.details.api_key).toBe("[REDACTED]");
    expect(parsed.details.token).toBe("[REDACTED]");
    expect(parsed.details.password).toBe("[REDACTED]");
    expect(parsed.details.authorization).toBe("[REDACTED]");
    expect(parsed.details.normal_info).toBe("safe-value");
    // Harmless fields must not be redacted
    expect(parsed.details.author).toBe("Jane Doe");
    expect(parsed.details.token_count).toBe(120);
  });

  test("sanitize utility function handles nested objects and errors", () => {
    const err = new Error("Failed at /Users/developer/secret.txt with Bearer eyJhbGciOi...");
    const sanitizedErr = sanitize(err) as { message: string };
    expect(sanitizedErr.message).toContain("[HOME]");
    expect(sanitizedErr.message).toContain("[REDACTED_SECRET]");
    expect(sanitizedErr.message).not.toContain("/Users/developer");
  });
});
