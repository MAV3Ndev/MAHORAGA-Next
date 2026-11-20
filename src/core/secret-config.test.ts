import { describe, expect, it } from "vitest";
import {
  SECRET_CONFIG_ARRAY_KEYS,
  SECRET_CONFIG_KEYS,
  maskAgentConfig,
  stripBlankSecrets,
} from "./secret-config";
import { buildAgentConfigUpdateCandidate } from "./config-update";
import { DEFAULT_CONFIG } from "../strategy/default/config";

describe("maskAgentConfig", () => {
  it("blanks every credential and reports which are set", () => {
    const config = {
      ...DEFAULT_CONFIG,
      llm_api_key: "sk-live-secret",
      typesafe_api_key: "apikey_secret",
      alpha_vantage_api_key: "AVSECRET",
      twitter_cookies: "auth_token=abc",
      reddit_cookies: "token_v2=xyz",
      discord_webhook_url: "https://discord.com/api/webhooks/1/abc",
      twitter_cookie_accounts: [{ cookies: "auth_token=abc" }],
      reddit_cookie_accounts: [{ cookies: "token_v2=xyz" }],
    };

    const { config: masked, secretFieldsSet } = maskAgentConfig(config);

    for (const key of SECRET_CONFIG_KEYS) {
      expect(masked[key]).toBe("");
      expect(secretFieldsSet[key]).toBe(true);
    }
    for (const key of SECRET_CONFIG_ARRAY_KEYS) {
      expect(masked[key]).toEqual([]);
      expect(secretFieldsSet[key]).toBe(true);
    }
    // Non-secret values survive untouched.
    expect(masked.llm_model).toBe(config.llm_model);
    expect(masked.stop_loss_pct).toBe(config.stop_loss_pct);
  });

  it("does not mutate the input", () => {
    const config = { ...DEFAULT_CONFIG, llm_api_key: "sk-live" };
    maskAgentConfig(config);
    expect(config.llm_api_key).toBe("sk-live");
  });

  it("reports unset credentials as false", () => {
    const { secretFieldsSet } = maskAgentConfig({ ...DEFAULT_CONFIG, llm_api_key: "   " });
    expect(secretFieldsSet.llm_api_key).toBe(false);
  });
});

describe("stripBlankSecrets", () => {
  it("drops blank secrets so a UI round-trip cannot erase them", () => {
    const out = stripBlankSecrets({
      llm_api_key: "",
      typesafe_api_key: "   ",
      twitter_cookie_accounts: [],
      stop_loss_pct: 3,
    });
    expect("llm_api_key" in out).toBe(false);
    expect("typesafe_api_key" in out).toBe(false);
    expect("twitter_cookie_accounts" in out).toBe(false);
    expect(out.stop_loss_pct).toBe(3);
  });

  it("keeps non-blank secrets", () => {
    const out = stripBlankSecrets({ llm_api_key: "sk-new" });
    expect(out.llm_api_key).toBe("sk-new");
  });

  it("clears only when explicitly requested", () => {
    const out = stripBlankSecrets({ llm_api_key: "", twitter_cookie_accounts: [] }, ["llm_api_key"]);
    expect(out.llm_api_key).toBe("");
  });

  it("never strips ordinary empty strings", () => {
    const out = stripBlankSecrets({ reddit_user_agent: "", openai_base_url: "" });
    expect(out.reddit_user_agent).toBe("");
    expect(out.openai_base_url).toBe("");
  });
});

describe("buildAgentConfigUpdateCandidate preserves stored credentials", () => {
  const current = {
    ...DEFAULT_CONFIG,
    llm_api_key: "sk-stored",
    typesafe_api_key: "ts-stored",
    twitter_cookies: "auth_token=stored",
    alpha_vantage_api_key: "av-stored",
  };

  it("keeps the stored key when a round-tripped config sends blanks", () => {
    const masked = maskAgentConfig(current).config as Record<string, unknown>;
    const merged = buildAgentConfigUpdateCandidate({
      currentConfig: current,
      update: { ...masked, stop_loss_pct: 3 } as never,
    });

    expect(merged.llm_api_key).toBe("sk-stored");
    expect(merged.typesafe_api_key).toBe("ts-stored");
    expect(merged.twitter_cookies).toBe("auth_token=stored");
    expect(merged.alpha_vantage_api_key).toBe("av-stored");
    // The actual edit still lands.
    expect(merged.stop_loss_pct).toBe(3);
  });

  it("accepts a genuine new credential", () => {
    const merged = buildAgentConfigUpdateCandidate({
      currentConfig: current,
      update: { llm_api_key: "sk-rotated" },
    });
    expect(merged.llm_api_key).toBe("sk-rotated");
  });

  it("clears only on explicit request", () => {
    const merged = buildAgentConfigUpdateCandidate({
      currentConfig: current,
      update: {},
      clearSecrets: ["llm_api_key"],
    });
    expect(merged.llm_api_key).toBe("");
    expect(merged.typesafe_api_key).toBe("ts-stored");
  });
});