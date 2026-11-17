import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search, SendHorizontal, Smile, MoreVertical, PanelRightClose, X, AlertCircle } from 'lucide-react';
import { useStore, convOf, isConnected, type UiMessage } from '../store/store';
import { discardMessage, loadHistory, markVisibleRead, openConv, selectRoom, sendMessage } from '../store/actions';
import { Avatar, IconButton, MenuItem, Popover } from './ui';
import { formatDay, formatTime, formatDateTime } from '../lib/format';
import { linkify } from '../../shared/validate';
import { rpc } from '../lib/api';
import { MAX_MESSAGE_LENGTH, type SearchHit } from '../../shared/protocol';
import { t } from '../i18n';

const EMOJIS = ['😀', '😂', '😊', '😍', '😎', '🤔', '😅', '😢', '😡', '👍', '👎', '👏', '🙏', '🔥', '🎉', '❤️', '👋', '🤝', '💯', '✅', '🎮', '🎧', '☕', '🌙'];

function MessageText({ text }: { text: string }) {
  const parts = useMemo(() => linkify(text), [text]);
  return (
    <>
      {parts.map((p, i) =>
        p.href ? (
          <a
            key={i}
            href={p.href}
            onClick={(e) => {
              e.preventDefault();
              void window.oda.app.openExternal(p.href!);
            }}
            rel="noreferrer noopener"
          >
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith('[') && p.endsWith(']') ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

function MessageRow({ m, prev, convKey }: { m: UiMessage; prev: UiMessage | null; convKey: string }) {
  const user = useStore((s) => s.users[m.senderId]);
  const meId = useStore((s) => s.me?.id);
  const name = user?.displayName ?? 'Bilinmeyen';
  const cont = !!prev && prev.senderId === m.senderId && m.createdAt - prev.createdAt < 5 * 60_000 && formatDay(prev.createdAt) === formatDay(m.createdAt);
  const mine = m.senderId === meId;
  return (
    <div className={`msg ${cont ? 'cont' : ''} ${mine ? 'mine' : ''} ${m.status}`}>
      <Avatar name={name} color={user?.color ?? '#56627A'} size={32} />
      <div className="msg-body">
        {!cont && (
          <div className="msg-meta">
            <span className="who">{name}</span>
            <span className="when" title={formatDateTime(m.createdAt)}>
              {formatTime(m.createdAt)}
            </span>
          </div>
        )}
        <div className="bubble">
          <MessageText text={m.body} />
        </div>
        {mine && m.status !== 'sent' && (
          <div className={`msg-state ${m.status === 'failed' ? 'err' : ''}`} aria-live="polite">
            {m.status === 'sending' && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />}
            {m.status === 'failed' && <AlertCircle size={12} />}
            {m.status === 'sending' ? t.chat.sending : t.chat.failed}
            {m.status === 'failed' && (
              <>
                <button type="button" onClick={() => void sendMessage(convKey, m.body, m)}>
                  {t.chat.resend}
                </button>
                <button type="button" onClick={() => discardMessage(convKey, m.localId!)}>
                  {t.chat.discard}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ convKey, disabledReason }: { convKey: string; disabledReason: string | null }) {
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef<Record<string, string>>({});

  useEffect(() => {
    setText(drafts.current[convKey] ?? '');
  }, [convKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  const update = (v: string) => {
    setText(v);
    drafts.current[convKey] = v;
  };
  const submit = () => {
    const body = text.trim();
    if (!body || body.length > MAX_MESSAGE_LENGTH || disabledReason) return;
    void sendMessage(convKey, body);
    update('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const over = text.length > MAX_MESSAGE_LENGTH;
  return (
    <div className="composer">
      <span style={{ position: 'relative' }}>
        <IconButton label={t.chat.emoji} onClick={() => setEmoji((v) => !v)} disabled={!!disabledReason}>
          <Smile size={19} />
        </IconButton>
        <Popover open={emoji} onClose={() => setEmoji(false)} style={{ bottom: 42, left: 0, minWidth: 0 }}>
          <div className="emoji-grid">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={e}
                onClick={() => {
                  update(text + e);
                  setEmoji(false);
                  ref.current?.focus();
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </Popover>
      </span>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={disabledReason ?? t.chat.placeholder}
        aria-label={t.chat.placeholder}
        disabled={!!disabledReason}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKey}
        maxLength={MAX_MESSAGE_LENGTH + 200}
      />
      {text.length > MAX_MESSAGE_LENGTH - 400 && <span className={`count ${over ? 'over' : ''}`}>{`${text.length}/${MAX_MESSAGE_LENGTH}`}</span>}
      <IconButton label={t.chat.send} onClick={submit} disabled={!!disabledReason || !text.trim() || over}>
        <SendHorizontal size={19} />
      </IconButton>
    </div>
  );
}

function SearchPane({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const users = useStore((s) => s.users);
  const rooms = useStore((s) => s.rooms);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    const id = setTimeout(() => {
      void rpc('messages.search', { q: term })
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q]);
  return (
    <div className="chat-search">
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="input" autoFocus placeholder={t.chat.searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
        <IconButton label={t.common.close} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      {hits && (
        <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8 }}>
          {hits.length === 0 && <div className="hint">{t.chat.noResults}</div>}
          {hits.map((h) => {
            const where = h.message.conv.startsWith('room:') ? `# ${rooms.find((r) => `room:${r.id}` === h.message.conv)?.name ?? ''}` : `@ ${users[h.message.conv.slice(3)]?.displayName ?? ''}`;
            return (
              <button
                key={h.message.id}
                type="button"
                className="search-hit"
                onClick={() => {
                  if (h.message.conv.startsWith('room:')) selectRoom(h.message.conv.slice(5));
                  else openConv(h.message.conv);
                  onClose();
                }}
              >
                <div className="sh-meta">
                  {users[h.message.senderId]?.displayName ?? ''} · {where} · {formatDateTime(h.message.createdAt)}
                </div>
                <Snippet text={h.snippet} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ChatPanel() {
  const connected = useStore(isConnected);
  const convKey = useStore((s) => s.chatConv);
  const conv = useStore((s) => (s.chatConv ? convOf(s, s.chatConv) : null));
  const rooms = useStore((s) => s.rooms);
  const users = useStore((s) => s.users);
  const friends = useStore((s) => s.friends);
  const blocked = useStore((s) => s.blocked);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const clientState = useStore((s) => s.clientStatus?.state);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);

  const messages = conv?.messages ?? [];
  const lastId = messages.length ? messages[messages.length - 1].localId ?? messages[messages.length - 1].id : null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastId, convKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !prevHeight.current) return;
    el.scrollTop = el.scrollHeight - prevHeight.current + el.scrollTop;
    prevHeight.current = 0;
  }, [messages[0]?.id]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [convKey]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !convKey) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (stickToBottom.current) markVisibleRead();
    if (el.scrollTop < 80 && conv?.hasMore && !conv.loading && conv.loaded) {
      prevHeight.current = el.scrollHeight;
      void loadHistory(convKey);
    }
  };

  let title = t.chat.roomChat;
  let disabledReason: string | null = null;
  let dmUser = null as null | (typeof users)[string];
  if (convKey?.startsWith('dm:')) {
    dmUser = users[convKey.slice(3)] ?? null;
    title = dmUser?.displayName ?? t.chat.dm;
    if (blocked.includes(convKey.slice(3))) disabledReason = t.chat.placeholderBlocked;
    else if (!friends.some((f) => f.userId === convKey.slice(3) && f.state === 'friends')) disabledReason = t.chat.placeholderNotFriends;
  } else if (convKey) {
    const r = rooms.find((x) => `room:${x.id}` === convKey);
    title = r && r.id !== activeRoomId ? `${t.chat.roomChat} · ${r.name}` : t.chat.roomChat;
  }
  if (clientState !== 'connected') disabledReason = t.chat.placeholderOffline;

  return (
    <aside className="chat-panel" aria-label={title}>
      <div className="chat-head">
        {dmUser && <Avatar name={dmUser.displayName} color={dmUser.color} size={28} online={dmUser.online} />}
        <h2 title={title}>{title}</h2>
        {convKey?.startsWith('dm:') && activeRoomId && (
          <IconButton label={t.chat.roomChat} onClick={() => openConv(`room:${activeRoomId}`)} placement="bottom">
            <X size={17} />
          </IconButton>
        )}
        <IconButton label={t.chat.search} onClick={() => setSearching((v) => !v)} disabled={!connected} placement="bottom">
          <Search size={18} />
        </IconButton>
        <span style={{ position: 'relative' }}>
          <IconButton label={t.room.more} onClick={() => setMenu((v) => !v)} placement="bottom">
            <MoreVertical size={18} />
          </IconButton>
          <Popover open={menu} onClose={() => setMenu(false)} style={{ right: 0, top: 38 }}>
            <MenuItem onClick={() => (useStore.setState({ chatOpen: false }), setMenu(false))}>
              <PanelRightClose size={15} />
              {t.chat.closePanel}
            </MenuItem>
            <div className="menu-label" style={{ textTransform: 'none', fontWeight: 500, letterSpacing: 0 }}>
              {t.chat.serverStores}
            </div>
          </Popover>
        </span>
      </div>
      {searching && connected && <SearchPane onClose={() => setSearching(false)} />}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} aria-live="polite" aria-relevant="additions">
        {conv?.loading && messages.length === 0 && <div className="hint" style={{ padding: 12 }}>{t.common.loading}</div>}
        {conv?.loaded && conv.hasMore && messages.length > 0 && (
          <div style={{ textAlign: 'center', padding: 6 }}>
            <button
              type="button"
              className="btn ghost sm"
              disabled={conv.loading}
              onClick={() => {
                prevHeight.current = scrollRef.current?.scrollHeight ?? 0;
                if (convKey) void loadHistory(convKey);
              }}
            >
              {conv.loading ? <span className="spinner" /> : null}
              {t.chat.loadMore}
            </button>
          </div>
        )}
        {conv?.loaded && messages.length === 0 && <div className="hint" style={{ padding: '24px 6px', textAlign: 'center' }}>{t.chat.empty}</div>}
        {!convKey && <div className="hint" style={{ padding: '24px 6px', textAlign: 'center' }}>{connected ? t.room.selectRoom : t.status.offline}</div>}
        {messages.map((m, i) => {
          const prev = i > 0 ? messages[i - 1] : null;
          const newDay = !prev || formatDay(prev.createdAt) !== formatDay(m.createdAt);
          return (
            <Fragment key={m.localId ?? m.id}>
              {newDay && <div className="day-sep">{formatDay(m.createdAt)}</div>}
              <MessageRow m={m} prev={newDay ? null : prev} convKey={convKey!} />
            </Fragment>
          );
        })}
      </div>
      {convKey && <Composer convKey={convKey} disabledReason={disabledReason} />}
    </aside>
  );
}
