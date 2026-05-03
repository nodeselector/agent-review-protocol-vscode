export type ReviewEvent = "comment" | "request_changes" | "ready";
export type CommentCategory = "note" | "issue" | "blocking";
export type CommentStatus = "draft" | "submitted" | "resolved" | "outdated";
export type CommentScope = "review" | "context";
export type ResolutionStatus =
  | "addressed"
  | "partially_addressed"
  | "not_addressed"
  | "needs_clarification";

export interface Session {
  id: string;
  workspaceRoot: string;
  title?: string;
  createdAt: string;
  updatedAt?: string;
  agent?: {
    name: string;
    version?: string;
    vendor?: string;
  };
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface Artifact {
  id: string;
  type: "gitDiff";
  baseRef?: string;
  headRef?: string;
  patch: string;
  changedFiles: ChangedFile[];
}

export interface Comment {
  id: string;
  path: string;
  side: "new";
  line?: number;
  startLine?: number;
  endLine?: number;
  body: string;
  category?: CommentCategory;
  scope?: CommentScope;
  status: CommentStatus;
  iteration?: number;
}

export interface Review {
  id: string;
  sessionId: string;
  event: ReviewEvent;
  summary?: string;
  comments: Comment[];
  createdAt: string;
}

export interface CommentResolution {
  commentId: string;
  status: ResolutionStatus;
  note?: string;
}

export interface Revision {
  id: string;
  sessionId: string;
  basedOnReviewId: string;
  summary: string;
  patch?: string;
  resolutions: CommentResolution[];
  questions?: string[];
}

export interface Capabilities {
  supports: {
    reviewSubmission: boolean;
    patchOutput: boolean;
    structuredResolutions: boolean;
    patchApply: boolean;
    streaming: boolean;
    diagnosticsContext?: boolean;
    selectionContext?: boolean;
  };
}

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage<T = unknown> = JsonRpcRequest<T> | JsonRpcSuccess<T> | JsonRpcError;

export interface ReviewSubmitParams {
  sessionId: string;
  review: Omit<Review, "id" | "createdAt" | "sessionId"> & { comments: Comment[] };
  artifact: Artifact;
}

export interface RevisionRequestResult {
  revision: Revision;
}

export interface ReviewSubmitCommandPayload {
  artifact: Artifact;
  review: ReviewSubmitParams["review"];
  submittedAt: string;
  workspaceRoot: string;
}

export interface ReviewRequestedEventPayload {
  requestId: string;
  sessionId: string;
  workspaceRoot: string;
  artifact: Artifact;
  summary?: string;
  iteration: number;
  priorFeedback?: Array<{
    iteration: number;
    comments: Comment[];
    summary?: string;
  }>;
  requestedAt: string;
}

export interface ReviewResponseEventPayload {
  requestId: string;
  sessionId: string;
  review: {
    event: ReviewEvent;
    summary?: string;
    comments: Comment[];
  };
  respondedAt: string;
}

export interface AdapterReviewResult {
  adapter: string;
  mode: "stub" | "live" | "fallback";
  normalized: boolean;
  revision: Revision;
  note?: string;
  prompt?: string;
  rawOutput?: string;
}

export interface RevisionProposedEventPayload extends AdapterReviewResult {
  commandId: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}
