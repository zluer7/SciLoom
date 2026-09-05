import { LazyManuscriptSegmentEditorWindow } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import type { MarkdownEditorContextItem } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import type { useExperimentManuscriptEditor } from "./useExperimentManuscriptEditor";
import { ExperimentManuscriptActionFeedback } from "./ExperimentManuscriptActionFeedback";

type ExperimentManuscriptEditorState = ReturnType<typeof useExperimentManuscriptEditor>;

function ExperimentFormalSwitchRecoveryRail({
  editor,
  ui
}: {
  editor: ExperimentManuscriptEditorState;
  ui(source: string): string;
}) {
  const recovery = editor.switchRecovery;
  if (!recovery) return null;
  const canSafelyCancel =
    recovery.operationIdentityVerified &&
    recovery.phase === "prepared" &&
    !recovery.writebackVerified;
  const canContinue =
    recovery.operationIdentityVerified &&
    [
      "writeback_unknown",
      "writeback_applied",
      "db_commit_unknown",
      "db_committed",
      "activation_pending",
    ].includes(recovery.phase);
  return (
    <section
      className="experiment-manuscript-action-feedback experiment-manuscript-action-feedback--compact experiment-manuscript-action-feedback--warning"
      role="status"
      aria-live="polite"
    >
      <span>{ui("检测到尚未完成的文稿切换，需要先完成恢复处理。")}</span>
      <div className="button-row">
        {canContinue ? (
          <button
            type="button"
            disabled={editor.currentBusy}
            onClick={() => void editor.retrySwitchRecovery()}
          >
            {ui("继续恢复")}
          </button>
        ) : null}
        {canSafelyCancel ? (
          <button
            type="button"
            disabled={editor.currentBusy}
            onClick={() => void editor.cancelSwitchRecovery()}
          >
            {ui("安全取消")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function ExperimentCurrentManuscriptEditor({
  editor,
  entityTitle,
  outlineItems,
  ui
}: {
  editor: ExperimentManuscriptEditorState;
  entityTitle?: string | null;
  outlineItems: MarkdownEditorContextItem[];
  ui(source: string): string;
}) {
  return (
    <LazyManuscriptSegmentEditorWindow
      isOpen={editor.mainOpen}
      entryKind="current"
      descriptorLookupIdentity={{ ownerType: "experiment", channel: "primary" }}
      lifecycle={{
        participantId: `experiment-current:${editor.mainSessionKey ?? "closed"}`,
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
        isAvailable: !editor.mainReadOnly && !editor.currentBusy,
        resolveMarkdown: editor.resolveContextSummaryMarkdown
      }}
      saveLabel={ui("保存文稿")}
      cancelLabel={ui("取消")}
      dirtyLabel={ui("有未保存更改")}
      unsavedChangesTitle={ui("当前文稿有未保存更改")}
      unsavedChangesLabel={ui("关闭前，请选择保存更改、放弃更改或取消关闭。")}
      saveChangesLabel={ui("保存并关闭")}
      discardChangesLabel={ui("放弃更改")}
      continueEditingLabel={ui("取消")}
      saveFailedLabel={ui("实验文稿保存失败。")}
      recoveryRailContent={editor.switchRecovery ? (
        <ExperimentFormalSwitchRecoveryRail editor={editor} ui={ui} />
      ) : undefined}
      floatingFeedbackContent={(
        <ExperimentManuscriptActionFeedback
          result={editor.currentActionResult}
          ui={ui}
          onDismiss={editor.dismissCurrentActionResult}
        />
      )}
      footerLeadingActions={[
        {
          key: "experiment-open-manuscript",
          label: ui("打开文稿"),
          disabled: editor.currentBusy,
          onClick: () => void editor.openDocument()
        },
        {
          key: "experiment-switch-manuscript",
          label: ui("切换文稿"),
          disabled: editor.currentBusy,
          onClick: () => void editor.switchDocument()
        },
        {
          key: "experiment-reload-manuscript",
          label: ui("重新加载"),
          disabled: editor.currentBusy,
          onClick: () => void editor.reloadCurrent(
            editor.readCurrentSession()?.draftRawText ?? ""
          )
        },
        {
          key: "experiment-save-as-manuscript",
          intent: "save-as",
          label: ui("另存为"),
          disabled: editor.currentBusy,
          onClick: (snapshot) => editor.saveCurrentAs(snapshot)
        }
      ]}
      disabled={editor.mainReadOnly || Boolean(editor.choiceDialog)}
      onCancel={() => void editor.closeCurrent()}
      onClose={() => void editor.closeCurrent()}
    />
  );
}
