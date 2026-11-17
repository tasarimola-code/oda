import type { RtcSignal, SfuGrant, VoiceParticipant } from '../../shared/protocol';
import type { AudioSettings } from '../../shared/ipc';
import type { MicError, PeerUi } from '../store/store';

const SPEAK_ON = 0.035;
const SPEAK_OFF = 0.02;
const SPEAK_ON_FRAMES = 2;
const SPEAK_HOLD_MS = 350;
const TICK_MS = 60;

export interface VoiceCallbacks {
  signal(to: string, data: RtcSignal): Promise<void>;
  onPeers(peers: Record<string, PeerUi>): void;
  onLocalSpeaking(v: boolean): void;
  onMicError(e: MicError): void;
  onDeviceFallback(kind: 'input' | 'output'): void;
  /** SFU mode: loopback URL of the pinned bridge to the host's media server. */
  sfuUrl(): Promise<string>;
  /** SFU mode: asks the host for a fresh media grant for the current room (null: no longer in it). */
  regrant(roomId: string): Promise<SfuGrant | null>;
}

/** Result of the host's voice.join. */
export interface JoinResult {
  participants: VoiceParticipant[];
  sfu?: SfuGrant;
}

export class SpeakDetector {
  private above = 0;
  private lastLoud = 0;
  speaking = false;
  level = 0;

  constructor(
    private read: () => number,
    private release: () => void = () => undefined,
  ) {}

  /** Local microphone: RMS from an analyser on the captured stream. */
  static fromStream(ctx: AudioContext, stream: MediaStream): SpeakDetector {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    const buf = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    return new SpeakDetector(
      () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return Math.sqrt(sum / buf.length);
      },
      () => {
        source.disconnect();
        analyser.disconnect();
      },
    );
  }

  /**
   * Remote peer: RFC 6464 audio level carried in each RTP packet. Routing remote tracks through
   * WebAudio is unreliable in Chromium (intermittent silence), so the receiver's level is used instead.
   */
  static fromReceiver(receiver: RTCRtpReceiver): SpeakDetector {
    return new SpeakDetector(() => {
      const src = receiver.getSynchronizationSources()[0];
      if (!src) return 0;
      const now = performance.now();
      const age = Math.min(Math.abs(performance.timeOrigin + now - src.timestamp), Math.abs(now - src.timestamp));
      return age > 500 ? 0 : (src.audioLevel ?? 0);
    });
  }

  /** Returns true when the speaking state changed. */
  sample(now: number, enabled: boolean): boolean {
    const rms = this.read();
    this.level = this.level * 0.6 + rms * 0.4;
    const prev = this.speaking;
    if (!enabled) {
      this.above = 0;
      this.speaking = false;
      return prev !== this.speaking;
    }
    if (rms > SPEAK_ON) {
      this.above++;
      this.lastLoud = now;
      if (this.above >= SPEAK_ON_FRAMES) this.speaking = true;
    } else {
      this.above = 0;
      if (rms > SPEAK_OFF) this.lastLoud = now;
      if (this.speaking && now - this.lastLoud > SPEAK_HOLD_MS) this.speaking = false;
    }
    return prev !== this.speaking;
  }

  dispose(): void {
    try {
      this.release();
    } catch {
      /* ignore */
    }
  }
}

export function micErrorOf(e: unknown): MicError {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notfound';
  return 'busy';
}

export function audioConstraints(s: AudioSettings, deviceId?: string): MediaTrackConstraints {
  const id = deviceId ?? s.inputDeviceId;
  return {
    deviceId: id && id !== 'default' ? { exact: id } : undefined,
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression,
    autoGainControl: s.autoGainControl,
    channelCount: 1,
  };
}

/** Local microphone, devices, output routing and speaking detection shared by both transports. */
export abstract class BaseVoice {
  protected ctx: AudioContext | null = null;
  protected localStream: MediaStream | null = null;
  private localDetector: SpeakDetector | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  protected selfId: string | null = null;
  roomId: string | null = null;
  protected muted = false;
  protected deafened = false;
  protected settings: AudioSettings;
  protected cb: VoiceCallbacks;
  private deviceListener = () => void this.onDeviceChange();
  protected blocked = new Set<string>();

  constructor(settings: AudioSettings, cb: VoiceCallbacks) {
    this.settings = settings;
    this.cb = cb;
  }

  get active(): boolean {
    return this.roomId !== null;
  }

  get hasMic(): boolean {
    return !!this.localStream?.getAudioTracks().some((t) => t.readyState === 'live');
  }

  setBlocked(ids: string[]): void {
    this.blocked = new Set(ids);
    this.applyOutput();
  }

  setIceServers(_servers: RTCIceServer[]): void {
    /* mesh only */
  }

  /** After voice.join succeeded on the host: start exchanging audio. */
  abstract start(res: JoinResult): Promise<void>;
  /** Server participant list update. Returns false if this client is no longer in the room. */
  abstract onParticipants(roomId: string, participants: VoiceParticipant[]): boolean;
  abstract onSignal(from: string, data: RtcSignal): Promise<void>;
  abstract retryPeer(userId: string): void;
  protected abstract onLocalTrack(track: MediaStreamTrack | null): void;
  protected abstract closeTransport(): void;
  protected abstract applySink(): void;
  protected abstract applyOutput(): void;
  /** Samples remote speaking state; returns true if any peer UI changed. */
  protected abstract tickRemote(now: number): boolean;
  protected abstract emitPeers(): void;

