import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { initial } from '../lib/format';
import { t } from '../i18n';

type BtnVariant = 'primary' | 'outline-gold' | 'danger' | 'ghost' | 'default';

export function Button({
  variant = 'default',
  size,
  loading,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'lg'; loading?: boolean }) {
  const cls = ['btn', variant !== 'default' ? variant : '', size ?? '', loading ? 'loading' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Tooltip({ label, children, placement }: { label: string; children: ReactNode; placement?: 'top' | 'bottom' | 'right' }) {
  return (
    <span className={`tt ${placement ?? ''}`}>
      {children}
      <span className="tt-bubble" role="tooltip">
        {label}
      </span>
    </span>
  );
}

export function IconButton({
  label,
  children,
  placement,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; placement?: 'top' | 'bottom' | 'right' }) {
  return (
    <Tooltip label={label} placement={placement}>
      <button type="button" className={`icon-btn ${className ?? ''}`} aria-label={label} {...rest}>
        {children}
      </button>
    </Tooltip>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function SettingRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="row-setting">
      <div>
        <div>{title}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function Avatar({ name, color, size = 36, online, fontSize }: { name: string; color: string; size?: number; online?: boolean; fontSize?: number }) {
  return (
    <span
      className="avatar"
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: fontSize ?? Math.round(size * 0.42),
        background: `radial-gradient(circle at 35% 30%, ${lighten(color, 0.18)} 0%, ${color} 55%, ${darken(color, 0.25)} 100%)`,
      }}
    >
      {initial(name)}
      {online !== undefined && <span className={`status ${online ? 'on' : ''}`} />}
    </span>
  );
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f)));
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
}
const lighten = (h: string, f: number) => shade(h, f);
const darken = (h: string, f: number) => shade(h, -f);

export function GoldBars({ size = 28, animated = false }: { size?: number; animated?: boolean }) {
  const heights = [0.36, 0.66, 1, 0.66, 0.36];
  const w = size / 9;
  return (
    <svg className="gold-bars" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      {heights.map((h, i) => {
        const bh = h * size * 0.9;
        return <rect key={i} x={i * w * 1.9 + w * 0.3} y={(size - bh) / 2} width={w} height={bh} rx={w / 2} fill="currentColor" opacity={animated ? 1 : 0.95} />;
      })}
    </svg>
  );
}

/** Click-outside + Escape aware popover anchored to its parent (parent must be position:relative). */
export function Popover({
  open,
  onClose,
  children,
  style,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  style?: React.CSSProperties;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button:not(:disabled), input, select')?.focus();
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className="popover" role="menu" aria-labelledby={labelledBy} style={style}>
      {children}
    </div>
  );
}

export function MenuItem({ children, onClick, danger, selected, disabled }: { children: ReactNode; onClick: () => void; danger?: boolean; selected?: boolean; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" className={`menu-item ${danger ? 'danger' : ''} ${selected ? 'selected' : ''}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')];
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const firstInput = ref.current?.querySelector<HTMLElement>('input, textarea, select') ?? ref.current?.querySelector<HTMLElement>('button');
    firstInput?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton label={t.common.close} onClick={onClose} placement="bottom">
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void window.oda.app.copyText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return [copied, copy];
}

export function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="icon-circle">{icon}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}
