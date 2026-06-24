import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  createThread,
  deleteThread,
  listThreads,
} from "@/lib/threads.functions";
import { TOOL_PRESETS, type ToolKey } from "@/lib/system-prompt";
import {
  LayoutGrid,
  Plus,
  Trash2,
  LogOut,
  Mail,
  CalendarCheck,
  ClipboardList,
  Microscope,
  MessagesSquare,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useEffect, useState } from "react";

const TOOL_ICONS: Record<ToolKey, typeof Mail> = {
  chat: MessagesSquare,
  email: Mail,
  meeting: CalendarCheck,
  planner: ClipboardList,
  research: Microscope,
};

export function AppSidebar() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const list = useServerFn(listThreads);
  const create = useServerFn(createThread);
  const del = useServerFn(deleteThread);
  const [email, setEmail] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list() });

  const startChat = useMutation({
    mutationFn: (tool: ToolKey) => create({ data: { tool } }),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      navigate({ to: "/chat/$threadId", params: { threadId: row.id } });
    },
  });

  const removeThread = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      if (pathname.includes(id)) navigate({ to: "/dashboard" });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="w-7 h-7 rounded-md bg-primary text-primary-foreground grid place-items-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            WorkplaceAI
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/dashboard"}
                  tooltip="Dashboard"
                >
                  <Link to="/dashboard">
                    <LayoutGrid />
                    <span>Dashboard</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="New chat"
                  onClick={() => startChat.mutate("chat")}
                >
                  <Plus />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Workflows</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {(Object.keys(TOOL_PRESETS) as ToolKey[]).map((key) => {
                const Icon = TOOL_ICONS[key];
                return (
                  <SidebarMenuItem key={key}>
                    <SidebarMenuButton
                      tooltip={TOOL_PRESETS[key].label}
                      onClick={() => startChat.mutate(key)}
                    >
                      <Icon />
                      <span>{TOOL_PRESETS[key].label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Recent</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {(threads.data ?? []).slice(0, 12).map((t) => {
                const Icon = TOOL_ICONS[(t.tool as ToolKey) ?? "chat"];
                const active = pathname.endsWith(t.id);
                return (
                  <SidebarMenuItem key={t.id}>
                    <div
                      className={`group/row flex items-center w-full rounded-md ${
                        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
                      }`}
                    >
                      <button
                        onClick={() =>
                          navigate({
                            to: "/chat/$threadId",
                            params: { threadId: t.id },
                          })
                        }
                        className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5 text-sm text-left"
                      >
                        <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{t.title}</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeThread.mutate(t.id);
                        }}
                        className="opacity-0 group-hover/row:opacity-100 p-1.5 text-muted-foreground hover:text-destructive transition"
                        aria-label="Delete thread"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </SidebarMenuItem>
                );
              })}
              {threads.data && threads.data.length === 0 && (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  No conversations yet.
                </div>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 px-2 py-1 group-data-[collapsible=icon]:hidden">
          <div className="text-xs text-muted-foreground truncate">{email}</div>
          <Button size="icon-sm" variant="ghost" onClick={signOut} aria-label="Sign out">
            <LogOut className="w-3.5 h-3.5" />
          </Button>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={signOut}
          className="hidden group-data-[collapsible=icon]:flex mx-auto"
          aria-label="Sign out"
        >
          <LogOut className="w-3.5 h-3.5" />
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
