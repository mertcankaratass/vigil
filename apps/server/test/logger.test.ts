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

  test("rotates log files when size limit is exceeded", () => {
    // Small limit to trigger rotation quickly
    const logger = new Logger({
      logPath: logFile,
      maxBytes: 150,
      maxFiles: 3,
      module: "rotate-test",
    });

    for (let i = 0; i < 10; i++) {
      logger.info(`Message number ${i} to fill bytes`);
    }

    expect(existsSync(logFile)).toBe(true);
    expect(existsSync(`${logFile}.1`)).toBe(true);

    // Ensure rotated backup file contains valid JSON lines
    const backupContent = readFileSync(`${logFile}.1`, "utf-8");
    const lines = backupContent.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toBeDefined();
    expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
  });

  test("redacts API keys, bearer tokens, passwords and personal paths", () => {
    const logger = new Logger({ logPath: logFile, module: "security" });

    logger.error("Failed to connect with secret", {
      api_key: "sk-ant-live-supersecret123456",
      token: "secret-token-value",
      password: "adminpassword",
      authorization: "Bearer my-jwt-token-xyz12345",
      path: "C:\\Users\\admin\\data\\file.json",
      normal_info: "safe-value",
    });

    const content = readFileSync(logFile, "utf-8");
    expect(content).not.toContain("sk-ant-live");
    expect(content).not.toContain("secret-token-value");
    expect(content).not.toContain("adminpassword");
    expect(content).not.toContain("my-jwt-token-xyz12345");
    expect(content).not.toContain("C:\\Users\\admin");

    const parsed = JSON.parse(content.trim());
    expect(parsed.details.api_key).toBe("[REDACTED]");
    expect(parsed.details.token).toBe("[REDACTED]");
    expect(parsed.details.password).toBe("[REDACTED]");
    expect(parsed.details.authorization).toBe("[REDACTED]");
    expect(parsed.details.normal_info).toBe("safe-value");
  });

  test("sanitize utility function handles nested objects and errors", () => {
    const err = new Error("Failed at /Users/developer/secret.txt with Bearer eyJhbGciOi...");
    const sanitizedErr = sanitize(err) as { message: string };
    expect(sanitizedErr.message).toContain("[HOME]");
    expect(sanitizedErr.message).toContain("[REDACTED_SECRET]");
    expect(sanitizedErr.message).not.toContain("/Users/developer");
  });
});
