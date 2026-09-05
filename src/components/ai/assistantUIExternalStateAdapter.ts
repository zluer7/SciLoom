import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { AIMessage } from "../../types/aiConversation";

export function orderCanonicalMessages(messages: readonly AIMessage[]): AIMessage[] {
  return [...messages].sort((left, right) => (
    left.sequence - right.sequence ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  ));
}

export function mapCanonicalMessage(message: AIMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
    ...(message.role === "assistant"
      ? { status: { type: "complete", reason: "stop" } as const }
      : {})
  };
}

export function extractComposerText(message: AppendMessage): string {
  if (message.role !== "user") return "";
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
