import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Badge, Button, InputArea, Tabs } from "@cloudflare/kumo";
import { Toasty } from "@cloudflare/kumo/components/toast";
import {
  CircleIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StopIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { isToolUIPart, type UIMessage } from "ai";
import { useAgent } from "agents/react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_ALIAS,
  SESSION_EXPIRED_CLOSE,
  SESSION_PATH,
  TOO_MANY_SOCKETS_CLOSE,
  type HdErrorFrame
} from "./config/protocol";
import type { TenantAgent, TenantState } from "./server";
import { ConfirmDelete, type DeleteTarget } from "./ui/ConfirmDelete";
import { HostnameDrawer } from "./ui/HostnameDrawer";
import { HostnameTable, type HostnameRow } from "./ui/HostnameTable";
import { Markdown } from "./ui/Markdown";
import { ToolCard, type LiveState } from "./ui/ToolCard";
import { LIMITS } from "./config/limits";

const STARTER_PROMPTS = [
  "Add shop.example.com as a custom hostname",
  "What DNS records do I need to add?",
  "Why is my hostname not verified yet?"
];

const DELETE_ERRORS: Record<string, string> = {
  "precondition-failed":
    "This hostname changed since the assistant offered to delete it. Ask again.",
  "not-found": "This hostname no longer exists.",
  "invalid-transition": "This hostname cannot be deleted in its current state."
};

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const mode = dark ? "light" : "dark";
    setDark(!dark);
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    try {
      localStorage.setItem("theme", mode);
    } catch {
      // Storage may be unavailable. The choice still applies to this page.
    }
  }, [dark]);
  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
    />
  );
}

type Connection = "connecting" | "connected" | "reconnecting" | "too-many-tabs";

const CONNECTION_LABEL: Record<Connection, string> = {
  connected: "Connected",
  connecting: "Connecting...",
  reconnecting: "Reconnecting...",
  "too-many-tabs": "Too many open tabs"
};

// Error frames from the agent, in words for the chat. Unknown ones use their title.
function errorNotice(frame: HdErrorFrame): string {
  if (frame.status === 429 && frame.retry_after !== undefined) {
    const hours = Math.max(1, Math.round(frame.retry_after / 3600));
    return `You've used today's chat turns. They reset in about ${hours} ${hours === 1 ? "hour" : "hours"}. The hostname table still works.`;
  }
  if (frame.status === 409) return "A reply is already in progress.";
  return `That message was not sent: ${frame.title}.`;
}

function parseErrorFrame(data: unknown): HdErrorFrame | null {
  if (typeof data !== "string" || !data.includes('"hd_error"')) return null;
  try {
    const frame = JSON.parse(data) as Partial<HdErrorFrame>;
    return frame.type === "hd_error" &&
      typeof frame.status === "number" &&
      typeof frame.title === "string"
      ? (frame as HdErrorFrame)
      : null;
  } catch {
    return null;
  }
}

function ConnectionStatus({ state }: { state: Connection }) {
  const label = CONNECTION_LABEL[state];
  return (
    <output className="flex items-center gap-1.5" aria-live="polite">
      <CircleIcon
        size={8}
        weight="fill"
        className={
          state === "connected"
            ? "text-kumo-success"
            : state === "too-many-tabs"
              ? "text-kumo-danger"
              : "text-kumo-warning"
        }
      />
      {/* On phones a healthy connection shows only the dot, so the title has room.
          Connecting and reconnecting always show their text. */}
      <span
        className={`text-xs text-kumo-subtle ${state === "connected" ? "sr-only sm:not-sr-only" : ""}`}
      >
        {label}
      </span>
    </output>
  );
}

