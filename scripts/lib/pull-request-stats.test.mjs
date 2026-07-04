import test from "node:test";
import assert from "node:assert/strict";
import {
  countActiveOpenPullRequests,
  countDraftOpenPullRequests,
  summarizeOpenPullRequests
} from "./pull-request-stats.mjs";

test("active open PR count excludes drafts", () => {
  assert.equal(
    countActiveOpenPullRequests([
      { number: 1, isDraft: false },
      { number: 2, isDraft: true },
      { number: 3, isDraft: false }
    ]),
    2
  );
});

test("draft open PR count only includes drafts", () => {
  assert.equal(
    countDraftOpenPullRequests([
      { number: 1, isDraft: false },
      { number: 2, isDraft: true },
      { number: 3, isDraft: true }
    ]),
    2
  );
});

test("open PR summary reports total, active, and drafts", () => {
  assert.deepEqual(
    summarizeOpenPullRequests([
      { number: 1, isDraft: false },
      { number: 2, isDraft: true },
      { number: 3, isDraft: false }
    ]),
    {
      total: 3,
      active: 2,
      drafts: 1
    }
  );
});
