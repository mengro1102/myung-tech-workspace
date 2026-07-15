import { useEffect, useRef } from 'react';

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number;
  size: number;
  pulse: number;
}

export default function BrainCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const N = 200;
    const particles: Particle[] = [];

    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 0.55 + Math.random() * 0.45;
      particles.push({
        x: r * Math.sin(phi) * Math.cos(theta) * 1.4,
        y: r * Math.sin(phi) * Math.sin(theta) * 1.1,
        z: r * Math.cos(phi),
        vx: (Math.random() - 0.5) * 0.003,
        vy: (Math.random() - 0.5) * 0.003,
        size: 1.5 + Math.random() * 2.5,
        pulse: Math.random() * Math.PI * 2,
      });
    }

    let angle = 0;
    let animId: number;

    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      angle += 0.003;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // 와이드 배너 형태: 세로는 H 기준, 가로는 W 전체에 퍼지게
      const scaleY = H * 0.42;
      const scaleX = Math.min(W * 0.32, scaleY * 3.5);
      const cx = W / 2;
      const cy = H / 2;

      const proj = particles.map((p, i) => {
        particles[i].pulse += 0.025;
        const rx = p.x * cos - p.z * sin;
        const rz = p.x * sin + p.z * cos;
        const depth = (rz + 1.6) / 3.2;
        const pulse = 0.8 + 0.2 * Math.sin(p.pulse);
        return {
          sx: cx + rx * scaleX,
          sy: cy + p.y * scaleY * 0.9,
          depth,
          size: p.size * depth * pulse,
        };
      });

      // connections
      const CONN_DIST = scaleX * 0.32;
      for (let i = 0; i < proj.length; i++) {
        for (let j = i + 1; j < proj.length; j++) {
          const dx = proj[i].sx - proj[j].sx;
          const dy = proj[i].sy - proj[j].sy;
          const d  = Math.sqrt(dx * dx + dy * dy);
          if (d < CONN_DIST) {
            const alpha = (1 - d / CONN_DIST) * 0.6
              * Math.min(proj[i].depth, proj[j].depth);
            ctx.beginPath();
            ctx.strokeStyle = `rgba(15,253,106,${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.moveTo(proj[i].sx, proj[i].sy);
            ctx.lineTo(proj[j].sx, proj[j].sy);
            ctx.stroke();
          }
        }
      }

      // nodes
      proj.forEach(p => {
        const a = 0.5 + p.depth * 0.5;
        // outer glow
        const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, p.size * 6);
        g.addColorStop(0, `rgba(15,253,106,${a * 0.35})`);
        g.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, p.size * 6, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();

        // core dot
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(100,255,160,${a})`;
        ctx.fill();
      });

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={className} style={{ display: 'block', width: '100%', height: '100%' }} />;
}
