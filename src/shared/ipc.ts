import type { PathKind } from './netclass';
import type { RpcMethod, RpcParams, RpcResult, ServerEventName, ServerEvents } from './protocol';

export type ClientErrorCode =
  | 'HOST_UNREACHABLE'
  | 'FINGERPRINT_MISMATCH'
  | 'HOST_MISMATCH'
  | 'TIMEOUT'
  | 'OFFLINE'
  | 'KICKED'
  | 'REPLACED'
  | 'HOST_SHUTDOWN'
  | 'INVALID_INVITE_CODE'
  | 'KEY_UNAVAILABLE'
  | 'NOT_SERVER'
  | string;

export interface ClientStatus {
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  hostId: string | null;
  hostName: string | null;
  userId: string | null;
  address: string | null;
  port: number | null;
  pathKind: PathKind | null;
  isOwnHost: boolean;
  attempt: number;
  nextRetryAt: number | null;
  error: { code: ClientErrorCode; message: string } | null;
}

export interface JoinResult {
  status: ClientStatus;
  /** Room the invite added this account to (only reported when an existing account redeemed it). */
  roomId: string | null;
}

export interface SavedHostSummary {
  hostId: string;
  hostName: string;
  displayName: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  isOwnHost: boolean;
  lastConnectedAt: number | null;
  lastAddress: string | null;
}

export interface AudioSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  outputVolume: number;
  peerVolumes: Record<string, number>;
  peerMuted: Record<string, boolean>;
  startMuted: boolean;
}

export interface AppSettings {
  audio: AudioSettings;
  notifications: { messages: boolean; sounds: boolean };
  app: { closeToTray: boolean; startWithWindows: boolean; startMinimized: boolean };
  onboardingDone: boolean;
  trayHintShown: boolean;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  platform: string;
  userDataDir: string;
  logDir: string;
  secureStorage: boolean;
  deviceName: string;
  /** Windows account name, used to prefill the display name when joining. */
  userName: string;
  /** Built-in ODA server used by "Oda oluştur". */
  defaultServer: { hostId: string; hostName: string };
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface OdaApi {
  app: {
    info(): Promise<IpcResult<AppInfo>>;
    openLogs(): Promise<IpcResult<void>>;
    openExternal(url: string): Promise<IpcResult<boolean>>;
    openMicPrivacy(): Promise<IpcResult<void>>;
    notify(title: string, body: string): Promise<IpcResult<void>>;
    copyText(text: string): Promise<IpcResult<void>>;
    quit(): Promise<IpcResult<void>>;
  };
  settings: {
    get(): Promise<IpcResult<AppSettings>>;
    set(patch: DeepPartial<AppSettings>): Promise<IpcResult<AppSettings>>;
  };
  client: {
    status(): Promise<IpcResult<ClientStatus>>;
    savedHosts(): Promise<IpcResult<SavedHostSummary[]>>;
    previewInvite(code: string): Promise<IpcResult<{ hostName: string; addresses: string[]; port: number; fingerprint: string; known: boolean }>>;
    /** Creates (or reuses) this device's account on the built-in ODA server; resolves once connected. */
    createAccount(opts: { displayName: string }): Promise<IpcResult<JoinResult>>;
    /** Joins the invite's server (creating an account if needed) and its room; resolves once connected. */
    joinWithInvite(opts: { code: string; displayName: string }): Promise<IpcResult<JoinResult>>;
    connectSaved(hostId: string): Promise<IpcResult<ClientStatus>>;
    updateSavedAddress(hostId: string, address: string, port: number): Promise<IpcResult<SavedHostSummary[]>>;
    disconnect(): Promise<IpcResult<ClientStatus>>;
    forget(hostId: string): Promise<IpcResult<SavedHostSummary[]>>;
    request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<IpcResult<RpcResult<M>>>;
    /** Loopback URL of the pinned bridge to the host's media server (SFU mode). */
    sfuUrl(): Promise<IpcResult<string>>;
  };
  backup: {
    exportTo(password: string): Promise<IpcResult<{ path: string } | null>>;
    importFrom(password: string): Promise<IpcResult<{ restoredHosts: number; skippedHostDb: boolean } | null>>;
  };
  on<E extends keyof RendererEvents>(event: E, cb: (payload: RendererEvents[E]) => void): () => void;
}

export interface RendererEvents {
  'client.status': ClientStatus;
  'client.event': { e: ServerEventName; d: ServerEvents[ServerEventName] };
  'app.focus': { focused: boolean };
}

export const RENDERER_EVENTS: readonly (keyof RendererEvents)[] = ['client.status', 'client.event', 'app.focus'];
