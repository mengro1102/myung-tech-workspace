import { Routes, Route, Link, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import AgentManager from './pages/AgentManager';
import VirtualOffice from './pages/VirtualOffice';

const navItems = [
  {
    path: '/',
    label: '실시간 모니터',
    icon: '📡',
    desc: 'Live workflow & events',
  },
  {
    path: '/agents',
    label: '에이전트 허브',
    icon: '🤖',
    desc: 'Manage agent personas',
  },
  {
    path: '/office',
    label: '가상 오피스',
    icon: '🏢',
    desc: 'Floor plan view',
  },
];

export default function App() {
  const location = useLocation();

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#07070f', color: '#e2e8f0', fontFamily: "'Inter', 'Noto Sans KR', system-ui, sans-serif" }}>
      {/* ── Sidebar ── */}
      <nav style={{
        width: 200,
        background: '#0d0d1a',
        borderRight: '1px solid rgba(255,255,255,0.07)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 7,
              background: 'linear-gradient(135deg, #0d9668, #059669)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 800, color: 'white', flexShrink: 0,
            }}>M</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', lineHeight: 1.2 }}>명테크</div>
              <div style={{ fontSize: 9, color: '#10b981', fontWeight: 600, letterSpacing: '0.06em' }}>AGENT STUDIO</div>
            </div>
          </div>
          <div style={{ fontSize: 10, color: '#374151', marginTop: 6 }}>v1.3.0</div>
        </div>

        {/* Nav items */}
        <div style={{ flex: 1, paddingTop: 8 }}>
          {navItems.map(item => {
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '11px 14px',
                  textDecoration: 'none',
                  borderRight: active ? '2px solid #10b981' : '2px solid transparent',
                  background: active ? 'rgba(16,185,129,0.08)' : 'transparent',
                  transition: 'all 0.15s',
                  marginBottom: 2,
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{item.icon}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: active ? '#e2e8f0' : '#94a3b8' }}>
                    {item.label}
                  </div>
                  <div style={{ fontSize: 10, color: '#374151', marginTop: 1 }}>{item.desc}</div>
                </div>
              </Link>
            );
          })}
        </div>

        {/* Status footer */}
        <StatusFooter />
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Routes>
          <Route path="/"       element={<Dashboard />} />
          <Route path="/agents" element={<AgentManager />} />
          <Route path="/office" element={<VirtualOffice />} />
        </Routes>
      </main>
    </div>
  );
}

function StatusFooter() {
  return (
    <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(255,255,255,0.07)', fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block', flexShrink: 0 }} />
        <span style={{ color: '#64748b' }}>Orchestrator Online</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block', flexShrink: 0 }} />
        <span style={{ color: '#64748b' }}>vLLM Ready</span>
      </div>
    </div>
  );
}
