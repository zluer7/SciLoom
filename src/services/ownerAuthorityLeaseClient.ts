import { invoke } from "@tauri-apps/api/core";

export type AuthorityLeaseMode = "read" | "write";

export type AuthorityLeaseKey =
  | { kind: "managedRoot" }
  | { kind: "project"; projectId: string }
  | { kind: "owner"; ownerType: string; ownerId: string }
  | {
      kind: "channelScope";
      ownerType: string;
      ownerId: string;
      scope: string;
    };

export interface AuthorityLeaseRequest {
  key: AuthorityLeaseKey;
  mode: AuthorityLeaseMode;
}

export interface AuthorityLeaseGrant {
  token: string;
  requestId: string;
  holderKind: "callerBound";
  registryGeneration: string;
  requests: AuthorityLeaseRequest[];
}

export interface OwnerAuthorityLeaseClient {
  tryAcquireMany(
    requestId: string,
    requests: AuthorityLeaseRequest[]
  ): Promise<AuthorityLeaseGrant>;
  validate(
    token: string,
    requests: AuthorityLeaseRequest[]
  ): Promise<{ valid: true; registryGeneration: string }>;
  release(token: string): Promise<{ released: boolean }>;
}

export const tauriOwnerAuthorityLeaseClient: OwnerAuthorityLeaseClient = {
  tryAcquireMany(requestId, requests) {
    return invoke<AuthorityLeaseGrant>("owner_authority_try_acquire_many", {
      requestId,
      requests
    });
  },
  validate(token, requests) {
    return invoke("owner_authority_validate", { token, requests });
  },
  release(token) {
    return invoke("owner_authority_release", { token });
  }
};
