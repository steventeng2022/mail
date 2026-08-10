import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { MailCounts, MailDetail, MailFolder, MailSummary, Session } from "../shared/types";

type SessionPayload = { session: Session; counts: MailCounts };
type ListPayload = { messages: MailSummary[]; counts: MailCounts };
type DetailPayload = { message: MailDetail; counts: MailCounts };
type ComposeState = { open: boolean; to: string; cc: string; bcc: string; subject: string; text: string; replyToId: string };

const emptyCounts: MailCounts = { inbox: 0, unread: 0, sent: 0, starred: 0, trash: 0 };
const emptyCompose: ComposeState = { open: false, to: "", cc: "", bcc: "", subject: "", text: "", replyToId: "" };

const folderNames: Record<MailFolder, string> = {
  inbox: "Inbox",
  sent: "Sent",
  starred: "Starred",
  trash: "Trash",
};

const folderIcons: Record<MailFolder, string> = {
  inbox: "↓",
  sent: "↗",
  starred: "☆",
  trash: "×",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function splitAddresses(value: string) {
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function formatDate(value: number, detailed = false) {
  const date = new Date(value);
  if (detailed) return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
  if (date.getFullYear() === today.getFullYear()) return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(date);
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "2-digit" }).format(date);
}

function initials(name: string, email: string) {
  const source = name.trim() || email.split("@")[0];
  return source.split(/[\s._-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function displaySender(message: MailSummary) {
  if (message.direction === "outbound") return message.toAddresses.join(", ") || "Unknown recipient";
  return message.fromName || message.fromAddress;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [counts, setCounts] = useState<MailCounts>(emptyCounts);
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [messages, setMessages] = useState<MailSummary[]>([]);
  const [selected, setSelected] = useState<MailDetail | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [compose, setCompose] = useState<ComposeState>(emptyCompose);
  const [sending, setSending] = useState(false);

  const loadList = useCallback(async (nextFolder: MailFolder, nextQuery = "") => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ folder: nextFolder });
      if (nextQuery.trim()) params.set("q", nextQuery.trim());
      const data = await api<ListPayload>(`/api/messages?${params}`);
      setMessages(data.messages);
      setCounts(data.counts);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the mailbox");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<SessionPayload>("/api/session");
        setSession(data.session);
        setCounts(data.counts);
        await loadList("inbox");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not open the mailbox");
        setLoading(false);
      }
    })();
  }, [loadList]);

  const chooseFolder = (next: MailFolder) => {
    setFolder(next);
    setSelected(null);
    setQuery("");
    void loadList(next);
  };

  const openMessage = async (id: string) => {
    setError("");
    try {
      const data = await api<DetailPayload>(`/api/messages/${id}`);
      setSelected(data.message);
      setCounts(data.counts);
      setMessages((current) => current.map((item) => item.id === id ? { ...item, isRead: true } : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open this message");
    }
  };

  const patchMessage = async (id: string, patch: Record<string, unknown>) => {
    const data = await api<{ ok: true; counts: MailCounts }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    setCounts(data.counts);
  };

  const toggleStar = async (message: MailSummary) => {
    const next = !message.isStarred;
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, isStarred: next } : item));
    setSelected((current) => current?.id === message.id ? { ...current, isStarred: next } : current);
    try {
      await patchMessage(message.id, { isStarred: next });
      if (folder === "starred" && !next) setMessages((current) => current.filter((item) => item.id !== message.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the message");
    }
  };

  const moveToTrash = async (message: MailSummary) => {
    try {
      await patchMessage(message.id, { folder: "trash" });
      setSelected(null);
      setMessages((current) => current.filter((item) => item.id !== message.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not move the message");
    }
  };

  const restore = async (message: MailSummary) => {
    const destination = message.direction === "outbound" ? "sent" : "inbox";
    try {
      await patchMessage(message.id, { folder: destination });
      setSelected(null);
      setMessages((current) => current.filter((item) => item.id !== message.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore the message");
    }
  };

  const reply = (message: MailDetail) => {
    setCompose({
      open: true,
      to: message.replyToAddress || message.fromAddress,
      cc: "",
      bcc: "",
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
      text: "",
      replyToId: message.id,
    });
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      await api<{ ok: true; id: string }>("/api/send", {
        method: "POST",
        body: JSON.stringify({
          to: splitAddresses(compose.to),
          cc: splitAddresses(compose.cc),
          bcc: splitAddresses(compose.bcc),
          subject: compose.subject,
          text: compose.text,
          replyToId: compose.replyToId,
        }),
      });
      setCompose(emptyCompose);
      if (folder === "sent") await loadList("sent", query);
      else setCounts((current) => ({ ...current, sent: current.sent + 1 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The message could not be sent");
    } finally {
      setSending(false);
    }
  };

  const selectedSummary = selected as MailSummary | null;
  const listTitle = query ? `Search in ${folderNames[folder]}` : folderNames[folder];
  const avatar = useMemo(() => initials(session?.mailboxName || "Steven", session?.mailboxAddress || ""), [session]);

  return (
    <div className="mail-app">
      <header className="topbar">
        <button className="menu-button" aria-label="Toggle navigation">☰</button>
        <div className="wordmark"><span className="wordmark-mark">S</span><strong>STEVEN</strong><em>MAIL</em></div>
        <form className="search" onSubmit={(event) => { event.preventDefault(); void loadList(folder, query); }}>
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your mail" aria-label="Search your mail" />
          {query && <button type="button" onClick={() => { setQuery(""); void loadList(folder); }} aria-label="Clear search">×</button>}
        </form>
        <div className="account">
          <div><strong>{session?.mailboxName || "Steven Teng"}</strong><span>{session?.mailboxAddress || "mail.steventeng.uk"}</span></div>
          <span className="account-avatar">{avatar}</span>
        </div>
      </header>

      <aside className="sidebar">
        <button className="compose-button" onClick={() => setCompose({ ...emptyCompose, open: true })}><span>＋</span> Compose</button>
        <nav aria-label="Mail folders">
          {(Object.keys(folderNames) as MailFolder[]).map((item) => (
            <button key={item} className={folder === item ? "active" : ""} onClick={() => chooseFolder(item)}>
              <span className="folder-icon">{folderIcons[item]}</span>
              <span>{folderNames[item]}</span>
              <b>{item === "inbox" ? counts.unread || counts.inbox : counts[item]}</b>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" />
          <div><strong>Protected mailbox</strong><small>Cloudflare Access</small></div>
        </div>
      </aside>

      <main className={`workspace${selected ? " has-reader" : ""}`}>
        <section className="mail-list" aria-label={listTitle}>
          <div className="list-heading">
            <div><p>MAILBOX / {folder.toUpperCase()}</p><h1>{listTitle}</h1></div>
            <button className="round-button" onClick={() => void loadList(folder, query)} aria-label="Refresh">↻</button>
          </div>
          <div className="list-meta"><span>{messages.length} message{messages.length === 1 ? "" : "s"}</span><span>{counts.unread} unread</span></div>

          {error && <div className="error-banner" role="alert"><span>!</span><p>{error}</p><button onClick={() => setError("")}>×</button></div>}
          {loading ? <LoadingRows /> : messages.length === 0 ? <EmptyState folder={folder} query={query} onCompose={() => setCompose({ ...emptyCompose, open: true })} /> : (
            <div className="messages">
              {messages.map((message) => (
                <article key={message.id} className={`${message.isRead ? "" : "unread"}${selected?.id === message.id ? " selected" : ""}`}>
                  <button className={`star-button${message.isStarred ? " is-starred" : ""}`} onClick={() => void toggleStar(message)} aria-label={message.isStarred ? "Remove star" : "Add star"}>{message.isStarred ? "★" : "☆"}</button>
                  <button className="message-open" onClick={() => void openMessage(message.id)}>
                    <span className="sender-avatar">{initials(message.fromName, message.fromAddress)}</span>
                    <span className="message-copy"><strong>{displaySender(message)}</strong><b>{message.subject}</b><small>{message.preview || "No preview available"}</small></span>
                    <span className="message-side">{message.hasAttachments && <i title="Has attachments">⌕</i>}<time>{formatDate(message.sentAt)}</time></span>
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        {selected && (
          <section className="reader" aria-label={`Message: ${selected.subject}`}>
            <div className="reader-toolbar">
              <button className="back-button" onClick={() => setSelected(null)}>← <span>Back</span></button>
              <div>
                <button onClick={() => void toggleStar(selectedSummary!)} aria-label="Star message">{selected.isStarred ? "★" : "☆"}</button>
                {folder === "trash" ? <button onClick={() => void restore(selectedSummary!)}>Restore</button> : <button onClick={() => void moveToTrash(selectedSummary!)}>Trash</button>}
                {selected.direction === "inbound" && <a href={`/api/messages/${selected.id}/raw`}>.EML</a>}
              </div>
            </div>
            <div className="reader-content">
              <p className="reader-kicker">{selected.direction === "inbound" ? "RECEIVED MESSAGE" : "SENT MESSAGE"}</p>
              <h2>{selected.subject}</h2>
              <div className="sender-block">
                <span className="sender-avatar large">{initials(selected.fromName, selected.fromAddress)}</span>
                <div><strong>{selected.fromName || selected.fromAddress}</strong><span>{selected.fromName && `<${selected.fromAddress}>`}</span><small>to {selected.toAddresses.join(", ")}</small></div>
                <time>{formatDate(selected.sentAt, true)}</time>
              </div>
              <pre className="message-body">{selected.textBody || "This message has no plain-text body. Download the original .eml file to inspect it."}</pre>
              {selected.attachments.length > 0 && (
                <div className="attachments"><p>{selected.attachments.length} attachment{selected.attachments.length === 1 ? "" : "s"}</p><div>{selected.attachments.map((part) => <a key={part.id} href={`/api/attachments/${part.id}`}><span>↓</span><strong>{part.filename}</strong><small>{formatBytes(part.size)}</small></a>)}</div></div>
              )}
              {selected.direction === "inbound" && <button className="reply-button" onClick={() => reply(selected)}>↩ Reply</button>}
            </div>
          </section>
        )}
      </main>

      {compose.open && <Compose state={compose} setState={setCompose} sending={sending} onSubmit={send} />}
    </div>
  );
}

function Compose({ state, setState, sending, onSubmit }: { state: ComposeState; setState: (value: ComposeState) => void; sending: boolean; onSubmit: (event: FormEvent) => void }) {
  const [expanded, setExpanded] = useState(Boolean(state.cc || state.bcc));
  const update = (key: keyof ComposeState, value: string | boolean) => setState({ ...state, [key]: value });
  return (
    <div className="compose-window" role="dialog" aria-modal="true" aria-label="New message">
      <div className="compose-head"><div><span>NEW MESSAGE</span><strong>{state.replyToId ? "Reply" : "Compose"}</strong></div><button onClick={() => setState(emptyCompose)} aria-label="Close compose">×</button></div>
      <form onSubmit={onSubmit}>
        <label><span>To</span><input required value={state.to} onChange={(event) => update("to", event.target.value)} placeholder="name@example.com" /><button type="button" onClick={() => setExpanded(!expanded)}>Cc/Bcc</button></label>
        {expanded && <><label><span>Cc</span><input value={state.cc} onChange={(event) => update("cc", event.target.value)} /></label><label><span>Bcc</span><input value={state.bcc} onChange={(event) => update("bcc", event.target.value)} /></label></>}
        <label><span>Subject</span><input value={state.subject} onChange={(event) => update("subject", event.target.value)} placeholder="What is this about?" /></label>
        <textarea required value={state.text} onChange={(event) => update("text", event.target.value)} placeholder="Write your message…" />
        <div className="compose-actions"><button disabled={sending} className="send-button">{sending ? "Sending…" : "Send message"}<span>↗</span></button><small>from steven@steventeng.uk</small></div>
      </form>
    </div>
  );
}

function EmptyState({ folder, query, onCompose }: { folder: MailFolder; query: string; onCompose: () => void }) {
  return <div className="empty-state"><span>{query ? "⌕" : folderIcons[folder]}</span><h2>{query ? "No matching mail" : `${folderNames[folder]} is clear`}</h2><p>{query ? "Try a different sender, subject, or phrase." : folder === "inbox" ? "New messages sent to steven@steventeng.uk will appear here." : "There are no messages in this folder yet."}</p>{folder === "sent" && !query && <button onClick={onCompose}>Write your first message</button>}</div>;
}

function LoadingRows() {
  return <div className="loading-rows" aria-label="Loading messages">{[0, 1, 2, 3].map((item) => <div key={item}><span /><p><i /><i /></p><b /></div>)}</div>;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
