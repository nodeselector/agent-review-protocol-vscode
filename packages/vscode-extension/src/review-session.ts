import type { AdapterReviewResult, Session } from "../../protocol/src/index.js";
import { getLatestRevisionFromBus } from "./bus-review.js";
import { loadReviewStore } from "./review-store.js";

export interface HydratedReviewSessionState {
  session?: Session;
  latestResult?: AdapterReviewResult;
}

export async function hydrateReviewSessionState(
  workspaceRoot: string,
  dbPath?: string,
): Promise<HydratedReviewSessionState> {
  const store = await loadReviewStore(workspaceRoot);
  if (!store.session) {
    return {};
  }

  const latest = await getLatestRevisionFromBus(workspaceRoot, store.session.id, dbPath);
  return {
    session: store.session,
    latestResult: latest?.result,
  };
}
