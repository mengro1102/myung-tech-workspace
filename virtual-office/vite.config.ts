import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:9000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Phaser 는 minify 후에도 1.5MB 다. 쪼갤 수 있는 성질의 라이브러리가 아니라
    // '메인 경로에서 빼는 것'이 최선이고, 그건 이미 했다 — OfficeView 와
    // VirtualOffice 를 lazy 로 돌려 2D 사무실을 열 때만 받는다.
    // 그래서 경고 한도를 Phaser 청크 위로 올린다. 다른 청크가 커지면 여전히 걸린다.
    chunkSizeWarningLimit: 1600,
  },
});
