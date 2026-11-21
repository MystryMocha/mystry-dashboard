import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The version number shown in the UI comes from the root package.json, so it is not hard-coded in components.
const rootPackage = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPackage.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Large dependencies and language packs are split so no single chunk exceeds 1 MiB: for inputs over 1 MiB esbuild goes through a temp file in %TEMP%,
        // and on Windows, deleting it fails while antivirus is scanning the file, making the build report "Access is denied".
        manualChunks(id) {
          const file = id.replace(/\\/g, '/');
          if (/\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(file)) return 'react';
          if (file.includes('/node_modules/@xterm/')) return 'xterm';
          if (file.includes('/node_modules/lucide-react/')) return 'icons';
          if (file.includes('/src/i18n/zh-CN/')) return 'i18n-zh-CN';
          if (file.includes('/src/i18n/zh-TW/')) return 'i18n-zh-TW';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // When binding local port 3000 is refused by the system, MYSTRY_DEV_API_PORT can point at the actual panel port.
      '/api': `http://127.0.0.1:${process.env.MYSTRY_DEV_API_PORT || '3000'}`,
      '/ws': {
        target: `ws://127.0.0.1:${process.env.MYSTRY_DEV_API_PORT || '3000'}`,
        ws: true,
      },
    },
  },
});
