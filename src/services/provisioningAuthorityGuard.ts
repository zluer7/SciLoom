import { assertDesktopSQLiteProvisioningAdmission } from "./desktopSQLiteProvisioningAdmissionGuard";
import {
  planningOwnerAuthorityPort,
  type PlanningAuthorityFailureStatus,
  type PlanningOwnerAuthorityRequest,
  type ValidatedPlanningAuthority,
  type ValidatedPlanningAuthorityHandle
} from "./planningOwnerAuthorityPort";

export class ProvisioningAuthorityError extends Error {
  readonly code: string;
  readonly status: PlanningAuthorityFailureStatus;
  readonly retryable: boolean;

  constructor(status: PlanningAuthorityFailureStatus, code: string) {
    super(code);
    this.name = "ProvisioningAuthorityError";
    this.code = code;
    this.status = status;
    this.retryable = status === "LeaseUnavailable" ||
      status === "LeaseStale" ||
      status === "AuthorityChanged" ||
      status === "InternalFailure";
  }
}

export function toProvisioningAuthorityIssue(error: unknown) {
  return error instanceof ProvisioningAuthorityError
    ? {
        code: error.code,
        message: error.message,
        status: error.status,
        retryable: error.retryable
      }
    : {
        code: "PROVISIONING_AUTHORITY_INTERNAL_FAILURE",
        message: error instanceof Error ? error.message : String(error),
        status: "InternalFailure" as const,
        retryable: false
      };
}

export async function runWithProvisioningAuthority<T>(input: {
  request: PlanningOwnerAuthorityRequest;
  permit?: ValidatedPlanningAuthorityHandle;
  write(
    permit: ValidatedPlanningAuthorityHandle,
    authority: ValidatedPlanningAuthority
  ): Promise<T>;
}) {
  assertDesktopSQLiteProvisioningAdmission();
  let permit = input.permit;
  let acquired = false;
  let authority: ValidatedPlanningAuthority;
  if (!permit) {
    const result = await planningOwnerAuthorityPort.acquirePlanningOwnerAuthority(input.request);
    if (result.status !== "Validated") {
      throw new ProvisioningAuthorityError(result.status, result.code);
    }
    permit = result.handle;
    authority = result.authority;
    acquired = true;
  } else {
    const result = await planningOwnerAuthorityPort.revalidatePlanningAuthority(
      permit,
      input.request
    );
    if (result.status !== "Validated") {
      throw new ProvisioningAuthorityError(result.status, result.code);
    }
    authority = result.authority;
  }
  try {
    return await input.write(permit, authority);
  } finally {
    if (acquired) {
      await planningOwnerAuthorityPort.releasePlanningOwnerAuthority(permit);
    }
  }
}
