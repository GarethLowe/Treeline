import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // WGSL is imported as source text and compiled at runtime, which keeps shader authoring
  // in real .wgsl files with editor tooling rather than in template literals.
  assetsInclude: ['**/*.wgsl'],
  resolve: {
    alias: {
      '@contracts': r('./src/contracts'),
      '@core': r('./src/core'),
      '@gpu': r('./src/gpu'),
      '@world': r('./src/world'),
      '@sim': r('./src/sim'),
      '@weather': r('./src/weather'),
      '@render': r('./src/render'),
    },
  },
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'esnext', sourcemap: true },
})
