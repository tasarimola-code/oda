import { useState } from 'react';
import { LogIn, Plus } from 'lucide-react';
import { useStore } from '../store/store';
import { OWN_INVITE_DAYS, OWN_INVITE_USES, createOwnRoom, enterRoom, refreshSavedHosts, updateSettings } from '../store/actions';
import { errorText } from '../lib/api';
import { normalizeDisplayName, normalizeRoomName } from '../../shared/validate';
import { Button, GoldBars } from './ui';
import { InviteCodeBox, JoinForm } from './modals';
import { t } from '../i18n';

export type StartStep = 'choose' | 'create' | 'join';

function defaultName(): string {
  const n = (useStore.getState().appInfo?.userName ?? '').replace(/[._-]+/g, ' ').trim();
  return n.length >= 2 && n.length <= 32 ? n : '';
}

/**
 * Create a room on the built-in server (the invite code is shown right away) or join one with a code.
 * Used by the first-run screen and by the "Oda oluştur" dialog.
 */
export function StartFlow({ initialStep = 'choose', onDone }: { initialStep?: StartStep; onDone?: () => void }) {
  const appInfo = useStore((s) => s.appInfo);
  const savedHosts = useStore((s) => s.savedHosts);
  const account = savedHosts.find((h) => h.hostId === appInfo?.defaultServer.hostId && !h.isOwnHost);
  const hasAccount = !!account;
  const [step, setStep] = useState<StartStep>(initialStep);
  const [name, setName] = useState(defaultName);
  const [roomName, setRoomName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ roomId: string; code: string } | null>(null);
  const nameOk = hasAccount || !!normalizeDisplayName(name);
  const ownerName = hasAccount ? account.displayName : (normalizeDisplayName(name) ?? '');
  const effectiveRoomName = roomName.trim() || t.onboarding.defaultRoomName(ownerName);

  const create = async () => {
    const rn = normalizeRoomName(effectiveRoomName);
    if (!rn) return setErr('Oda adı 1–40 karakter olmalı.');
    setBusy(true);
    setErr(null);
    try {
      const res = await createOwnRoom(name, rn);
      setCreated(res);
      void refreshSavedHosts();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const enter = async () => {
    if (!created) return;
    await updateSettings({ onboardingDone: true });
    useStore.setState({ view: 'chats' });
    enterRoom(created.roomId, true);
    onDone?.();
  };

  if (created) {
    return (
      <div>
        <h2 style={{ marginTop: 4 }}>{t.share.title}</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          {t.share.text}
        </p>
        <InviteCodeBox code={created.code} autoCopy />
        <div className="hint" style={{ marginTop: 8 }}>
          {t.share.validity(OWN_INVITE_USES, OWN_INVITE_DAYS)}
        </div>
        <div className="start-actions">
          <span />
          <Button variant="primary" onClick={() => void enter()}>
            {t.share.enter}
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'join') {
    return (
      <div>
        <h2 style={{ marginTop: 4 }}>{t.join.title}</h2>
        <JoinForm initialName={name} onDone={onDone} />
        <div className="start-actions">
          <Button variant="ghost" onClick={() => setStep('choose')}>
            {t.onboarding.back}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => (e.preventDefault(), step === 'create' && nameOk && void create())}>
      {!hasAccount && (
        <div className="field">
          <label htmlFor="st-name">{t.join.name}</label>
          <input id="st-name" className="input" autoFocus maxLength={32} placeholder={t.join.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>
      )}
      {step === 'choose' ? (
        <div className="start-choices">
          <button type="button" className="start-choice primary" disabled={!nameOk} onClick={() => setStep('create')}>
            <span className="sc-title">
              <Plus size={18} color="var(--gold)" /> {t.onboarding.create}
            </span>
            <span className="sc-desc">{t.onboarding.createDesc}</span>
          </button>
          <button type="button" className="start-choice" disabled={!nameOk} onClick={() => setStep('join')}>
            <span className="sc-title">
              <LogIn size={18} color="var(--gold)" /> {t.onboarding.join}
            </span>
            <span className="sc-desc">{t.onboarding.joinDesc}</span>
          </button>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="st-room">{t.onboarding.roomName}</label>
            <input
              id="st-room"
              className="input"
              autoFocus={hasAccount}
              maxLength={40}
              placeholder={t.onboarding.defaultRoomName(ownerName)}
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              disabled={busy}
            />
          </div>
          {err && (
            <div className="error-text" role="alert">
              {err}
            </div>
          )}
          <div className="start-actions">
            <Button variant="ghost" onClick={() => (setStep('choose'), setErr(null))} disabled={busy}>
              {t.onboarding.back}
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!nameOk}>
              {busy ? t.onboarding.creating : t.onboarding.createSubmit}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

export function Onboarding() {
  return (
    <div className="onboarding">
      <div className="onboarding-inner">
        <div className="onboarding-brand">
          <GoldBars size={28} />
          <span>ODA</span>
        </div>
        <h1>{t.onboarding.title}</h1>
        <p className="lead">{t.onboarding.subtitle}</p>
        <div className="card onboarding-form">
          <StartFlow />
        </div>
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Button variant="ghost" onClick={() => void updateSettings({ onboardingDone: true }).then(() => useStore.setState({ view: 'settings' }))}>
            {t.onboarding.skip}
          </Button>
        </div>
      </div>
    </div>
  );
}
