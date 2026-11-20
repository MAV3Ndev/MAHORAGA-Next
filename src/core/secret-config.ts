/**
 * Secret handling for the agent config.
 *
 * The config object holds credentials (LLM key, social cookies, webhook URLs).
 * Returning them verbatim from `/agent/config` and `/agent/status` leaks them to
 * anything that can read the API — dashboards, the Sentinel app, screenshots,
 * log dumps.
 *
 * The constraint that makes this non-trivial: the dashboard loads the whole
 * config, edits it locally, and POSTs it back. If we simply blank the secrets
 * on read, the next save would overwrite the real credentials with the blank
 * value. So masking must be paired with "empty means unchanged" on write.
 *
 * Clears are explicit: POST `clear_secrets: ["llm_api_key"]`.
 */

/** String-valued credentials. Blanked on read; empty input on write is ignored. */
export const SECRET_CONFIG_KEYS = [
  "llm_api_key",
  "typesafe_api_key",
  "alpha_vantage_api_key",
  "twitter_cookies",
  "reddit_cookies",
  "discord_webhook_url",
] as const;

/** Array-valued credentials (cookie account lists). Empty input on write is ignored. */
export const SECRET_CONFIG_ARRAY_KEYS = ["twitter_cookie_accounts", "reddit_cookie_accounts"] as const;

export type SecretConfigKey = (typeof SECRET_CONFIG_KEYS)[number];
export type SecretConfigArrayKey = (typeof SECRET_CONFIG_ARRAY_KEYS)[number];

const SECRET_KEYS = new Set<string>([...SECRET_CONFIG_KEYS, ...SECRET_CONFIG_ARRAY_KEYS]);

export function isSecretConfigKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

function isBlankString(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

function isBlankArray(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0;
}

export interface MaskedAgentConfig {
  /** Copy of the config with every credential replaced by an empty value. */
  config: Record<string, unknown>;
  /** Which credentials are currently populated, so a UI can show "set" without the value. */
  secretFieldsSet: Record<string, boolean>;
}

/**
 * Replace credentials with empty values and report which ones are set.
 * The input object is never mutated.
 */
export function maskAgentConfig(config: Record<string, unknown>): MaskedAgentConfig {
  const masked: Record<string, unknown> = { ...config };
  const secretFieldsSet: Record<string, boolean> = {};

  for (const key of SECRET_CONFIG_KEYS) {
    secretFieldsSet[key] = !isBlankString(masked[key]);
    if (key in masked) masked[key] = "";
  }

  for (const key of SECRET_CONFIG_ARRAY_KEYS) {
    const value = masked[key];
    secretFieldsSet[key] = Array.isArray(value) && value.length > 0;
    if (key in masked) masked[key] = [];
  }

  return { config: masked, secretFieldsSet };
}

/**
 * Drop secret keys whose incoming value is blank, so a config round-trip through
 * a UI (load → edit unrelated field → save) cannot erase stored credentials.
 *
 * @param update    incoming partial config
 * @param clearKeys secrets the caller explicitly asked to clear
 */
export function stripBlankSecrets<T extends Record<string, unknown>>(
  update: T,
  clearKeys: readonly string[] = []
): Partial<T> {
  const clearing = new Set(clearKeys);
  const arrayKeys = new Set<string>(SECRET_CONFIG_ARRAY_KEYS);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(update)) {
    if (clearing.has(key)) {
      out[key] = arrayKeys.has(key) ? [] : "";
      continue;
    }
    if (SECRET_CONFIG_KEYS.includes(key as SecretConfigKey) && isBlankString(value)) {
      continue;
    }
    if (arrayKeys.has(key) && isBlankArray(value)) {
      continue;
    }
    out[key] = value;
  }

  // A clear request must apply even when the caller did not include the key.
  for (const key of clearing) {
    if (!(key in out)) {
      out[key] = arrayKeys.has(key) ? [] : "";
    }
  }

  return out as Partial<T>;
}
