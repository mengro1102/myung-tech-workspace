import { useRef, useEffect } from 'react';

export interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  time: Date;
  read: boolean;
  link?: () => void;
}

interface Props {
  notifications: Notification[];
  open: boolean;
  onToggle: () => void;
  onRead: (id: string) => void;
  onReadAll: () => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

const TYPE_META: Record<string, { icon: string; color: string; bg: string }> = {
  info:    { icon: 'ℹ',  color: '#60A5FA', bg: 'rgba(96,165,250,0.15)'  },
  success: { icon: '✓',  color: '#2DD4BF', bg: 'rgba(45,212,191,0.15)'  },
  warning: { icon: '⚠',  color: '#F59E0B', bg: 'rgba(245,158,11,0.15)'  },
  error:   { icon: '✕',  color: '#EF4444', bg: 'rgba(239,68,68,0.15)'   },
};

function fmtTime(d: Date): string {
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return '방금 전';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function NotificationBell({
  notifications, open, onToggle, onRead, onReadAll, onRemove, onClearAll, containerRef
}: Props) {
  const unread = notifications.filter(n => !n.read).length;

  return (
    <div className="nb-root" ref={containerRef}>
      {/* 벨 버튼 */}
      <button className={`nb-bell ${open ? 'open' : ''}`} onClick={onToggle} title="알림">
        <span className="nb-bell-icon">🔔</span>
        {unread > 0 && (
          <span className="nb-badge">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {/* 드롭다운 */}
      {open && (
        <div className="nb-dropdown">
          <div className="nb-dropdown-header">
            <span className="nb-dropdown-title">알림</span>
            <div className="nb-dropdown-actions">
              {unread > 0 && (
                <button className="nb-action-btn" onClick={onReadAll}>모두 읽음</button>
              )}
              {notifications.length > 0 && (
                <button className="nb-action-btn" onClick={onClearAll}>전체 삭제</button>
              )}
            </div>
          </div>

          <div className="nb-list">
            {notifications.length === 0 && (
              <div className="nb-empty">
                <span style={{ fontSize: 28, opacity: 0.3 }}>🔔</span>
                <span>새 알림이 없습니다</span>
              </div>
            )}
            {notifications.map(n => {
              const meta = TYPE_META[n.type] ?? TYPE_META.info;
              return (
                <div
                  key={n.id}
                  className={`nb-item ${n.read ? 'read' : ''}`}
                  onClick={() => { onRead(n.id); n.link?.(); }}
                >
                  <div className="nb-item-icon" style={{ background: meta.bg, color: meta.color }}>
                    {meta.icon}
                  </div>
                  <div className="nb-item-body">
                    <div className="nb-item-msg">{n.message}</div>
                    <div className="nb-item-time">{fmtTime(n.time)}</div>
                  </div>
                  <button className="nb-item-dismiss" onClick={e => { e.stopPropagation(); onRemove(n.id); }}>
                    ✕
                  </button>
                  {!n.read && <span className="nb-unread-dot" />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
