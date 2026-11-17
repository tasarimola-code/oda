import { AudioPresets, DisconnectReason, LogLevel, Room, RoomEvent, Track, setLogLevel, type LocalTrackPublication, type Participant, type RemoteParticipant, type RemoteTrack } from 'livekit-client';
import type { RtcSignal, VoiceParticipant } from '../../shared/protocol';
import type { PeerUi } from '../store/store';
import { BaseVoice, type JoinResult } from './base';

setLogLevel(LogLevel.error);

const PRESENCE_TIMEOUT_MS = 20_000;
const MAX_REJOINS = 4;

interface Peer {
  userId: string;
  audio: HTMLAudioElement;
  track: RemoteTrack | null;
  ui: PeerUi;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Media server (SFU) transport: each participant sends one audio stream to the host's LiveKit server,
 * which forwards it to the others. Signaling goes through the main-process loopback bridge, which pins
 * the host certificate; media goes to the server's UDP/TCP ports directly.
 */
export class SfuVoice extends BaseVoice {
  private room: Room | null = null;
  private pub: LocalTrackPublication | null = null;
  private peers = new Map<string, Peer>();
  private expected = new Set<string>();
  private remoteMuted = new Set<string>();
  private linkUp = false;
  private rejoins = 0;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;

  async start(res: JoinResult): Promise<void> {
    if (!res.sfu) throw new Error('Sunucu ses bağlantı bilgisi göndermedi.');
    this.syncExpected(res.participants);
    await this.connectRoom(res.sfu.token);
  }

