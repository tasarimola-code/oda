import { useCallback, useEffect, useState } from 'react';
import { Plug, LogIn, Plus, Trash2, Pencil } from 'lucide-react';
import { useStore, toast, isConnected } from '../store/store';
import { connectSaved, disconnect, openCreateRoom, openJoin, refreshSavedHosts } from '../store/actions';
import { Avatar, Button, IconButton, Tooltip } from './ui';
import { oda, rpc, unwrap, errorText } from '../lib/api';
import { formatDateTime, relativeUntil } from '../lib/format';
import type { InviteInfo, UserPublic } from '../../shared/protocol';
import { t } from '../i18n';

function InvitesCard() {
  const me = useStore((s) => s.me);
  const connected = useStore(isConnected);
  const rooms = useStore((s) => s.rooms);
  const modal = useStore((s) => s.modal);
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  const load = useCallback(() => {
    void rpc('admin.invites.list', {})
      .then(setInvites)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (connected && me?.role === 'admin' && !modal) load();
  }, [connected, me?.role, modal, load]);
  if (!connected || me?.role !== 'admin') return null;
  const active = invites.filter((i) => !i.revoked && i.expiresAt > Date.now() && i.uses < i.maxUses);
  return (
    <div className="card">
      <h2>
        {t.home.invites}
        <span className="right">
          <Button size="sm" variant="outline-gold" onClick={() => useStore.setState({ modal: { kind: 'invite' } })}>
            <Plus size={14} /> {t.home.newInvite}
          </Button>
        </span>
      </h2>
      {active.length === 0 && <div className="hint">{t.home.noInvites}</div>}
      {active.map((i) => (
        <div className="list-row" key={i.id}>
          <div className="grow">
            <div className="t1">
              {t.home.usesLeft(i.uses, i.maxUses)}
              {i.roomId && ` · ${rooms.find((r) => r.id === i.roomId)?.name ?? ''}`}
            </div>
            <div className="t2">
              {t.home.expiresIn(relativeUntil(i.expiresAt))} · {formatDateTime(i.createdAt)}
            </div>
          </div>
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void rpc('admin.invites.revoke', { inviteId: i.id })
                .then(setInvites)
                .catch((e) => toast(errorText(e), 'error'))
            }
          >
            {t.home.revoke}
          </Button>
        </div>
      ))}
    </div>
  );
}

function MembersCard() {
  const me = useStore((s) => s.me);
  const connected = useStore(isConnected);
  const users = useStore((s) => s.users);
  const [list, setList] = useState<UserPublic[]>([]);
  useEffect(() => {
    if (connected && me?.role === 'admin')
      void rpc('admin.users.list', {})
        .then(setList)
        .catch(() => undefined);
  }, [connected, me?.role, users]);
  if (!connected || me?.role !== 'admin') return null;
  const act = (method: 'admin.users.kick' | 'admin.users.ban' | 'admin.users.unban', u: UserPublic) => {
    const run = async () => {
      const r = await rpc(method, { userId: u.id });
      if (Array.isArray(r)) setList(r);
    };
    if (method === 'admin.users.ban') {
      useStore.setState({ modal: { kind: 'confirm', title: t.home.ban, text: t.home.banConfirm(u.displayName), confirmLabel: t.home.ban, danger: true, onConfirm: run } });
    } else void run().catch((e) => toast(errorText(e), 'error'));
  };
  return (
    <div className="card">
      <h2>{t.home.users}</h2>
      {list.map((u) => (
        <div className="list-row" key={u.id}>
          <Avatar name={u.displayName} color={u.color} size={32} online={u.online} />
          <div className="grow">
            <div className="t1">
              {u.displayName} {u.role === 'admin' && <span className="pill warn">{t.common.admin}</span>} {u.banned && <span className="pill err">{t.home.banned}</span>}
            </div>
            <div className="t2">{u.online ? t.common.online : t.common.offline}</div>
          </div>
          {u.role !== 'admin' && (
            <>
              {u.online && !u.banned && (
                <Button size="sm" onClick={() => act('admin.users.kick', u)}>
                  {t.home.kick}
                </Button>
              )}
              {u.banned ? (
                <Button size="sm" onClick={() => act('admin.users.unban', u)}>
                  {t.home.unban}
                </Button>
              ) : (
                <Button size="sm" variant="danger" onClick={() => act('admin.users.ban', u)}>
                  {t.home.ban}
                </Button>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function SavedHostsCard() {
  const saved = useStore((s) => s.savedHosts);
  const cs = useStore((s) => s.clientStatus);
  useEffect(() => {
    void refreshSavedHosts();
  }, []);
  return (
    <div className="card">
      <h2>
        {t.home.savedHosts}
        <span className="right" style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" variant="primary" onClick={openCreateRoom}>
            <Plus size={14} /> {t.onboarding.create}
          </Button>
          <Button size="sm" variant="outline-gold" onClick={openJoin}>
            <LogIn size={14} /> {t.home.joinHost}
          </Button>
        </span>
      </h2>
      {saved.length === 0 && <div className="hint">{t.home.noSaved}</div>}
      {saved.length > 0 && <p className="hint" style={{ marginTop: 0 }}>{t.home.signInHint}</p>}
      {saved.map((h) => {
        const current = cs?.hostId === h.hostId && cs.state !== 'idle';
        const state = current ? cs!.state : null;
        return (
          <div className="list-row" key={h.hostId}>
            <Plug size={18} color={state === 'connected' ? 'var(--green)' : 'var(--muted)'} />
            <div className="grow">
              <div className="t1">
                {h.hostName} {state === 'connected' && <span className="pill ok">{t.home.current}</span>}
                {(state === 'connecting' || state === 'reconnecting') && <span className="pill warn">{t.net.connecting}</span>}
                {state === 'failed' && <span className="pill err">{t.net.failed}</span>}
              </div>
              <div className="t2">
                {h.displayName} · <span className="mono">{`${h.lastAddress ?? h.addresses[0]}:${h.port}`}</span>
                {h.lastConnectedAt ? ` · ${t.home.lastSeen}: ${formatDateTime(h.lastConnectedAt)}` : ''}
              </div>
            </div>
            {h.isOwnHost ? (
              <span className="pill">{t.home.legacyHost}</span>
            ) : state === 'connected' ? (
              <Button size="sm" onClick={() => void disconnect()}>
                {t.home.disconnect}
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => void connectSaved(h.hostId)}>
                {t.home.signIn}
              </Button>
            )}
            {!h.isOwnHost && (
              <IconButton label={t.home.editAddress} onClick={() => useStore.setState({ modal: { kind: 'editAddress', hostId: h.hostId } })}>
                <Pencil size={15} />
              </IconButton>
            )}
            <IconButton
              label={t.home.forget}
              onClick={() =>
                useStore.setState({
                  modal: {
                    kind: 'confirm',
                    title: t.home.forget,
                    text: t.home.forgetConfirm,
                    confirmLabel: t.home.forget,
                    danger: true,
                    onConfirm: async () => {
                      const list = await unwrap(oda().client.forget(h.hostId));
                      useStore.setState({ savedHosts: list });
                    },
                  },
                })
              }
            >
              <Trash2 size={15} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}

export function HomeView() {
  return (
    <div className="center-scroll">
      <div className="page">
        <h1>{t.home.title}</h1>
        <p className="lead">{t.home.welcomeText}</p>
        <SavedHostsCard />
        <InvitesCard />
        <MembersCard />
        <Tooltip label={t.settings.unsigned}>
          <span className="hint">ODA {useStore.getState().appInfo?.version}</span>
        </Tooltip>
      </div>
    </div>
  );
}
