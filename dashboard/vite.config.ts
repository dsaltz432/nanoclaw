import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/**
 * Writes .br and .gz beside each built JS/CSS asset, so the server can send
 * the ~860KB bundle compressed without compressing it on every request (see
 * server/index.ts). Node's zlib, no extra dependency.
 */
function precompress(): Plugin {
  return {
    name: 'precompress',
    apply: 'build',
    writeBundle(options, bundle) {
      const dir = options.dir ?? 'dist';
      for (const file of Object.keys(bundle)) {
        if (!/\.(js|css)$/.test(file)) continue;
        const full = path.join(dir, file);
        const buf = fs.readFileSync(full);
        fs.writeFileSync(`${full}.gz`, zlib.gzipSync(buf, { level: 9 }));
        fs.writeFileSync(
          `${full}.br`,
          zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
  build: {
    outDir: 'dist',
  },
});