function Message({
  message,
  animating,
  onDelete,
  live
}: {
  message: UIMessage;
  animating: boolean;
  onDelete: (t: DeleteTarget) => void;
  live: LiveState;
}) {
  const isUser = message.role === "user";
  return (
    <div className="space-y-2">
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        if (isToolUIPart(part))
          return (
            <ToolCard key={key} part={part} onDelete={onDelete} live={live} />
          );
        if (part.type !== "text" || !part.text) return null;
        return isUser ? (
          <div key={key} className="flex justify-end">
            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed whitespace-pre-wrap break-words">
              {part.text}
            </div>
          </div>
        ) : (
          <div key={key} className="flex justify-start">
            <div className="max-w-[85%] min-w-0 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
              <Markdown text={part.text} animating={animating} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChatPane({
  messages,
  status,
  connected,
  notice,
  onSend,
  onStop,
  onDelete,
  live
}: {
  messages: UIMessage[];
  status: string;
  connected: boolean;
  notice: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onDelete: (t: DeleteTarget) => void;
  live: LiveState;
}) {
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const streaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const send = (text: string) => {
    const trimmed = text.trim();
    // Only sending is blocked while a reply streams. Typing stays available.
    if (!trimmed || streaming || !connected) return;
    onSend(trimmed);
    setInput("");
    if (textarea.current) textarea.current.style.height = "auto";
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
          {messages.length === 0 && (
            <div className="py-10 text-center space-y-4">
              <p className="text-kumo-default">
                Add a customer hostname and I'll verify it and explain what's
                blocking it.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {STARTER_PROMPTS.map((prompt) => (
                  <Button
                    key={prompt}
                    variant="outline"
                    size="sm"
                    disabled={streaming || !connected}
                    onClick={() => send(prompt)}
                  >
                    {prompt}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message, index) => (
            <Message
              key={message.id}
              message={message}
              animating={
                streaming &&
                message.role === "assistant" &&
                index === messages.length - 1
              }
              onDelete={onDelete}
              live={live}
            />
          ))}
          <div ref={end} />
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-kumo-line bg-kumo-base px-4 py-3"
      >
        {notice && (
          <output className="mx-auto mb-2 block max-w-3xl text-sm text-kumo-warning">
            {notice}
          </output>
        )}
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-kumo-line bg-kumo-base p-2 focus-within:ring-2 focus-within:ring-kumo-ring">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <InputArea
            id="chat-input"
            ref={textarea}
            value={input}
            onValueChange={setInput}
            onKeyDown={(e) => {
              // Enter sends. Shift+Enter adds a new line. Composing (IME) input is left alone.
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send(input);
              }
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${el.scrollHeight}px`;
            }}
            placeholder="Ask about a hostname..."
            rows={1}
            className="flex-1 min-w-0 resize-none max-h-40 bg-transparent! shadow-none! ring-0! focus:ring-0! outline-none!"
          />
          {streaming ? (
            <Button
              type="button"
              variant="secondary"
              shape="square"
              aria-label="Stop reply"
              icon={<StopIcon size={18} />}
              onClick={onStop}
            />
          ) : (
            <Button
              type="submit"
              variant="primary"
              shape="square"
              aria-label="Send message"
              disabled={!input.trim() || !connected}
              icon={<PaperPlaneRightIcon size={18} />}
            />
          )}
        </div>
        <p className="mx-auto mt-1 max-w-3xl text-xs text-kumo-subtle">
          Enter to send, Shift+Enter for a new line.
        </p>
      </form>
    </div>
  );
}

function Workspace() {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [hostnames, setHostnames] = useState<HostnameRow[]>([]);
  const [tab, setTab] = useState("chat");
  const [open, setOpen] = useState<HostnameRow | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set once useAgentChat exists. A refused message never gets a reply, so the
  // pending send is stopped when its error frame arrives.
  const stopRef = useRef<() => void>(() => {});

  const agent = useAgent<TenantAgent, TenantState>({
    agent: "TenantAgent",
    // The server maps this alias to the visitor's own agent from the session cookie.
    name: AGENT_ALIAS,
    onOpen: useCallback(() => setConnection("connected"), []),
    // Too many open tabs is final for this tab. Reconnecting would only be refused again.
    shouldReconnectOnClose: useCallback(
      (event: CloseEvent) => event.code !== TOO_MANY_SOCKETS_CLOSE,
      []
    ),
    onClose: useCallback((event: CloseEvent) => {
      if (event.code === TOO_MANY_SOCKETS_CLOSE) {
        setConnection("too-many-tabs");
        return;
      }
      setConnection((c) =>
        c === "connecting" ? "connecting" : "reconnecting"
      );
      // An expired session closes the socket. Renew the cookie so the reconnect works.
      if (event.code === SESSION_EXPIRED_CLOSE) void refreshSession();
    }, []),
    onMessage: useCallback((event: MessageEvent) => {
      const frame = parseErrorFrame(event.data);
      if (!frame) return;
      setNotice(errorNotice(frame));
      stopRef.current();
    }, []),
    // The server pushes the hostname summary after every change.
    onStateUpdate: useCallback((state: TenantState) => {
      setHostnames(state.hostnames as unknown as HostnameRow[]);
    }, [])
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent,
    experimental_throttle: LIMITS.ui.chatThrottleMs,
    // History lives on the server. The client sends only the new message.
    syncMessagesToServer: false,
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { messages: messages.slice(-1) }
    })
  });
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  // Tool cards show each hostname's live state from the table the server pushes.
  const liveState = useCallback<LiveState>(
    (hostname) => hostnames.find((h) => h.hostname === hostname)?.state,
    [hostnames]
  );

  // Keep the open drawer in step with live state changes.
  const openRow = open
    ? (hostnames.find((h) => h.id === open.id) ?? open)
    : null;

  const confirmDelete = async (
    target: DeleteTarget
  ): Promise<string | null> => {
    try {
      const result = (await agent.stub.confirmDelete(
        target.id,
        target.etag
      )) as {
        ok: boolean;
        error?: string;
      };
      if (result.ok) {
        if (open?.id === target.id) setOpen(null);
        return null;
      }
      return (
        DELETE_ERRORS[result.error ?? ""] ??
        "The delete did not go through. Try again."
      );
    } catch {
      return "The delete did not go through. Check your connection and try again.";
    }
  };

  const chat = (
    <ChatPane
      messages={messages}
      status={status}
      connected={connection === "connected"}
      notice={
        connection === "too-many-tabs"
          ? "Too many open tabs. Close another tab with this app, then reload this one."
          : notice
      }
      onSend={(text) => {
        setNotice(null);
        void sendMessage({ role: "user", parts: [{ type: "text", text }] });
      }}
      onStop={stop}
      onDelete={setDeleting}
      live={liveState}
    />
  );
  // A refused tab never receives the table, so it says why instead of showing it empty.
  const table =
    connection === "too-many-tabs" ? (
      <p className="px-4 py-2 text-sm text-kumo-subtle">
        Your hostnames show here once this tab connects.
      </p>
    ) : (
      <HostnameTable rows={hostnames} onOpen={setOpen} />
    );

  return (
    <div className="flex h-dvh flex-col bg-kumo-elevated">
      <header className="flex items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-base font-semibold text-kumo-default">
            Hostname Doctor
          </h1>
          <Badge variant="beta">Demo</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ConnectionStatus state={connection} />
          <ThemeToggle />
          <Button
            variant="secondary"
            icon={<TrashIcon size={16} />}
            onClick={clearHistory}
            aria-label="Clear chat"
          >
            <span className="hidden sm:inline">Clear chat</span>
          </Button>
        </div>
      </header>

      {/* Phones: one pane at a time behind tabs. Wide screens: chat and table side by side. */}
      <div className="border-b border-kumo-line bg-kumo-base px-4 py-2 md:hidden">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "chat", label: "Chat" },
            { value: "hostnames", label: `Hostnames (${hostnames.length})` }
          ]}
        />
      </div>
      <main className="flex min-h-0 flex-1">
        <section
          aria-label="Chat"
          className={`min-h-0 min-w-0 flex-1 ${tab === "chat" ? "flex" : "hidden"} md:flex flex-col`}
        >
          {chat}
        </section>
        <aside
          aria-label="Hostnames"
          className={`min-h-0 w-full overflow-y-auto border-kumo-line bg-kumo-base md:w-[24rem] md:border-l lg:w-[28rem] ${tab === "hostnames" ? "block" : "hidden"} md:block`}
        >
          <h2 className="px-4 pt-4 pb-2 text-sm font-semibold">Hostnames</h2>
          {table}
        </aside>
      </main>

      <HostnameDrawer row={openRow} onClose={() => setOpen(null)} />
      <ConfirmDelete
        target={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

// Creates or renews the hd_sid cookie. The socket needs it before it connects.
async function refreshSession(): Promise<boolean> {
  try {
    const res = await fetch(SESSION_PATH, {
      credentials: "same-origin",
      cache: "no-store"
    });
    return res.ok;
  } catch {
    return false;
  }
}

function useSession(): "loading" | "ready" | "failed" {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading"
  );
  useEffect(() => {
    let active = true;
    void refreshSession().then((ok) => {
      if (active) setStatus(ok ? "ready" : "failed");
    });
    return () => {
      active = false;
    };
  }, []);
  return status;
}

export default function App() {
  const session = useSession();
  const fallback = (text: string) => (
    <div className="flex h-dvh items-center justify-center text-kumo-inactive">
      {text}
    </div>
  );
  if (session === "loading") return fallback("Loading...");
  if (session === "failed")
    return fallback(
      "Could not start a session. Refresh the page to try again."
    );
  return (
    <Toasty>
      <Suspense fallback={fallback("Loading...")}>
        <Workspace />
      </Suspense>
    </Toasty>
  );
}
