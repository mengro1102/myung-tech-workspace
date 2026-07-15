import { useEffect, useState } from 'react';

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

const TYPE_META = {
  success: { icon: '✅', color: '#0ffd6a', bg: 'rgba(15,253,106,0.12)', border: 'rgba(15,253,106,0.3)' },
  error:   { icon: '❌', color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.3)' },
  warning: { icon: '⚠️', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)' },
  info:    { icon: 'ℹ️', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.3)' },
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  const m = TYPE_META[toast.type];

  useEffect(() => {
    const t1 = setTimeout(() => setVisible(true), 10);
    const t2 = setTimeout(() => { setVisible(false); setTimeout(onDismiss, 300); }, 4500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDismiss]);

  return (
    <div
      className="toast-card"
      style={{
        background: m.bg,
        borderColor: m.border,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0)' : 'translateX(100%)',
      }}
      onClick={onDismiss}
    >
      <span className="toast-icon">{m.icon}</span>
      <span className="toast-msg" style={{ color: m.color }}>{toast.message}</span>
    </div>
  );
}

export default function ToastContainer({ toasts, onDismiss }: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}
