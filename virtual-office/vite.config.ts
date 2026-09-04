import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // API 서버가 루프백 전용이라 개발 서버도 같이 묶는다. 0.0.0.0 이면
    // /api 프록시를 통해 그 방어가 그대로 뚫린다.
    // 'localhost' 로 두면 이 PC 에서 ::1 에만 붙어 127.0.0.1 요청이 끊겼다.
    host: '127.0.0.1',
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
    // Phaser 를 걷어내면서(렌더러를 PixelOffice 로 합쳤다) 1.5MB 청크가
    // 사라졌다. 한도를 기본값 근처로 되돌린다 — 다시 커지면 알아채야 한다.
    chunkSizeWarningLimit: 700,
  },
});