  // ---------------------------------------------------------------- local audio
  private async acquireMic(): Promise<MediaStream | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(this.settings), video: false });
      this.cb.onMicError(null);
      return stream;
    } catch (e) {
      if ((e as { name?: string }).name === 'OverconstrainedError' && this.settings.inputDeviceId !== 'default') {
        this.cb.onDeviceFallback('input');
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(this.settings, 'default'), video: false });
          this.cb.onMicError(null);
          return stream;
        } catch (e2) {
          this.cb.onMicError(micErrorOf(e2));
          return null;
        }
      }
      this.cb.onMicError(micErrorOf(e));
      return null;
    }
  }

  private setLocalStream(stream: MediaStream | null): void {
    const old = this.localStream;
    this.localDetector?.dispose();
    this.localDetector = null;
    this.localStream = stream;
    const track = stream?.getAudioTracks()[0] ?? null;
    if (track) {
      track.enabled = !this.muted && !this.deafened;
      track.addEventListener('ended', () => {
        if (this.localStream === stream) void this.refreshInput();
      });
      if (this.ctx) this.localDetector = SpeakDetector.fromStream(this.ctx, stream!);
    }
    this.onLocalTrack(track);
    old?.getTracks().forEach((t) => t.stop());
  }

  protected get localTrack(): MediaStreamTrack | null {
    return this.localStream?.getAudioTracks()[0] ?? null;
  }

  /** Re-acquires the microphone (device or processing settings changed). */
  async refreshInput(): Promise<void> {
    if (!this.active) return;
    const stream = await this.acquireMic();
    if (!this.active) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);
  }

  async retryMic(): Promise<boolean> {
    await this.refreshInput();
    return this.hasMic;
  }

  updateSettings(next: AudioSettings): void {
    const prev = this.settings;
    this.settings = next;
    const inputChanged =
      prev.inputDeviceId !== next.inputDeviceId ||
      prev.echoCancellation !== next.echoCancellation ||
      prev.noiseSuppression !== next.noiseSuppression ||
      prev.autoGainControl !== next.autoGainControl;
    if (inputChanged) void this.refreshInput();
    if (prev.outputDeviceId !== next.outputDeviceId) this.applySink();
    this.applyOutput();
  }

  private async onDeviceChange(): Promise<void> {
    if (!this.active) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const track = this.localTrack;
    const inputId = this.settings.inputDeviceId;
    if (inputId !== 'default' && !inputs.some((d) => d.deviceId === inputId)) {
      this.cb.onDeviceFallback('input');
      this.settings = { ...this.settings, inputDeviceId: 'default' };
      await this.refreshInput();
    } else if (!track || track.readyState !== 'live') {
      await this.refreshInput();
    } else if (inputId === 'default') {
      // Windows default device may have changed (e.g. headset unplugged): follow it.
      const current = track.getSettings().deviceId;
      const def = inputs.find((d) => d.deviceId === 'default');
      if (def && current && current !== 'default' && !inputs.some((d) => d.deviceId === current)) await this.refreshInput();
    }
    const outId = this.settings.outputDeviceId;
    if (outId !== 'default' && !outputs.some((d) => d.deviceId === outId)) {
      this.cb.onDeviceFallback('output');
      this.settings = { ...this.settings, outputDeviceId: 'default' };
      this.applySink();
    }
  }

  // ---------------------------------------------------------------- lifecycle
  /** Opens the microphone for a room; audio exchange starts with start(). */
  async join(selfId: string, roomId: string, muted: boolean): Promise<void> {
    if (this.active) await this.leave();
    this.selfId = selfId;
    this.roomId = roomId;
    this.muted = muted;
    this.deafened = false;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.resume().catch(() => undefined);
    const stream = await this.acquireMic();
    if (this.roomId !== roomId) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);
    navigator.mediaDevices.addEventListener('devicechange', this.deviceListener);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async leave(): Promise<void> {
    this.closeTransport();
    this.roomId = null;
    this.selfId = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    navigator.mediaDevices.removeEventListener('devicechange', this.deviceListener);
    this.setLocalStream(null);
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.cb.onLocalSpeaking(false);
    this.emitPeers();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const t = this.localTrack;
    if (t) t.enabled = !this.muted && !this.deafened;
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    this.setMuted(this.muted);
    this.applyOutput();
  }

  // ---------------------------------------------------------------- output
  protected sinkTo(el: HTMLAudioElement): void {
    const id = this.settings.outputDeviceId || 'default';
    const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (sink.setSinkId) {
      sink.setSinkId(id === 'default' ? '' : id).catch(() => {
        this.cb.onDeviceFallback('output');
        void sink.setSinkId?.('').catch(() => undefined);
      });
    }
  }

  protected outputTo(el: HTMLAudioElement, userId: string): void {
    const peerVol = this.settings.peerVolumes[userId] ?? 100;
    el.volume = Math.max(0, Math.min(1, (peerVol / 100) * (this.settings.outputVolume / 100)));
    el.muted = this.deafened || !!this.settings.peerMuted[userId] || this.blocked.has(userId);
  }

  // ---------------------------------------------------------------- speaking
  private tick(): void {
    const now = performance.now();
    if (this.localDetector) {
      const enabled = !this.muted && !this.deafened;
      if (this.localDetector.sample(now, enabled)) this.cb.onLocalSpeaking(this.localDetector.speaking);
    }
    if (this.tickRemote(now)) this.emitPeers();
  }
}
