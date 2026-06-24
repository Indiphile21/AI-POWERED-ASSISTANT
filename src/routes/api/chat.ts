import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { buildSystemPrompt, type ToolKey } from "@/lib/system-prompt";

type ChatBody = { messages?: UIMessage[]; tool?: ToolKey; threadId?: string };

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as ChatBody;
        if (!Array.isArray(body.messages)) {
          return new Response("Messages required", { status: 400 });
        }

        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("Missing LOVABLE_API_KEY", { status: 500 });

        const authHeader = request.headers.get("authorization");
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token) return new Response("Unauthorized", { status: 401 });

        // Verify user + persist messages via service-role client
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !userData.user) return new Response("Unauthorized", { status: 401 });
        const userId = userData.user.id;

        const threadId = body.threadId;
        if (!threadId) return new Response("threadId required", { status: 400 });

        // Verify thread ownership
        const { data: thread } = await supabaseAdmin
          .from("threads")
          .select("id,user_id,tool")
          .eq("id", threadId)
          .maybeSingle();
        if (!thread || thread.user_id !== userId) {
          return new Response("Forbidden", { status: 403 });
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
