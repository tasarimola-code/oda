import { useEffect, useMemo, useState } from 'react';
import { Copy, Check, ShieldCheck } from 'lucide-react';
import { useStore, toast, type ModalState } from '../store/store';
import { Button, Modal, Avatar, useCopy } from './ui';
import { oda, rpc, unwrap, errorText } from '../lib/api';
import { OWN_INVITE_DAYS, OWN_INVITE_USES, createRoomInvite, enterRoom, joinByCode, refreshSavedHosts, selectRoom, updateSettings } from '../store/actions';
import { decodeInvite, shortFingerprint } from '../../shared/invite';
import { capacityNote, capacityOptions } from '../lib/format';
import { DEFAULT_PORT, MAX_ROOM_CAPACITY } from '../../shared/protocol';
import { t } from '../i18n';
import { StartFlow } from './Onboarding';

const close = () => useStore.setState({ modal: null });

const EXPIRY_OPTIONS: Array<[number, string]> = [
  [15, '15 dakika'],
  [60, '1 saat'],
  [1440, '24 saat'],
  [10080, '7 gün'],
  [43200, '30 gün'],
  [129600, '90 gün'],
];
const USE_OPTIONS = [1, 3, 5, 10, 25, 50, 100, 250, 1000];

/** Shows a freshly created invite code with a copy button. */
export function InviteCodeBox({ code, autoCopy = false }: { code: string; autoCopy?: boolean }) {
  const [copied, copy] = useCopy();
  const decoded = decodeInvite(code);
  useEffect(() => {
    if (autoCopy) copy(code);
  }, [code, autoCopy]);
  return (
    <div className="invite-box">
      <textarea className="input mono" readOnly value={code} rows={3} onFocus={(e) => e.target.select()} aria-label={t.join.code} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <Button variant="primary" onClick={() => copy(code)}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? t.common.copied : t.common.copy}
        </Button>
        {decoded && (
          <span className="hint">
            {t.invite.server}: <span className="mono">{decoded.n}</span> · {t.home.fingerprint}: <span className="mono">{shortFingerprint(decoded.f)}…</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Invite for one room the user owns: created as soon as the dialog opens. */
function RoomInviteModal({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId));
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      setCode(await createRoomInvite(roomId));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void generate();
  }, [roomId]);
  return (
    <Modal
      title={`${t.room.invite} · ${room?.name ?? ''}`}
      onClose={close}
      footer={
        <>
          <Button onClick={() => void generate()} loading={busy}>
            {t.share.newCode}
          </Button>
          <Button variant="primary" onClick={close}>
            {t.common.close}
          </Button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        {t.invite.codeHint}
      </p>
      {code && <InviteCodeBox code={code} />}
      {code && <div className="hint" style={{ marginTop: 8 }}>{t.share.validity(OWN_INVITE_USES, OWN_INVITE_DAYS)}</div>}
      {!code && busy && <div className="hint">{t.common.loading}</div>}
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

function InviteModal({ roomId }: { roomId?: string }) {
  if (roomId) return <RoomInviteModal roomId={roomId} />;
  return <AdminInviteModal />;
}

function AdminInviteModal() {
  const rooms = useStore((s) => s.rooms);
  const host = useStore((s) => s.host);
  const limits = host?.inviteLimits ?? { maxUses: 50, maxMinutes: 10080 };
  const expiryOptions = EXPIRY_OPTIONS.filter(([m]) => m <= limits.maxMinutes);
  const useOptions = USE_OPTIONS.filter((n) => n <= limits.maxUses);
  const [minutes, setMinutes] = useState(Math.min(10080, limits.maxMinutes));
  const [uses, setUses] = useState(Math.min(50, limits.maxUses));
  const [roomId, setRoomId] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await rpc('admin.invites.create', { expiresInMinutes: minutes, maxUses: uses, roomId: roomId || null });
      setCode(r.code);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (code) {
    return (
      <Modal title={t.invite.created} onClose={close} footer={<Button onClick={close}>{t.common.close}</Button>}>
        <p className="hint" style={{ marginTop: 0 }}>
          {t.invite.codeHint}
        </p>
        <InviteCodeBox code={code} />
      </Modal>
    );
  }

  return (
    <Modal
      title={t.invite.title}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t.common.cancel}</Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>
            {t.invite.generate}
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label htmlFor="inv-exp">{t.invite.expires}</label>
          <select id="inv-exp" className="select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {expiryOptions.map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="inv-uses">{t.invite.uses}</label>
          <select id="inv-uses" className="select" value={uses} onChange={(e) => setUses(Number(e.target.value))}>
            {useOptions.map((n) => (
              <option key={n} value={n}>
                {n === 1 ? t.invite.single : `${n} kişi`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="inv-room">{t.invite.room}</label>
        <select id="inv-room" className="select" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="">{t.invite.noRoom}</option>
          {rooms
            .filter((r) => r.isPrivate)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </div>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

function CreateRoomModal() {
  const host = useStore((s) => s.host);
  const open = host?.openRegistration ?? false;
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(open);
  const [cap, setCap] = useState(host?.media === 'sfu' ? Math.min(25, host.maxRoomCapacity) : MAX_ROOM_CAPACITY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ roomId: string; code: string } | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const room = await rpc('rooms.create', { name, isPrivate: priv, capacity: cap });
      useStore.setState((s) => ({ rooms: s.rooms.some((r) => r.id === room.id) ? s.rooms : [...s.rooms, room] }));
      selectRoom(room.id);
      if (room.isPrivate) setCreated({ roomId: room.id, code: await createRoomInvite(room.id) });
      else close();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (created) {
    return (
      <Modal
        title={t.share.title}
        onClose={close}
        footer={
          <Button variant="primary" onClick={() => (close(), enterRoom(created.roomId, true))}>
            {t.share.enter}
          </Button>
        }
      >
        <p className="hint" style={{ marginTop: 0 }}>
          {t.share.text}
        </p>
        <InviteCodeBox code={created.code} autoCopy />
        <div className="hint" style={{ marginTop: 8 }}>
          {t.share.validity(OWN_INVITE_USES, OWN_INVITE_DAYS)}
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title={t.createRoom.title}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t.common.cancel}</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {t.common.create}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), void submit())}>
        <div className="field">
          <label htmlFor="rn">{t.createRoom.name}</label>
          <input id="rn" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rc">{t.createRoom.capacity}</label>
          <select id="rc" className="select" value={cap} onChange={(e) => setCap(Number(e.target.value))}>
            {capacityOptions(host, cap).map((n) => (
              <option key={n} value={n}>
                {n} kişi
              </option>
            ))}
          </select>
          <div className="hint">{capacityNote(host)}</div>
        </div>
        {!open && (
          <label className="check">
            <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
            <span>{t.createRoom.private}</span>
          </label>
        )}
        {err && <div className="error-text">{err}</div>}
      </form>
    </Modal>
  );
}

function RenameRoomModal({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId));
  const host = useStore((s) => s.host);
  const [name, setName] = useState(room?.name ?? '');
  const [cap, setCap] = useState(room?.capacity ?? MAX_ROOM_CAPACITY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!room) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await rpc('rooms.update', { roomId, name, capacity: cap });
      close();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t.room.rename}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t.common.cancel}</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="rrn">{t.createRoom.name}</label>
        <input id="rrn" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="rrc">{t.createRoom.capacity}</label>
        <select id="rrc" className="select" value={cap} onChange={(e) => setCap(Number(e.target.value))}>
          {capacityOptions(host, room.capacity).map((n) => (
            <option key={n} value={n}>
              {n} kişi
            </option>
          ))}
        </select>
      </div>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

function RoomMembersModal({ roomId }: { roomId: string }) {
  const users = useStore((s) => s.users);
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId));
  const adminsSeeAll = useStore((s) => !s.host?.openRegistration);
  const [members, setMembers] = useState<string[] | null>(null);
  useEffect(() => {
    void rpc('rooms.members', { roomId })
      .then(setMembers)
      .catch((e) => toast(errorText(e), 'error'));
  }, [roomId]);
  const toggle = async (userId: string, add: boolean) => {
    try {
      setMembers(await rpc(add ? 'rooms.addMember' : 'rooms.removeMember', { roomId, userId }));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <Modal title={`${t.room.members} · ${room?.name ?? ''}`} onClose={close} footer={<Button onClick={close}>{t.common.close}</Button>}>
      {!members && <div className="hint">{t.common.loading}</div>}
      {members &&
        Object.values(users)
          .filter((u) => !u.banned)
          .map((u) => {
            const fixed = u.id === room?.ownerId || (adminsSeeAll && u.role === 'admin');
            const isMember = members.includes(u.id) || fixed;
            return (
              <div className="list-row" key={u.id}>
                <Avatar name={u.displayName} color={u.color} size={30} />
                <div className="grow t1">{u.displayName}</div>
                {fixed ? (
                  <span className="pill warn">{u.id === room?.ownerId ? t.room.owner : t.common.admin}</span>
                ) : (
                  <Button size="sm" variant={isMember ? 'danger' : 'outline-gold'} onClick={() => void toggle(u.id, !isMember)}>
                    {isMember ? t.common.remove : 'Ekle'}
                  </Button>
                )}
              </div>
            );
          })}
    </Modal>
  );
}

function defaultDisplayName(): string {
  const n = (useStore.getState().appInfo?.userName ?? '').replace(/[._-]+/g, ' ').trim();
  return n.length >= 2 && n.length <= 32 ? n : '';
}

export function JoinForm({ onDone, initialName }: { onDone?: () => void; initialName?: string }) {
  const savedHosts = useStore((s) => s.savedHosts);
  const [code, setCode] = useState('');
  const [name, setName] = useState(() => initialName ?? defaultDisplayName());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const preview = useMemo(() => (code.trim() ? decodeInvite(code) : null), [code]);
  const known = !!preview && savedHosts.some((h) => h.hostId === preview.h && !h.isOwnHost);
  const nameOk = known || name.trim().length >= 2;
  const canSubmit = !!preview && nameOk && !busy;

  const submit = async (inviteCode = code) => {
    setErr(null);
    setBusy(true);
    try {
      await joinByCode(inviteCode, name);
      await refreshSavedHosts();
      await updateSettings({ onboardingDone: true });
      useStore.setState({ view: 'chats' });
      onDone?.();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onCodeChange = (value: string) => {
    setCode(value);
    setErr(null);
    const inv = decodeInvite(value);
    const isKnown = !!inv && savedHosts.some((h) => h.hostId === inv.h && !h.isOwnHost);
    if (!busy && inv && (isKnown || name.trim().length >= 2)) void submit(value);
  };

  return (
    <form onSubmit={(e) => (e.preventDefault(), void submit())}>
      {!known && (
        <div className="field">
          <label htmlFor="jn">{t.join.name}</label>
          <input id="jn" className="input" maxLength={32} placeholder={t.join.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>
      )}
      <div className="field">
        <label htmlFor="jc">{t.join.code}</label>
        <textarea
          id="jc"
          autoFocus
          className={`input ${code.trim() && !preview ? 'error' : ''}`}
          rows={3}
          placeholder={t.join.codePlaceholder}
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          disabled={busy}
        />
        {code.trim() && !preview && <div className="error-text">{t.join.badCode}</div>}
        {!code.trim() && <div className="hint">{t.join.codeHint}</div>}
      </div>
      {preview && (
        <div className="banner" style={{ margin: '0 0 14px' }}>
          <ShieldCheck size={18} color="var(--gold)" />
          <div className="grow">
            <div className="title">
              {t.join.preview}: {preview.n}
            </div>
            <div className="desc">
              <span className="mono">{preview.a[0]}</span> · {t.home.fingerprint}: <span className="mono">{shortFingerprint(preview.f)}</span>
            </div>
          </div>
        </div>
      )}
      {err && (
        <div className="error-text" role="alert">
          {err}
          {/ulaşılamıyor|reddetti|yanıt vermedi|kapattı/.test(err) && <div className="hint">{t.status.unreachableHint}</div>}
        </div>
      )}
      <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
        {busy ? t.status.connecting(preview?.n ?? '') : t.join.submit}
      </Button>
    </form>
  );
}

function EditAddressModal({ hostId }: { hostId: string }) {
  const h = useStore((s) => s.savedHosts.find((x) => x.hostId === hostId));
  const [addr, setAddr] = useState(h?.lastAddress ?? h?.addresses[0] ?? '');
  const [port, setPort] = useState(String(h?.port ?? DEFAULT_PORT));
  const [err, setErr] = useState<string | null>(null);
  if (!h) return null;
  const save = async () => {
    try {
      const list = await unwrap(oda().client.updateSavedAddress(hostId, addr.trim(), Number(port)));
      useStore.setState({ savedHosts: list, modal: null });
      await unwrap(oda().client.connectSaved(hostId));
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <Modal
      title={`${t.home.editAddress} · ${h.hostName}`}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t.common.cancel}</Button>
          <Button variant="primary" onClick={() => void save()}>
            {t.common.save} ve bağlan
          </Button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Sunucunun adresi değiştiyse yeni IP adresini veya alan adını girin. Güvenlik parmak izi değişmez; bu adreste farklı bir sunucu çalışıyorsa bağlantı reddedilir.
      </p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="ea">IP / DNS</label>
          <input id="ea" className="input" value={addr} onChange={(e) => setAddr(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ep">{t.home.port}</label>
          <input id="ep" className="input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
        </div>
      </div>
      <div className="hint">Bilinen adresler: {h.addresses.join(', ')}</div>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

function ConfirmModal({ m }: { m: Extract<ModalState, { kind: 'confirm' }> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={m.title}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t.common.cancel}</Button>
          <Button
            variant={m.danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await m.onConfirm();
                close();
              } catch (e) {
                toast(errorText(e), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {m.confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0, color: 'var(--text-2)' }}>{m.text}</p>
    </Modal>
  );
}

export function ModalHost() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'invite':
      return <InviteModal roomId={modal.roomId} />;
    case 'createRoom':
      return <CreateRoomModal />;
    case 'renameRoom':
      return <RenameRoomModal roomId={modal.roomId} />;
    case 'roomMembers':
      return <RoomMembersModal roomId={modal.roomId} />;
    case 'join':
      return (
        <Modal title={t.join.title} onClose={close}>
          <JoinForm onDone={close} />
        </Modal>
      );
    case 'start':
      return (
        <Modal title={modal.step === 'create' ? t.onboarding.create : t.join.title} onClose={close}>
          <StartFlow initialStep={modal.step} onDone={close} />
        </Modal>
      );
    case 'editAddress':
      return <EditAddressModal hostId={modal.hostId} />;
    case 'confirm':
      return <ConfirmModal m={modal} />;
  }
}
