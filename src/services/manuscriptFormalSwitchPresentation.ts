import type { ManuscriptOutlineFieldDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";

export type FormalSwitchPresentationFieldAction = Readonly<{
  key: string;
  action: "set" | "clear";
}>;

// Exact terminal branches whose callers have already settled visible current
// state. Keep the existing page-store replacement lifecycle, without a message.
const SILENT_TERMINALS: Readonly<Record<string, readonly string[]>> = {
  "experiment.manuscript.switch": ["success"],
  "experiment.manuscript.switchNoOp": ["info"],
  "experiment.manuscript.switchCanceled": ["info"],
  "experiment.manuscript.switchConfirmCanceled": ["info"],
  "experiment.manuscript.externalRegistrationCanceled": ["info"],
  "experimentRun.manuscript.formalSwitch": ["success"],
  "experimentRun.manuscript.formalSwitchNoop": ["info"],
  "literature.manuscript.switch": ["success", "info"],
  "review.manuscript.setCurrent": ["success"],
  "output.markdown.switch": ["success"]
};

export function isSilentFormalSwitchFeedback(operation: string | undefined, severity: string) {
  return Boolean(operation && SILENT_TERMINALS[operation]?.includes(severity));
}

const ORDINARY_EDITOR_TERMINALS = new Set([
  ...Object.keys(SILENT_TERMINALS),
  "experiment.manuscript.selectSwitch",
  "experiment.manuscript.switchPreflight",
  "experiment.manuscript.switchConfirm",
  "experiment.manuscript.switchRefresh",
  "experimentRun.manuscript.formalSwitchPreflight",
  "experimentRun.manuscript.formalSwitchRecovery",
  "experimentRun.manuscript.formalSwitchFailed",
  "experimentRun.manuscript.formalSwitchStale"
]);

export function isOrdinaryFormalSwitchFeedback(operation: string) {
  return ORDINARY_EDITOR_TERMINALS.has(operation);
}

const STALE_SWITCH_CODES = new Set([
  "FORMAL_SWITCH_TOKEN_STALE",
  "EXPERIMENT_FORMAL_SWITCH_OWNER_CHANGED",
  "EXPERIMENT_FORMAL_SWITCH_CURRENT_CHANGED",
  "EXPERIMENT_FORMAL_SWITCH_DEFAULT_CHANGED",
  "EXPERIMENT_FORMAL_SWITCH_TARGET_CHANGED",
  "EXPERIMENT_FORMAL_SWITCH_TOKEN_EXPIRED",
  "EXPERIMENT_FORMAL_SWITCH_TOKEN_USED",
  "EXPERIMENT_FORMAL_SWITCH_CURRENT_BASELINE_MISSING",
  "EXPERIMENT_FORMAL_SWITCH_TARGET_BASELINE_MISSING",
  "EXPERIMENT_FORMAL_SWITCH_CURRENT_PHYSICAL_REVISION_CHANGED",
  "EXPERIMENT_FORMAL_SWITCH_TARGET_PHYSICAL_REVISION_CHANGED"
]);
const UNAVAILABLE_SWITCH_CODES = new Set([
  "EXPERIMENT_CURRENT_RAW_SESSION_MISSING",
  "EXPERIMENT_FORMAL_SWITCH_RUNTIME_IDENTITY_INVALID",
  "EXPERIMENT_FORMAL_SWITCH_CURRENT_RUNTIME_SESSION_UNAVAILABLE",
  "EXPERIMENT_FORMAL_SWITCH_TARGET_RUNTIME_SESSION_UNAVAILABLE",
  "EXPERIMENT_FORMAL_SWITCH_CURRENT_RUNTIME_IDENTITY_REPLACED",
  "EXPERIMENT_FORMAL_SWITCH_TARGET_RUNTIME_IDENTITY_REPLACED"
]);

export function projectFormalSwitchFailure(
  result: unknown,
  translate?: (source: string) => string,
  capability: Readonly<{ reload?: boolean; reopen?: boolean; wait?: boolean }> = {}
) {
  const text = (source: string, english: string) => translate ? translate(source) : english;
  const value = result && typeof result === "object"
    ? result as { status?: string; error?: {
        code?: string; errorCode?: string; causeCode?: string;
        recoveryRequired?: boolean; recoverability?: string;
        sideEffectSummary?: { databaseCommitted?: boolean };
      } }
    : undefined;
  const error = value?.error;
  const codes = [error?.code, error?.errorCode, error?.causeCode];
  const has = (set: ReadonlySet<string>) => codes.some((code) => code && set.has(code));
  if (value?.status === "recovery-required" || error?.recoveryRequired ||
      codes.includes("FORMAL_SWITCH_RECOVERY_PENDING")) {
    return { category: "RECOVERY_REQUIRED", summary: text("文稿切换需要恢复处理。", "The manuscript switch needs recovery."), action: "none" } as const;
  }
  if (error?.sideEffectSummary?.databaseCommitted ||
      codes.includes("EXPERIMENT_FORMAL_SWITCH_PAGE_REFRESH_FAILED")) {
    return { category: "INCOMPLETE_REFRESH", summary: text("当前稿已切换，但显示信息尚未更新完成。", "The current manuscript has switched, but its displayed information has not finished updating."), action: "none" } as const;
  }
  if (has(STALE_SWITCH_CODES) || value?.status === "stale") {
    return { category: "STALE_OR_CHANGED", summary: text(capability.reload
      ? "文稿状态已变化，请重新加载后确认切换。" : "文稿状态已变化，切换未完成。", capability.reload
      ? "The manuscript state has changed. Reload before confirming the switch." : "The manuscript state has changed; the switch did not complete."), action: capability.reload ? "reload" : "none" } as const;
  }
  if (has(UNAVAILABLE_SWITCH_CODES)) {
    return { category: "SESSION_UNAVAILABLE", summary: text(capability.reopen
      ? "文稿会话已不可用，请重新打开当前稿和目标稿。" : "文稿会话已不可用，切换未完成。", capability.reopen
      ? "The manuscript session is unavailable. Reopen the current and target manuscripts." : "The manuscript session is unavailable; the switch did not complete."), action: capability.reopen ? "reopen" : "none" } as const;
  }
  if (codes.includes("FORMAL_SWITCH_RESOURCE_BUSY") || codes.includes("MANUSCRIPT_OPERATION_IN_PROGRESS")) {
    return { category: "IN_PROGRESS", summary: text(capability.wait
      ? "另一项文稿操作仍在进行，请等待完成。" : "另一项文稿操作仍在进行，切换未完成。", capability.wait
      ? "Another manuscript operation is in progress. Wait for it to finish." : "Another manuscript operation is in progress; the switch did not complete."), action: capability.wait ? "wait" : "none" } as const;
  }
  if (value?.status === "conflict" || error?.recoverability === "resolve-conflict" ||
      codes.includes("EXPERIMENT_FORMAL_SWITCH_CURRENT_DIRTY") ||
      codes.includes("EXPERIMENT_FORMAL_SWITCH_TARGET_DIRTY")) {
    return { category: "CONFLICT", summary: text("文稿存在冲突或未保存修改，请先处理当前文稿状态。", "The manuscript has a conflict or unsaved changes. Resolve its current state first."), action: "none" } as const;
  }
  return { category: "UNEXPECTED_OR_UNKNOWN", summary: text("文稿切换未完成。", "The manuscript switch did not complete."), action: "none" } as const;
}

function persistenceLeaf(field: ManuscriptOutlineFieldDescriptor) {
  return field.persistenceProjectorIdentity.split(".").pop() ?? "";
}

function interpolate(
  template: string,
  values: Readonly<Record<string, string>>
) {
  return template.replace(/\{([A-Za-z]+)\}/gu, (token, key: string) =>
    values[key] ?? token
  );
}

export function buildFormalSwitchConfirmationCopy(input: Readonly<{
  targetFileName: string;
  ownerDisplayName: string;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  fieldActions?: readonly FormalSwitchPresentationFieldAction[];
  importedStableKeys?: readonly string[];
  missingStableKeys?: readonly string[];
  notices?: readonly string[];
  emptySetLabel?: string;
  resolveLabel?: (field: ManuscriptOutlineFieldDescriptor) => string;
  translate?: (source: string) => string;
}>) {
  const translate = input.translate ?? ((source: string) => source);
  const descriptor = getManuscriptOutlineDescriptor(
    input.descriptorLookupIdentity
  );
  const actionByKey = new Map(
    (input.fieldActions ?? []).map((item) => [item.key, item.action] as const)
  );
  const explicitImported = input.importedStableKeys
    ? new Set(input.importedStableKeys)
    : undefined;
  const explicitMissing = input.missingStableKeys
    ? new Set(input.missingStableKeys)
    : undefined;
  const imported = descriptor.fields.filter((field) => explicitImported
    ? explicitImported.has(field.stableKey)
    : explicitMissing
      ? !explicitMissing.has(field.stableKey)
      : (actionByKey.get(field.stableKey) ??
          actionByKey.get(persistenceLeaf(field))) === "set");
  const importedKeys = new Set(imported.map((field) => field.stableKey));
  const missing = descriptor.fields.filter(
    (field) => !importedKeys.has(field.stableKey)
  );
  const emptySetLabel = input.emptySetLabel ?? translate("无");
  const labels = (fields: readonly ManuscriptOutlineFieldDescriptor[]) =>
    fields.length > 0
      ? fields.map((field) => input.resolveLabel?.(field) ?? field.displayLabel)
        .join("、")
      : emptySetLabel;
  const ownerDisplayName = /^[A-Za-z]/u.test(input.ownerDisplayName)
    ? ` ${input.ownerDisplayName}`
    : input.ownerDisplayName;
  const ruleBlock = interpolate(translate(
    "确认将“{filename}”设为当前{owner}。默认稿保持不变，文稿正文内容保留，文件不会移动、改名或删除；结构化纲要仅按当前文稿切换规则更新。"
  ), {
    filename: input.targetFileName,
    owner: ownerDisplayName
  });
  const noticeText = input.notices?.length
    ? interpolate(translate(" 内容提示：{notices}（不阻断切换）。"), {
        notices: input.notices.join("；")
      })
    : "";
  const confirmationBlock = interpolate(translate(
    "结构化纲要可导入字段（{importedCount}）：{importedLabels}；缺失字段（{missingCount}）：{missingLabels}。缺失字段按空值处理，不继承原稿。"
  ), {
    importedCount: String(imported.length),
    importedLabels: labels(imported),
    missingCount: String(missing.length),
    missingLabels: labels(missing)
  }) + noticeText;
  const semanticBlocks = Object.freeze([ruleBlock, confirmationBlock] as const);
  return Object.freeze({
    semanticBlocks,
    message: semanticBlocks.join("\n\n"),
    importedStableKeys: Object.freeze(imported.map((field) => field.stableKey)),
    missingStableKeys: Object.freeze(missing.map((field) => field.stableKey)),
    importedFieldLabels: Object.freeze(imported.map((field) =>
      input.resolveLabel?.(field) ?? field.displayLabel
    )),
    missingFieldLabels: Object.freeze(missing.map((field) =>
      input.resolveLabel?.(field) ?? field.displayLabel
    ))
  });
}

export const manuscriptFormalSwitchPresentation = Object.freeze({
  buildConfirmationCopy: buildFormalSwitchConfirmationCopy
});
