#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_script="$repo_root/scripts/deploy-branch-to-host.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

source_repo="$tmp_dir/source"
host_repo="$tmp_dir/host/autonomous-engine"
target_repo="$tmp_dir/host/target-repo"
env_file="$tmp_dir/deploy.env"

mkdir -p "$source_repo/config/repos" "$source_repo/docs" "$target_repo"

cat >"$source_repo/config/repos/example.yaml" <<'EOF'
version: 2
repo:
  key: fixture
  github_slug: example/fixture
  default_branch: main
lifecycle:
  enabled: true
  target_mode: open
  target_name: fixture
  pause_when_target_complete: true
  pause_when_budget_exhausted: true
  max_parallel_prs: 1
  max_runs_per_day: 1
issue_source:
  labels: []
models:
  dispatcher:
    primary:
      name: gpt-5.4
      reasoning_effort: medium
      pause_threshold_used_percent: 80
      weekly_pause_threshold_used_percent: 80
      reserve_burn_window_minutes: 300
      nominal_burn_per_lane_hour: 3
    secondary:
      name: gpt-5.4
      reasoning_effort: medium
      pause_threshold_used_percent: 80
      weekly_pause_threshold_used_percent: 80
      reserve_burn_window_minutes: 300
      nominal_burn_per_lane_hour: 3
  reviewer:
    name: gpt-5.4
    reasoning_effort: medium
validation:
  commands:
    - true
safety:
  pr_only: true
  auto_merge: false
  protected_branches:
    - main
  protected_paths: []
  allow_force_push: false
  require_clean_worktree_before_run: true
EOF

cat >"$source_repo/compose.yaml" <<'EOF'
services: {}
EOF

cat >"$source_repo/docs/readme.md" <<'EOF'
fixture
EOF

cat >"$env_file" <<EOF
AE_TARGET_REPO_PATH=$target_repo
AE_REPO_CONFIG_FILE=example.yaml
EOF

git -C "$source_repo" init >/dev/null
git -C "$source_repo" config user.name "Codex"
git -C "$source_repo" config user.email "codex@example.com"
git -C "$source_repo" add .
git -C "$source_repo" commit -m "fixture" >/dev/null
git -C "$source_repo" branch -M repo/test-fixture
git -C "$source_repo" remote add origin https://example.com/fixture.git

bash "$deploy_script" \
  --transport local \
  --source-repo "$source_repo" \
  --remote-repo-path "$host_repo" \
  --env-file "$env_file" \
  --skip-launch >/dev/null

expected_sha="$(git -C "$source_repo" rev-parse HEAD)"
actual_sha="$(git -C "$host_repo" rev-parse HEAD)"
[[ "$expected_sha" == "$actual_sha" ]]
cmp "$env_file" "$host_repo/.env"

rm -rf "$host_repo"
git -C "$tmp_dir/host" init autonomous-engine >/dev/null
git -C "$host_repo" config user.name "Codex"
git -C "$host_repo" config user.email "codex@example.com"
cat >"$host_repo/compose.yaml" <<'EOF'
services:
  drifted: {}
EOF
git -C "$host_repo" add compose.yaml
git -C "$host_repo" commit -m "unmanaged checkout" >/dev/null

if bash "$deploy_script" \
  --transport local \
  --source-repo "$source_repo" \
  --remote-repo-path "$host_repo" \
  --env-file "$env_file" \
  --skip-launch >/dev/null 2>"$tmp_dir/unmanaged.log"; then
  printf 'Expected unmanaged remote checkout detection to fail.\n' >&2
  exit 1
fi
grep -q "Remote checkout is unmanaged" "$tmp_dir/unmanaged.log"

bash "$deploy_script" \
  --transport local \
  --source-repo "$source_repo" \
  --remote-repo-path "$host_repo" \
  --env-file "$env_file" \
  --skip-launch \
  --force >/dev/null
actual_sha="$(git -C "$host_repo" rev-parse HEAD)"
[[ "$expected_sha" == "$actual_sha" ]]

git -C "$host_repo" config user.name "Codex"
git -C "$host_repo" config user.email "codex@example.com"
printf 'drifted\n' >"$host_repo/docs/readme.md"
git -C "$host_repo" add docs/readme.md
git -C "$host_repo" commit -m "host drift" >/dev/null

if bash "$deploy_script" \
  --transport local \
  --source-repo "$source_repo" \
  --remote-repo-path "$host_repo" \
  --env-file "$env_file" \
  --skip-launch >/dev/null 2>"$tmp_dir/revision-drift.log"; then
  printf 'Expected remote revision drift detection to fail.\n' >&2
  exit 1
fi
grep -q "Remote checkout revision drift detected" "$tmp_dir/revision-drift.log"

bash "$deploy_script" \
  --transport local \
  --source-repo "$source_repo" \
  --remote-repo-path "$host_repo" \
  --env-file "$env_file" \
  --skip-launch \
  --force >/dev/null
actual_sha="$(git -C "$host_repo" rev-parse HEAD)"
[[ "$expected_sha" == "$actual_sha" ]]

printf 'drift\n' >"$host_repo/DRIFT.txt"
if bash "$deploy_script" \
  --transport local \
  --source-repo "$source_repo" \
  --remote-repo-path "$host_repo" \
  --env-file "$env_file" \
  --skip-launch >/dev/null 2>"$tmp_dir/drift.log"; then
  printf 'Expected remote checkout drift detection to fail.\n' >&2
  exit 1
fi
grep -q "Remote checkout drift detected" "$tmp_dir/drift.log"

bash "$deploy_script" \
  --transport local \
  --source-repo "$source_repo" \
  --remote-repo-path "$host_repo" \
  --env-file "$env_file" \
  --skip-launch \
  --force >/dev/null
[[ ! -e "$host_repo/DRIFT.txt" ]]

printf 'AE_TARGET_REPO_PATH=%s\nAE_REPO_CONFIG_FILE=other.yaml\n' "$target_repo" >"$host_repo/.env"
if bash "$deploy_script" \
  --transport local \
  --source-repo "$source_repo" \
  --remote-repo-path "$host_repo" \
  --env-file "$env_file" \
  --skip-launch >/dev/null 2>"$tmp_dir/env.log"; then
  printf 'Expected remote .env drift detection to fail.\n' >&2
  exit 1
fi
grep -q "Remote .env drift detected" "$tmp_dir/env.log"

printf 'deploy-branch-to-host tests passed\n'
