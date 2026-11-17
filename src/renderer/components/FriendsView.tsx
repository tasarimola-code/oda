import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, UserPlus, UserX, Ban, Check, X, Users, Headphones } from 'lucide-react';
import { useStore, toast, isConnected } from '../store/store';
import { joinVoice, openDm, selectRoom, signIn } from '../store/actions';
import { Avatar, Button, EmptyState, IconButton } from './ui';
import { rpc, errorText } from '../lib/api';
import type { FriendEntry, UserPublic } from '../../shared/protocol';
import { t } from '../i18n';

type Tab = 'all' | 'pending' | 'add' | 'blocked';

async function act(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

const setFriends = (friends: FriendEntry[]) => useStore.setState({ friends });

function UserRow({ u, children, sub }: { u: UserPublic; children: React.ReactNode; sub?: string }) {
  return (
    <div className="list-row">
      <Avatar name={u.displayName} color={u.color} size={36} online={u.online} />
      <div className="grow">
        <div className="t1">{u.displayName}</div>
        <div className="t2">{sub ?? (u.online ? t.common.online : t.common.offline)}</div>
      </div>
      {children}
    </div>
  );
}

function blockUser(u: UserPublic) {
  useStore.setState({
    modal: {
      kind: 'confirm',
      title: t.friends.block,
      text: t.friends.blockConfirm(u.displayName),
      confirmLabel: t.friends.block,
      danger: true,
      onConfirm: async () => {
        const r = await rpc('blocks.add', { userId: u.id });
        useStore.setState({ blocked: r.blocked, friends: r.friends });
      },
    },
  });
}

export function FriendsView() {
  const connected = useStore(isConnected);
  const friends = useStore((s) => s.friends);
  const users = useStore((s) => s.users);
  const blocked = useStore((s) => s.blocked);
  const me = useStore((s) => s.me);
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserPublic[] | null>(null);

  useEffect(() => {
    if (tab !== 'add') return;
    const term = q.trim();
    if (!term) {
      setResults(Object.values(users).filter((u) => u.id !== me?.id && !u.banned).sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr')));
      return;
    }
    const id = setTimeout(() => {
      void rpc('users.search', { q: term })
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(id);
  }, [q, tab, users, me?.id]);

  const accepted = useMemo(() => friends.filter((f) => f.state === 'friends' && users[f.userId]), [friends, users]);
  const pending = useMemo(() => friends.filter((f) => f.state !== 'friends' && users[f.userId]), [friends, users]);

  const rooms = useStore((s) => s.rooms);
  const hasAccount = useStore((s) => s.savedHosts.some((h) => !h.isOwnHost));

  if (!connected) {
    return (
      <div className="center-scroll">
        <EmptyState icon={<Users size={26} />} title={hasAccount ? t.home.signedOut : t.status.offline} text={hasAccount ? t.home.signedOutText : t.friends.noneHint}>
          {hasAccount && (
            <Button variant="primary" onClick={() => void signIn()}>
              {t.home.signIn}
            </Button>
          )}
        </EmptyState>
      </div>
    );
  }

  const stateOf = (id: string) => friends.find((f) => f.userId === id)?.state;

  return (
    <div className="center-scroll">
      <div className="page">
        <h1>{t.friends.title}</h1>
        <p className="lead">{t.friends.communityNote}</p>
        <div className="tabs" role="tablist">
          {(
            [
              ['all', t.friends.tabAll, accepted.length],
              ['pending', t.friends.tabPending, pending.filter((p) => p.state === 'incoming').length],
              ['add', t.friends.tabAdd, 0],
              ['blocked', t.friends.tabBlocked, 0],
            ] as const
          ).map(([k, label, n]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              {label}
              {n > 0 && k === 'pending' && <span className="badge">{n}</span>}
            </button>
          ))}
        </div>

        {tab === 'all' && (
          <div className="card">
            {accepted.length === 0 && <EmptyState icon={<UserPlus size={24} />} title={t.friends.none} text={t.friends.noneHint}><Button variant="outline-gold" onClick={() => setTab('add')}>{t.friends.tabAdd}</Button></EmptyState>}
            {accepted.map((f) => {
              const u = users[f.userId];
              const voiceRoom = u.voiceRoomId ? rooms.find((r) => r.id === u.voiceRoomId) : undefined;
              return (
                <UserRow key={u.id} u={u} sub={voiceRoom ? `${t.friends.inVoice}: ${voiceRoom.name}` : undefined}>
                  {voiceRoom && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        selectRoom(voiceRoom.id);
                        void joinVoice(voiceRoom.id);
                      }}
                    >
                      <Headphones size={14} /> {t.friends.joinVoice}
                    </Button>
                  )}
                  <Button size="sm" variant="outline-gold" onClick={() => openDm(u.id)}>
                    <MessageSquare size={14} /> {t.friends.message}
                  </Button>
                  <IconButton label={t.friends.unfriend} onClick={() => void act(async () => setFriends(await rpc('friends.remove', { userId: u.id })))}>
                    <UserX size={16} />
                  </IconButton>
                  <IconButton label={t.friends.block} onClick={() => blockUser(u)}>
                    <Ban size={16} />
                  </IconButton>
                </UserRow>
              );
            })}
          </div>
        )}

        {tab === 'pending' && (
          <div className="card">
            {pending.length === 0 && <div className="hint">{t.friends.noPending}</div>}
            {pending.map((f) => {
              const u = users[f.userId];
              return (
                <UserRow key={u.id} u={u} sub={f.state === 'incoming' ? t.friends.incoming : t.friends.outgoing}>
                  {f.state === 'incoming' ? (
                    <>
                      <Button size="sm" variant="primary" onClick={() => void act(async () => setFriends(await rpc('friends.accept', { userId: u.id })))}>
                        <Check size={14} /> {t.friends.accept}
                      </Button>
                      <Button size="sm" onClick={() => void act(async () => setFriends(await rpc('friends.reject', { userId: u.id })))}>
                        <X size={14} /> {t.friends.reject}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => void act(async () => setFriends(await rpc('friends.reject', { userId: u.id })))}>
                      {t.friends.cancel}
                    </Button>
                  )}
                  <IconButton label={t.friends.block} onClick={() => blockUser(u)}>
                    <Ban size={16} />
                  </IconButton>
                </UserRow>
              );
            })}
          </div>
        )}

        {tab === 'add' && (
          <div className="card">
            <input className="input" placeholder={t.friends.searchCommunity} value={q} onChange={(e) => setQ(e.target.value)} autoFocus style={{ marginBottom: 8 }} />
            {results && results.length === 0 && <div className="hint">{t.chat.noResults}</div>}
            {results?.map((u) => {
              const st = stateOf(u.id);
              const isBlocked = blocked.includes(u.id);
              return (
                <UserRow key={u.id} u={u}>
                  {isBlocked ? (
                    <span className="pill err">{t.friends.tabBlocked}</span>
                  ) : st === 'friends' ? (
                    <Button size="sm" variant="outline-gold" onClick={() => openDm(u.id)}>
                      <MessageSquare size={14} /> {t.friends.message}
                    </Button>
                  ) : st === 'outgoing' ? (
                    <span className="pill warn">{t.friends.requested}</span>
                  ) : st === 'incoming' ? (
                    <Button size="sm" variant="primary" onClick={() => void act(async () => setFriends(await rpc('friends.accept', { userId: u.id })))}>
                      {t.friends.accept}
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => void act(async () => setFriends(await rpc('friends.request', { userId: u.id })))}>
                      <UserPlus size={14} /> {t.friends.add}
                    </Button>
                  )}
                </UserRow>
              );
            })}
          </div>
        )}

        {tab === 'blocked' && (
          <div className="card">
            {blocked.length === 0 && <div className="hint">{t.friends.noBlocked}</div>}
            {blocked.map((id) => {
              const u = users[id] ?? { id, displayName: 'Bilinmeyen', color: '#56627A', role: 'member' as const, online: false };
              return (
                <UserRow key={id} u={u}>
                  <Button size="sm" onClick={() => void act(async () => useStore.setState({ blocked: (await rpc('blocks.remove', { userId: id })).blocked }))}>
                    {t.friends.unblock}
                  </Button>
                </UserRow>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
