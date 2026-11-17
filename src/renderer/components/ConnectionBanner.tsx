import { useEffect, useState } from 'react';
import { AlertTriangle, WifiOff, RefreshCw } from 'lucide-react';
import { useStore } from '../store/store';
import { Button } from './ui';
import { oda } from '../lib/api';
import { connectSaved } from '../store/actions';
import { t } from '../i18n';

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const OFFLINE_CODES = new Set(['HOST_UNREACHABLE', 'OFFLINE', 'TIMEOUT', 'HOST_SHUTDOWN']);

export function ConnectionBanner() {
  const cs = useStore((s) => s.clientStatus);
  const now = useNow(cs?.state === 'reconnecting');
  if (!cs || cs.state === 'idle' || cs.state === 'connected') return null;
  const host = cs.hostName ?? 'Sunucu';

  if (cs.state === 'connecting') {
    return (
      <div className="banner" role="status">
        <span className="spinner" aria-hidden />
        <div className="grow title">{t.status.connecting(host)}</div>
      </div>
    );
  }

  if (cs.state === 'reconnecting') {
    const secs = cs.nextRetryAt ? Math.max(0, Math.ceil((cs.nextRetryAt - now) / 1000)) : 0;
    const offline = cs.error && OFFLINE_CODES.has(cs.error.code);
    return (
      <div className="banner warn" role="status">
        <WifiOff size={18} />
        <div className="grow">
          <div className="title">{offline ? `${t.status.hostOffline} · ${t.status.reconnecting(host)}` : t.status.reconnecting(host)}</div>
          <div className="desc">
            {offline ? t.status.hostOfflineHint : (cs.error?.message ?? '')} {secs > 0 && t.status.nextRetry(secs)}
          </div>
        </div>
        <Button size="sm" onClick={() => cs.hostId && void connectSaved(cs.hostId)}>
          <RefreshCw size={14} /> {t.status.retryNow}
        </Button>
      </div>
    );
  }

  const code = cs.error?.code ?? '';
  const canRetry = !['BANNED', 'FINGERPRINT_MISMATCH', 'HOST_MISMATCH', 'DEVICE_UNKNOWN', 'NOT_SERVER'].includes(code);
  return (
    <div className="banner err" role="alert">
      <AlertTriangle size={18} />
      <div className="grow">
        <div className="title">{t.status.failed}</div>
        <div className="desc">
          {cs.error?.message}
          {code === 'HOST_UNREACHABLE' && ` ${t.status.unreachableHint}`}
        </div>
      </div>
      {cs.hostId && code === 'HOST_UNREACHABLE' && (
        <Button size="sm" onClick={() => useStore.setState({ modal: { kind: 'editAddress', hostId: cs.hostId! } })}>
          {t.home.editAddress}
        </Button>
      )}
      {cs.hostId && canRetry && (
        <Button size="sm" variant="outline-gold" onClick={() => void connectSaved(cs.hostId!)}>
          <RefreshCw size={14} /> {t.common.retry}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void oda().client.disconnect()}>
        {t.common.close}
      </Button>
    </div>
  );
}
