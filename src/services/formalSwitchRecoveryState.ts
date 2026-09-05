import matrix from "../contracts/formalSwitchRecoveryStateMatrixV1.json";
import type { FormalSwitchPhase } from "../types/formalSwitchFoundation";

export interface FormalSwitchRecoveryStateV1 {
  readonly phase: FormalSwitchPhase;
  readonly settlementOutcome: "NOT_REQUIRED" | "APPLIED" | "ALREADY_APPLIED" | "UNKNOWN";
  readonly dbOutcome: "NOT_APPLIED" | "COMMITTED" | "ALREADY_COMMITTED" | "UNKNOWN";
  readonly activationOutcome: "PENDING" | "APPLIED" | "ALREADY_ACTIVE" | "UNKNOWN";
  readonly terminalCode: string | null;
}

function sameState(state: FormalSwitchRecoveryStateV1, candidate: typeof matrix.transitions[number]) {
  return candidate.settlement.includes(state.settlementOutcome)
    && candidate.db.includes(state.dbOutcome)
    && candidate.activation.includes(state.activationOutcome)
    && candidate.terminalCode === state.terminalCode;
}

export function initialFormalSwitchRecoveryState(): FormalSwitchRecoveryStateV1 {
  return { ...matrix.initial } as FormalSwitchRecoveryStateV1;
}

export function validateFormalSwitchRecoveryState(state: FormalSwitchRecoveryStateV1) {
  const phase = matrix.phases.find((candidate) => candidate.name === state.phase);
  if (!phase) throw new Error("FORMAL_SWITCH_STATE_PHASE_UNKNOWN");
  if (phase.terminal !== (state.terminalCode !== null)) {
    throw new Error("FORMAL_SWITCH_STATE_TERMINAL_MISMATCH");
  }
  if (state.terminalCode !== null && !matrix.terminalCodes.includes(state.terminalCode)) {
    throw new Error("FORMAL_SWITCH_STATE_TERMINAL_CODE_UNKNOWN");
  }
  const reachable = state.phase === matrix.initial.phase
    ? JSON.stringify(state) === JSON.stringify(matrix.initial)
    : matrix.transitions.some((candidate) => candidate.to === state.phase && sameState(state, candidate));
  if (!reachable) throw new Error("FORMAL_SWITCH_STATE_UNREACHABLE");
  return state;
}

export function validateFormalSwitchRecoveryTransition(
  current: FormalSwitchRecoveryStateV1,
  next: FormalSwitchRecoveryStateV1
) {
  validateFormalSwitchRecoveryState(current);
  validateFormalSwitchRecoveryState(next);
  const allowed = matrix.transitions.some((candidate) =>
    candidate.from === current.phase && candidate.to === next.phase && sameState(next, candidate)
  );
  if (!allowed) throw new Error("FORMAL_SWITCH_STATE_TRANSITION_FORBIDDEN");
  return next;
}

export function occupiesFormalSwitchUnresolvedSlot(state: FormalSwitchRecoveryStateV1) {
  validateFormalSwitchRecoveryState(state);
  return matrix.phases.find((candidate) => candidate.name === state.phase)!.occupiesUnresolvedSlot;
}

export function validateFormalSwitchRecoveryStateMatrix() {
  if (matrix.matrixId !== "FormalSwitchRecoveryStateMatrixV1" || matrix.matrixVersion !== 1) {
    throw new Error("FORMAL_SWITCH_STATE_MATRIX_IDENTITY_MISMATCH");
  }
  const expectedPhases = [
    "prepared", "settlement_started", "settlement_complete", "db_pending", "db_complete",
    "activation_pending", "contained", "blocked", "resolved", "cancelled_safe"
  ];
  if (JSON.stringify(matrix.phases.map((phase) => phase.name)) !== JSON.stringify(expectedPhases)) {
    throw new Error("FORMAL_SWITCH_STATE_MATRIX_PHASE_AUTHORITY_MISMATCH");
  }
  if (matrix.phases.filter((phase) => phase.occupiesUnresolvedSlot).length !== 8) {
    throw new Error("FORMAL_SWITCH_STATE_MATRIX_SLOT_POLICY_MISMATCH");
  }
  if (matrix.phases.filter((phase) => !phase.occupiesUnresolvedSlot).length !== 2) {
    throw new Error("FORMAL_SWITCH_STATE_MATRIX_RELEASE_POLICY_MISMATCH");
  }
  if (JSON.stringify(matrix.slotReleasingTerminalCodes) !== JSON.stringify(["RESOLVED", "CANCELLED_SAFE"])
    || JSON.stringify(matrix.outcomeMutationPhases) !== JSON.stringify({
      settlementOutcome: ["prepared", "settlement_started"],
      dbOutcome: ["db_pending"],
      activationOutcome: ["activation_pending"]
    })) {
    throw new Error("FORMAL_SWITCH_STATE_MATRIX_MUTATION_AUTHORITY_MISMATCH");
  }
  validateFormalSwitchRecoveryState(initialFormalSwitchRecoveryState());
  for (const transition of matrix.transitions) {
    const current = transition.from === matrix.initial.phase
      ? initialFormalSwitchRecoveryState()
      : null;
    const next: FormalSwitchRecoveryStateV1 = {
      phase: transition.to as FormalSwitchPhase,
      settlementOutcome: transition.settlement[0] as FormalSwitchRecoveryStateV1["settlementOutcome"],
      dbOutcome: transition.db[0] as FormalSwitchRecoveryStateV1["dbOutcome"],
      activationOutcome: transition.activation[0] as FormalSwitchRecoveryStateV1["activationOutcome"],
      terminalCode: transition.terminalCode
    };
    validateFormalSwitchRecoveryState(next);
    if (current) validateFormalSwitchRecoveryTransition(current, next);
  }
  return true;
}
