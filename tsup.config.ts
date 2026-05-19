import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cluster.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'node20',
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: true,
  minify: false,
  // Lua scripts are copied to dist in the Dockerfile COPY step
});
