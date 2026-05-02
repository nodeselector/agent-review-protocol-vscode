import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type CommentResolution,
  type ReviewSubmitParams,
  type Revision,
} from "../../protocol/src/index.js";

const execFileAsync = promisify(execFile);

export interface ExecFileLikeResult {
  stdout: string;
  stderr: string;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<ExecFileLikeResult>;

export interface PiInvocationResult {
  prompt: string;
  rawOutput?: string;
  revision: Revision;
  normalized: boolean;
}

export async function invokePiForReview(
  params: ReviewSubmitParams,
  cwd: string,
  execImpl: ExecFileLike = (file, args, options) => execFileAsync(file, args, options),
): Promise<PiInvocationResult> {
  const prompt = buildPrompt(params);
  const timeout = Number.parseInt(process.env.ARP_PI_TIMEOUT_MS ?? "120000", 10);
  const args = [
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--tools",
    "read,grep,find,ls",
    "--thinking",
    "off",
  ];

  if (process.env.ARP_PI_PROVIDER) {
    args.push("--provider", process.env.ARP_PI_PROVIDER);
  }

  if (process.env.ARP_PI_MODEL) {
    args.push("--model", process.env.ARP_PI_MODEL);
  }

  args.push(prompt);

  const { stdout } = await execImpl("pi", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
    timeout,
  });

  const assistantText = extractAssistantTextFromPiJson(stdout);
  const normalized = normalizeAssistantTextToRevision(assistantText, params);

  return {
    prompt,
    rawOutput: assistantText,
    revision: normalized.revision,
    normalized: normalized.normalized,
  };
}

export function buildPrompt(params: ReviewSubmitParams): string {
  const comments = params.review.comments
    .map(
      (comment: ReviewSubmitParams["review"]["comments"][number]) =>
        `- ${comment.id} | ${comment.path}:${comment.line ?? `${comment.startLine}-${comment.endLine}`} | ${comment.category ?? "note"} | ${comment.body}`,
    )
    .join("\n");

  return [
    "You are participating in the Agent Review Protocol as the revising agent.",
    "Return exactly one JSON object and no markdown fences or extra prose.",
    "JSON shape:",
    JSON.stringify(
      {
        summary: "string",
        patch: "string",
        resolutions: [
          {
            commentId: "string",
            status: "addressed | partially_addressed | not_addressed | needs_clarification",
            note: "string",
          },
        ],
        questions: ["string"],
      },
      null,
      2,
    ),
    `Session: ${params.sessionId}`,
    `Review event: ${params.review.event}`,
    params.review.summary ? `Summary: ${params.review.summary}` : undefined,
    "Comments:",
    comments || "- none",
    "Artifact patch:",
    params.artifact.patch,
    [
      "Instructions:",
      "- Preserve unchanged hunks when possible.",
      "- If you cannot confidently produce a corrected patch, return the original patch and explain why in summary/questions.",
      "- Include one resolution entry for every comment.",
      "- patch must be a unified diff string.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function extractAssistantTextFromPiJson(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let fallbackText = "";

  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
      const text = getTextContent(assistant?.content);
      if (text) {
        return text;
      }
    }

    if (event.type === "turn_end" && event.message?.role === "assistant") {
      const text = getTextContent(event.message?.content);
      if (text) {
        fallbackText = text;
      }
    }
  }

  return fallbackText;
}

export function normalizeAssistantTextToRevision(
  assistantText: string,
  params: ReviewSubmitParams,
): { revision: Revision; normalized: boolean } {
  const parsed = tryParseFirstJsonObject(assistantText);
  if (parsed && isRevisionLike(parsed)) {
    return {
      normalized: true,
      revision: {
        id: `rev_${Date.now()}`,
        sessionId: params.sessionId,
        basedOnReviewId: `review_${Date.now()}`,
        summary: typeof parsed.summary === "string" ? parsed.summary : "pi returned a structured response.",
        patch: typeof parsed.patch === "string" ? parsed.patch : params.artifact.patch,
        resolutions: normalizeResolutions(parsed.resolutions, params),
        questions: Array.isArray(parsed.questions)
          ? parsed.questions.filter((value): value is string => typeof value === "string")
          : undefined,
      },
    };
  }

  return {
    normalized: false,
    revision: {
      id: `rev_${Date.now()}`,
      sessionId: params.sessionId,
      basedOnReviewId: `review_${Date.now()}`,
      summary: assistantText || "pi did not return structured JSON.",
      patch: params.artifact.patch,
      resolutions: params.review.comments.map((comment) => ({
        commentId: comment.id,
        status: "needs_clarification",
        note: "pi response could not be normalized to structured ARP JSON.",
      })),
      questions: ["Adapter fallback used because pi did not return valid ARP JSON."],
    },
  };
}

function normalizeResolutions(raw: unknown, params: ReviewSubmitParams): CommentResolution[] {
  const byId = new Map<string, CommentResolution>();

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const commentId = typeof item.commentId === "string" ? item.commentId : undefined;
      const status =
        item.status === "addressed" ||
        item.status === "partially_addressed" ||
        item.status === "not_addressed" ||
        item.status === "needs_clarification"
          ? item.status
          : "needs_clarification";

      if (!commentId) {
        continue;
      }

      byId.set(commentId, {
        commentId,
        status,
        note: typeof item.note === "string" ? item.note : undefined,
      });
    }
  }

  return params.review.comments.map((comment) => {
    return (
      byId.get(comment.id) ?? {
        commentId: comment.id,
        status: "needs_clarification",
        note: "pi did not provide a resolution for this comment.",
      }
    );
  });
}

function tryParseFirstJsonObject(text: string): unknown {
  if (!text) {
    return undefined;
  }

  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return undefined;
    }

    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return undefined;
    }
  }
}

function isRevisionLike(value: unknown): value is {
  summary?: unknown;
  patch?: unknown;
  resolutions?: unknown;
  questions?: unknown;
} {
  return Boolean(value && typeof value === "object");
}

function getTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (item && typeof item === "object" && typeof item.text === "string") {
        return item.text;
      }

      return "";
    })
    .join("");
}
