import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import {
  AIChatLaunchProvider,
  type AIChatLaunchIntent,
  type AIChatLaunchRequest
} from "../ai/AIChatLaunchContext";
import { GlobalAIChatPanel } from "../ai/GlobalAIChatPanel";
import { AIContextDiscardDialog } from "../ai/AIContextDiscardDialog";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
  const navigate = useNavigate();
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);
  const [aiChatLaunchIntent, setAIChatLaunchIntent] = useState<AIChatLaunchIntent | null>(null);
  const [isAIContextDirty, setIsAIContextDirty] = useState(false);
  const [pendingAICloseIntent, setPendingAICloseIntent] = useState<"panel" | "settings" | null>(null);
  const launchSequenceRef = useRef(0);

  const openAIChat = useCallback((request: AIChatLaunchRequest) => {
    launchSequenceRef.current += 1;
    setAIChatLaunchIntent({ ...request, requestId: launchSequenceRef.current });
    setIsAIChatOpen(true);
  }, []);

  const closeAIChat = useCallback((intent: "panel" | "settings") => {
    setPendingAICloseIntent(null);
    setIsAIContextDirty(false);
    setIsAIChatOpen(false);
    if (intent === "settings") {
      navigate({ pathname: "/settings", hash: "#ai-provider-settings" });
      window.setTimeout(() => {
        document.getElementById("ai-provider-settings")?.scrollIntoView({ block: "start" });
      }, 0);
    }
  }, [navigate]);

  const requestCloseAIChat = useCallback((intent: "panel" | "settings" = "panel") => {
    if (isAIContextDirty) {
      setPendingAICloseIntent(intent);
      return false;
    }
    closeAIChat(intent);
    return true;
  }, [closeAIChat, isAIContextDirty]);

  useEffect(() => {
    if (!isAIChatOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (pendingAICloseIntent) {
        setPendingAICloseIntent(null);
        return;
      }
      requestCloseAIChat();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAIChatOpen, pendingAICloseIntent, requestCloseAIChat]);

  return (
    <AIChatLaunchProvider value={{ openAIChat }}>
      <div className="app-container">
        <Sidebar
          isAIChatOpen={isAIChatOpen}
          onToggleAIChat={() => {
            if (isAIChatOpen) {
              requestCloseAIChat();
            } else {
              setAIChatLaunchIntent(null);
              setIsAIContextDirty(false);
              setIsAIChatOpen(true);
            }
          }}
        />
        {isAIChatOpen ? (
          <GlobalAIChatPanel
            launchIntent={aiChatLaunchIntent}
            onClose={requestCloseAIChat}
            onContextDirtyChange={setIsAIContextDirty}
          />
        ) : null}
        <AIContextDiscardDialog
          confirmLabel={pendingAICloseIntent === "settings" ? "放弃编辑并打开设置" : "放弃编辑并关闭"}
          onCancel={() => setPendingAICloseIntent(null)}
          onConfirm={() => closeAIChat(pendingAICloseIntent ?? "panel")}
          open={Boolean(pendingAICloseIntent)}
        />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </AIChatLaunchProvider>
  );
}
