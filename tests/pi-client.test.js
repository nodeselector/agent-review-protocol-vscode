import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPrompt,
  extractAssistantTextFromPiJson,
  invokePiForReview,
  normalizeAssistantTextToRevision,
} from "../dist/pi-adapter/src/pi-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sampleDiffPath = path.join(repoRoot, "tests/fixtures/sample-review.diff");

async function makeParams() {
  const patch = await fs.readFile(sampleDiffPath, "utf8");
  return {
    sessionId: "sess_pi",
    review: {
      event: "comment",
      summary: "Looks close",
      comments: [
        {
          id: "c_1",
          path: "src/fs.ts",
          side: "new",
          line: 84,
          body: "Preserve root slash semantics.",
          category: "blocking",
          status: "draft",
        },
      ],
    },
    artifact: {
      id: "art_1",
      type: "gitDiff",
      patch,
      changedFiles: [
        {
          path: "src/fs.ts",
          status: "modified",
        },
      ],
    },
  };
}

test("buildPrompt includes JSON contract and comments", async () => {
  const params = await makeParams();
  const prompt = buildPrompt(params);

  assert.match(prompt, /Return exactly one JSON object/);
  assert.match(prompt, /c_1 \| src\/fs.ts:84 \| blocking \| Preserve root slash semantics\./);
  assert.match(prompt, /patch must be a unified diff string/);
});

test("extractAssistantTextFromPiJson returns final assistant text", () => {
  const output = [
    JSON.stringify({ type: "session" }),
    JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: '{"summary":"done","patch":"diff --git ...","resolutions":[]}' }],
        },
      ],
    }),
  ].join("\n");

  assert.equal(
    extractAssistantTextFromPiJson(output),
    '{"summary":"done","patch":"diff --git ...","resolutions":[]}',
  );
});

test("normalizeAssistantTextToRevision parses structured JSON", async () => {
  const params = await makeParams();
  const normalized = normalizeAssistantTextToRevision(
    JSON.stringify({
      summary: "Handled the issue.",
      patch: "diff --git a/src/fs.ts b/src/fs.ts\n",
      resolutions: [
        {
          commentId: "c_1",
          status: "addressed",
          note: "Preserved root slash semantics.",
        },
      ],
      questions: ["none"],
    }),
    params,
  );

  assert.equal(normalized.normalized, true);
  assert.equal(normalized.revision.summary, "Handled the issue.");
  assert.equal(normalized.revision.resolutions[0]?.status, "addressed");
});

test("normalizeAssistantTextToRevision falls back for unstructured output", async () => {
  const params = await makeParams();
  const normalized = normalizeAssistantTextToRevision("I could not produce strict JSON.", params);

  assert.equal(normalized.normalized, false);
  assert.match(normalized.revision.summary, /I could not produce strict JSON/);
  assert.equal(normalized.revision.resolutions[0]?.status, "needs_clarification");
});

test("invokePiForReview executes pi and returns normalized revision", async () => {
  const params = await makeParams();
  const calls = [];
  const result = await invokePiForReview(
    params,
    repoRoot,
    async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: [
          JSON.stringify({ type: "session" }),
          JSON.stringify({
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      summary: "Fixed it.",
                      patch: "diff --git a/src/fs.ts b/src/fs.ts\n",
                      resolutions: [
                        {
                          commentId: "c_1",
                          status: "addressed",
                          note: "done",
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
        ].join("\n"),
        stderr: "",
      };
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "pi");
  assert.deepEqual(calls[0]?.args.slice(0, 8), [
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--tools",
    "read,grep,find,ls",
    "--thinking",
    "off",
  ]);
  assert.equal(calls[0]?.options.timeout, 120000);
  assert.equal(result.normalized, true);
  assert.equal(result.revision.summary, "Fixed it.");
  assert.equal(result.revision.resolutions[0]?.status, "addressed");
});
