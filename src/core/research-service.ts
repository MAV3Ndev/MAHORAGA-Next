import { parseLlmJsonObject } from "../lib/llm-json";
import type { CompletionParams, LLMProvider } from "../providers/types";
import type { PromptTemplate } from "../strategy/types";
import type { AgentConfig } from "./types";

export interface ResearchServiceDeps {
  getLlm: () => LLMProvider | null;
  getConfig: () => AgentConfig;
  log: (agent: string, action: string, details: Record<string, unknown>) => void;
  trackLLMCost: (model: string, tokensIn: number, tokensOut: number) => number;
}

export interface CompletePromptParams {
  prompt: PromptTemplate;
  logAgent: string;
  defaultMaxTokens: number;
  temperature: number;
  validate?: (analysis: unknown) => unknown;
}

const JSON_COMPLETION_MAX_ATTEMPTS = 3;

export function isUnknownModelError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("unknown model") || message.includes('"1211"') || message.includes('code":"1211');
}

export function isRateLimitError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("rate_limit") ||
    message.includes("temporarily overloaded") ||
    message.includes("try again later")
  );
}

export class ResearchService {
  constructor(private readonly deps: ResearchServiceDeps) {}

  async completePromptJson<T>({
    prompt,
    logAgent,
    defaultMaxTokens,
    temperature,
    validate,
  }: CompletePromptParams): Promise<{ analysis: T; model: string }> {
    const config = this.deps.getConfig();
    const preferredModel = prompt.model || config.llm_analyst_model || config.llm_model;
    const fallbackModel = config.llm_model;
    const maxTokens = prompt.maxTokens || defaultMaxTokens;
    const request: CompletionParams = {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_tokens: maxTokens,
      temperature,
      response_format: { type: "json_object" },
    };
    let model = preferredModel;
    let attemptRequest = request;

    for (let attempt = 0; attempt < JSON_COMPLETION_MAX_ATTEMPTS; attempt++) {
      const completion =
        attempt === 0
          ? await this.completeWithFallback(attemptRequest, preferredModel, fallbackModel, logAgent)
          : { response: await this.completeOnce(attemptRequest, model), model };

      model = completion.model;
      this.trackUsage(model, completion.response);

      try {
        const parsed = parseLlmJsonObject<unknown>(completion.response.content || "{}");
        return {
          analysis: (validate ? validate(parsed) : parsed) as T,
          model,
        };
      } catch (error) {
        if (attempt >= JSON_COMPLETION_MAX_ATTEMPTS - 1) {
          throw error;
        }

        const retryMaxTokens = Math.max(maxTokens * (attempt + 3), 1200);
        this.deps.log(logAgent, "json_parse_retry", {
          model,
          attempt: attempt + 1,
          max_tokens: attemptRequest.max_tokens,
          retry_max_tokens: retryMaxTokens,
          reason: String(error),
        });

        attemptRequest = {
          ...request,
          messages: [
            ...request.messages,
            {
              role: "user",
              content:
                "Return the same answer again as one complete, valid JSON object only. Include every required field from the requested schema. Do not include markdown or thinking text.",
            },
          ],
          max_tokens: retryMaxTokens,
        };
      }
    }

    throw new Error("Failed to complete JSON prompt");
  }

  private trackUsage(model: string, response: Awaited<ReturnType<LLMProvider["complete"]>>): void {
    if (response.usage) {
      this.deps.trackLLMCost(model, response.usage.prompt_tokens, response.usage.completion_tokens);
    }
  }

  private async completeWithFallback(
    request: CompletionParams,
    preferredModel: string,
    fallbackModel: string | undefined,
    logAgent: string
  ) {
    try {
      const response = await this.completeOnce(request, preferredModel);
      return { response, model: preferredModel };
    } catch (error) {
      const shouldRetryWithFallback = !!fallbackModel && fallbackModel !== preferredModel && isUnknownModelError(error);

      if (!shouldRetryWithFallback) {
        throw error;
      }

      this.deps.log(logAgent, "model_fallback", {
        preferred_model: preferredModel,
        fallback_model: fallbackModel,
        reason: "unknown_model",
      });

      const response = await this.completeOnce(request, fallbackModel);
      return { response, model: fallbackModel };
    }
  }

  private async completeOnce(request: CompletionParams, model: string) {
    const llm = this.deps.getLlm();
    if (!llm) {
      throw new Error("LLM provider not initialized");
    }

    return llm.complete({
      ...request,
      model,
    });
  }
}
