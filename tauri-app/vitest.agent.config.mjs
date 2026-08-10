import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: '/tmp/agentree-vite-cache',
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
