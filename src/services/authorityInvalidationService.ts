import { emit } from "@tauri-apps/api/event";

export interface AuthorityInvalidation {
  domain: "planning" | "fileRef" | "binding" | "managedRoot";
  projectId?: string;
  ownerType?: string;
  ownerId?: string;
  scope?: string;
}

export const AUTHORITY_INVALIDATION_EVENT = "labpod://authority-invalidated";

export function publishAuthorityInvalidation(input: AuthorityInvalidation) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTHORITY_INVALIDATION_EVENT, {
      detail: Object.freeze({ ...input })
    }));
    // Keep native delivery outside the caller's synchronous stack.
    void Promise.resolve()
      .then(() => emit(AUTHORITY_INVALIDATION_EVENT, input))
      .catch(() => undefined);
  }
}
