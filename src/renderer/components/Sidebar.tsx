import { useMemo, useState } from 'react';
import { Hash, Lock, LogIn, Plus, Search, Settings, UserPlus } from 'lucide-react';
import { useStore, isConnected } from '../store/store';
import { openCreateRoom, openDm, openJoin, selectRoom, setView, signIn } from '../store/actions';
import { Avatar, Button, GoldBars, IconButton } from './ui';
import { nameKey } from '../../shared/validate';
import { t } from '../i18n';

export function Sidebar() {
  const connected = useStore(isConnected);
  const rooms = useStore((s) => s.rooms);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const view = useStore((s) => s.view);
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const friends = useStore((s) => s.friends);
  const unread = useStore((s) => s.unread);
  const chatConv = useStore((s) => s.chatConv);
  const voiceRoom = useStore((s) => s.voice.roomId);
  const savedHosts = useStore((s) => s.savedHosts);
  const clientStatus = useStore((s) => s.clientStatus);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);

  const friendList = useMemo(() => {
    const list = friends
      .filter((f) => f.state === 'friends' && users[f.userId])
      .map((f) => users[f.userId])
      .sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName, 'tr'));
    const k = nameKey(q);
    return k ? list.filter((u) => nameKey(u.displayName).includes(k)) : list;
  }, [friends, users, q]);
  const pending = friends.filter((f) => f.state === 'incoming').length;

  const profileName = me?.displayName ?? savedHosts.find((h) => h.hostId === clientStatus?.hostId)?.displayName ?? t.status.offline;

  return (
    <aside className="sidebar" aria-label={t.sidebar.rooms}>
      <div className="sb-head">
        <h2>{t.sidebar.rooms}</h2>
        <span style={{ display: 'flex', gap: 2 }}>
          <IconButton label={t.home.joinHost} onClick={openJoin} placement="bottom">
            <LogIn size={17} />
          </IconButton>
          <IconButton label={t.sidebar.addRoom} onClick={openCreateRoom} placement="bottom">
            <Plus size={19} />
          </IconButton>
        </span>
      </div>
      <div className="sb-scroll">
        {!connected && (
          <div className="sb-empty">
            {savedHosts.some((h) => !h.isOwnHost) ? (
              <>
                <Button size="sm" variant="primary" onClick={() => void signIn()}>
                  {t.home.signIn}
                </Button>
                <div style={{ marginTop: 8 }}>{t.home.signInHint}</div>
              </>
            ) : (
              t.sidebar.notConnected
            )}
          </div>
        )}
        {connected && rooms.length === 0 && <div className="sb-empty">{t.sidebar.noRooms}</div>}
        {connected &&
          rooms.map((r) => {
            const active = r.id === activeRoomId && view === 'chats';
            const n = unread[`room:${r.id}`] ?? 0;
            return (
              <button key={r.id} type="button" className={`room-item ${active ? 'active' : ''}`} onClick={() => selectRoom(r.id)} aria-current={active ? 'true' : undefined}>
                <span className="room-icon">{active || voiceRoom === r.id ? <GoldBars size={20} /> : r.isPrivate ? <Lock size={16} /> : <Hash size={17} />}</span>
                <span className="room-meta">
                  <span className="room-name" title={r.name}>
                    {r.name}
                  </span>
                  <span className="room-sub" style={{ display: 'block' }}>
                    {r.voice.length > 0 ? t.sidebar.connected(r.voice.length) : r.isPrivate ? t.sidebar.privateRoom : t.sidebar.empty}
                  </span>
                </span>
                {n > 0 && <span className="badge">{n > 99 ? '99+' : n}</span>}
              </button>
            );
          })}

        <div className="sb-divider" />
        <div className="sb-section">
          <span>{t.sidebar.friends}</span>
          <span style={{ display: 'flex', gap: 2 }}>
            <IconButton label={t.sidebar.searchFriends} onClick={() => setSearching((v) => !v)} disabled={!connected} placement="bottom">
              <Search size={15} />
            </IconButton>
            <IconButton label={t.sidebar.addFriends} onClick={() => setView('friends')} disabled={!connected} placement="bottom">
              <UserPlus size={15} />
            </IconButton>
          </span>
        </div>
        {searching && (
          <div className="sb-search">
            <input className="input" autoFocus placeholder={t.sidebar.searchFriends} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setQ(''), setSearching(false))} />
          </div>
        )}
        {connected && pending > 0 && (
          <button type="button" className="friend-item" onClick={() => setView('friends')}>
            <span className="badge">{pending}</span>
            <span className="fsub">{t.sidebar.requests(pending)}</span>
          </button>
        )}
        {connected && friendList.length === 0 && <div className="sb-empty">{q ? t.chat.noResults : t.sidebar.noFriends}</div>}
        {friendList.map((u) => {
          const key = `dm:${u.id}`;
          const n = unread[key] ?? 0;
          return (
            <button key={u.id} type="button" className={`friend-item ${chatConv === key ? 'active' : ''}`} onClick={() => openDm(u.id)}>
              <Avatar name={u.displayName} color={u.color} size={32} online={u.online} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="fname" style={{ display: 'block' }}>
                  {u.displayName}
                </span>
                <span className="fsub">
                  {u.voiceRoomId && rooms.some((r) => r.id === u.voiceRoomId)
                    ? rooms.find((r) => r.id === u.voiceRoomId)?.name
                    : u.online
                      ? t.common.online
                      : t.common.offline}
                </span>
              </span>
              {n > 0 && <span className="badge">{n}</span>}
            </button>
          );
        })}
      </div>
      <div className="profile-card" onClick={() => !connected && savedHosts.some((h) => !h.isOwnHost) && void signIn()} style={!connected && savedHosts.some((h) => !h.isOwnHost) ? { cursor: 'pointer' } : undefined}>
        <Avatar name={profileName} color={me?.color ?? '#56627A'} size={36} online={connected} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pname">{profileName}</div>
          <div className="psub">{connected ? (me?.role === 'admin' ? `${t.common.online} · ${t.common.admin}` : t.common.online) : t.common.offline}</div>
        </div>
        <IconButton label={t.nav.settings} onClick={() => setView('settings')}>
          <Settings size={18} />
        </IconButton>
      </div>
    </aside>
  );
}
