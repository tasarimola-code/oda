import { useEffect } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useStore, isConnected } from './store/store';
import { Rail } from './components/Rail';
import { Sidebar } from './components/Sidebar';
import { RoomView } from './components/RoomView';
import { ChatPanel } from './components/ChatPanel';
import { HomeView } from './components/HomeView';
import { FriendsView } from './components/FriendsView';
import { SettingsView } from './components/SettingsView';
import { Onboarding } from './components/Onboarding';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ModalHost } from './components/modals';
import { GoldBars, IconButton } from './components/ui';
import { t } from './i18n';

function TitleStatus() {
  const cs = useStore((s) => s.clientStatus);
  if (!cs || cs.state === 'idle') return <span className="tb-status">{t.status.offline}</span>;
  const dot = cs.state === 'connected' ? 'ok' : cs.state === 'failed' ? 'err' : 'warn';
  return (
    <span className="tb-status" role="status">
      <span className={`dot ${dot}`} aria-hidden />
      <span>{cs.hostName ?? ''}</span>
      {cs.state === 'connected' && <span className="pill">{t.net.serverHost}</span>}
      {cs.state === 'connecting' && <span>{t.common.loading}</span>}
      {cs.state === 'reconnecting' && <span>{t.status.hostOffline}</span>}
      {cs.state === 'failed' && <span>{t.status.failed}</span>}
    </span>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} role={x.kind === 'error' ? 'alert' : 'status'}>
          {x.text}
        </div>
      ))}
    </div>
  );
}

function CreditBar() {
  return <div className="credit-bar">{t.settings.credit}</div>;
}

function Center() {
  const view = useStore((s) => s.view);
  switch (view) {
    case 'home':
      return <HomeView />;
    case 'friends':
      return <FriendsView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <RoomView />;
  }
}

export function App() {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const onboardingDone = useStore((s) => s.settings?.onboardingDone ?? true);
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const chatOpen = useStore((s) => s.chatOpen);
  const chatConv = useStore((s) => s.chatConv);
  const connected = useStore(isConnected);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen }));
      } else if (e.key.toLowerCase() === 'j') {
        e.preventDefault();
        useStore.setState((s) => ({ chatOpen: !s.chatOpen }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) {
    return (
      <div className="boot" role="status">
        {bootError ? (
          <span className="error-text">ODA başlatılamadı: {bootError}</span>
        ) : (
          <>
            <span className="spinner" aria-hidden /> {t.common.loading}
          </>
        )}
      </div>
    );
  }

  if (!onboardingDone) {
    return (
      <div className="app">
        <div className="titlebar">
          <div className="brand">
            <GoldBars size={18} /> ODA
          </div>
        </div>
        <Onboarding />
        <CreditBar />
        <ModalHost />
        <Toasts />
      </div>
    );
  }

  const chatAvailable = connected && !!chatConv && (view === 'chats' || (view === 'friends' && chatConv.startsWith('dm:')));
  const showChat = chatOpen && chatAvailable;
  const cls = ['main', sidebarOpen ? '' : 'no-sidebar', showChat ? '' : 'no-chat'].filter(Boolean).join(' ');

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <GoldBars size={18} /> ODA
        </div>
        <span className="tb-actions">
          <IconButton label={sidebarOpen ? 'Yan paneli gizle (Ctrl+B)' : 'Yan paneli göster (Ctrl+B)'} placement="bottom" onClick={() => useStore.setState({ sidebarOpen: !sidebarOpen })}>
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </IconButton>
          {chatAvailable && (
            <IconButton label={chatOpen ? `${t.chat.closePanel} (Ctrl+J)` : `${t.chat.openPanel} (Ctrl+J)`} placement="bottom" onClick={() => useStore.setState({ chatOpen: !chatOpen })}>
              {chatOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </IconButton>
          )}
        </span>
        <TitleStatus />
      </div>
      <div className={cls}>
        <Rail />
        <Sidebar />
        <main className="center">
          <ConnectionBanner />
          <Center />
        </main>
        {showChat ? <ChatPanel /> : <aside className="chat-panel" />}
      </div>
      <CreditBar />
      <ModalHost />
      <Toasts />
    </div>
  );
}
