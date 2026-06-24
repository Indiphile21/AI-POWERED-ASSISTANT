import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { getThread } from "@/lib/threads.functions";
import { TOOL_PRESETS, type ToolKey } from "@/lib/system-prompt";
import { supabase } from "@/integrations/supabase/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  head: () => ({ meta: [{ title: "Chat — WorkplaceAI" }] }),
  component: ChatPage,
});

class ChatAuthError extends Error {
  constructor(message = "Authentication required. Please sign in again.") {
    super(message);
    this.name = "ChatAuthError";
  }
}

type AuthUiState = "idle" | "authenticating" | "connecting" | "session-expired";
const TOKEN_REFRESH_WINDOW_MS = 60_000;

async function getFreshChatAccessToken() {
  console.info("[Chat Auth] Checking current session before chat request");
  const { data, error } = await supabase.auth.getSession();
  let session = data.session;
  let token = session?.access_token;
  const expiresAtMs = session?.expires_at ? session.expires_at * 1000 : null;
  const shouldRefresh = !token || (expiresAtMs !== null && expiresAtMs - Date.now() < TOKEN_REFRESH_WINDOW_MS);

  console.info("[Chat Auth] Session status", {
    hasSession: Boolean(session),
    hasToken: Boolean(token),
    expiresAt: session?.expires_at ?? null,
    shouldRefresh,
  });

  if (error) {
    console.warn("[Chat Auth] Session lookup failed", { message: error.message });
    throw new ChatAuthError();
  }

  if (shouldRefresh) {
    console.info("[Chat Auth] Refreshing session before chat request", {
      reason: token ? "token_near_expiry" : "missing_token",
    });
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    session = refreshData.session;
    token = session?.access_token;

    console.info("[Chat Auth] Pre-request refresh status", {
      hasSession: Boolean(session),
      hasToken: Boolean(token),
      hasError: Boolean(refreshError),
      expiresAt: session?.expires_at ?? null,
    });

    if (refreshError) {
      console.warn("[Chat Auth] Pre-request refresh failed", { message: refreshError.message });
      throw new ChatAuthError();
    }
  }

  if (!token) {
    console.warn("[Chat Auth] Chat request blocked: missing access token");
    throw new ChatAuthError();
  }

  return token;
}

async function getFreshChatAuthHeaders(): Promise<Record<string, string>> {
  const token = await getFreshChatAccessToken();
  return { Authorization: `Bearer ${token}` };
}

function isAuthError(error: unknown) {
  if (error instanceof ChatAuthError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /auth|unauthorized|forbidden|session|token/i.test(message);
}

async function authenticatedChatFetch(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const freshHeaders = await getFreshChatAuthHeaders();
  headers.set("Authorization", freshHeaders.Authorization);

  console.info("[Chat Auth] Sending chat request", {
    hasAuthorizationHeader: headers.has("Authorization"),
  });

  let response = await fetch(input, { ...init, headers });
  console.info("[Chat Auth] Chat response status", {
    status: response.status,
    ok: response.ok,
  });

  if (response.status !== 401) return response;

  console.warn("[Chat Auth] Chat request returned 401; refreshing session and retrying once");
  const { data, error } = await supabase.auth.refreshSession();
  const refreshedToken = data.session?.access_token;

  console.info("[Chat Auth] Session refresh result", {
    refreshed: Boolean(refreshedToken),
    hasError: Boolean(error),
  });

  if (error || !refreshedToken) return response;

  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set("Authorization", `Bearer ${refreshedToken}`);
  response = await fetch(input, { ...init, headers: retryHeaders });

  console.info("[Chat Auth] Chat retry response status", {
    status: response.status,
    ok: response.ok,
  });

  return response;
}

function ChatPage() {
  const { threadId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const get = useServerFn(getThread);

  const { data, isLoading } = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => get({ data: { id: threadId } }),
  });

  useEffect(() => {
    if (!isLoading && data === null) {
      toast.error("Thread not found");
      navigate({ to: "/dashboard" });
    }
  }, [data, isLoading, navigate]);

  if (isLoading || !data) {
    return (
      <div className="h-full grid place-items-center text-sm text-muted-foreground">
        Loading conversation…
      </div>
    );
  }

  const tool = (data.thread.tool as ToolKey) ?? "chat";
  return (
    <ChatWindow
      key={threadId}
      threadId={threadId}
      tool={tool}
      initial={data.messages}
      onActivity={() => qc.invalidateQueries({ queryKey: ["threads"] })}
    />
  );
}

