import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";
import type { ManuscriptSegmentEntryKind } from "./manuscriptSegmentProductCapability";

export const F3_MANUSCRIPT_EDITOR_REFERENCE_VIEWPORT = Object.freeze({
  width: 1452,
  height: 1028,
  deviceScaleFactor: 1
});

export const F3_MANUSCRIPT_EDITOR_REFERENCE_ASSETS = Object.freeze({
  currentDefectAndPreviewFailure: Object.freeze({
    role: "CURRENT_MAIN_UI_DEFECT_AND_PREVIEW_FAILURE_EVIDENCE",
    width: 2396,
    height: 1599,
    byteLength: 295322,
    sha256: "318F9F7AE7C71B3B39C7756708CAEB5B471720FD0FFA9EFE01BE00EEFF116EBE"
  }),
  independentContractViolation: Object.freeze({
    role: "INDEPENDENT_EDITOR_CONTRACT_VIOLATION_EVIDENCE",
    width: 2401,
    height: 1598,
    byteLength: 294430,
    sha256: "50EF5BFA35A183C542DC859EE198A62C1D77BE36586595A59CE9F2B8A13124B0"
  }),
  currentCompactTarget: Object.freeze({
    role: "CURRENT_ENTRY_COMPACT_LAYOUT_TARGET",
    width: 1452,
    height: 1028,
    byteLength: 118597,
    sha256: "B31CBA601CF5043B7A9FFB9181FB2B6B6E6B88FFF64B309BE614F9E473801531"
  }),
  templateUiDefect: Object.freeze({
    role: "CURRENT_TEMPLATE_UI_DEFECT",
    width: 2368,
    height: 1607,
    byteLength: 323228,
    sha256: "A2D75FBC450529B57DB6485CE7FF0F44DF5E10A2949DC21B22690A7D69F13B58"
  }),
  templateWorkspaceTarget: Object.freeze({
    role: "TEMPLATE_WORKSPACE_PANEL_STYLE_AND_CAPABILITY_TARGET",
    width: 1038,
    height: 760,
    byteLength: 82869,
    sha256: "D7BF3A366D969475B034C317CFE48747DB90DC6830C0C620C5160993F4DE3D4B"
  })
});

export const F3_MANUSCRIPT_EDITOR_MINIMUM_DESKTOP = Object.freeze({
  width: 1100,
  height: 720
});

export const F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS = Object.freeze({
  modalInset: "0px",
  modalWidthPolicy: "100vw",
  modalHeightPolicy: "100dvh",
  headerHeight: "64px",
  footerHeight: "72px",
  footerLeftPadding: "20px",
  footerRightPadding: "28px",
  leftPanelWidth: "320px",
  columnDividerWidth: "1px",
  mainBodyMinHeight: "584px",
  leftPanelPadding: "20px",
  rightPanelPadding: "18px",
  currentToolbarHeight: "96px",
  independentToolbarHeight: "54px",
  rightToolbarGap: "8px",
  modeToggleHeight: "42px",
  modeToggleRadius: "999px",
  actionButtonHeight: "40px",
  actionButtonRadius: "9px",
  actionButtonGap: "8px",
  editorMinHeight: "480px",
  editorHorizontalPadding: "16px",
  editorVerticalPadding: "2px",
  leftPanelOverflow: "auto",
  rightWorkspaceOverflow: "hidden",
  footerAlignment: "space-between"
});

export const F3_MANUSCRIPT_EDITOR_LAYOUT_CSS_VARIABLES = Object.freeze({
  "--f3-modal-inset": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.modalInset,
  "--f3-modal-width": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.modalWidthPolicy,
  "--f3-modal-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.modalHeightPolicy,
  "--f3-header-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.headerHeight,
  "--f3-footer-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.footerHeight,
  "--f3-footer-padding-left": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.footerLeftPadding,
  "--f3-footer-padding-right": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.footerRightPadding,
  "--f3-left-panel-width": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.leftPanelWidth,
  "--f3-column-divider-width": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.columnDividerWidth,
  "--f3-main-body-min-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.mainBodyMinHeight,
  "--f3-left-panel-padding": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.leftPanelPadding,
  "--f3-right-panel-padding": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.rightPanelPadding,
  "--f3-current-toolbar-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.currentToolbarHeight,
  "--f3-independent-toolbar-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.independentToolbarHeight,
  "--f3-right-toolbar-gap": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.rightToolbarGap,
  "--f3-mode-toggle-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.modeToggleHeight,
  "--f3-mode-toggle-radius": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.modeToggleRadius,
  "--f3-action-button-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.actionButtonHeight,
  "--f3-action-button-radius": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.actionButtonRadius,
  "--f3-action-button-gap": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.actionButtonGap,
  "--f3-editor-min-height": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.editorMinHeight,
  "--f3-editor-padding-x": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.editorHorizontalPadding,
  "--f3-editor-padding-y": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.editorVerticalPadding,
  "--f3-left-overflow": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.leftPanelOverflow,
  "--f3-right-overflow": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.rightWorkspaceOverflow,
  "--f3-footer-alignment": F3_MANUSCRIPT_EDITOR_LAYOUT_TOKENS.footerAlignment
});

