import { useEffect, useRef, useState } from 'react';
import { Mic, Square, FolderOpen, Download, Upload } from 'lucide-react';
import { useStore, toast, isConnected } from '../store/store';
import { updateSettings } from '../store/actions';
import { Button, SettingRow, Switch } from './ui';
import { oda, rpc, unwrap, errorText } from '../lib/api';
import { audioConstraints, micErrorOf } from '../voice/base';
import { AVATAR_COLORS } from '../../shared/protocol';
import { t } from '../i18n';

function useDevices(kind: MediaDeviceKind, refreshKey: number) {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => void navigator.mediaDevices.enumerateDevices().then((d) => setList(d.filter((x) => x.kind === kind && x.deviceId !== 'communications')));
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, [kind, refreshKey]);
  return list;
}

function MicTest() {
  const settings = useStore((s) => s.settings)!;
  const inVoice = useStore((s) => !!s.voice.roomId);
  const [running, setRunning] = useState(false);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const stop = () => {
    cleanup.current?.();
    cleanup.current = null;
    setRunning(false);
    setLevel(0);
  };
  useEffect(() => stop, []);
  useEffect(() => {
    if (running) stop();
  }, [settings.audio.inputDeviceId, settings.audio.echoCancellation, settings.audio.noiseSuppression, settings.audio.autoGainControl]);

  const start = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(settings.audio), video: false });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      const audio = new Audio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      audio.srcObject = stream;
      const out = settings.audio.outputDeviceId;
      await audio.setSinkId?.(out === 'default' ? '' : out).catch(() => undefined);
      await audio.play().catch(() => undefined);
      const id = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 6));
      }, 70);
      cleanup.current = () => {
        clearInterval(id);
        audio.pause();
        audio.srcObject = null;
        stream.getTracks().forEach((tr) => tr.stop());
        void ctx.close();
      };
      setRunning(true);
    } catch (e) {
      const k = micErrorOf(e);
      setErr(k === 'denied' ? t.mic.deniedHint : k === 'notfound' ? t.mic.notFoundHint : t.mic.busyHint);
    }
  };

  return (
    <div>
      <div className="field-label" style={{ marginBottom: 6 }}>
        {t.settings.level}
      </div>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} aria-label={t.settings.level}>
        <div style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
        {running ? (
          <Button size="sm" onClick={stop}>
            <Square size={13} /> {t.settings.stopTest}
          </Button>
        ) : (
          <Button size="sm" variant="outline-gold" onClick={() => void start()} disabled={inVoice}>
            <Mic size={14} /> {t.settings.test}
          </Button>
        )}
        <span className="hint">{inVoice ? 'Sesli odadayken test kullanılamaz.' : t.settings.testHint}</span>
      </div>
      {err && (
        <div className="error-text">
          {err}{' '}
          <button type="button" className="btn ghost sm" onClick={() => void oda().app.openMicPrivacy()}>
            {t.mic.openPrivacy}
          </button>
        </div>
      )}
    </div>
  );
}

