import type { OutputManuscriptOwnerType } from "../types";
import { sharedManuscriptSessionRuntime } from "./sharedManuscriptSessionComposition";
import type { SharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";

export function createOutputManuscriptLifecycleSessionRegistry(
  runtime: SharedManuscriptSessionRuntime = sharedManuscriptSessionRuntime
) {
  return Object.freeze({
    setOwnerDeleted(
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      deleted: boolean
    ) {
      if (!deleted) {
        return runtime.closeCleanSessions(
          (session) =>
            session.owner.ownerType === ownerType &&
            session.owner.ownerId === ownerId &&
            session.owner.channel === "primary"
        ).then((closed) => {
          if (!closed) throw new Error("OUTPUT_MANUSCRIPT_SESSION_DIRTY");
          return 0;
        });
      }
      return runtime.transitionToReadOnlySessions(
        (session) =>
          session.owner.ownerType === ownerType &&
          session.owner.ownerId === ownerId &&
          session.owner.channel === "primary",
        "OUTPUT_MANUSCRIPT_OWNER_DELETED"
      );
    }
  });
}

export const outputManuscriptLifecycleSessionRegistry =
  createOutputManuscriptLifecycleSessionRegistry();
