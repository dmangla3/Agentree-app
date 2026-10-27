const os = require("node:os");
const path = require("node:path");

// Resolve the OS cache directory, mirroring the Rust `dirs::cache_dir()` used by
// src-tauri/src/command_guards.rs so both halves of the app agree.
//
// Deliberately NOT os.tmpdir(): on Fedora, Arch and openSUSE /tmp is a tmpfs, so a
// cache there lives in RAM where the kernel cannot reclaim it. Vite's dep-optimizer
// cache is also meant to persist between runs -- putting it on a tmpfs throws it
// away on every reboot and forces a re-optimize.
function osCacheDir(env = process.env) {
  const home = os.homedir();
  if (process.platform === "win32") {
    return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Caches");
  }
  return env.XDG_CACHE_HOME || path.join(home, ".cache");
}

// Worktree dev apps get stable isolated caches. Agents get a per-run sandbox;
// everyone else shares one cache.
function viteCacheDir(env = process.env) {
  const worktreeCache = env.AGENTREE_VITE_CACHE_DIR;
  if (worktreeCache) return worktreeCache;
  const agentSandbox = env.AGENT_SANDBOX;
  if (agentSandbox) return path.join(agentSandbox, "vite-cache");
  return path.join(osCacheDir(env), "agentree", "vite-cache");
}

module.exports = { osCacheDir, viteCacheDir };
