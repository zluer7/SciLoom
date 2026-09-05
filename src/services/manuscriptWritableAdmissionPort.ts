import { invoke } from "@tauri-apps/api/core";
import type {
  SharedWritableAdmissionPort,
  SharedWritableAdmissionGrant,
  SharedWritableAdmissionRelease,
  SharedWritableAdmissionValidation,
  SharedWritableTargetRequest
} from "../types/sharedManuscriptSession";

export const manuscriptWritableAdmissionPort: SharedWritableAdmissionPort =
  Object.freeze({
    acquire(input: {
      requestId: string;
      logicalSessionKey: string;
      target: SharedWritableTargetRequest;
    }) {
      return invoke<SharedWritableAdmissionGrant>("manuscript_writable_admit", input);
    },
    retain(proof: string) {
      return invoke<SharedWritableAdmissionGrant>("manuscript_writable_retain", {
        proof
      });
    },
    validate(proof: string, target: SharedWritableTargetRequest) {
      return invoke<SharedWritableAdmissionValidation>(
        "manuscript_writable_validate",
        { proof, target }
      );
    },
    renew(
      proof: string,
      target: SharedWritableTargetRequest,
      expectedRevision?: string
    ) {
      return invoke<SharedWritableAdmissionValidation>(
        "manuscript_writable_renew",
        { proof, target, expectedRevision }
      );
    },
    release(proof: string) {
      return invoke<SharedWritableAdmissionRelease>(
        "manuscript_writable_release",
        { proof }
      );
    },
    detachWindow() {
      return invoke<{ releasedCount: number }>(
        "manuscript_writable_detach_window"
      );
    }
  });
