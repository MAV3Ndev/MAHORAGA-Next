import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../lib/errors";
import {
  asChoiceAnswer,
  asScoreAnswer,
  createTypeSafeClient,
  createTypeSafeClientFromEnv,
  TypeSafeClient,
} from "./client";

describe("TypeSafeClient", () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("createTypeSafeClient", () => {
    it("creates client with required config", () => {
      const client = createTypeSafeClient({ apiKey: "ts-test" });
      expect(client).toBeInstanceOf(TypeSafeClient);
      expect(client.modelId).toBe("jev-latest");
    });

    it("uses custom model", () => {
      const client = createTypeSafeClient({ apiKey: "ts-test", model: "jev-1" });
      expect(client.modelId).toBe("jev-1");
    });
  });

  describe("systemOne", () => {
    it("sends correct request to the TypeSafe API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "jev-latest",
          answers: {
            is_urgent: { type: "noul", noul: 0.92 },
          },
          usage: { input_tokens: 312, output_tokens: 48 },
        }),
      });

      const client = createTypeSafeClient({ apiKey: "ts-test" });
      await client.systemOne({
        state: "Help! My payouts have been failing for 3 days.",
        questions: {
          is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
        },
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(options.method).toBe("POST");
      expect(options.headers).toMatchObject({
        "Content-Type": "application/json",
        Authorization: "Bearer ts-test",
      });

      const body = JSON.parse(options.body as string);
      expect(body.model).toBe("jev-latest");
      expect(body.state).toBe("Help! My payouts have been failing for 3 days.");
      expect(body.questions.is_urgent.type).toBe("noul");
    });

    it("returns typed answers and usage", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "jev-latest",
          answers: {
            department: {
              type: "choice",
              choice: "technical",
              probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
              confidence: 0.82,
            },
          },
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      });

      const client = createTypeSafeClient({ apiKey: "ts-test" });
      const result = await client.systemOne({
        state: { document: "App crashes on launch" },
        questions: {
          department: {
            type: "choice",
            instructions: "Which team should handle this?",
            criteria: { billing: null, technical: null, sales: null },
          },
        },
      });

      const answer = asChoiceAnswer(result.answers.department);
      expect(answer?.choice).toBe("technical");
      expect(answer?.probabilities.technical).toBe(0.85);
      expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    });

    it("uses custom base URL and model override", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: "jev-1", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
      });

      const client = createTypeSafeClient({ apiKey: "ts-test", baseUrl: "https://typesafe.example.com/" });
      await client.systemOne({ state: "x", questions: {}, model: "jev-1" });

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://typesafe.example.com/v1/systemone");
      expect(JSON.parse(options.body as string).model).toBe("jev-1");
    });

    it("throws PROVIDER_ERROR on API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Invalid API key",
      });

      const client = createTypeSafeClient({ apiKey: "bad" });
      await expect(client.systemOne({ state: "x", questions: {} })).rejects.toMatchObject({
        code: ErrorCode.PROVIDER_ERROR,
        message: expect.stringContaining("401"),
      });
    });
  });

  describe("createTypeSafeClientFromEnv", () => {
    it("returns null without TYPESAFE_API_KEY", () => {
      expect(createTypeSafeClientFromEnv({} as never)).toBeNull();
    });

    it("creates a client when TYPESAFE_API_KEY is set", () => {
      const client = createTypeSafeClientFromEnv({ TYPESAFE_API_KEY: "ts-key" } as never);
      expect(client).toBeInstanceOf(TypeSafeClient);
    });
  });

  describe("answer narrowing helpers", () => {
    it("narrows choice answers", () => {
      expect(asChoiceAnswer({ type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 })?.choice).toBe("a");
      expect(asChoiceAnswer({ type: "noul", noul: 0.5 })).toBeNull();
      expect(asChoiceAnswer(undefined)).toBeNull();
    });

    it("narrows score answers", () => {
      expect(
        asScoreAnswer({
          type: "score",
          score: 1.5,
          legend: { "0": "low", "1": "high" },
          probabilities: { "0": 0.5, "1": 0.5 },
          confidence: 0.4,
        })?.score
      ).toBe(1.5);
      expect(asScoreAnswer({ type: "noul", noul: 0.5 })).toBeNull();
    });
  });
});
