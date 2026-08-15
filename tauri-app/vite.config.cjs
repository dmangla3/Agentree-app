const path = require("node:path");
const { configDefaults, defineConfig } = require("vitest/config");
const react = require("@vitejs/plugin-react");

const reactPlugin = react.default ?? react;
const host = process.env.TAURI_DEV_HOST;
const agentSandbox = process.env.AGENT_SANDBOX;
const agentreeViteCacheDir = agentSandbox ? path.join(agentSandbox, "vite-cache") : undefined;

// https://vite.dev/config/
module.exports = defineConfig(async () => ({
  plugins: [reactPlugin()],
  cacheDir: agentreeViteCacheDir || "/tmp/agentree-vite-cache",
  envDir: path.resolve(__dirname, ".env-files-disabled"),
  resolve: {
    alias: [
      {
        find: /^@\/lib\/(.*)$/,
        replacement: path.resolve(__dirname, "./src/lib/$1"),
      },
      {
        find: "@",
        replacement: path.resolve(__dirname, "./@"),
      },
      {
        find: "src",
        replacement: path.resolve(__dirname, "./src"),
      },
      {
        find: "@shared",
        replacement: path.resolve(__dirname, "../shared"),
      },
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 3000,
  },
  test: {
    exclude: [...configDefaults.exclude, "src-tauri/**"],
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
  },
}));
