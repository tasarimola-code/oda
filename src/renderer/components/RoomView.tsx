import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Headphones, HeadphoneOff, Link2, LogIn, Mic, MicOff, MoreVertical, PhoneOff, PhoneIncoming, Plus, SlidersHorizontal, UserPlus, Users, VolumeX, Volume2, RefreshCw, PanelRightClose, PanelRightOpen, Check } from 'lucide-react';
import { useStore, isConnected, type PeerUi } from '../store/store';
import { joinVoice, leaveVoice, openCreateRoom, openJoin, retryMic, retryPeer, setPeerVolume, setView, signIn, toggleDeafen, toggleMute, togglePeerMuted, updateSettings } from '../store/actions';
import { Avatar, Button, EmptyState, GoldBars, IconButton, MenuItem, Popover, Tooltip } from './ui';
import { capacityNote, pathLabel } from '../lib/format';
import { rpc, errorText } from '../lib/api';
import { toast } from '../store/store';
import type { RoomInfo, UserPublic, VoiceParticipant } from '../../shared/protocol';
import { t } from '../i18n';

function SpeakRing({ radius }: { radius: number }) {
  const bars = useMemo(
    () =>
      Array.from({ length: 44 }, (_, i) => {
        const deg = (360 / 44) * i;
        const h = 5 + Math.round(9 * Math.abs(Math.sin(i * 1.93)));
        return { deg, h, delay: ((i * 137) % 900) / 1000 };
      }),
    [],
  );
  return (
    <span className="speak-ring" aria-hidden>
      {bars.map((b, i) => (
        <span key={i} style={{ height: b.h, marginLeft: -1, transform: `rotate(${b.deg}deg) translateY(${radius}px)`, animationDelay: `${b.delay}s` }} />
      ))}
    </span>
  );
}

