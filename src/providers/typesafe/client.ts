import type { Env } from "../../env.d";
import { createError, ErrorCode } from "../../lib/errors";

/**
 * TypeSafe (Jev) System One client.
 *
 * Jev is not a text-generating LLM: it evaluates a `state` payload against a map
 * of typed questions (choice / score / noul) and returns structured answers with
 * probabilities and confidence. Code owns the workflow; Jev supplies the
 * judgments.
 *
 * API: POST {baseUrl}/v1/systemone — see https://docs.typesafe.ai/api
 */

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface NoulQuestion {
  type: "noul";
  instructions: JsonValue;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: JsonValue;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: JsonValue;
  criteria: string[];
}

export type TypeSafeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type TypeSafeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
  state: JsonValue;
  questions: Record<string, TypeSafeQuestion>;
  model?: string;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface TypeSafeClientConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class TypeSafeClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: TypeSafeClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
    this.model = config.model ?? TYPESAFE_DEFAULT_MODEL;
  }

  get modelId(): string {
    return this.model;
  }

  async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
    const response = await fetch(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        state: request.state,
        model: request.model ?? this.model,
        questions: request.questions,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw createError(ErrorCode.PROVIDER_ERROR, `TypeSafe API error (${response.status}): ${errorText}`);
    }

    return (await response.json()) as SystemOneResponse;
  }
}

export function createTypeSafeClient(config: TypeSafeClientConfig): TypeSafeClient {
  return new TypeSafeClient(config);
}

/**
 * Build a client from Worker env bindings.
 * Returns null when TYPESAFE_API_KEY is not configured.
 */
export function createTypeSafeClientFromEnv(env: Env): TypeSafeClient | null {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  return new TypeSafeClient({
    apiKey,
    baseUrl: env.TYPESAFE_BASE_URL,
    model: env.TYPESAFE_MODEL,
  });
}

/** Narrow an answer to a choice answer, or null. */
export function asChoiceAnswer(answer: TypeSafeAnswer | undefined): ChoiceAnswer | null {
  return answer?.type === "choice" ? answer : null;
}

/** Narrow an answer to a score answer, or null. */
export function asScoreAnswer(answer: TypeSafeAnswer | undefined): ScoreAnswer | null {
  return answer?.type === "score" ? answer : null;
}
