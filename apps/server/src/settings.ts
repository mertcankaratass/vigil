/**
 * Settings file schema, defaults and validation (#195, decision 0008).
 * Stored as JSON in the data volume. KAP polite-access rules cannot be configured.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LlmProvider, Settings } from "@vigil/api-types";

export class SettingsError extends Error {
  override name = "SettingsError";
}

export const VALID_PROVIDERS: readonly LlmProvider[] = ["anthropic", "gemini", "openai_compatible", "ollama"];

/** Default data directory, configurable via VIGIL_DATA_DIR. */
export const DEFAULT_DATA_DIR = process.env.VIGIL_DATA_DIR ?? "data";

export interface StoredLlmSettings {
  provider: LlmProvider;
  model: string;
  base_url: string | null;
  api_key: string | null;
}

export interface StoredSettings {
  data_dir: string;
  quarters: string[];
  llm: StoredLlmSettings | null;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  data_dir: DEFAULT_DATA_DIR,
  quarters: [],
  llm: null,
};

export const DEFAULT_SETTINGS_FILE = "vigil.settings.json";

export function defaultSettingsPath(dataDir = DEFAULT_DATA_DIR): string {
  return join(dataDir, DEFAULT_SETTINGS_FILE);
}

const QUARTER_REGEX = /^(\d{4})[-_]([1-4])$/;

export function validateSettings(raw: unknown): StoredSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettingsError("Ayarlar bir JSON nesnesi olmalıdır (Settings must be a JSON object).");
  }

  const obj = raw as Record<string, unknown>;

  // KAP polite-access rules cannot be configured (decision 0008, #195)
  const forbiddenKeys = ["kap_rate", "kap_delay", "request_rate", "rate_limit", "kap_interval"];
  for (const k of forbiddenKeys) {
    if (k in obj) {
      throw new SettingsError(
        `KAP erişim kuralları değiştirilemez (KAP request rate cannot be changed, decision 0008): '${k}'`,
      );
    }
  }

  // data_dir
  let data_dir = DEFAULT_DATA_DIR;
  if ("data_dir" in obj && obj.data_dir !== undefined) {
    if (typeof obj.data_dir !== "string" || obj.data_dir.trim().length === 0) {
      throw new SettingsError("data_dir boş olmayan bir metin olmalıdır (data_dir must be a non-empty string).");
    }
    data_dir = obj.data_dir.trim();
  }

  // quarters
  const quarters: string[] = [];
  if ("quarters" in obj && obj.quarters !== undefined) {
    if (!Array.isArray(obj.quarters)) {
      throw new SettingsError("quarters bir dizi olmalıdır (quarters must be an array).");
    }
    for (const q of obj.quarters) {
      if (typeof q !== "string" || !QUARTER_REGEX.test(q.trim())) {
        throw new SettingsError(
          `Geçersiz çeyrek formatı (Invalid quarter format, expected YYYY-Q like '2026-2'): '${q}'`,
        );
      }
      quarters.push(q.trim().replace("_", "-"));
    }
  }

  // llm
  let llm: StoredLlmSettings | null = null;
  if ("llm" in obj && obj.llm !== undefined && obj.llm !== null) {
    if (typeof obj.llm !== "object" || Array.isArray(obj.llm)) {
      throw new SettingsError("llm bir nesne veya null olmalıdır (llm must be an object or null).");
    }
    const llmObj = obj.llm as Record<string, unknown>;

    const provider = llmObj.provider as LlmProvider;
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new SettingsError(
        `Bilinmeyen LLM sağlayıcısı (Unknown LLM provider): '${provider}'. Geçerli olanlar: ${VALID_PROVIDERS.join(", ")}`,
      );
    }

    if (typeof llmObj.model !== "string" || llmObj.model.trim().length === 0) {
      throw new SettingsError("LLM model adı belirtilmelidir (LLM model name must be provided).");
    }
    const model = llmObj.model.trim();

    let base_url: string | null = null;
    if (provider === "openai_compatible") {
      if (typeof llmObj.base_url !== "string" || llmObj.base_url.trim().length === 0) {
        throw new SettingsError(
          "openai_compatible sağlayıcısı için base_url zorunludur (base_url is required for openai_compatible).",
        );
      }
      base_url = llmObj.base_url.trim();
    } else if (provider === "ollama") {
      base_url =
        typeof llmObj.base_url === "string" && llmObj.base_url.trim().length > 0
          ? llmObj.base_url.trim()
          : "http://127.0.0.1:11434";
    } else if (typeof llmObj.base_url === "string" && llmObj.base_url.trim().length > 0) {
      base_url = llmObj.base_url.trim();
    }

    const api_key = typeof llmObj.api_key === "string" ? llmObj.api_key.trim() : null;

    llm = {
      provider,
      model,
      base_url,
      api_key,
    };
  }

  return {
    data_dir,
    quarters,
    llm,
  };
}

/** Converts stored settings into safe API settings where api_key is masked. */
export function toApiSettings(stored: StoredSettings): Settings {
  return {
    data_dir: stored.data_dir,
    quarters: stored.quarters,
    llm: stored.llm
      ? {
          provider: stored.llm.provider,
          model: stored.llm.model,
          base_url: stored.llm.base_url,
          api_key_set: Boolean(stored.llm.api_key && stored.llm.api_key.length > 0),
        }
      : null,
  };
}

/** Reads settings from file. Missing file returns default settings. Invalid file throws SettingsError. */
export function readSettings(path = defaultSettingsPath()): StoredSettings {
  if (!existsSync(path)) {
    return { ...DEFAULT_SETTINGS, quarters: [...DEFAULT_SETTINGS.quarters] };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    throw new SettingsError(`Ayarlar dosyası okunamadı (cannot read settings file ${path}): ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SettingsError(`Ayarlar dosyası geçerli JSON değil (invalid JSON in ${path}): ${(e as Error).message}`);
  }

  return validateSettings(parsed);
}

/** Validates and writes settings to file. Creates parent directories if needed. */
export function writeSettings(path: string, settings: unknown): StoredSettings {
  const validated = validateSettings(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(validated, null, 2), "utf-8");
  return validated;
}