function ParticipantCard({ user, participant, peer, isSelf, removeFrom }: { user: UserPublic; participant: VoiceParticipant | null; peer: PeerUi | null; isSelf: boolean; removeFrom: RoomInfo | null }) {
  const inVoice = useStore((s) => !!s.voice.roomId && !s.voice.joining);
  const localSpeaking = useStore((s) => s.voice.localSpeaking);
  const micError = useStore((s) => s.voice.micError);
  const me = useStore((s) => s.me);
  const settings = useStore((s) => s.settings);
  const blocked = useStore((s) => s.blocked.includes(user.id));
  const [menu, setMenu] = useState(false);
  const muted = participant ? participant.muted || participant.deafened : false;
  const speaking = !muted && (isSelf ? localSpeaking && inVoice : !!peer?.speaking);
  const localMuted = !!settings?.audio.peerMuted[user.id] || blocked;
  const volume = settings?.audio.peerVolumes[user.id] ?? 100;

  let sub: { text: string; cls?: string } = { text: '' };
  if (isSelf) sub = { text: micError ? t.mic.listenOnly : t.room.you, cls: micError ? 'warn' : undefined };
  else if (participant?.deafened) sub = { text: t.room.deafenedBadge };
  else if (peer?.state === 'connecting') sub = { text: t.room.peerConnecting, cls: 'warn' };
  else if (peer?.state === 'failed') sub = { text: t.room.peerFailed, cls: 'err' };
  else if (peer?.state === 'connected') sub = { text: localMuted ? t.room.localMute : pathLabel(peer.pathKind) };

  return (
    <div className={`p-card ${speaking ? 'speaking' : ''}`} aria-label={`${user.displayName}${speaking ? ', ' + t.room.speaking : ''}${muted ? ', ' + t.room.mutedBadge : ''}`}>
      {!isSelf && inVoice && (
        <span className="p-menu" style={{ position: 'absolute' }}>
          <IconButton label={t.room.more} onClick={() => setMenu((v) => !v)}>
            <MoreVertical size={16} />
          </IconButton>
          <Popover open={menu} onClose={() => setMenu(false)} style={{ right: 0, top: 36 }}>
            <div className="menu-label">{t.room.volume}</div>
            <div style={{ padding: '4px 10px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="range" min={0} max={100} value={volume} aria-label={`${user.displayName} ${t.room.volume}`} onChange={(e) => setPeerVolume(user.id, Number(e.target.value))} />
              <span className="hint" style={{ width: 34, textAlign: 'right' }}>
                {volume}%
              </span>
            </div>
            <MenuItem onClick={() => togglePeerMuted(user.id)}>
              {localMuted ? <Volume2 size={15} /> : <VolumeX size={15} />}
              {localMuted ? t.room.localUnmute : t.room.localMute}
            </MenuItem>
            {peer?.state === 'failed' && (
              <MenuItem onClick={() => (retryPeer(user.id), setMenu(false))}>
                <RefreshCw size={15} />
                {t.common.retry}
              </MenuItem>
            )}
            {removeFrom && removeFrom.isPrivate && user.id !== removeFrom.ownerId && (
              <>
                <div className="menu-sep" />
                <MenuItem
                  danger
                  onClick={() => {
                    setMenu(false);
                    void rpc('rooms.removeMember', { roomId: removeFrom.id, userId: user.id }).catch((e) => toast(errorText(e), 'error'));
                  }}
                >
                  <PhoneOff size={15} />
                  {t.room.removeFromRoom}
                </MenuItem>
              </>
            )}
            {me?.role === 'admin' && user.role !== 'admin' && (
              <>
                <div className="menu-sep" />
                <MenuItem
                  danger
                  onClick={() => {
                    setMenu(false);
                    void rpc('admin.users.kick', { userId: user.id }).catch((e) => toast(errorText(e), 'error'));
                  }}
                >
                  <PhoneOff size={15} />
                  {t.room.kickFromRoom}
                </MenuItem>
              </>
            )}
          </Popover>
        </span>
      )}
      <div className="p-avatar-wrap">
        <SpeakRing radius={50} />
        <Avatar name={user.displayName} color={user.color} size={88} fontSize={38} />
      </div>
      <div className="p-name" title={user.displayName}>
        {user.displayName}
      </div>
      <div className={`p-sub ${sub.cls ?? ''}`}>
        {sub.text}
        {peer?.state === 'failed' && (
          <Tooltip label={t.room.peerFailedHint.slice(0, 60) + '…'}>
            <button type="button" className="icon-btn" style={{ width: 22, height: 22, marginLeft: 4, verticalAlign: 'middle' }} aria-label={t.common.retry} onClick={() => retryPeer(user.id)}>
              <RefreshCw size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      {isSelf ? (
        <Tooltip label={muted ? t.room.unmuteMic : t.room.muteMic}>
          <button type="button" className={`p-mic ${muted ? 'muted' : ''}`} aria-label={muted ? t.room.unmuteMic : t.room.muteMic} onClick={() => void toggleMute()} disabled={!inVoice}>
            {muted ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
        </Tooltip>
      ) : (
        <span className={`p-mic ${muted ? 'muted' : ''}`} aria-hidden>
          {participant?.deafened ? <HeadphoneOff size={16} /> : muted ? <MicOff size={17} /> : <Mic size={17} />}
        </span>
      )}
    </div>
  );
}

function DeviceMenu({ kind, open, onClose }: { kind: 'audioinput' | 'audiooutput'; open: boolean; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!open) return;
    void navigator.mediaDevices.enumerateDevices().then((list) => setDevices(list.filter((d) => d.kind === kind)));
  }, [open, kind]);
  if (!settings) return null;
  const selected = kind === 'audioinput' ? settings.audio.inputDeviceId : settings.audio.outputDeviceId;
  const choose = (id: string) => {
    void updateSettings({ audio: kind === 'audioinput' ? { inputDeviceId: id } : { outputDeviceId: id } });
    onClose();
  };
  const list = devices.filter((d) => d.deviceId !== 'communications');
  return (
    <Popover open={open} onClose={onClose} style={{ bottom: 56, left: -20, minWidth: 280 }}>
      <div className="menu-label">{kind === 'audioinput' ? t.settings.input : t.settings.output}</div>
      {list.length === 0 && (
        <MenuItem onClick={() => choose('default')} selected>
          <Check size={14} /> {t.settings.defaultDevice}
        </MenuItem>
      )}
      {list.map((d) => {
        const isSel = selected === d.deviceId || (selected === 'default' && d.deviceId === 'default');
        return (
          <MenuItem key={d.deviceId} onClick={() => choose(d.deviceId)} selected={isSel}>
            <span style={{ width: 14 }}>{isSel && <Check size={14} />}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label || (d.deviceId === 'default' ? t.settings.defaultDevice : d.deviceId.slice(0, 12))}</span>
          </MenuItem>
        );
      })}
      <div className="menu-sep" />
      <MenuItem onClick={() => (onClose(), setView('settings'))}>
        <SlidersHorizontal size={14} /> {t.room.audioSettings}
      </MenuItem>
    </Popover>
  );
}

function connectionSummary(peers: Record<string, PeerUi>): { text: string; err?: boolean; detail: string } {
  const list = Object.values(peers);
  const server = t.net.server;
  if (list.length === 0) return { text: server, detail: `${t.net.serverHost}: ${server}` };
  const failed = list.filter((p) => p.state === 'failed').length;
  if (failed) return { text: `${t.net.failed} (${failed})`, err: true, detail: t.room.peerFailedHint };
  if (list.some((p) => p.state === 'connecting')) return { text: t.net.connecting, detail: t.room.peerConnecting };
  return { text: server, detail: `Ses: ${server}` };
}

export function RoomView() {
  const connected = useStore(isConnected);
  const room = useStore((s) => s.rooms.find((r) => r.id === s.activeRoomId) ?? null);
  const roomCount = useStore((s) => s.rooms.length);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  const host = useStore((s) => s.host);
  const voice = useStore((s) => s.voice);
  const chatOpen = useStore((s) => s.chatOpen);
  const hasAccount = useStore((s) => s.savedHosts.some((h) => !h.isOwnHost));
  const [menu, setMenu] = useState<null | 'mic' | 'out' | 'room'>(null);

  if (!connected || !room || !me) {
    if (!connected && hasAccount) {
      return (
        <div className="center-scroll">
          <EmptyState icon={<GoldBars size={30} />} title={t.home.signedOut} text={t.home.signedOutText}>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={() => void signIn()}>
                <LogIn size={16} /> {t.home.signIn}
              </Button>
            </div>
          </EmptyState>
        </div>
      );
    }
    const noRooms = !connected || roomCount === 0;
    return (
      <div className="center-scroll">
        <EmptyState icon={<GoldBars size={30} />} title={noRooms ? t.home.noRooms : t.room.selectRoom} text={noRooms ? t.home.noRoomsText : undefined}>
          {noRooms && (
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={openCreateRoom}>
                <Plus size={16} /> {t.onboarding.create}
              </Button>
              <Button variant="outline-gold" onClick={openJoin}>
                <LogIn size={16} /> {t.onboarding.join}
              </Button>
            </div>
          )}
        </EmptyState>
      </div>
    );
  }
  const owner = room.ownerId === me.id || me.role === 'admin';

  const inThisRoom = voice.roomId === room.id;
  const inOtherRoom = !!voice.roomId && !inThisRoom;
  const participants = room.voice;
  const count = participants.length;
  const full = count >= room.capacity && !participants.some((p) => p.userId === me.id);
  const conn = connectionSummary(inThisRoom ? voice.peers : {});
  const micOff = voice.muted || voice.deafened;

  return (
    <>
      <header className="room-header">
        <GoldBars size={34} />
        <div style={{ minWidth: 0 }}>
          <h1 title={room.name}>{room.name}</h1>
          <div className="sub">
            <Users size={14} />
            {t.room.connected(count)} · {t.room.capacity(count, room.capacity)}
          </div>
        </div>
        <div className="actions">
          <Tooltip label={owner ? t.room.invite : t.invite.ownerOnly} placement="bottom">
            <Button variant="outline-gold" onClick={() => useStore.setState({ modal: { kind: 'invite', roomId: room.id } })} disabled={!owner}>
              <UserPlus size={17} />
              {t.room.invite}
            </Button>
          </Tooltip>
          <span style={{ position: 'relative' }}>
            <IconButton label={t.room.more} onClick={() => setMenu(menu === 'room' ? null : 'room')} placement="bottom">
              <MoreVertical size={18} />
            </IconButton>
            <Popover open={menu === 'room'} onClose={() => setMenu(null)} style={{ right: 0, top: 38 }}>
              <MenuItem onClick={() => (useStore.setState({ chatOpen: !chatOpen }), setMenu(null))}>
                {chatOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
                {chatOpen ? t.chat.closePanel : t.chat.openPanel}
              </MenuItem>
              {owner && (
                <>
                  <MenuItem onClick={() => (useStore.setState({ modal: { kind: 'renameRoom', roomId: room.id } }), setMenu(null))}>{t.room.rename}</MenuItem>
                  {room.isPrivate && <MenuItem onClick={() => (useStore.setState({ modal: { kind: 'roomMembers', roomId: room.id } }), setMenu(null))}>{t.room.members}</MenuItem>}
                  <div className="menu-sep" />
                  <MenuItem
                    danger
                    onClick={() => {
                      setMenu(null);
                      useStore.setState({
                        modal: {
                          kind: 'confirm',
                          title: t.room.deleteRoom,
                          text: `"${room.name}" silinsin mi? Odadaki herkes sesli sohbetten çıkarılır.`,
                          confirmLabel: t.common.delete,
                          danger: true,
                          onConfirm: async () => {
                            await rpc('rooms.delete', { roomId: room.id });
                          },
                        },
                      });
                    }}
                  >
                    {t.room.deleteRoom}
                  </MenuItem>
                </>
              )}
            </Popover>
          </span>
        </div>
      </header>

      {inThisRoom && voice.micError && (
        <div className="banner warn" role="alert">
          <MicOff size={18} />
          <div className="grow">
            <div className="title">{voice.micError === 'denied' ? t.mic.denied : voice.micError === 'notfound' ? t.mic.notFound : t.mic.busy}</div>
            <div className="desc">{voice.micError === 'denied' ? t.mic.deniedHint : voice.micError === 'notfound' ? t.mic.notFoundHint : t.mic.busyHint}</div>
          </div>
          {voice.micError === 'denied' && (
            <Button size="sm" onClick={() => void window.oda.app.openMicPrivacy()}>
              {t.mic.openPrivacy}
            </Button>
          )}
          <Button size="sm" variant="outline-gold" onClick={() => void retryMic()}>
            {t.common.retry}
          </Button>
        </div>
      )}

      <div className="center-scroll">
        <div className="stage">
          {count === 0 && !inThisRoom ? (
            <EmptyState icon={<Mic size={26} />} title={t.room.empty} text={t.room.emptyHint} />
          ) : (
            <div className="cards" role="list">
              {participants.map((p) => {
                const u = users[p.userId];
                if (!u) return null;
                const isSelf = p.userId === me.id;
                return (
                  <div role="listitem" key={p.userId}>
                    <ParticipantCard user={u} participant={p} peer={isSelf || !inThisRoom ? null : (voice.peers[p.userId] ?? { state: 'connecting', pathKind: null, speaking: false })} isSelf={isSelf} removeFrom={owner ? room : null} />
                  </div>
                );
              })}
            </div>
          )}
          <div className="room-info">
            <Tooltip label={conn.detail.length > 90 ? conn.detail.slice(0, 90) + '…' : conn.detail}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Link2 size={15} color="var(--gold)" />
                {t.room.connection}: <b className={conn.err ? 'err' : ''}>{conn.text}</b>
              </span>
            </Tooltip>
            <span className="sep" />
            <span>
              {t.room.owner}: {(room.ownerId && users[room.ownerId]?.displayName) || host?.ownerName || '—'}
            </span>
          </div>
          <div className="room-note">
            {t.room.hostNote} {capacityNote(host)}
          </div>
        </div>
      </div>

      <div className="control-bar" role="toolbar" aria-label="Ses denetimleri">
        <div className="ctl">
          <div className="ctl-row" style={{ position: 'relative' }}>
            <Tooltip label={micOff ? t.room.unmuteMic : t.room.muteMic}>
              <button type="button" className={`ctl-btn ${inThisRoom && micOff ? 'off' : ''}`} aria-pressed={inThisRoom && micOff} aria-label={micOff ? t.room.unmuteMic : t.room.muteMic} disabled={!inThisRoom} onClick={() => void toggleMute()}>
                {micOff ? <MicOff size={19} /> : <Mic size={19} />}
              </button>
            </Tooltip>
            <button type="button" className="ctl-caret" aria-label={t.settings.input} onClick={() => setMenu(menu === 'mic' ? null : 'mic')}>
              <ChevronDown size={15} />
            </button>
            <DeviceMenu kind="audioinput" open={menu === 'mic'} onClose={() => setMenu(null)} />
          </div>
          {t.room.mic}
        </div>
        <div className="ctl">
          <div className="ctl-row" style={{ position: 'relative' }}>
            <Tooltip label={voice.deafened ? t.room.undeafen : t.room.deafen}>
              <button type="button" className={`ctl-btn ${inThisRoom && voice.deafened ? 'off' : ''}`} aria-pressed={inThisRoom && voice.deafened} aria-label={voice.deafened ? t.room.undeafen : t.room.deafen} disabled={!inThisRoom} onClick={() => void toggleDeafen()}>
                {voice.deafened ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
              </button>
            </Tooltip>
            <button type="button" className="ctl-caret" aria-label={t.settings.output} onClick={() => setMenu(menu === 'out' ? null : 'out')}>
              <ChevronDown size={15} />
            </button>
            <DeviceMenu kind="audiooutput" open={menu === 'out'} onClose={() => setMenu(null)} />
          </div>
          {t.room.headset}
        </div>
        <div className="ctl">
          <Tooltip label={t.room.audioSettings}>
            <button type="button" className="ctl-btn" aria-label={t.room.audioSettings} onClick={() => setView('settings')}>
              <SlidersHorizontal size={19} />
            </button>
          </Tooltip>
          {t.room.audioSettings}
        </div>
        <span className="ctl-sep" />
        {inThisRoom ? (
          <button type="button" className="leave-btn" onClick={() => void leaveVoice()} disabled={voice.joining}>
            {voice.joining ? <span className="spinner" /> : <PhoneOff size={18} />}
            {voice.joining ? t.room.joining : t.room.leave}
          </button>
        ) : (
          <Tooltip label={full ? t.room.full : inOtherRoom ? t.room.inVoiceElsewhere : t.room.join}>
            <button type="button" className="leave-btn" onClick={() => void joinVoice(room.id)} disabled={full || voice.joining}>
              {voice.joining ? <span className="spinner" /> : <PhoneIncoming size={18} />}
              {voice.joining ? t.room.joining : full ? t.room.full : t.room.join}
            </button>
          </Tooltip>
        )}
      </div>
    </>
  );
}
