#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy-branch-to-host.sh --remote-repo-path PATH --env-file PATH [options]

Required:
  --remote-repo-path PATH   Remote checkout path for this branch deployment.
  --env-file PATH           Local .env file to install on the host.

Options:
  --source-repo PATH        Local source repo to deploy. Defaults to the current working directory.
  --transport MODE          Deployment transport: ssh or local. Defaults to ssh.
  --ssh-host HOST           SSH destination when --transport=ssh.
  --force                   Repair drift by resetting a dirty remote checkout and replacing a drifted .env.
  --skip-launch             Stop after syncing code and .env; skip remote validate/build/up.
  --help                    Show this help text.

The script syncs the exact local HEAD commit to the remote host, verifies the remote
checkout matches that commit, and fails closed on checkout or .env drift unless
--force is provided.
EOF
}

shell_quote() {
  printf "%q" "$1"
}

transport="ssh"
source_repo="$(pwd)"
remote_repo_path=""
env_file=""
ssh_host=""
force=0
skip_launch=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --transport)
      transport="${2:-}"
      shift 2
      ;;
    --source-repo)
      source_repo="${2:-}"
      shift 2
      ;;
    --remote-repo-path)
      remote_repo_path="${2:-}"
      shift 2
      ;;
    --env-file)
      env_file="${2:-}"
      shift 2
      ;;
    --ssh-host)
      ssh_host="${2:-}"
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    --skip-launch)
      skip_launch=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$remote_repo_path" || -z "$env_file" ]]; then
  usage >&2
  exit 1
fi

if [[ "$transport" != "ssh" && "$transport" != "local" ]]; then
  printf 'Unsupported transport: %s\n' "$transport" >&2
  exit 1
fi

if [[ "$transport" == "ssh" && -z "$ssh_host" ]]; then
  printf '--ssh-host is required when --transport=ssh\n' >&2
  exit 1
fi

source_repo="$(cd "$source_repo" && pwd)"
env_file="$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"

if [[ ! -d "$source_repo/.git" ]]; then
  printf 'Source repo is not a git repository: %s\n' "$source_repo" >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  printf 'Missing env file: %s\n' "$env_file" >&2
  exit 1
fi

run_local_git() {
  git -C "$source_repo" "$@"
}

