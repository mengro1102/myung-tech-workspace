import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API 서버는 인증이 없어 127.0.0.1 로 내렸다. 개발 서버가 0.0.0.0 이면
// /api 프록시를 통해 그 방어가 그대로 뚫린다 — 같은 플래그로 묶는다.
// 폰에서 열어 보려면 MYUNGTECH_LAN=1 로 둘 다 켠다.
const lanExposed = ['1', 'true', 'True'].includes(process.env.MYUNGTECH_LAN ?? '');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // 'localhost' 로 두면 이 PC 에서 ::1 에만 붙어 127.0.0.1 로 오는 요청이
    // 연결되지 않았다. IPv4 루프백을 명시한다.
    host: lanExposed ? true : '127.0.0.1',
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
