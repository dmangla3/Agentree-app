import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { viteCacheDir } = createRequire(import.meta.url)('./scripts/vite-cache-dir.cjs');

export default defineConfig({
  cacheDir: viteCacheDir(),
  resolve: {
    alias: [
      {
        find: /^@\/lib\/(.*)$/,
        replacement: path.resolve(__dirname, './src/lib/$1'),
      },
      {
        find: '@',
        replacement: path.resolve(__dirname, './@'),
      },
      {
        find: 'src',
        replacement: path.resolve(__dirname, './src'),
      },
      {
        find: '@shared',
        replacement: path.resolve(__dirname, '../shared'),
      },
    ],
  },
  test: {
    environment: 'node',
  },
});
