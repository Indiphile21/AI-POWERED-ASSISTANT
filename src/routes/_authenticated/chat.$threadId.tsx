import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { getThread } from "@/lib/threads.functions";
import { TOOL_PRESETS, type ToolKey } from "@/lib/system-prompt";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  head: () => ({ meta: [{ title: "Chat — WorkplaceAI" }] }),
  component: ChatPage,
});

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
  const [token, setToken] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setToken(data.session?.access_token ?? null));
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: () => (token ? { Authorization: `Bearer ${token}` } : {}),
        body: { threadId, tool },
      }),
    [token, threadId, tool],
  );

  const { messages, sendMessage, status, error } = useChat({
    id: threadId,
    messages: initial,
    transport,
    onError: (e) => toast.error(e.message || "Something went wrong"),
    onFinish: () => onActivity(),
  });

  useEffect(() => {
    textareaRef.current?.focus();
  }, [threadId, status]);

  const isBusy = status === "submitted" || status === "streaming";

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
                <MessageContent variant={m.role === "user" ? "contained" : "flat"}>
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
              <MessageContent variant="flat">
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
          <PromptInput
            onSubmit={async (msg) => {
              const text = msg.text?.trim();
              if (!text || isBusy) return;
              await sendMessage({ text });
            }}
          >
            <PromptInputTextarea
              ref={textareaRef}
              placeholder={`Message ${preset.label}…`}
              autoFocus
            />
            <PromptInputFooter className="justify-end">
              <PromptInputSubmit status={status} disabled={isBusy} />
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