function AudioSection() {
  const settings = useStore((s) => s.settings)!;
  const [permKey, setPermKey] = useState(0);
  const inputs = useDevices('audioinput', permKey);
  const outputs = useDevices('audiooutput', permKey);
  const needsPermission = inputs.length > 0 && inputs.every((d) => !d.label);
  const a = settings.audio;
  const grant = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((tr) => tr.stop());
      setPermKey((k) => k + 1);
    } catch (e) {
      toast(micErrorOf(e) === 'denied' ? t.mic.deniedHint : t.mic.notFoundHint, 'error');
    }
  };
  const label = (d: MediaDeviceInfo) => d.label || (d.deviceId === 'default' ? t.settings.defaultDevice : `${d.deviceId.slice(0, 10)}…`);
  return (
    <div className="card" id="audio">
      <h2>{t.settings.audio}</h2>
      {needsPermission && (
        <div className="banner warn" style={{ margin: '0 0 12px' }}>
          <Mic size={16} />
          <div className="grow desc">{t.settings.grantHint}</div>
          <Button size="sm" variant="outline-gold" onClick={() => void grant()}>
            {t.settings.grant}
          </Button>
        </div>
      )}
      <div className="grid-2">
        <div className="field">
          <label htmlFor="in-dev">{t.settings.input}</label>
          <select id="in-dev" className="select" value={a.inputDeviceId} onChange={(e) => void updateSettings({ audio: { inputDeviceId: e.target.value } })}>
            {!inputs.some((d) => d.deviceId === 'default') && <option value="default">{t.settings.defaultDevice}</option>}
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {label(d)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="out-dev">{t.settings.output}</label>
          <select id="out-dev" className="select" value={a.outputDeviceId} onChange={(e) => void updateSettings({ audio: { outputDeviceId: e.target.value } })}>
            {!outputs.some((d) => d.deviceId === 'default') && <option value="default">{t.settings.defaultDevice}</option>}
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {label(d)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <MicTest />
      <div style={{ marginTop: 14 }}>
        <SettingRow title={t.settings.echo}>
          <Switch label={t.settings.echo} checked={a.echoCancellation} onChange={(v) => void updateSettings({ audio: { echoCancellation: v } })} />
        </SettingRow>
        <SettingRow title={t.settings.noise}>
          <Switch label={t.settings.noise} checked={a.noiseSuppression} onChange={(v) => void updateSettings({ audio: { noiseSuppression: v } })} />
        </SettingRow>
        <SettingRow title={t.settings.agc}>
          <Switch label={t.settings.agc} checked={a.autoGainControl} onChange={(v) => void updateSettings({ audio: { autoGainControl: v } })} />
        </SettingRow>
        <SettingRow title={t.settings.startMuted}>
          <Switch label={t.settings.startMuted} checked={a.startMuted} onChange={(v) => void updateSettings({ audio: { startMuted: v } })} />
        </SettingRow>
        <SettingRow title={t.settings.outputVolume}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, width: 260 }}>
            <input type="range" min={0} max={100} value={a.outputVolume} aria-label={t.settings.outputVolume} onChange={(e) => void updateSettings({ audio: { outputVolume: Number(e.target.value) } })} />
            <span className="hint" style={{ width: 36, textAlign: 'right' }}>
              {a.outputVolume}%
            </span>
          </span>
        </SettingRow>
      </div>
    </div>
  );
}

function ProfileSection() {
  const me = useStore((s) => s.me);
  const connected = useStore(isConnected);
  const [name, setName] = useState(me?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(me?.displayName ?? ''), [me?.displayName]);
  if (!connected || !me) return null;
  const save = async (patch: { displayName?: string; color?: string }) => {
    setBusy(true);
    try {
      const u = await rpc('profile.update', patch);
      useStore.setState((s) => ({ me: u, users: { ...s.users, [u.id]: u } }));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>{t.settings.profile}</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        {t.settings.profileHint}
      </p>
      <div className="field">
        <label htmlFor="dn">{t.settings.displayName}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="dn" className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
          <Button loading={busy} disabled={name.trim().length < 2 || name.trim() === me.displayName} onClick={() => void save({ displayName: name })}>
            {t.common.save}
          </Button>
        </div>
      </div>
      <div className="field">
        <span className="field-label">{t.settings.color}</span>
        <div className="color-swatches">
          {AVATAR_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} aria-pressed={me.color === c} style={{ background: c }} onClick={() => void save({ color: c })} />
          ))}
        </div>
      </div>
    </div>
  );
}

