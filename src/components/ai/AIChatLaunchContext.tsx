import { createContext, useContext } from "react";
import type { AIResearchObjectType } from "../../types/aiContext";

export type AIChatLaunchIntent = {
  requestId: number;
  projectId: string;
  researchObjects: Array<{
    objectType: AIResearchObjectType;
    objectId: string;
    label: string;
  }>;
  /** Optional editable composer seed only; it never builds, sends, parses or confirms automatically. */
  draftQuestion?: string;
};

export type AIChatLaunchRequest = Omit<AIChatLaunchIntent, "requestId">;

type AIChatLaunchContextValue = {
  openAIChat: (request: AIChatLaunchRequest) => void;
};

const AIChatLaunchContext = createContext<AIChatLaunchContextValue | null>(null);

export const AIChatLaunchProvider = AIChatLaunchContext.Provider;

/** Sends only an ephemeral open/preset intent to the unique global Chat owner. */
export function useAIChatLauncher(): AIChatLaunchContextValue {
  const value = useContext(AIChatLaunchContext);
  if (!value) throw new Error("useAIChatLauncher must be used inside AppLayout.");
  return value;
}