read_env_value() {
  local key="$1"
  local file="$2"
  local value
  value="$(awk -F= -v key="$key" '
    $0 ~ /^[[:space:]]*#/ { next }
    $1 == key {
      sub(/^[^=]*=/, "", $0)
      print $0
      exit
    }
  ' "$file")"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

remote_run() {
  local script="$1"
  shift
  if [[ "$transport" == "local" ]]; then
    bash -s -- "$@" <<<"$script"
  else
    ssh "$ssh_host" bash -s -- "$@" <<<"$script"
  fi
}

remote_copy_file() {
  local src="$1"
  local dest="$2"
  local dest_quoted
  dest_quoted="$(shell_quote "$dest")"
  if [[ "$transport" == "local" ]]; then
    mkdir -p "$(dirname "$dest")"
    cat "$src" >"$dest"
  else
    ssh "$ssh_host" "mkdir -p $(shell_quote "$(dirname "$dest")") && cat > $dest_quoted" <"$src"
  fi
}

local_status="$(run_local_git status --porcelain --untracked-files=all)"
if [[ -n "$local_status" ]]; then
  printf 'Local worktree is dirty; commit or stash changes before deployment.\n' >&2
  exit 1
fi

branch_name="$(run_local_git rev-parse --abbrev-ref HEAD)"
commit_sha="$(run_local_git rev-parse HEAD)"
origin_url="$(run_local_git remote get-url origin)"
env_checksum="$(sha256sum "$env_file" | awk '{print $1}')"
repo_config_file="$(read_env_value "AE_REPO_CONFIG_FILE" "$env_file")"
target_repo_path="$(read_env_value "AE_TARGET_REPO_PATH" "$env_file")"

if [[ -z "$repo_config_file" ]]; then
  printf 'AE_REPO_CONFIG_FILE must be set in %s\n' "$env_file" >&2
  exit 1
fi

if [[ -z "$target_repo_path" ]]; then
  printf 'AE_TARGET_REPO_PATH must be set in %s\n' "$env_file" >&2
  exit 1
fi

if [[ ! -f "$source_repo/config/repos/$repo_config_file" ]]; then
  printf 'Configured repo file is missing from the local branch: %s\n' "$source_repo/config/repos/$repo_config_file" >&2
  exit 1
fi

bundle_file="$(mktemp)"
trap 'rm -f "$bundle_file"' EXIT
run_local_git bundle create "$bundle_file" HEAD >/dev/null

remote_bundle_path="$remote_repo_path/.ae-deploy.bundle"
remote_env_path="$remote_repo_path/.env"
remote_manifest_path="$remote_repo_path/.ae-deploy-manifest.json"
remote_bundle_ref="refs/ae-deploy/source"

printf 'Deploying branch %s at %s to %s\n' "$branch_name" "$commit_sha" "$remote_repo_path"

preflight_script='
set -euo pipefail

remote_repo_path="$1"
branch_name="$2"
origin_url="$3"
env_checksum="$4"
force="$5"
manifest_path="$remote_repo_path/.ae-deploy-manifest.json"

read_manifest_value() {
  local key="$1"
  local file="$2"
  awk -F'"'"'"'"'"' -v key="$key" '"'"'$2 == key { print $4; exit }'"'"' "$file"
}

if [[ -e "$remote_repo_path" && ! -d "$remote_repo_path" ]]; then
  printf "Remote path exists but is not a directory: %s\n" "$remote_repo_path" >&2
  exit 1
fi

if [[ ! -d "$remote_repo_path/.git" ]]; then
  if [[ -e "$remote_repo_path" && -n "$(find "$remote_repo_path" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    printf "Remote path exists but is not a git checkout: %s\n" "$remote_repo_path" >&2
    exit 1
  fi
  mkdir -p "$remote_repo_path"
  git init "$remote_repo_path" >/dev/null
fi

if [[ -f "$manifest_path" ]]; then
  manifest_branch="$(read_manifest_value "branch" "$manifest_path")"
  manifest_commit="$(read_manifest_value "commit" "$manifest_path")"
  manifest_origin_url="$(read_manifest_value "origin_url" "$manifest_path")"
  current_sha="$(git -C "$remote_repo_path" rev-parse HEAD 2>/dev/null || true)"

  if [[ -n "$manifest_branch" && "$manifest_branch" != "$branch_name" && "$force" != "1" ]]; then
    printf "Remote checkout branch drift detected at %s: expected %s but found %s\n" "$remote_repo_path" "$manifest_branch" "$branch_name" >&2
    exit 1
  fi

  if [[ -n "$manifest_origin_url" && "$manifest_origin_url" != "$origin_url" && "$force" != "1" ]]; then
    printf "Remote checkout origin drift detected at %s: expected %s but found %s\n" "$remote_repo_path" "$manifest_origin_url" "$origin_url" >&2
    exit 1
  fi

  if [[ -n "$manifest_commit" && -n "$current_sha" && "$current_sha" != "$manifest_commit" && "$force" != "1" ]]; then
    printf "Remote checkout revision drift detected at %s: expected %s but found %s\n" "$remote_repo_path" "$manifest_commit" "$current_sha" >&2
    exit 1
  fi
elif git -C "$remote_repo_path" rev-parse --verify HEAD >/dev/null 2>&1 && [[ "$force" != "1" ]]; then
  printf "Remote checkout is unmanaged at %s: missing %s\n" "$remote_repo_path" "$manifest_path" >&2
  exit 1
fi

tracked_dirty=0
git -C "$remote_repo_path" diff --quiet || tracked_dirty=1
git -C "$remote_repo_path" diff --cached --quiet || tracked_dirty=1
untracked_output="$(
  git -C "$remote_repo_path" ls-files --others --exclude-standard |
    grep -vE "^(\.env|\.ae-deploy-manifest\.json|\.ae-deploy\.bundle|state/|\.codex/|node_modules/)" || true
)"
if [[ "$tracked_dirty" == "1" || -n "$untracked_output" ]] && [[ "$force" != "1" ]]; then
  printf "Remote checkout drift detected at %s\n" "$remote_repo_path" >&2
  exit 1
fi

if [[ -f "$remote_repo_path/.env" ]]; then
  remote_env_checksum="$(sha256sum "$remote_repo_path/.env" | awk "{print \$1}")"
  if [[ "$remote_env_checksum" != "$env_checksum" && "$force" != "1" ]]; then
    printf "Remote .env drift detected at %s/.env\n" "$remote_repo_path" >&2
    exit 1
  fi
fi

if [[ "$force" == "1" ]]; then
  git -C "$remote_repo_path" reset --hard >/dev/null 2>&1 || true
  git -C "$remote_repo_path" clean -fdx -e .env -e .ae-deploy-manifest.json -e .ae-deploy.bundle -e state/ -e .codex/ -e node_modules/ >/dev/null 2>&1 || true
fi
'

remote_run "$preflight_script" "$remote_repo_path" "$branch_name" "$origin_url" "$env_checksum" "$force"
remote_copy_file "$bundle_file" "$remote_bundle_path"
remote_copy_file "$env_file" "$remote_env_path"

deploy_script='
set -euo pipefail

remote_repo_path="$1"
bundle_path="$2"
branch_name="$3"
commit_sha="$4"
origin_url="$5"
repo_config_file="$6"
target_repo_path="$7"
env_checksum="$8"
manifest_path="$9"
bundle_ref="${10}"
skip_launch="${11}"

git -C "$remote_repo_path" remote get-url origin >/dev/null 2>&1 || git -C "$remote_repo_path" remote add origin "$origin_url"
git -C "$remote_repo_path" remote set-url origin "$origin_url"
git -C "$remote_repo_path" fetch --force "$bundle_path" "$commit_sha:$bundle_ref" >/dev/null
git -C "$remote_repo_path" checkout -B "$branch_name" "$commit_sha" >/dev/null
git -C "$remote_repo_path" reset --hard "$commit_sha" >/dev/null
git -C "$remote_repo_path" clean -fdx -e .env -e .ae-deploy-manifest.json -e .ae-deploy.bundle -e state/ -e .codex/ -e node_modules/ >/dev/null

actual_sha="$(git -C "$remote_repo_path" rev-parse HEAD)"
if [[ "$actual_sha" != "$commit_sha" ]]; then
  printf "Remote revision mismatch: expected %s but found %s\n" "$commit_sha" "$actual_sha" >&2
  exit 1
fi

if [[ ! -f "$remote_repo_path/config/repos/$repo_config_file" ]]; then
  printf "Missing deployed repo config: %s\n" "$remote_repo_path/config/repos/$repo_config_file" >&2
  exit 1
fi

if [[ ! -e "$target_repo_path" ]]; then
  printf "Remote target repo path is missing: %s\n" "$target_repo_path" >&2
  exit 1
fi

cat >"$manifest_path" <<JSON
{
  "branch": "$branch_name",
  "commit": "$commit_sha",
  "env_checksum": "$env_checksum",
  "origin_url": "$origin_url"
}
JSON

rm -f "$bundle_path"

if [[ "$skip_launch" == "1" ]]; then
  exit 0
fi

cd "$remote_repo_path"
docker compose config >/dev/null
docker compose build engine-image
if command -v node >/dev/null 2>&1; then
  AE_REPO_CONFIG="$remote_repo_path/config/repos/$repo_config_file" node scripts/validate-config.mjs
else
  docker compose run --rm -T --no-deps \
    -e AE_REPO_CONFIG="/engine/config/repos/$repo_config_file" \
    autonomous node scripts/validate-config.mjs </dev/null
fi

# The dashboard-dist named volume exists only to survive the whole-repo bind
# mount (compose.yaml mounts . over /engine, which would otherwise hide the
# image-built frontend). Once populated, Docker does not re-seed a named
# volume from a newer image layer automatically, so a stale volume silently
# keeps serving the previous deploy frontend forever unless dropped here.
existing_dashboard_container="$(docker compose ps -a -q dashboard 2>/dev/null || true)"
if [[ -n "$existing_dashboard_container" ]]; then
  dashboard_dist_volume="$(
    docker inspect "$existing_dashboard_container" \
      --format "{{range .Mounts}}{{if eq .Destination \"/engine/dashboard/dist\"}}{{.Name}}{{println}}{{end}}{{end}}" 2>/dev/null |
      head -n1
  )"
  docker compose stop dashboard >/dev/null 2>&1 || true
  docker compose rm -f dashboard >/dev/null 2>&1 || true
  if [[ -n "$dashboard_dist_volume" ]]; then
    docker volume rm "$dashboard_dist_volume" >/dev/null 2>&1 || true
  fi
fi

docker compose up -d --force-recreate autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
'

remote_run \
  "$deploy_script" \
  "$remote_repo_path" \
  "$remote_bundle_path" \
  "$branch_name" \
  "$commit_sha" \
  "$origin_url" \
  "$repo_config_file" \
  "$target_repo_path" \
  "$env_checksum" \
  "$remote_manifest_path" \
  "$remote_bundle_ref" \
  "$skip_launch"

if [[ "$transport" == "local" ]]; then
  deployed_sha="$(git -C "$remote_repo_path" rev-parse HEAD)"
else
  deployed_sha="$(ssh "$ssh_host" "git -C $(shell_quote "$remote_repo_path") rev-parse HEAD")"
fi

printf 'Remote revision verified at %s\n' "$deployed_sha"
