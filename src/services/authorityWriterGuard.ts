import { assertDesktopSQLiteProvisioningAdmission } from "./desktopSQLiteProvisioningAdmissionGuard";
import {
  planningOwnerAuthorityPort,
  type PlanningAuthorityEnvelopeView,
  type PlanningOwnerAuthorityRequest,
  type ValidatedPlanningAuthorityHandle
} from "./planningOwnerAuthorityPort";
import {
  publishAuthorityInvalidation,
  type AuthorityInvalidation
} from "./authorityInvalidationService";

type PlanningOwnerAuthorityPortLike = Pick<
  typeof planningOwnerAuthorityPort,
  | "acquirePlanningOwnerAuthority"
  | "revalidatePlanningAuthority"
  | "releasePlanningOwnerAuthority"
>;

export interface AuthorityWriterGuardDependencies {
  port: PlanningOwnerAuthorityPortLike;
  assertAdmission(): unknown;
  publishInvalidation(input: AuthorityInvalidation): void;
  isolatedRuntime?: () => boolean;
}

export interface AuthorityWriterInput<T> {
  request: PlanningOwnerAuthorityRequest;
  permit?: ValidatedPlanningAuthorityHandle;
  invalidation: AuthorityInvalidation;
  write(
    permit: ValidatedPlanningAuthorityHandle,
    context: PlanningAuthorityEnvelopeView
  ): Promise<T>;
}

export class AuthorityWriterGuardError extends Error {
  constructor(
    readonly status: string,
    readonly code: string
  ) {
    super(code);
    this.name = "AuthorityWriterGuardError";
  }
}

export function createAuthorityWriterGuard(
  dependencies: AuthorityWriterGuardDependencies
) {
  return {
    async run<T>(input: AuthorityWriterInput<T>): Promise<T> {
      if (dependencies.isolatedRuntime?.()) {
        const result = await input.write(
          undefined as unknown as ValidatedPlanningAuthorityHandle,
          undefined as unknown as PlanningAuthorityEnvelopeView
        );
        dependencies.publishInvalidation(input.invalidation);
        return result;
      }
      dependencies.assertAdmission();
      let permit = input.permit;
      let acquired = false;
      if (!permit) {
        const result = await dependencies.port.acquirePlanningOwnerAuthority(input.request);
        if (result.status !== "Validated") {
          throw new AuthorityWriterGuardError(result.status, result.code);
        }
        permit = result.handle;
        acquired = true;
      }
      try {
        const revalidated = await dependencies.port.revalidatePlanningAuthority(
          permit,
          input.request
        );
        if (revalidated.status !== "Validated") {
          throw new AuthorityWriterGuardError(revalidated.status, revalidated.code);
        }
        const result = await input.write(permit!, revalidated.context);
        dependencies.publishInvalidation(input.invalidation);
        return result;
      } finally {
        if (acquired) {
          await dependencies.port.releasePlanningOwnerAuthority(permit!);
        }
      }
    }
  };
}

function assertProductionAdmission() {
  assertDesktopSQLiteProvisioningAdmission();
}

export const authorityWriterGuard = createAuthorityWriterGuard({
  port: planningOwnerAuthorityPort,
  assertAdmission: assertProductionAdmission,
  publishInvalidation: publishAuthorityInvalidation,
  // Node-only repository tests use isolated in-memory fixtures and cannot touch
  // the desktop Planning/SQLite stores. Browser windows never take this branch.
  isolatedRuntime: () => typeof window === "undefined"
});
