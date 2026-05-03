import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nowIso, type Comment, type Session } from "../../protocol/src/index.js";

export interface ReviewStore {
  session?: Session;
  reviewSessionId?: string;
  reviewIteration?: number;
  comments: Comment[];
}

export function getActiveDraftComments(store: ReviewStore): Comment[] {
  return store.comments.filter((comment) => comment.status === "draft");
}

export async function loadReviewStore(workspaceRoot: string): Promise<ReviewStore> {
  const storePath = getStorePath(workspaceRoot);

  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as ReviewStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { comments: [] };
    }

    throw error;
  }
}

export async function saveReviewStore(workspaceRoot: string, store: ReviewStore): Promise<void> {
  const storePath = getStorePath(workspaceRoot);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function ensureSession(workspaceRoot: string): Promise<Session> {
  const store = await loadReviewStore(workspaceRoot);
  if (store.session) {
    return store.session;
  }

  const session: Session = {
    id: `sess_${randomUUID()}`,
    workspaceRoot,
    title: "local draft review",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await saveReviewStore(workspaceRoot, {
    ...store,
    session,
  });

  return session;
}

export async function addDraftComment(workspaceRoot: string, comment: Omit<Comment, "id" | "status">): Promise<Comment> {
  const store = await loadReviewStore(workspaceRoot);
  const draft: Comment = {
    ...comment,
    id: `c_${randomUUID()}`,
    status: "draft",
    iteration: store.reviewIteration ?? 1,
  };

  await saveReviewStore(workspaceRoot, {
    ...store,
    comments: [...store.comments, draft],
  });

  return draft;
}

export async function updateDraftComment(
  workspaceRoot: string,
  commentId: string,
  updates: Partial<Pick<Comment, "body" | "line" | "startLine" | "endLine" | "category">>,
): Promise<Comment> {
  const store = await loadReviewStore(workspaceRoot);
  const index = store.comments.findIndex((comment) => comment.id === commentId);
  if (index < 0) {
    throw new Error(`draft comment not found: ${commentId}`);
  }

  const updated: Comment = {
    ...store.comments[index],
    ...updates,
  };

  const comments = [...store.comments];
  comments[index] = updated;
  await saveReviewStore(workspaceRoot, { ...store, comments });
  return updated;
}

export async function removeDraftComment(workspaceRoot: string, commentId: string): Promise<void> {
  const store = await loadReviewStore(workspaceRoot);
  await saveReviewStore(workspaceRoot, {
    ...store,
    comments: store.comments.filter((comment) => comment.id !== commentId),
  });
}

export async function markDraftCommentsSubmitted(workspaceRoot: string, commentIds?: string[]): Promise<Comment[]> {
  const store = await loadReviewStore(workspaceRoot);
  const selectedIds = commentIds ? new Set(commentIds) : undefined;
  const comments = store.comments.map((comment) => {
    if (comment.status !== "draft") {
      return comment;
    }
    if (selectedIds && !selectedIds.has(comment.id)) {
      return comment;
    }
    return {
      ...comment,
      status: "submitted",
    } satisfies Comment;
  });

  await saveReviewStore(workspaceRoot, {
    ...store,
    comments,
  });

  return comments.filter((comment) => comment.status === "submitted" && (!selectedIds || selectedIds.has(comment.id)));
}

export async function clearDraftComments(workspaceRoot: string): Promise<void> {
  const store = await loadReviewStore(workspaceRoot);
  await saveReviewStore(workspaceRoot, {
    ...store,
    comments: store.comments.filter((comment) => comment.status !== "draft"),
  });
}

export async function bindReviewSession(
  workspaceRoot: string,
  reviewSessionId: string,
  iteration: number,
): Promise<void> {
  const store = await loadReviewStore(workspaceRoot);

  if (store.reviewSessionId === reviewSessionId && store.reviewIteration === iteration) {
    return;
  }

  const comments = store.comments.map((comment) =>
    comment.status === "draft"
      ? { ...comment, status: "outdated" as const }
      : comment,
  );

  await saveReviewStore(workspaceRoot, {
    ...store,
    reviewSessionId,
    reviewIteration: iteration,
    comments,
  });
}

export function getCommentsForCurrentIteration(store: ReviewStore): Comment[] {
  return store.comments.filter((comment) => comment.status === "draft");
}

export function getCommentsFromPreviousIterations(store: ReviewStore): Comment[] {
  return store.comments.filter((comment) => comment.status === "submitted" || comment.status === "outdated");
}

export async function clearAllComments(workspaceRoot: string): Promise<void> {
  const store = await loadReviewStore(workspaceRoot);
  await saveReviewStore(workspaceRoot, {
    ...store,
    comments: [],
    reviewSessionId: undefined,
    reviewIteration: undefined,
  });
}

export function formatDraftComments(comments: Comment[]): string {
  if (comments.length === 0) {
    return "No draft comments.";
  }

  return comments
    .map((comment, index) => {
      const startLine = comment.startLine ?? comment.line ?? 1;
      const endLine = comment.endLine ?? comment.line ?? startLine;
      const line = startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
      return `${index + 1}. ${comment.path}:${line} [${comment.scope ?? "review"}/${comment.category ?? "note"}] ${comment.body}`;
    })
    .join("\n");
}

export function getStorePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".arp", "reviews", "draft-review.json");
}
