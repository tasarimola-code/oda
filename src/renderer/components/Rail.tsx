import { Home, MessageSquareText, Users, Settings } from 'lucide-react';
import { useStore, type View } from '../store/store';
import { setView } from '../store/actions';
import { t } from '../i18n';

const ITEMS: Array<{ view: View; label: string; Icon: typeof Home }> = [
  { view: 'home', label: t.nav.home, Icon: Home },
  { view: 'chats', label: t.nav.chats, Icon: MessageSquareText },
  { view: 'friends', label: t.nav.friends, Icon: Users },
  { view: 'settings', label: t.nav.settings, Icon: Settings },
];

export function Rail() {
  const view = useStore((s) => s.view);
  const unreadTotal = useStore((s) => Object.values(s.unread).reduce((a, b) => a + (b || 0), 0));
  const incoming = useStore((s) => s.friends.filter((f) => f.state === 'incoming').length);
  return (
    <nav className="rail" aria-label="Ana gezinme">
      {ITEMS.map(({ view: v, label, Icon }) => {
        const badge = v === 'chats' ? unreadTotal : v === 'friends' ? incoming : 0;
        return (
          <button key={v} type="button" className={`rail-item ${view === v ? 'active' : ''}`} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>
            <Icon size={21} strokeWidth={1.7} />
            <span>{label}</span>
            {badge > 0 && <span className="badge">{badge > 99 ? '99+' : badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}