function ChatWindow({
  threadId,
  tool,
  initial,
  onActivity,
}: {
  threadId: string;
  tool: ToolKey;
  initial: Awaited<ReturnType<typeof getThread>> extends null
    ? never
    : NonNullable<Awaited<ReturnType<typeof getThread>>>["messages"];
  onActivity: () => void;
}) {
  const preset = TOOL_PRESETS[tool];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [authUi, setAuthUi] = useState<{ state: AuthUiState; message?: string }>({
    state: "idle",
  });

  const handleAuthFailure = useCallback((error?: unknown) => {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Your session expired. Please sign in again.";
    console.warn("[Chat Auth] Authentication failure surfaced to UI", {
      message,
    });
    setAuthUi({ state: "session-expired", message });
    toast.error("Authentication required. Please sign in again.");
  }, []);

  const verifySessionForChat = useCallback(async () => {
    setAuthUi({ state: "authenticating", message: "Authenticating…" });
    try {
      await getFreshChatAccessToken();
      setAuthUi({ state: "idle" });
      return true;
    } catch (error) {
      handleAuthFailure(error);
      return false;
    }
  }, [handleAuthFailure]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: getFreshChatAuthHeaders,
        fetch: authenticatedChatFetch,
        body: { threadId, tool },
      }),
    [threadId, tool],
  );

  const { messages, sendMessage, status, error } = useChat({
    id: threadId,
    messages: initial as never,
    transport,
    onError: (e) => {
      if (isAuthError(e)) {
        handleAuthFailure(e);
        return;
      }
      console.warn("[Chat Auth] Chat request failed", { message: e.message });
      toast.error(e.message || "Something went wrong");
      setAuthUi({ state: "idle" });
    },
    onFinish: () => {
      setAuthUi({ state: "idle" });
      onActivity();
    },
  });

  useEffect(() => {
    textareaRef.current?.focus();
  }, [threadId, status]);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      console.info("[Chat Auth] Auth state changed", {
        event,
        hasSession: Boolean(session),
        hasToken: Boolean(session?.access_token),
      });

      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") {
        setAuthUi({ state: "idle" });
      }

      if (event === "SIGNED_OUT") {
        setAuthUi({
          state: "session-expired",
          message: "Your session ended. Please sign in again.",
        });
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const isBusy = status === "submitted" || status === "streaming";
  const isAuthBlocking = authUi.state === "authenticating" || authUi.state === "session-expired";
  const statusLabel =
    authUi.state === "authenticating"
      ? "Authenticating…"
      : authUi.state === "connecting"
        ? "Connecting…"
        : authUi.state === "session-expired"
          ? "Session expired"
          : null;

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      <div className="border-b px-6 py-3 flex items-center gap-3 bg-background">
        <div className="w-8 h-8 rounded-md bg-primary/10 text-primary grid place-items-center">
          <Sparkles className="w-4 h-4" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight">{preset.label}</div>
          <div className="text-xs text-muted-foreground">{preset.description}</div>
        </div>
      </div>

      <Conversation className="flex-1">
        <ConversationContent className="max-w-3xl mx-auto px-4 md:px-6 py-6 space-y-4">
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<Sparkles className="w-6 h-6 text-primary" />}
              title={preset.label}
              description={preset.greeting}
            />
          ) : (
            messages.map((m) => (
              <Message key={m.id} from={m.role}>
                <MessageContent>
                  {m.parts.map((part, i) => {
                    if (part.type === "text") {
                      return m.role === "assistant" ? (
                        <MessageResponse key={i}>{part.text}</MessageResponse>
                      ) : (
                        <p key={i} className="whitespace-pre-wrap">
                          {part.text}
                        </p>
                      );
                    }
                    return null;
                  })}
                </MessageContent>
              </Message>
            ))
          )}
          {status === "submitted" && (
            <Message from="assistant">
              <MessageContent>
                <Shimmer>Thinking…</Shimmer>
              </MessageContent>
            </Message>
          )}
          {error && (
            <div className="text-sm text-destructive border border-destructive/30 rounded-md p-3 bg-destructive/5">
              {error.message}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t bg-background">
        <div className="max-w-3xl mx-auto px-4 md:px-6 py-4">
          {statusLabel && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {authUi.message ?? statusLabel}
              </span>
              {authUi.state === "session-expired" && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={verifySessionForChat}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Retry
                </Button>
              )}
            </div>
          )}
          <PromptInput
            onSubmit={async (msg) => {
              const text = msg.text?.trim();
              if (!text || isBusy) return;
              const hasSession = await verifySessionForChat();
              if (!hasSession) return;

              setAuthUi({ state: "connecting", message: "Connecting…" });
              await sendMessage({ text });
            }}
          >
            <PromptInputTextarea
              ref={textareaRef}
              placeholder={`Message ${preset.label}…`}
              disabled={isBusy || isAuthBlocking}
              autoFocus
            />
            <PromptInputFooter className="justify-end">
              <PromptInputSubmit status={status} disabled={isBusy || isAuthBlocking} />
            </PromptInputFooter>
          </PromptInput>
          <p className="text-[11px] text-muted-foreground mt-2 text-center">
            WorkplaceAI can make mistakes. Verify important business, legal, or HR decisions.
          </p>
        </div>
      </div>
    </div>
  );
}