  // ---------------------------------------------------------------- media server link
  private async connectRoom(token: string): Promise<void> {
    const roomId = this.roomId;
    const url = await this.cb.sfuUrl();
    if (!this.active || this.roomId !== roomId) return;
    this.dropRoom();
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      webAudioMix: false,
      disconnectOnPageLeave: true,
      stopLocalTrackOnUnpublish: false,
      publishDefaults: { dtx: true, red: true, audioPreset: AudioPresets.speech, stopMicTrackOnMute: false },
    });
    this.room = room;
    this.wire(room);
    try {
      // No ICE servers: candidates come only from the media server itself, nothing third-party is contacted.
      await room.connect(url, token, { autoSubscribe: true, maxRetries: 1, peerConnectionTimeout: 15_000, websocketTimeout: 15_000, rtcConfig: { iceServers: [] } });
    } catch (e) {
      if (this.room === room) this.dropRoom();
      throw e;
    }
    if (this.room !== room) return;
    this.linkUp = true;
    this.rejoins = 0;
    for (const p of room.remoteParticipants.values()) this.onRemoteJoined(p);
    await this.publishLocal();
    this.refreshStates();
  }

  private wire(room: Room): void {
    const mine = () => this.room === room;
    room
      .on(RoomEvent.ParticipantConnected, (p) => mine() && this.onRemoteJoined(p))
      .on(RoomEvent.ParticipantDisconnected, (p) => mine() && this.onRemoteLeft(p.identity))
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => mine() && this.onTrack(p, track))
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => {
        if (!mine()) return;
        track.detach();
        const peer = this.peers.get(p.identity);
        if (peer?.track === track) peer.track = null;
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => mine() && this.onSpeakers(speakers))
      .on(RoomEvent.Reconnecting, () => {
        if (!mine()) return;
        this.linkUp = false;
        this.refreshStates();
      })
      .on(RoomEvent.Reconnected, () => {
        if (!mine()) return;
        this.linkUp = true;
        this.refreshStates();
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => mine() && this.onLinkLost(reason));
  }

  private async publishLocal(): Promise<void> {
    const room = this.room;
    const track = this.localTrack;
    if (!room || !track || this.pub) return;
    try {
      const pub = await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: true, red: true, stopMicTrackOnMute: false });
      if (this.room !== room) return;
      this.pub = pub;
      this.syncMute();
    } catch {
      /* listen-only: a missing publish must not break receiving */
    }
  }

  protected onLocalTrack(track: MediaStreamTrack | null): void {
    if (!this.room || !this.linkUp) return;
    const pubTrack = this.pub?.track;
    if (track && pubTrack) {
      void pubTrack.replaceTrack(track, true).then(() => this.syncMute()).catch(() => undefined);
    } else if (track) {
      void this.publishLocal();
    } else if (this.pub?.track) {
      void this.room.localParticipant.unpublishTrack(this.pub.track, false).catch(() => undefined);
      this.pub = null;
    }
  }

  private syncMute(): void {
    const t = this.pub?.track;
    if (!t) return;
    const off = this.muted || this.deafened;
    if (off && !t.isMuted) void t.mute().catch(() => undefined);
    else if (!off && t.isMuted) void t.unmute().catch(() => undefined);
  }

  override setMuted(muted: boolean): void {
    super.setMuted(muted);
    this.syncMute();
  }

  private onLinkLost(reason?: DisconnectReason): void {
    this.linkUp = false;
    this.dropRoom();
    const roomId = this.roomId;
    if (!roomId) return;
    const final = reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.DUPLICATE_IDENTITY;
    if (final || this.rejoins >= MAX_REJOINS) {
      this.refreshStates(true);
      return;
    }
    this.refreshStates();
    this.scheduleRejoin(roomId);
  }

  private scheduleRejoin(roomId: string): void {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    const delay = Math.min(15_000, 1000 * 2 ** this.rejoins);
    this.rejoins++;
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      void this.rejoin(roomId);
    }, delay);
  }

  private async rejoin(roomId: string): Promise<void> {
    if (this.roomId !== roomId) return;
    try {
      const grant = await this.cb.regrant(roomId);
      if (!grant || this.roomId !== roomId) return;
      await this.connectRoom(grant.token);
    } catch {
      if (this.roomId !== roomId) return;
      if (this.rejoins < MAX_REJOINS) this.scheduleRejoin(roomId);
      else this.refreshStates(true);
    }
  }

  private dropRoom(): void {
    const room = this.room;
    this.room = null;
    this.pub = null;
    this.linkUp = false;
    if (!room) return;
    room.removeAllListeners();
    for (const p of this.peers.values()) {
      p.track?.detach();
      p.track = null;
    }
    void room.disconnect(true).catch(() => undefined);
  }

  protected closeTransport(): void {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    this.rejoins = 0;
    this.dropRoom();
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.expected.clear();
    this.remoteMuted.clear();
  }

  // ---------------------------------------------------------------- participants
  private syncExpected(participants: VoiceParticipant[]): void {
    this.expected = new Set(participants.filter((p) => p.userId !== this.selfId).map((p) => p.userId));
    this.remoteMuted = new Set(participants.filter((p) => p.muted || p.deafened).map((p) => p.userId));
    for (const id of [...this.peers.keys()]) if (!this.expected.has(id)) this.closePeer(id);
    for (const id of this.expected) this.ensurePeer(id);
  }

  onParticipants(roomId: string, participants: VoiceParticipant[]): boolean {
    if (roomId !== this.roomId) return true;
    if (this.selfId && !participants.some((p) => p.userId === this.selfId)) return false;
    this.syncExpected(participants);
    this.refreshStates();
    return true;
  }

  private ensurePeer(userId: string): Peer {
    let peer = this.peers.get(userId);
    if (peer) return peer;
    const audio = new Audio();
    audio.autoplay = true;
    peer = { userId, audio, track: null, ui: { state: 'connecting', pathKind: null, speaking: false }, timer: null };
    this.peers.set(userId, peer);
    this.sinkTo(audio);
    this.outputTo(audio, userId);
    this.armTimer(peer);
    return peer;
  }

  private armTimer(peer: Peer): void {
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = setTimeout(() => {
      peer.timer = null;
      if (peer.ui.state === 'connecting' && this.peers.get(peer.userId) === peer) {
        peer.ui = { ...peer.ui, state: 'failed', pathKind: null, speaking: false };
        this.emitPeers();
      }
    }, PRESENCE_TIMEOUT_MS);
  }

  private onRemoteJoined(p: RemoteParticipant): void {
    if (!this.expected.has(p.identity)) return;
    this.ensurePeer(p.identity);
    for (const pub of p.audioTrackPublications.values()) if (pub.track) this.onTrack(p, pub.track);
    this.refreshStates();
  }

  private onRemoteLeft(identity: string): void {
    const peer = this.peers.get(identity);
    if (!peer) return;
    peer.track?.detach();
    peer.track = null;
    if (!this.expected.has(identity)) this.closePeer(identity);
    this.refreshStates();
  }

  private onTrack(p: RemoteParticipant, track: RemoteTrack): void {
    if (track.kind !== Track.Kind.Audio || !this.expected.has(p.identity)) return;
    const peer = this.ensurePeer(p.identity);
    if (peer.track && peer.track !== track) peer.track.detach();
    peer.track = track;
    track.attach(peer.audio);
    this.outputTo(peer.audio, peer.userId);
    void peer.audio.play().catch(() => undefined);
  }

  private onSpeakers(speakers: Participant[]): void {
    const ids = new Set(speakers.map((s) => s.identity));
    let changed = false;
    for (const p of this.peers.values()) {
      const speaking = p.ui.state === 'connected' && ids.has(p.userId) && !this.remoteMuted.has(p.userId);
      if (p.ui.speaking !== speaking) {
        p.ui = { ...p.ui, speaking };
        changed = true;
      }
    }
    if (changed) this.emitPeers();
  }

  /** Derives each peer's UI state from our link and whether they are present on the media server. */
  private refreshStates(failed = false): void {
    const room = this.room;
    for (const p of this.peers.values()) {
      const present = !!room && this.linkUp && [...room.remoteParticipants.values()].some((r) => r.identity === p.userId);
      let next: PeerUi;
      if (failed) next = { state: 'failed', pathKind: null, speaking: false };
      else if (present) next = { ...p.ui, state: 'connected', pathKind: 'server' };
      else if (p.ui.state === 'failed' && this.linkUp) next = p.ui;
      else next = { state: 'connecting', pathKind: null, speaking: false };
      if (next.state === 'connected' && p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
      if (next.state === 'connecting' && p.ui.state !== 'connecting') this.armTimer(p);
      p.ui = next;
    }
    this.emitPeers();
  }

  private closePeer(userId: string): void {
    const p = this.peers.get(userId);
    if (!p) return;
    this.peers.delete(userId);
    if (p.timer) clearTimeout(p.timer);
    p.track?.detach();
    p.audio.pause();
    p.audio.srcObject = null;
  }

  /** Manual retry: reconnects to the media server if our link is down, otherwise waits for the peer again. */
  retryPeer(userId: string): void {
    const roomId = this.roomId;
    if (!roomId) return;
    if (!this.linkUp) {
      this.rejoins = 0;
      if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
      for (const p of this.peers.values()) p.ui = { state: 'connecting', pathKind: null, speaking: false };
      this.emitPeers();
      void this.rejoin(roomId);
      return;
    }
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.ui = { ...peer.ui, state: 'connecting' };
    this.armTimer(peer);
    this.refreshStates();
  }

  async onSignal(_from: string, _data: RtcSignal): Promise<void> {
    /* no peer-to-peer signaling in SFU mode */
  }

  // ---------------------------------------------------------------- output
  protected applySink(): void {
    for (const p of this.peers.values()) this.sinkTo(p.audio);
  }

  protected applyOutput(): void {
    for (const p of this.peers.values()) this.outputTo(p.audio, p.userId);
  }

  protected tickRemote(): boolean {
    return false;
  }

  protected emitPeers(): void {
    const out: Record<string, PeerUi> = {};
    for (const [id, p] of this.peers) out[id] = p.ui;
    this.cb.onPeers(out);
  }
}
