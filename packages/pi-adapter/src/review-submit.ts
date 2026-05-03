import {
  type AdapterReviewResult,
  type ReviewSubmitParams,
} from "../../protocol/src/index.js";
import { buildPrompt, createStubRevision, invokePiForReview, normalizeAssistantTextToRevision } from "./pi-client.js";

export async function submitReview(params: ReviewSubmitParams): Promise<AdapterReviewResult> {
  if (process.env.ARP_PI_ADAPTER_DISABLE_LIVE === "1") {
    return {
      adapter: "pi",
      mode: "stub",
      prompt: buildPrompt(params),
      normalized: true,
      revision: createStubRevision(params),
      note: "Live pi invocation disabled by ARP_PI_ADAPTER_DISABLE_LIVE=1.",
    };
  }

  try {
    const result = await invokePiForReview(params, process.cwd());
    return {
      adapter: "pi",
      mode: "live",
      prompt: result.prompt,
      normalized: result.normalized,
      rawOutput: result.rawOutput,
      revision: result.revision,
    };
  } catch (invokeError) {
    return {
      adapter: "pi",
      mode: "fallback",
      prompt: buildPrompt(params),
      normalized: false,
      revision: normalizeAssistantTextToRevision(
        invokeError instanceof Error ? invokeError.message : String(invokeError),
        params,
      ).revision,
      note: "Live pi invocation failed. Returned fallback revision payload.",
    };
  }
}
