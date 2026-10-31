import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 界面上显示的版本号取自根 package.json，避免写死在组件里。
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
  server: {
    port: 5173,
    proxy: {
      // 本机 3000 被系统拒绝绑定时，可用 MYSTRY_DEV_API_PORT 指向实际的面板端口。
      '/api': `http://127.0.0.1:${process.env.MYSTRY_DEV_API_PORT || '3000'}`,
      '/ws': {
        target: `ws://127.0.0.1:${process.env.MYSTRY_DEV_API_PORT || '3000'}`,
        ws: true,
      },
    },
  },
});
