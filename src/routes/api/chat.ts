import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { buildSystemPrompt, type ToolKey } from "@/lib/system-prompt";

type ChatBody = { messages?: UIMessage[]; tool?: ToolKey; threadId?: string };
type BearerTokenResult = { ok: true; token: string } | { ok: false; response: Response };

function textResponse(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function authFailure(reason: string, message: string, status = 401) {
  console.warn("[Chat API Auth] Authentication failure", { reason, status });
  return textResponse(message, status);
}

function getBearerToken(request: Request): BearerTokenResult {
  const authHeader = request.headers.get("authorization");
  console.info("[Chat API Auth] Authorization header status", {
    hasHeader: Boolean(authHeader),
  });

  if (!authHeader) {
    return {
      ok: false,
      response: authFailure(
        "missing_authorization_header",
        "Authentication required: missing Authorization header.",
      ),
    };
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {
      ok: false,
      response: authFailure(
        "malformed_authorization_header",
        "Authentication required: malformed Authorization header. Expected a Bearer token.",
      ),
    };
  }

  const token = match[1]?.trim();
  if (!token || token.includes(" ")) {
    return {
      ok: false,
      response: authFailure("empty_bearer_token", "Authentication required: Bearer token is empty."),
    };
  }

  if (token.split(".").length !== 3) {
    return {
      ok: false,
      response: authFailure(
        "invalid_token_shape",
        "Authentication required: Bearer token is malformed.",
      ),
    };
  }

  console.info("[Chat API Auth] Bearer token present", { hasToken: true });
  return { ok: true, token };
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: ChatBody;
        try {
          body = (await request.json()) as ChatBody;
        } catch (error) {
          console.warn("[Chat API] Invalid JSON body", { error });
          return textResponse("Invalid JSON request body.", 400);
        }

        console.info("[Chat API] Request received", {
          hasMessages: Array.isArray(body.messages),
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          hasThreadId: Boolean(body.threadId),
        });

        if (!Array.isArray(body.messages)) {
          return textResponse("Messages required", 400);
        }

        const key = process.env.LOVABLE_API_KEY;
        if (!key) {
          console.error("[Chat API] Missing AI gateway configuration", {
            missing: "LOVABLE_API_KEY",
          });
          return textResponse(
            "AI service is not configured for this deployment. Reconnect the AI gateway and retry.",
            500,
          );
        }

        const authResult = getBearerToken(request);
        if (!authResult.ok) return authResult.response;
        const token = authResult.token;

        // Verify user + persist messages via service-role client
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !userData.user) {
          console.warn("[Chat API Auth] Token verification failed", {
            hasUser: Boolean(userData.user),
            error: userErr?.message ?? null,
          });
          return authFailure("token_verification_failed", "Authentication required: token is invalid or expired.");
        }
        const userId = userData.user.id;
        console.info("[Chat API Auth] Token verified", { hasUserId: Boolean(userId) });

        const threadId = body.threadId;
        if (!threadId) return textResponse("threadId required", 400);

        // Verify thread ownership
        const { data: thread } = await supabaseAdmin
          .from("threads")
          .select("id,user_id,tool")
          .eq("id", threadId)
          .maybeSingle();
        if (!thread || thread.user_id !== userId) {
          console.warn("[Chat API Auth] Thread ownership check failed", {
            hasThread: Boolean(thread),
          });
          return authFailure("thread_forbidden", "Forbidden: you do not have access to this chat.", 403);
        }
        const tool = (body.tool ?? thread.tool ?? "chat") as ToolKey;

        // Persist the latest user message
        const last = body.messages[body.messages.length - 1];
        if (last && last.role === "user") {
          await supabaseAdmin.from("messages").insert({
            thread_id: threadId,
            user_id: userId,
            role: "user",
            parts: last.parts as unknown as never,
          });
          // Update thread title from first user text if still default
          const firstText =
            last.parts?.find((p) => p.type === "text") as { text?: string } | undefined;
          if (firstText?.text) {
            await supabaseAdmin
              .from("threads")
              .update({
                title: firstText.text.slice(0, 80),
                updated_at: new Date().toISOString(),
              })
              .eq("id", threadId)
              .eq("title", "New conversation");
            await supabaseAdmin
              .from("threads")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", threadId);
          }
        }

        const gateway = createLovableAiGatewayProvider(key);
        console.info("[Chat API] Starting AI stream", {
          threadId,
          tool,
          messageCount: body.messages.length,
        });
        const result = streamText({
          model: gateway("google/gemini-3-flash-preview"),
          system: buildSystemPrompt(tool),
          messages: await convertToModelMessages(body.messages),
        });

        return result.toUIMessageStreamResponse({
          originalMessages: body.messages,
          onFinish: async ({ responseMessage }) => {
            try {
              await supabaseAdmin.from("messages").insert({
                thread_id: threadId,
                user_id: userId,
                role: "assistant",
                parts: responseMessage.parts as unknown as never,
              });
              await supabaseAdmin
                .from("threads")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", threadId);
            } catch (e) {
              console.error("persist assistant message failed", e);
            }
          },
          onError: (err) => {
            console.error("stream error", err);
            return err instanceof Error ? err.message : "Stream error";
          },
        });
      },
    },
  },
});
