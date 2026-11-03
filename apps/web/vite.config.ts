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
  build: {
    rollupOptions: {
      output: {
        // 拆分大依赖与语言包，避免单个代码块超过 1 MiB：esbuild 对超过 1 MiB 的输入会经 %TEMP% 临时文件中转，
        // Windows 上杀毒软件扫描占用该文件时删除失败，导致构建报 "Access is denied"。
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
      // 本机 3000 被系统拒绝绑定时，可用 MYSTRY_DEV_API_PORT 指向实际的面板端口。
      '/api': `http://127.0.0.1:${process.env.MYSTRY_DEV_API_PORT || '3000'}`,
      '/ws': {
        target: `ws://127.0.0.1:${process.env.MYSTRY_DEV_API_PORT || '3000'}`,
        ws: true,
      },
    },
  },
});
