import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createThread, listThreads } from "@/lib/threads.functions";
import { TOOL_PRESETS, type ToolKey } from "@/lib/system-prompt";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useState } from "react";
import {
  Mail,
  ClipboardList,
  CalendarCheck,
  Microscope,
  MessagesSquare,
  ArrowRight,
  Sparkles,
  TrendingUp,
  Clock,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Command Center — WorkplaceAI" },
      { name: "description", content: "Your AI productivity command center." },
    ],
  }),
  component: Dashboard,
});

const TOOL_META: Record<ToolKey, { icon: typeof Mail; accent: string }> = {
  chat: { icon: MessagesSquare, accent: "from-foreground/5 to-foreground/0" },
  email: { icon: Mail, accent: "from-primary/15 to-primary/0" },
  meeting: { icon: CalendarCheck, accent: "from-amber-500/15 to-amber-500/0" },
  planner: { icon: ClipboardList, accent: "from-sky-500/15 to-sky-500/0" },
  research: { icon: Microscope, accent: "from-violet-500/15 to-violet-500/0" },
};

function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useServerFn(listThreads);
  const create = useServerFn(createThread);
  const [greeting, setGreeting] = useState("Hello");
  const [name, setName] = useState<string>("");

  useEffect(() => {
    const hour = new Date().getHours();
    setGreeting(hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
    supabase.auth.getUser().then(({ data }) => {
      const n =
        (data.user?.user_metadata?.full_name as string) ||
        data.user?.email?.split("@")[0] ||
        "";
      setName(n);
    });
  }, []);

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list() });

  const start = useMutation({
    mutationFn: (tool: ToolKey) => create({ data: { tool } }),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      navigate({ to: "/chat/$threadId", params: { threadId: row.id } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not start"),
  });

  const todayCount = threads.data?.filter((t) => {
    const d = new Date(t.updated_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length ?? 0;
  const totalCount = threads.data?.length ?? 0;
  const score = Math.min(100, todayCount * 18 + Math.min(40, totalCount * 4));

  return (
    <div className="px-6 md:px-10 py-8 max-w-6xl mx-auto space-y-10">
      <header className="space-y-2">
        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Command center
        </div>
        <h1 className="font-serif text-4xl md:text-5xl tracking-tight">
          {greeting}{name ? `, ${name}` : ""}.
        </h1>
        <p className="text-muted-foreground max-w-xl">
          Pick a workflow to get started, or jump back into a recent conversation below.
        </p>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard
          icon={TrendingUp}
          label="Productivity score"
          value={`${score}`}
          hint="Daily activity index"
        />
        <StatCard
          icon={Clock}
          label="Sessions today"
          value={`${todayCount}`}
          hint="Conversations updated today"
        />
        <StatCard
          icon={CheckCircle2}
          label="Total threads"
          value={`${totalCount}`}
          hint="Across all workflows"
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-tight">Quick actions</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(Object.keys(TOOL_PRESETS) as ToolKey[]).map((key) => {
            const preset = TOOL_PRESETS[key];
            const meta = TOOL_META[key];
            const Icon = meta.icon;
            return (
              <button
                key={key}
                onClick={() => start.mutate(key)}
                disabled={start.isPending}
                className={`group relative text-left rounded-xl border bg-card hover:border-foreground/30 transition-all p-5 overflow-hidden`}
              >
                <div
                  className={`absolute inset-0 bg-gradient-to-br ${meta.accent} opacity-60 pointer-events-none`}
                />
                <div className="relative flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="w-9 h-9 rounded-lg bg-background border grid place-items-center">
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-semibold tracking-tight">{preset.label}</div>
                      <div className="text-sm text-muted-foreground leading-snug">
                        {preset.description}
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 mt-1 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Recent threads</h2>
          {threads.data && threads.data.length > 0 && (
            <span className="text-xs text-muted-foreground">{threads.data.length} total</span>
          )}
        </div>
        <div className="rounded-xl border bg-card divide-y">
          {!threads.data || threads.data.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No conversations yet. Pick a workflow above to start.
            </div>
          ) : (
            threads.data.slice(0, 8).map((t) => {
              const meta = TOOL_META[(t.tool as ToolKey) ?? "chat"];
              const Icon = meta.icon;
              return (
                <button
                  key={t.id}
                  onClick={() =>
                    navigate({ to: "/chat/$threadId", params: { threadId: t.id } })
                  }
                  className="w-full text-left flex items-center gap-3 p-4 hover:bg-muted/40 transition-colors"
                >
                  <div className="w-8 h-8 rounded-md bg-muted grid place-items-center shrink-0">
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{t.title}</div>
                    <div className="text-xs text-muted-foreground capitalize">
                      {TOOL_PRESETS[(t.tool as ToolKey) ?? "chat"].label} ·{" "}
                      {new Date(t.updated_at).toLocaleString()}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                </button>
              );
            })
          )}
        </div>
      </section>

      <section className="rounded-xl border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6">
        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground mb-1">
          Tip of the day
        </div>
        <p className="text-base leading-relaxed">
          Time-block your day in 90-minute focus sprints. Use the <strong>Task Planner</strong> to
          turn a messy to-do list into a calendar you'll actually follow.
        </p>
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Mail;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className="mt-2 font-serif text-3xl tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{hint}</div>
    </div>
  );
}
