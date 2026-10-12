import { invoke } from "@tauri-apps/api/core";
import type { AIConversationSummary } from "../types";

export type ConversationLifecycle = "ACTIVE" | "ARCHIVED" | "TRASHED";
export type ConversationManagementAction = "rename" | "archive" | "unarchive" | "trash" | "restore" | "permanentDelete";
export type ConversationManagementReceipt = Pick<AIConversationSummary, "title" | "archivedAt" | "trashedAt" | "revision">;
export function conversationLifecycle(row: Pick<AIConversationSummary, "archivedAt" | "trashedAt">): ConversationLifecycle {
  return row.trashedAt ? "TRASHED" : row.archivedAt ? "ARCHIVED" : "ACTIVE";
}
export function manageAIConversation(row: AIConversationSummary, action: ConversationManagementAction, options: { title?: string; confirmed?: boolean } = {}) {
  return invoke<ConversationManagementReceipt>("db_manage_ai_conversation", { input: { conversationId: row.id, expectedRevision: row.revision ?? 0, action, ...options } });
}

export function conversationDisplayTitle(row: AIConversationSummary): string {
  return row.title?.trim() || row.firstUserMessage?.replace(/\s+/g, " ").trim().slice(0, 52) || "新对话";
}
