import { LazyManuscriptSegmentEditorWindow } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import type { MarkdownEditorContextItem } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import type { useExperimentRunManuscriptEditor } from "./useExperimentRunManuscriptEditor";

type EditorState = ReturnType<typeof useExperimentRunManuscriptEditor>;

function ActionFeedback({ editor }: { editor: EditorState }) {
  const result = editor.currentActionResult;
  if (!result) return null;
  return (
    <section role={result.severity === "error" ? "alert" : "status"} className={`experiment-manuscript-action-feedback experiment-manuscript-action-feedback--compact experiment-manuscript-action-feedback--${result.severity}`}>
      <span>{result.message}</span>
      <button type="button" aria-label="关闭" onClick={editor.dismissCurrentActionResult}>×</button>
    </section>
  );
}

function RecoveryBanner({ editor, ui }: { editor: EditorState; ui(source: string): string }) {
  const recovery = editor.switchRecovery;
  if (!recovery) return null;
  return (
    <section role="status" className="experiment-manuscript-action-feedback experiment-manuscript-action-feedback--warning">
      <span>
        {ui("上一次正式文稿切换尚未完成，请继续恢复或重新验证。")}
        {` ${ui("原当前文稿")}：${recovery.oldCurrentFileName}；${ui("目标文稿")}：${recovery.targetFileName}。`}
        {` ${ui("默认文稿保持不变，恢复过程不会写入目标文稿。")}`}
      </span>
      <button type="button" disabled={editor.busy} onClick={() => void editor.continueSwitchRecovery()}>
        {ui("继续恢复")}
      </button>
      {recovery.phase === "prepared" ? (
        <button type="button" disabled={editor.busy} onClick={() => void editor.safeCancelSwitchRecovery()}>
          {ui("安全取消")}
        </button>
      ) : null}
      <button type="button" onClick={editor.dismissSwitchRecovery}>{ui("关闭")}</button>
    </section>
  );
}

function SaveAsRecoveryBanner({ editor, ui }: { editor: EditorState; ui(source: string): string }) {
  const recovery = editor.saveAsRecovery;
  if (!recovery) return null;
  return (
    <section role="status" className="experiment-manuscript-action-feedback experiment-manuscript-action-feedback--warning">
      <span>{`${ui("另存为操作尚未完成")}：${recovery.targetFileName}。${ui("源文件、当前文稿和默认文稿保持不变。")}`}</span>
      <button type="button" disabled={editor.busy} onClick={() => void editor.continueSaveAsRecovery()}>
        {ui("继续恢复")}
      </button>
      {recovery.phase === "prepared" ? (
        <button type="button" disabled={editor.busy} onClick={() => void editor.safeCancelSaveAsRecovery()}>
          {ui("安全取消")}
        </button>
      ) : null}
    </section>
  );
}

export function ExperimentRunCurrentManuscriptEditor({
  editor,
  entityTitle,
  outlineItems,
  ui
}: {
  editor: EditorState;
  entityTitle?: string | null;
  outlineItems: MarkdownEditorContextItem[];
  ui(source: string): string;
}) {
  const session = editor.mainSession;
  const recoveryReadOnly = Boolean(editor.switchRecovery);
  const readOnly = session?.accessMode === "read-only";
  const parentDeleted =
    session?.error?.causeCode === "PARENT_DELETED" ||
    session?.targetSnapshot?.lifecycleRevision?.includes("parent-deleted");
  const ownerDeleted =
    session?.error?.causeCode === "RUN_DELETED" ||
    session?.targetSnapshot?.lifecycleRevision?.includes("owner-deleted");
  const readOnlyNotice = parentDeleted
    ? ui("所属实验已删除；当前 Run 文稿仅可读取和重新加载。")
    : ownerDeleted
      ? ui("当前 Run 已删除；文稿仅可读取和重新加载。")
      : recoveryReadOnly
        ? ui("正式文稿切换正在恢复；完成处理前文稿暂时只读。")
        : undefined;
  return (
    <LazyManuscriptSegmentEditorWindow
      isOpen={editor.mainOpen}
      entryKind="current"
      descriptorLookupIdentity={{ ownerType: "experimentRun", channel: "primary" }}
      lifecycle={{
        participantId: `experiment-run-current:${editor.mainSessionKey ?? "closed"}`,
        handle: editor.mainSessionKey ?? "closed",
        presentationEpoch: editor.mainPresentationEpoch,
        readSession: editor.readCurrentSession
      }}
      contentIdentity={editor.mainContentIdentity}
      entityTitle={entityTitle}
      readonlyContextItems={outlineItems}
      leftPanelTitle={ui("结构化纲要")}
      contextInsertion={{
        label: ui("插入上下文结构"),
        isAvailable: !editor.busy && !readOnly && !recoveryReadOnly,
        resolveMarkdown: editor.resolveContextSummaryMarkdown
      }}
      headerNotice={readOnlyNotice}
      recoveryRailContent={editor.switchRecovery || editor.saveAsRecovery ? (
        <>
          <RecoveryBanner editor={editor} ui={ui} />
          <SaveAsRecoveryBanner editor={editor} ui={ui} />
        </>
      ) : undefined}
      floatingFeedbackContent={<ActionFeedback editor={editor} />}
      saveLabel={ui("保存文稿")}
      cancelLabel={ui("取消")}
      closeLabel={ui("关闭")}
      dirtyLabel={ui("有未保存更改")}
      saveFailedLabel={ui("Run 文稿保存失败。")}
      footerLeadingActions={[
        {
          key: "experiment-run-open-document",
          label: ui("打开文稿"),
          disabled: editor.busy,
          onClick: () => void editor.openDocument()
        },
        {
          key: "experiment-run-switch-document",
          label: ui("切换文稿"),
          disabled: editor.busy || Boolean(readOnly || recoveryReadOnly),
          onClick: () => void editor.switchDocument()
        },
        {
          key: "experiment-run-reload-current",
          label: ui("重新加载"),
          disabled: editor.busy,
          onClick: () => void editor.reloadCurrent(
            editor.readCurrentSession()?.draftRawText ?? ""
          )
        },
        {
          key: "experiment-run-save-as-current",
          intent: "save-as",
          label: ui("另存为"),
          disabled: editor.busy || Boolean(readOnly || recoveryReadOnly || editor.saveAsRecovery),
          onClick: (snapshot) => editor.saveCurrentAs(snapshot)
        }
      ]}
      disabled={Boolean(editor.choiceDialog)}
      draftReadOnly={Boolean(readOnly || recoveryReadOnly)}
      saveDisabled={Boolean(readOnly || recoveryReadOnly)}
      onCancel={() => void editor.closeCurrent()}
      onClose={() => void editor.closeCurrent()}
    />
  );
}