function BackupSection() {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>{t.settings.backup}</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        {t.settings.backupHint}
      </p>
      <div className="field">
        <label htmlFor="bpw">{t.settings.backupPassword}</label>
        <input id="bpw" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button
          variant="outline-gold"
          loading={busy === 'exp'}
          disabled={pw.length < 8}
          onClick={async () => {
            setBusy('exp');
            try {
              const r = await unwrap(oda().backup.exportTo(pw));
              if (r) toast(t.settings.backupDone(r.path), 'success');
            } catch (e) {
              toast(errorText(e), 'error');
            } finally {
              setBusy(null);
            }
          }}
        >
          <Download size={15} /> {t.settings.exportBackup}
        </Button>
        <Button
          loading={busy === 'imp'}
          disabled={pw.length < 8}
          onClick={() =>
            useStore.setState({
              modal: {
                kind: 'confirm',
                title: t.settings.importBackup,
                text: t.settings.restoreWarn,
                confirmLabel: t.settings.importBackup,
                onConfirm: async () => {
                  setBusy('imp');
                  try {
                    const r = await unwrap(oda().backup.importFrom(pw));
                    if (r) {
                      toast(t.settings.restoreDone, 'success');
                      useStore.setState({ savedHosts: await unwrap(oda().client.savedHosts()), settings: await unwrap(oda().settings.get()) });
                    }
                  } finally {
                    setBusy(null);
                  }
                },
              },
            })
          }
        >
          <Upload size={15} /> {t.settings.importBackup}
        </Button>
      </div>
    </div>
  );
}

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.appInfo);
  const connectedHost = useStore((s) => s.host);
  if (!settings) return null;
  return (
    <div className="center-scroll">
      <div className="page">
        <h1>{t.settings.title}</h1>
        <p className="lead">Ayarlar bu cihazda saklanır.</p>
        <AudioSection />
        <div className="card">
          <h2>{t.settings.notifications}</h2>
          <SettingRow title={t.settings.notifyMessages}>
            <Switch label={t.settings.notifyMessages} checked={settings.notifications.messages} onChange={(v) => void updateSettings({ notifications: { messages: v } })} />
          </SettingRow>
          <SettingRow title={t.settings.notifySounds}>
            <Switch label={t.settings.notifySounds} checked={settings.notifications.sounds} onChange={(v) => void updateSettings({ notifications: { sounds: v } })} />
          </SettingRow>
        </div>
        <ProfileSection />
        <div className="card">
          <h2>{t.settings.app}</h2>
          <SettingRow title={t.settings.startWithWindows}>
            <Switch label={t.settings.startWithWindows} checked={settings.app.startWithWindows} onChange={(v) => void updateSettings({ app: { startWithWindows: v } })} />
          </SettingRow>
          <SettingRow title={t.settings.startMinimized}>
            <Switch label={t.settings.startMinimized} checked={settings.app.startMinimized} disabled={!settings.app.startWithWindows} onChange={(v) => void updateSettings({ app: { startMinimized: v } })} />
          </SettingRow>
          <SettingRow title={t.settings.closeToTray} hint={t.settings.closeToTrayHint}>
            <Switch label={t.settings.closeToTray} checked={settings.app.closeToTray} onChange={(v) => void updateSettings({ app: { closeToTray: v } })} />
          </SettingRow>
        </div>
        <BackupSection />
        <div className="card">
          <h2>{t.settings.privacy}</h2>
          {connectedHost && <h3>{t.settings.privacyTitleServer(connectedHost.hostName)}</h3>}
          <ul className="privacy-list">
            {t.settings.privacyText.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h2>{t.settings.about}</h2>
          <div className="kv">
            <div>{t.settings.version}</div>
            <div>
              ODA {info?.version} · Electron {info?.electron} · Chromium {info?.chrome}
            </div>
            <div>{t.settings.dataDir}</div>
            <div className="mono">{info?.userDataDir}</div>
            <div>{t.settings.secureStorage}</div>
            <div>{info?.secureStorage ? t.settings.secureYes : t.settings.secureNo}</div>
            <div>Sistem</div>
            <div>{info?.platform}</div>
          </div>
          <p className="hint">{t.settings.credit}</p>
          <p className="hint">{t.settings.unsigned}</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button size="sm" onClick={() => void oda().app.openLogs()}>
              <FolderOpen size={14} /> {t.settings.openLogs}
            </Button>
            <Button size="sm" variant="danger" onClick={() => void oda().app.quit()}>
              {t.settings.quit}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
