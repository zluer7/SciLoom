import type {
  ExperimentFormalSwitchActualRuntimeHandle,
  ExperimentFormalSwitchLogicalSessionKey
} from "./experimentManuscriptSwitchService";

declare const logicalSessionKey: ExperimentFormalSwitchLogicalSessionKey;
declare const actualRuntimeHandle: ExperimentFormalSwitchActualRuntimeHandle;
declare function reloadByActualRuntimeHandle(
  handle: ExperimentFormalSwitchActualRuntimeHandle
): void;

reloadByActualRuntimeHandle(actualRuntimeHandle);

// @ts-expect-error A logical session key is not a runtime capability handle.
reloadByActualRuntimeHandle(logicalSessionKey);

