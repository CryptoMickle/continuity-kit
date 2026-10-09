import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Separate build. Never replaces the Account Reserve v1 application or output.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
});
