import { Channel, invoke } from "@tauri-apps/api/core";
import type { Review } from "../types/planning";
import {
  activatePlanningRepositoryProducerWriter,
  getPlanningRepositoryEnvelope,
  revokePlanningRepositoryProducerWriter
} from "./planningRepository";
import {
  planningOwnerAuthorityPort,
  type PlanningAuthorityFailure,
  type PlanningAuthorityResult
} from "./planningOwnerAuthorityPort";
import type { PlanningRepositoryWriterSession } from "./planningRepositoryEnvelope";

export type PlanningAuthorityPurpose =
  | "PreparePreflight"
  | "PlanMaterialization"
  | "MutationPoint"
  | "NextStepAdmission";

export type PlanningAuthorityOwner = "Review" | "Experiment";

export interface PlanningAuthorityChallenge {
  challengeId: string;
  nonce: string;
  ownerId: string;
  projectId: string;
  owner: PlanningAuthorityOwner;
  scope: "channel";
  channel: "primary";
  purpose: PlanningAuthorityPurpose;
  processGeneration: string;
  producerSessionGeneration: number;
  transportGeneration: number;
  freshnessKind: "anyFresh" | "exact";
  expectedRepositoryEpoch?: string;
  expectedRepositoryRevision?: string;
  ttlMs: number;
}

type PlanningAuthorityAttestationStatus = "accepted" | "rejected";

interface PlanningAuthorityAttestation {
  challengeId: string;
  nonce: string;
  ownerId: string;
  projectId: string;
  owner: PlanningAuthorityOwner;
  scope: "channel";
  channel: "primary";
  purpose: PlanningAuthorityPurpose;
  processGeneration: string;
  producerSessionGeneration: number;
  transportGeneration: number;
  repositoryEpoch?: string;
  repositoryRevision?: string;
  reviewType?: Review["reviewType"];
  projectLifecycle?:
    | "active"
    | "archived"
    | "deleted"
    | "missing"
    | "missing-for-create"
    | "not-applicable";
  ownerLifecycle?: "active" | "deleted";
  authorityStatus: PlanningAuthorityAttestationStatus;
  rejectionReason?: string;
}

interface PlanningProducerRegistration {
  processGeneration: string;
  producerSessionGeneration: number;
  transportGeneration: number;
  producerCapability: string;
}

type PrivatePlanningProducerSession = {
  registration: PlanningProducerRegistration;
  writerSession: PlanningRepositoryWriterSession;
};

let privateSession: PrivatePlanningProducerSession | undefined;
let unloadInstalled = false;

function rejectionCode(result: Exclude<PlanningAuthorityResult, { status: "Validated" }>) {
  return (result as PlanningAuthorityFailure).code;
}

async function produceAttestation(
  challenge: PlanningAuthorityChallenge
): Promise<PlanningAuthorityAttestation> {
  let repositoryEpoch: string | undefined;
  let repositoryRevision: string | undefined;
  let authorityResult: PlanningAuthorityResult | undefined;
  try {
    const envelope = await getPlanningRepositoryEnvelope();
    repositoryEpoch = envelope.repositoryEpoch;
    repositoryRevision = envelope.revision;
    authorityResult =
      await planningOwnerAuthorityPort.acquirePlanningOwnerAuthorityForAttestation(
        {
          intent: "provisioningRead",
          requestId: challenge.challengeId,
          projectId: challenge.projectId,
          ownerType: challenge.owner === "Review" ? "review" : "experiment",
          ownerId: challenge.ownerId,
          scope: challenge.channel
        },
        {
          repositoryEpoch,
          revision: repositoryRevision,
          snapshot: envelope.snapshot
        }
      );
    if (authorityResult.status !== "Validated") {
      return {
        ...challenge,
        repositoryEpoch,
        repositoryRevision,
        authorityStatus: "rejected",
        rejectionReason: rejectionCode(authorityResult)
      };
    }
    const review = challenge.owner === "Review"
      ? envelope.snapshot.reviews.find((candidate) => candidate.id === challenge.ownerId)
      : undefined;
    return {
      ...challenge,
      repositoryEpoch,
      repositoryRevision,
      reviewType: review?.reviewType,
      projectLifecycle: authorityResult.authority.projectLifecycle,
      ownerLifecycle: authorityResult.authority.ownerLifecycle,
      authorityStatus: "accepted"
    };
  } catch (error) {
    return {
      ...challenge,
      repositoryEpoch,
      repositoryRevision,
      authorityStatus: "rejected",
      rejectionReason:
        error instanceof Error
          ? error.message
          : "PLANNING_AUTHORITY_UNAVAILABLE"
    };
  } finally {
    if (authorityResult?.status === "Validated") {
      await planningOwnerAuthorityPort
        .releasePlanningOwnerAuthority(authorityResult.handle)
        .catch(() => undefined);
    }
  }
}

async function respondToChallenge(challenge: PlanningAuthorityChallenge) {
  const session = privateSession;
  if (!session) {
    return;
  }
  const attestation = await produceAttestation(challenge);
  await invoke("planning_authority_submit_attestation", {
    producerCapability: session.registration.producerCapability,
    producerSessionGeneration:
      session.registration.producerSessionGeneration,
    transportGeneration: session.registration.transportGeneration,
    attestation
  });
}

function installUnloadRevocation() {
  if (unloadInstalled) {
    return;
  }
  unloadInstalled = true;
  window.addEventListener("beforeunload", () => {
    const session = privateSession;
    privateSession = undefined;
    if (!session) {
      return;
    }
    revokePlanningRepositoryProducerWriter(session.writerSession);
    void invoke("planning_authority_revoke_producer", {
      producerCapability: session.registration.producerCapability,
      producerSessionGeneration:
        session.registration.producerSessionGeneration,
      transportGeneration: session.registration.transportGeneration
    }).catch(() => undefined);
  });
}

export async function bootstrapPlanningAuthorityProducer(): Promise<void> {
  if (privateSession) {
    return;
  }
  const challengeChannel = new Channel<PlanningAuthorityChallenge>();
  challengeChannel.onmessage = (challenge) => {
    void respondToChallenge(challenge).catch(() => undefined);
  };
  const registration = await invoke<PlanningProducerRegistration>(
    "planning_authority_register_producer",
    { challengeChannel }
  );
  const writerSession: PlanningRepositoryWriterSession = Object.freeze({
    processGeneration: registration.processGeneration,
    producerSessionGeneration: registration.producerSessionGeneration,
    transportGeneration: registration.transportGeneration
  });
  privateSession = { registration, writerSession };
  activatePlanningRepositoryProducerWriter(writerSession);
  installUnloadRevocation();
}
