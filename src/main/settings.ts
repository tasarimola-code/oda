import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, DeepPartial } from '../shared/ipc';

export const DEFAULT_SETTINGS: AppSettings = {
  audio: {
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    outputVolume: 100,
    peerVolumes: {},
    peerMuted: {},
    startMuted: false,
  },
  notifications: { messages: true, sounds: true },
  app: { closeToTray: true, startWithWindows: false, startMinimized: false },
  onboardingDone: false,
  trayHintShown: false,
};

type Validator = (v: unknown) => boolean;
const isBool: Validator = (v) => typeof v === 'boolean';
const isStr = (max: number): Validator => (v) => typeof v === 'string' && v.length <= max;
const isNum = (min: number, max: number): Validator => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isVolumeMap: Validator = (v) =>
  !!v && typeof v === 'object' && Object.keys(v as object).length <= 500 && Object.entries(v as object).every(([k, x]) => /^[A-Za-z0-9_-]{8,40}$/.test(k) && typeof x === 'number' && x >= 0 && x <= 200);
const isMuteMap: Validator = (v) =>
  !!v && typeof v === 'object' && Object.keys(v as object).length <= 500 && Object.entries(v as object).every(([k, x]) => /^[A-Za-z0-9_-]{8,40}$/.test(k) && typeof x === 'boolean');
const SCHEMA: { [K in keyof AppSettings]: AppSettings[K] extends object ? { [P in keyof AppSettings[K]]: Validator } : Validator } = {
  audio: {
    inputDeviceId: isStr(256),
    outputDeviceId: isStr(256),
    echoCancellation: isBool,
    noiseSuppression: isBool,
    autoGainControl: isBool,
    outputVolume: isNum(0, 100),
    peerVolumes: isVolumeMap,
    peerMuted: isMuteMap,
    startMuted: isBool,
  },
  notifications: { messages: isBool, sounds: isBool },
  app: { closeToTray: isBool, startWithWindows: isBool, startMinimized: isBool },
  onboardingDone: isBool,
  trayHintShown: isBool,
} as never;

/** Applies only known, valid keys from `patch` onto `base`. */
export function mergeSettings(base: AppSettings, patch: unknown): AppSettings {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  if (!patch || typeof patch !== 'object') return base;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const rule = (SCHEMA as Record<string, unknown>)[k];
    if (!rule) continue;
    if (typeof rule === 'function') {
      if ((rule as Validator)(v)) out[k] = v;
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const section = out[k] as Record<string, unknown>;
    for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
      const r = (rule as Record<string, Validator>)[sk];
      if (r && r(sv)) section[sk] = sv;
    }
  }
  return out as unknown as AppSettings;
}

export class SettingsStore {
  private file: string;
  private data: AppSettings;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'settings.json');
    this.data = DEFAULT_SETTINGS;
    try {
      this.data = mergeSettings(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      /* first run or unreadable: defaults */
    }
  }

  get(): AppSettings {
    return structuredClone(this.data);
  }

  set(patch: DeepPartial<AppSettings>): AppSettings {
    this.data = mergeSettings(this.data, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get();
  }

  replace(all: unknown): AppSettings {
    this.data = mergeSettings(DEFAULT_SETTINGS, all);
    return this.set({});
  }
}
