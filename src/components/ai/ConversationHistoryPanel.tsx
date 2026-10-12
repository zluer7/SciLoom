import { useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import type { AIConversationSummary } from "../../types";
import { useI18n } from "../../i18n/I18nProvider";
import { groupAIConversationHistory } from "./aiPanelProductizationModel";
import { conversationDisplayTitle, conversationLifecycle, type ConversationLifecycle, type ConversationManagementAction } from "../../services/aiConversationManagementService";

export type ConversationHistoryProps = {
  summaries: AIConversationSummary[];
  selectedId: string | null;
  view: ConversationLifecycle;
  onViewChange(view: ConversationLifecycle): void;
  busy: boolean;
  loading: boolean;
  error?: string | null;
  onRefresh?(): Promise<void>;
  onSelect(id: string): void;
  onManage(row: AIConversationSummary, action: ConversationManagementAction, options?: { title?: string; confirmed?: boolean }): Promise<void>;
};

export function ConversationHistoryPanel(props: ConversationHistoryProps) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AIConversationSummary | null>(null);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const focusRef = useRef<HTMLButtonElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [pendingRename, setPendingRename] = useState<AIConversationSummary | null>(null);
  const [title, setTitle] = useState("");
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const rows = props.summaries.filter(row => conversationLifecycle(row) === props.view &&
    `${conversationDisplayTitle(row)} ${row.latestMessage ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const labels = { ACTIVE: zh ? "对话" : "Active", ARCHIVED: zh ? "归档" : "Archived", TRASHED: zh ? "回收站" : "Trash" };
  const disabled = props.busy || working;
  function restoreFocus(e: Event) {
    e.preventDefault();
    const target = focusRef.current?.isConnected ? focusRef.current : viewRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    target?.focus();
  }
  function failure(unknown: unknown) {
    const code = String(unknown);
    if (code.includes("UNSAVED_DRAFT")) return zh ? "请先保存或清空当前输入与上下文草稿。" : "Save or clear the current input and context draft first.";
    if (code.includes("BUSY")) return zh ? "请先停止生成或等待当前操作完成。" : "Stop generation or wait for the current operation.";
    if (code.includes("STATE_CHANGED")) return zh ? "对话状态已变化，请刷新后重试。" : "The conversation changed. Refresh before retrying.";
    if (code.includes("TITLE_INVALID")) return zh ? "名称须包含 1–200 个字符。" : "Use a name containing 1–200 characters.";
    return zh ? "操作未完成或结果尚未确认，请刷新后检查。" : "The operation failed or its result is unconfirmed. Refresh and check.";
  }
  async function run(row: AIConversationSummary, action: ConversationManagementAction, confirmed?: boolean) {
    if (disabled || workingRef.current) return;
    workingRef.current = true;
    setWorking(true); setFeedback(null);
    try {
      await props.onManage(row, action, action === "rename" ? { title: title.trim() } : { confirmed });
      setFeedback({ error: false, text: zh ? "已完成。" : "Done." });
      setPendingDelete(null);
      setPendingRename(null);
      if (action !== "rename" && typeof window !== "undefined") window.requestAnimationFrame?.(() => viewRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus());
    } catch (unknown) {
      setFeedback({ error: true, text: failure(unknown) });
    } finally { workingRef.current = false; setWorking(false); }
  }
  return (
    <section className="global-ai-chat-panel__history">
      <div className="global-ai-chat-panel__section-heading"><h3>{zh ? "对话历史" : "Conversation history"}</h3><span>{rows.length}</span></div>
      <div className="conversation-history-toolbar">
      <label className="global-ai-chat-panel__history-search"><span className="global-ai-chat-panel__sr-only">{zh ? "搜索对话" : "Search conversations"}</span>
        <input type="search" aria-label={zh ? "搜索对话历史" : "Search conversation history"} placeholder={zh ? "搜索对话" : "Search"} value={search} onChange={e => setSearch(e.target.value)} />
      </label>
      {props.onRefresh ? <button type="button" disabled={disabled || props.loading} onClick={async () => {
        if (workingRef.current) return;
        workingRef.current = true; setWorking(true); setFeedback(null);
        try { await props.onRefresh?.(); }
        catch { setFeedback({ error: true, text: zh ? "历史刷新失败，请重试。" : "History refresh failed. Try again." }); }
        finally { workingRef.current = false; setWorking(false); }
      }} aria-label={zh ? "刷新历史" : "Refresh history"} title={zh ? "刷新历史" : "Refresh history"}>↻</button> : null}
      </div>
      {props.error ? <p role="alert">{props.error}</p> : null}
      {props.loading ? <p role="status">{zh ? "正在读取对话历史…" : "Loading history…"}</p> : null}
      {feedback ? <p role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
      {props.busy ? <p className="conversation-history-notice">{zh ? "当前操作进行中，请先停止生成或等待完成。" : "An operation is running. Stop generation or wait for completion."}</p> : null}
      <nav aria-label={zh ? "对话历史" : "Conversation history"} className="global-ai-chat-panel__history-list">
        {groupAIConversationHistory(rows).map(group => <section className="global-ai-chat-panel__history-group" key={group.id}><h4>{zh ? group.label : ({today:"Today",recent:"Recent",older:"Earlier"})[group.id]}</h4>{group.conversations.map(row => <div className={`conversation-history-row${row.id === props.selectedId ? " is-active" : ""}`} key={row.id} data-conversation-row={row.id}>
          <button type="button" data-conversation-id={row.id} aria-current={row.id === props.selectedId ? "page" : undefined} className={row.id === props.selectedId ? "is-active" : ""} disabled={disabled || props.view === "TRASHED"} onClick={() => props.onSelect(row.id)} title={conversationDisplayTitle(row)}>
            <strong>{conversationDisplayTitle(row)}</strong><time dateTime={row.updatedAt}>{row.updatedAt.slice(0, 16).replace("T", " ")}</time>
          </button>
          <Menu.Root><Menu.Trigger type="button" className="conversation-history-actions" disabled={disabled} onClick={e => { focusRef.current = e.currentTarget; }} aria-label={`${zh ? "管理对话" : "Manage conversation"} ${conversationDisplayTitle(row)}`}>…</Menu.Trigger>
            <Menu.Portal><Menu.Content className="conversation-history-menu" sideOffset={4} onCloseAutoFocus={e => { if (pendingDelete || pendingRename) e.preventDefault(); }}>
              {props.view !== "TRASHED" ? <>
                <Menu.Item disabled={disabled} onSelect={() => { setPendingRename(row); setTitle(conversationDisplayTitle(row)); setFeedback(null); }}>{zh ? "重命名" : "Rename"}</Menu.Item>
                <Menu.Item disabled={disabled} onSelect={() => { void run(row, props.view === "ARCHIVED" ? "unarchive" : "archive"); }}>{props.view === "ARCHIVED" ? (zh ? "取消归档" : "Unarchive") : (zh ? "归档" : "Archive")}</Menu.Item>
                <Menu.Item disabled={disabled} onSelect={() => { void run(row, "trash"); }}>{zh ? "移到回收站" : "Move to Trash"}</Menu.Item>
              </> : <>
                <Menu.Item disabled={disabled} onSelect={() => { void run(row, "restore"); }}>{zh ? "恢复" : "Restore"}</Menu.Item>
                <Menu.Item disabled={disabled} onSelect={() => { setPendingDelete(row); setFeedback(null); }}>{zh ? "永久删除" : "Delete permanently"}</Menu.Item>
              </>}
            </Menu.Content></Menu.Portal>
          </Menu.Root>
        </div>)}</section>)}
        {!props.loading && rows.length === 0 ? <p>{search.trim() ? (zh ? "没有匹配的对话。" : "No matching conversations.") : zh ? `${labels[props.view]}中暂无对话。` : `No conversations in ${labels[props.view]}.`}</p> : null}
      </nav>
      <div ref={viewRef} className="conversation-history-views" aria-label={zh ? "历史视图" : "History view"}>
        {(["ACTIVE", "ARCHIVED", "TRASHED"] as const).map(view => <button key={view} type="button" aria-pressed={view === props.view} disabled={disabled} onClick={() => { props.onViewChange(view); setFeedback(null); }}>{labels[view]}</button>)}
      </div>
      <AlertDialog.Root open={Boolean(pendingDelete)} onOpenChange={open => { if (!open && !working) setPendingDelete(null); }}>
        <AlertDialog.Portal><AlertDialog.Overlay className="conversation-dialog-overlay" /><AlertDialog.Content className="conversation-dialog" onCloseAutoFocus={restoreFocus} onEscapeKeyDown={e => { e.stopPropagation(); if (working) e.preventDefault(); }}>
          <AlertDialog.Title>{zh ? "永久删除对话" : "Delete conversation permanently"}</AlertDialog.Title>
          <AlertDialog.Description>{pendingDelete ? conversationDisplayTitle(pendingDelete) : ""} — {zh ? "对话及其消息将永久删除，无法恢复。独立科研对象和外部文件将保留。" : "This conversation and its messages will be deleted irreversibly. Independent research objects and external files remain."}</AlertDialog.Description>
          {feedback?.error ? <p role="alert">{feedback.text}</p> : null}
          <div className="conversation-dialog-actions"><AlertDialog.Cancel disabled={working}>{zh ? "取消" : "Cancel"}</AlertDialog.Cancel>
            <AlertDialog.Action className="danger-button" disabled={disabled} onClick={e => { e.preventDefault(); if (pendingDelete) void run(pendingDelete, "permanentDelete", true); }}>{working ? (zh ? "处理中…" : "Working…") : zh ? "永久删除" : "Delete permanently"}</AlertDialog.Action></div>
        </AlertDialog.Content></AlertDialog.Portal>
      </AlertDialog.Root>
      <Dialog.Root open={Boolean(pendingRename)} onOpenChange={open => { if (!open && !workingRef.current) setPendingRename(null); }}>
        <Dialog.Portal><Dialog.Overlay className="conversation-dialog-overlay" /><Dialog.Content className="conversation-dialog" onCloseAutoFocus={restoreFocus} onEscapeKeyDown={e => { e.stopPropagation(); if (workingRef.current) e.preventDefault(); }} onPointerDownOutside={e => { if (workingRef.current) e.preventDefault(); }}>
          <Dialog.Title>{zh ? "重命名对话" : "Rename conversation"}</Dialog.Title>
          <Dialog.Description>{zh ? "名称须包含 1–200 个字符，对话身份和消息保持不变。" : "Use 1–200 characters. Conversation identity and messages are preserved."}</Dialog.Description>
          <form onSubmit={e => { e.preventDefault(); if (pendingRename && title.trim() && Array.from(title.trim()).length <= 200) void run(pendingRename,"rename"); }}>
            <label>{zh ? "对话名称" : "Conversation name"}<input autoFocus value={title} disabled={working} onChange={e => setTitle(e.target.value)} aria-label={zh ? "对话名称" : "Conversation name"} /></label>
            {feedback?.error ? <p role="alert">{feedback.text}</p> : null}
            <div className="conversation-dialog-actions"><Dialog.Close type="button" disabled={working}>{zh ? "取消" : "Cancel"}</Dialog.Close>
              <button type="submit" disabled={disabled || !title.trim() || Array.from(title.trim()).length > 200}>{working ? (zh ? "保存中…" : "Saving…") : zh ? "保存名称" : "Save name"}</button></div>
          </form>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
