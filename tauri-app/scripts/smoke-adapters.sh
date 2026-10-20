#!/usr/bin/env bash
# Smoke-tests the packaged provider adapters the way a clean user machine
# would run them: scrubbed environment, fresh HOME, managed runtime archives
# installed into the app data dir, no reliance on repo node_modules or PATH
# tools. Catches packaging breakage (missing SDK, wrong layout, stale codex)
# on the build machine instead of on user laptops.
#
# Usage:
#   smoke-adapters.sh <resources_dir> <app_binary> <archives_dir>
#
#   resources_dir  dir containing scripts/claude-agent-sdk-adapter.mjs
#                  (AppImage: squashfs-root/usr/lib/Agentree,
#                   macOS:    agentree.app/Contents/Resources)
#   app_binary     packaged agentree binary (for the codex helper)
#   archives_dir   dir with agentree-runtime-*.tar.gz for this platform
set -euo pipefail

resources_dir="${1:?resources_dir required}"
app_binary="${2:?app_binary required}"
archives_dir="${3:?archives_dir required}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform="linux-x86_64" ;;
  Darwin-arm64) platform="darwin-aarch64" ;;
  *) echo "error: unsupported smoke platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

fake_home="$(mktemp -d)"
trap 'rm -rf "$fake_home"' EXIT
if [[ "$platform" == darwin-* ]]; then
  data_root="$fake_home/Library/Application Support/com.agentree.agentree/runtime"
else
  data_root="$fake_home/.local/share/com.agentree.agentree/runtime"
fi

echo "==> Installing runtime archives into fake HOME"
found_any=0
for archive in "$archives_dir"/agentree-runtime-*-"$platform".tar.gz; do
  [[ -f "$archive" ]] || continue
  found_any=1
  base="$(basename "$archive" .tar.gz)"
  rest="${base#agentree-runtime-}"
  rest="${rest%-$platform}"
  component=""
  for known in claude-sdk node codex; do
    if [[ "$rest" == "$known"-* ]]; then
      component="$known"
      version="${rest#${known}-}"
      break
    fi
  done
  [[ -n "$component" ]] || { echo "error: unrecognized archive name: $base" >&2; exit 1; }
  dest="$data_root/$component/$version"
  mkdir -p "$dest"
  tar -xzf "$archive" -C "$dest"
  touch "$dest/.agentree-runtime-ok"
  echo "    installed $component $version"
done
[[ "$found_any" == 1 ]] || { echo "error: no runtime archives for $platform in $archives_dir" >&2; exit 1; }

node_bin="$(echo "$data_root"/node/*/bin/node)"
sdk_dir="$(echo "$data_root"/claude-sdk/*)"
codex_bin="$(echo "$data_root"/codex/*/bin/codex)"
adapter_resource="$resources_dir/scripts/claude-agent-sdk-adapter.mjs"
[[ -x "$node_bin" ]] || { echo "error: managed node missing at $node_bin" >&2; exit 1; }
[[ -x "$codex_bin" ]] || { echo "error: managed codex missing at $codex_bin" >&2; exit 1; }
[[ -f "$adapter_resource" ]] || { echo "error: bundled adapter missing at $adapter_resource" >&2; exit 1; }

run_scrubbed() {
  env -i HOME="$fake_home" PATH="$(dirname "$node_bin")" "$@"
}

echo "==> Claude adapter smoke (scrubbed env, managed runtime only)"
cp "$adapter_resource" "$sdk_dir/"
set +e
claude_out="$(run_scrubbed CLAUDE_CODE_OAUTH_TOKEN=sk-ant-smoke-invalid \
  "$node_bin" "$sdk_dir/claude-agent-sdk-adapter.mjs" --permission-mode bypassPermissions hi 2>&1)"
set -e
echo "$claude_out" | tail -2
if echo "$claude_out" | grep -qE "ERR_MODULE_NOT_FOUND|Cannot find package|Native CLI binary .* not found"; then
  echo "error: Claude adapter cannot resolve the SDK and its native CLI from the managed runtime" >&2
  exit 1
fi
if ! echo "$claude_out" | grep -q '"type":"provider_stop"'; then
  echo "error: Claude adapter did not produce structured output" >&2
  exit 1
fi
# With an invalid token the adapter must get far enough to be rejected by the
# API itself — proving node + SDK + bundled CLI all work without host tools.
if ! echo "$claude_out" | grep -qE "Invalid bearer token|authentication_error|API Error: 401"; then
  echo "error: Claude adapter failed before reaching provider authentication" >&2
  exit 1
fi

echo "==> Codex helper smoke (scrubbed env, managed codex)"
codex_out="$(run_scrubbed "$app_binary" \
  --agentree-codex-adapter \
  --agentree-managed-codex-bin "$codex_bin" \
  --readiness-check 2>&1)"
echo "$codex_out" | head -1 | cut -c1-300
if ! echo "$codex_out" | grep -q '"codexBin"'; then
  echo "error: codex readiness check produced no codexBin diagnostics" >&2
  exit 1
fi
if ! echo "$codex_out" | grep -qF "$data_root/codex"; then
  echo "error: codex helper did not resolve the managed codex CLI" >&2
  exit 1
fi
# The managed binary must actually execute, not merely exist — a lost exec
# bit or broken unpack would still leave codexBin pointing at the right path.
if ! echo "$codex_out" | grep -q '"codexVersion":"codex-cli'; then
  echo "error: managed codex CLI did not report a working version" >&2
  exit 1
fi

echo "==> Bash adapter smoke (managed node, system bash)"
# bash itself is a base-OS dependency, not a managed component — keep system
# dirs on PATH for it while node still comes from the managed runtime.
bash_out="$(env -i HOME="$fake_home" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" "$resources_dir/scripts/bash-adapter.cjs" -p "echo smoke-ok" 2>&1)"
echo "$bash_out" | tail -1
if ! echo "$bash_out" | grep -q '"provider_status":"completed"'; then
  echo "error: bash adapter did not complete under the managed node" >&2
  exit 1
fi
if ! echo "$bash_out" | grep -q "smoke-ok"; then
  echo "error: bash adapter did not relay command output" >&2
  exit 1
fi

echo "==> Adapter smoke passed"
