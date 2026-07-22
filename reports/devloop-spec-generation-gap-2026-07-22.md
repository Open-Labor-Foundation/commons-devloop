# commons-devloop spec.yaml Generation Gap — Investigation & Fix

**Date:** 2026-07-22
**Investigator:** olf-keeper[bot] (autonomous session)
**Scope:** Item #9 — commons-devloop spec.yaml generation gap

---

## Summary

The commons-devloop autonomous spec.yaml generation pipeline on jkm-remote
Docker is not producing correctly-scoped spec.yaml files for labor-commons.
Three root causes were identified; two have code fixes applied, one requires
operator action on the remote Docker host.

## Root Causes

### 1. No write-path scoping (CODE FIX APPLIED)

**Problem:** The lane coder's `write_files` action accepted any repo-relative
path. The system prompt said "Write only under the target_path" but nothing
enforced it. `finalizeLocalPullRequest` used `git add -A`, staging everything
the model wrote regardless of target path.

**Impact:** PR #545 on labor-commons shipped 3000 files across 10 unrelated
specialists, reintroducing a deprecated legacy multi-file schema. The PR was
closed without merge by jkmurphy-alt with the note: "independent audit found
this PR's actual diff doesn't match its stated scope."

**Fix:** Three layers of defense added to `local-lane-runner.mjs`:

1. **Write-path guard** (in `executeAction`): When
   `AE_LOCAL_CODER_ENFORCE_TARGET_PATH=1` (default), `write_files` entries
   whose path doesn't start with the target directory are rejected with a
   `quality_gate` observation before the file is written.

2. **Unified-diff path guard** (in `applyUnifiedDiff`): Before `git apply`
   runs, the diff's `+++`/`---` file paths are checked against the target
   directory. Diffs touching files outside the target are rejected.

3. **Quality validation guard** (in `validateLocalCoderQuality`): After the
   model signals `done`, `changedFiles()` is checked — any file outside the
   target directory produces a quality gate failure.

4. **Staging guard** (in `finalizeLocalPullRequest`): `git add -A` replaced
   with `git add -- <overlay_root>/` when target path enforcement is active.
   Only files under the catalog overlay root are staged.

5. **File-count guard** (in `finalizeLocalPullRequest`): After staging, the
   number of staged files is checked against `AE_LOCAL_CODER_MAX_PR_FILES`
   (default 10). If exceeded, the run throws with a diagnostic message. A
   spec-pack issue should produce 1-3 files; 3000 is a clear signal of
   out-of-scope writing.

All guards are controlled by `AE_LOCAL_CODER_ENFORCE_TARGET_PATH` (default
`1`/on) and can be disabled per-repo if needed.

### 2. Reviewer 401 Unauthorized (OPERATOR ACTION REQUIRED)

**Problem:** The reviewer service on jkm-remote Docker is getting HTTP 401
from Featherless API (`https://api.featherless.ai/v1`). The error log shows:

```
openai-compatible review request failed: 401 Unauthorized
```

The error log also shows `model=zai-org/GLM-5.2`, but `labor-commons.yaml`
configures `deepseek-ai/DeepSeek-V3.2` for both primary and reviewer. This
means the model was changed via the dashboard UI (which writes to
`secrets.json`/runtime state) without updating the API key, or the
Featherless API key expired.

**Impact:** No PRs can pass review. The reviewer failure is non-blocking
for `gh pr comment` failures (see `reviewerPostFailureIsNonBlocking`), but
the 401 itself prevents any review content from being generated.

**Required action:**
1. Verify the Featherless API key in `secrets.json` on jkm-remote is valid
2. Verify the model name in the dashboard/runtime state matches what the
   Featherless plan supports
3. If the model was intentionally changed to GLM-5.2, update
   `labor-commons.yaml` to reflect the actual model being used
4. If the key expired, generate a new one and update `secrets.json`

### 3. Repo manually paused (OPERATOR ACTION REQUIRED)

**Problem:** `repo-state.json` on jkm-remote shows:
```json
{
  "status": "paused_manual",
  "pauseReason": "manual pause from dashboard",
  "runsToday": 0
}
```

**Impact:** The dispatcher will not pick up any of the 499 queued spec-pack
issues while the repo is paused.

**Required action:** Unpause the repo via the dashboard or by setting
`status: "running"` in `repo-state.json` on jkm-remote.

## State of the Pipeline (as of 2026-07-22)

| Metric | Value |
|--------|-------|
| Open spec-pack issues | 499 |
| Running issues | 0 |
| Queued issues | 499 |
| Open PRs | 1 |
| Merged spec-pack PRs | 2 (#544, #546) |
| Closed-without-merge PRs | 1 (#545 — out-of-scope) |
| Repo status | paused_manual |
| Reviewer status | 401 Unauthorized |
| Dispatcher model (config) | deepseek-ai/DeepSeek-V3.2 |
| Reviewer model (config) | deepseek-ai/DeepSeek-V3.2 |
| Reviewer model (runtime error) | zai-org/GLM-5.2 |

## Files Changed

- `commons-devloop/scripts/local-lane-runner.mjs`:
  - `executeAction()`: Added write-path guard for `write_files` entries
  - `applyUnifiedDiff()`: Added diff-path pre-validation against target directory
  - `validateLocalCoderQuality()`: Added out-of-scope file detection
  - `finalizeLocalPullRequest()`: Replaced `git add -A` with scoped `git add`;
    added file-count guard (`AE_LOCAL_CODER_MAX_PR_FILES`, default 10)

## What Still Needs Operator Action

1. **Fix the Featherless API key** on jkm-remote Docker (secrets.json)
2. **Reconcile the model mismatch** — config says DeepSeek-V3.2, runtime error
   shows GLM-5.2. Either update the config or the dashboard state.
3. **Unpause the repo** via the dashboard
4. **Redeploy** the commons-devloop containers on jkm-remote to pick up the
   code fixes in this commit