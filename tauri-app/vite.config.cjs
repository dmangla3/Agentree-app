const path = require("node:path");
const { configDefaults, defineConfig } = require("vitest/config");
const { loadEnv } = require("vite");
const react = require("@vitejs/plugin-react");

const { viteCacheDir } = require("./scripts/vite-cache-dir.cjs");

const reactPlugin = react.default ?? react;
const host = process.env.TAURI_DEV_HOST;
const configuredDevPort = Number.parseInt(process.env.AGENTREE_DEV_PORT ?? "", 10);
const devPort = Number.isInteger(configuredDevPort) && configuredDevPort > 0
  ? configuredDevPort
  : 1420;
const configuredHmrPort = Number.parseInt(process.env.AGENTREE_DEV_HMR_PORT ?? "", 10);
const hmrPort = Number.isInteger(configuredHmrPort) && configuredHmrPort > 0
  ? configuredHmrPort
  : 1421;
const agentreeViteCacheDir = viteCacheDir();
const envDir = path.resolve(__dirname, ".env-files-disabled");

const isEnabled = (value) => ["1", "true", "yes", "on"].includes(
  String(value ?? "").trim().toLowerCase(),
);

// https://vite.dev/config/
module.exports = defineConfig(async ({ command, mode }) => {
  const resolvedEnv = loadEnv(mode, envDir);
  if (command === "build" && isEnabled(resolvedEnv.VITE_DEV_AUTH_BYPASS)) {
    throw new Error(
      "Refusing to create a production build with VITE_DEV_AUTH_BYPASS enabled. " +
      "Unset it or set it to false.",
    );
  }

  return {
    plugins: [reactPlugin()],
    cacheDir: agentreeViteCacheDir,
    envDir,
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
      port: devPort,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: hmrPort,
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
  };
});
