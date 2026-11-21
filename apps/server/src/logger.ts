/**
 * Structured logging and log rotation (#196).
 * JSON lines with level, time, module. Stored in data volume with size limit and rotation.
 * Redacts secrets (API keys, authorization headers, passwords) and personal paths.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  time: string;
  module: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Log directory or file path. If directory, 'vigil.log' is used. */
  logPath?: string;
  /** Maximum file size in bytes before rotating. Default: 5MB (5 * 1024 * 1024). */
  maxBytes?: number;
  /** Maximum number of backup files to keep. Default: 3. */
  maxFiles?: number;
  /** Minimum level to record. Default: 'info'. */
  minLevel?: LogLevel;
  /** Module name. Default: 'root'. */
  module?: string;
  /** Also write to console (useful in dev/tests). Default: false. */
  console?: boolean;
  /** List of configured secret values (e.g. API keys) to redact in logs. */
  secrets?: string[];
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SECRET_KEY_REGEX =
  /^(?:api[_-]?key|token|(?:access|refresh|id|auth)[_-]?token|secret|client[_-]?secret|password|passwd|auth(?:orization)?|bearer)$/i;
const SECRET_VALUE_REGEX =
  /(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z-_]{20,}|gh[op]_[A-Za-z0-9]{20,})/gi;
const HOME_PATH_REGEX = /(?:[A-Za-z]:\\Users\\[^\\]+|\/(?:Users|home)\/[^/]+)/gi;

/** Redacts secrets, tokens, passwords and user home paths. */
export function sanitize(value: unknown, secrets: string[] = []): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) {
      if (secret && secret.length > 0) {
        result = result.replaceAll(secret, "[REDACTED_SECRET]");
      }
    }
    return result.replace(SECRET_VALUE_REGEX, "[REDACTED_SECRET]").replace(HOME_PATH_REGEX, "[HOME]");
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitize(value.message, secrets),
      stack: value.stack ? sanitize(value.stack, secrets) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, secrets));
  }

  if (typeof value === "object") {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_REGEX.test(k)) {
        sanitizedObj[k] = "[REDACTED]";
      } else {
        sanitizedObj[k] = sanitize(v, secrets);
      }
    }
    return sanitizedObj;
  }

  return value;
}

export class Logger {
  readonly logPath: string | null;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly minLevel: LogLevel;
  readonly module: string;
  readonly console: boolean;
  readonly secrets: string[];

  constructor(options: LoggerOptions = {}) {
    this.logPath = options.logPath ?? null;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    this.minLevel = options.minLevel ?? "info";
    this.module = options.module ?? "root";
    this.console = options.console ?? false;
    this.secrets = (options.secrets ?? []).filter((s): s is string => typeof s === "string" && s.trim().length > 0);

    if (this.logPath) {
      mkdirSync(dirname(this.logPath), { recursive: true });
    }
  }

  child(moduleName: string): Logger {
    return new Logger({
      logPath: this.logPath ?? undefined,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      minLevel: this.minLevel,
      module: moduleName,
      console: this.console,
      secrets: this.secrets,
    });
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private rotate(logPath: string, newBytes: number): void {
    if (!existsSync(logPath)) return;

    try {
      const stats = statSync(logPath);
      if (stats.size + newBytes <= this.maxBytes) return;

      // Delete the oldest backup file if it exists
      const oldestBackup = `${logPath}.${this.maxFiles}`;
      if (existsSync(oldestBackup)) {
        rmSync(oldestBackup, { force: true });
      }

      // Shift existing backups: .i -> .(i+1) for i = maxFiles - 1 down to 1
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const oldFile = `${logPath}.${i}`;
        const nextFile = `${logPath}.${i + 1}`;
        if (existsSync(oldFile)) {
          renameSync(oldFile, nextFile);
        }
      }

      // Rotate primary log file to .1
      renameSync(logPath, `${logPath}.1`);
    } catch {
      // Rotation failures must not crash the application
    }
  }

  log(level: LogLevel, message: string, details?: unknown): void {
    if (!this.shouldLog(level)) return;

    const time = new Date().toISOString();
    const cleanMessage = String(sanitize(message, this.secrets));
    const cleanDetails =
      details !== undefined ? (sanitize(details, this.secrets) as Record<string, unknown>) : undefined;

    const entry: LogEntry = {
      level,
      time,
      module: this.module,
      message: cleanMessage,
    };
    if (cleanDetails !== undefined) {
      entry.details = cleanDetails;
    }

    const line = `${JSON.stringify(entry)}\n`;

    if (this.console) {
      if (level === "error") console.error(line.trim());
      else if (level === "warn") console.warn(line.trim());
      else console.log(line.trim());
    }

    if (this.logPath) {
      this.rotate(this.logPath, Buffer.byteLength(line, "utf-8"));
      appendFileSync(this.logPath, line, "utf-8");
    }
  }

  debug(message: string, details?: unknown): void {
    this.log("debug", message, details);
  }

  info(message: string, details?: unknown): void {
    this.log("info", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.log("warn", message, details);
  }

  error(message: string, errorOrDetails?: unknown): void {
    this.log("error", message, errorOrDetails);
  }
}

/** Default logger factory for the server. */
export function createLogger(dataDir: string, module = "server", options: Partial<LoggerOptions> = {}): Logger {
  const logPath = join(dataDir, "logs", "vigil.log");
  return new Logger({
    logPath,
    module,
    ...options,
  });
}