export const F3_MANUSCRIPT_EDITOR_UI_FREEZE = Object.freeze({
  id: "LP12-4-A-F3",
  status: "CANDIDATE_PENDING_USER_ACCEPTANCE",
  layoutTokenStatus: "CANDIDATE_FROZEN_VALUES_PENDING_USER_ACCEPTANCE",
  futureVisibleUiModifications: "PROHIBITED_AFTER_USER_ACCEPTANCE"
});

export const F3_MANUSCRIPT_EDITOR_VISIBLE_COPY = Object.freeze({
  leftTitle: "结构化纲要",
  sourceMode: "原文",
  previewMode: "预览",
  currentToolbarActions: Object.freeze(["插入模板", "插入上下文摘要"]),
  currentManuscript: "当前文稿：",
  currentFooterActions: Object.freeze([
    "打开文稿",
    "切换文稿",
    "重新加载",
    "另存为",
    "保存文稿",
    "取消"
  ]),
  independentFooterActions: Object.freeze(["重新加载", "另存为", "保存文稿", "取消"]),
  missingSummaryValue: "未设置",
  missingEntityTitle: "未命名",
  missingFileName: "未选择",
  independentSuffix: "（独立编辑）"
});

export type ManuscriptEditorFooterActionSlot = "open" | "switch" | "reload" | "save-as";

export const F3_MANUSCRIPT_EDITOR_VARIANT_REGISTRY = Object.freeze({
  current: Object.freeze({
    id: "COMPACT_FULL_EDITOR",
    columnCount: 2,
    showStructuredSummary: true,
    showTemplate: true,
    showContext: true,
    showCurrentManuscript: true,
    footerSlots: Object.freeze(["open", "switch", "reload", "save-as", "save", "cancel"])
  }),
  independent: Object.freeze({
    id: "SIMPLIFIED_PURE_FILE_EDITOR",
    columnCount: 1,
    showStructuredSummary: false,
    showTemplate: false,
    showContext: false,
    showCurrentManuscript: false,
    footerSlots: Object.freeze(["reload", "save-as", "save", "cancel"])
  })
});

export const F3_MANUSCRIPT_EDITOR_TITLE_REGISTRY = Object.freeze({
  "experiment:primary": "实验记录",
  "experimentRun:primary": "实验运行记录",
  "literature:literature_outline": "文献纲要",
  "literature:dedicated_notes": "文献专属笔记",
  "review:primary": "复盘记录",
  "resultItem:primary": "结果资产",
  "finding:primary": "关键发现",
  "outputCandidate:primary": "候选成果",
  "outputGap:primary": "成果缺口",
  "researchOutput:primary": "正式成果"
} as const);

export function resolveF3ManuscriptEditorWindowTitle(
  identity: ManuscriptOutlineDescriptorLookupIdentity,
  entryKind: ManuscriptSegmentEntryKind,
  translate: (source: string) => string
) {
  const base = F3_MANUSCRIPT_EDITOR_TITLE_REGISTRY[
    `${identity.ownerType}:${identity.channel}` as keyof typeof F3_MANUSCRIPT_EDITOR_TITLE_REGISTRY
  ] ?? "文稿编辑器";
  return entryKind === "independent"
    ? `${translate(base)}${translate("（独立编辑）")}`
    : translate(base);
}

export function resolveF3RightManuscriptTitle(
  entityTitle: string | null | undefined,
  translate: (source: string) => string
) {
  return entityTitle?.trim() || translate("未命名");
}

export function resolveF3StructuredSummaryValue(
  value: string | null | undefined,
  translate: (source: string) => string
) {
  const normalized = value?.trim() ?? "";
  if (!normalized || ["未填写", "未设置", "Not set", "Unset", "—", "-"].includes(normalized)) {
    return translate("未设置");
  }
  return normalized;
}

export function classifyF3FooterActionSlot(
  action: Readonly<{ key: string; label: string; intent?: "save-as" }>,
  translate: (source: string) => string
): ManuscriptEditorFooterActionSlot | undefined {
  if (action.intent === "save-as") return "save-as";
  const normalizedKey = action.key.toLowerCase();
  if (normalizedKey.includes("switch")) return "switch";
  if (normalizedKey.includes("reload")) return "reload";
  if (normalizedKey.includes("open")) return "open";
  if (action.label === translate("打开文稿")) return "open";
  if (action.label === translate("切换文稿")) return "switch";
  if (action.label === translate("重新加载")) return "reload";
  return undefined;
}
