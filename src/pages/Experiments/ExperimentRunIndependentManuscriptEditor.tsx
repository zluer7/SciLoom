import { LazyManuscriptSegmentEditorWindow } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import type { MarkdownEditorContextItem } from "../../types/markdownEditor";
import type { useExperimentRunManuscriptEditor } from "./useExperimentRunManuscriptEditor";

type EditorState = ReturnType<typeof useExperimentRunManuscriptEditor>;

function ActionFeedback({ editor }: { editor: EditorState }) {
  const result = editor.independentActionResult;
  if (!result) return null;
  return (
    <section role={result.severity === "error" ? "alert" : "status"} className={`experiment-manuscript-action-feedback experiment-manuscript-action-feedback--compact experiment-manuscript-action-feedback--${result.severity}`}>
      <span>{result.message}</span>
      <button type="button" aria-label="关闭" onClick={editor.dismissIndependentActionResult}>×</button>
    </section>
  );
}

export function ExperimentRunIndependentManuscriptEditor({
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
  const session = editor.independentSession;
  const readOnly = session?.accessMode === "read-only";
  const parentDeleted =
    session?.error?.causeCode === "PARENT_DELETED" ||
    session?.targetSnapshot?.lifecycleRevision?.includes("parent-deleted");
  const ownerDeleted =
    session?.error?.causeCode === "RUN_DELETED" ||
    session?.targetSnapshot?.lifecycleRevision?.includes("owner-deleted");
  const readOnlyNotice = parentDeleted
    ? ui("所属实验已删除；所选 Run 文稿仅可读取和重新加载。")
    : ownerDeleted
      ? ui("当前 Run 已删除；所选文稿仅可读取和重新加载。")
      : undefined;
  return (
    <LazyManuscriptSegmentEditorWindow
      isOpen={editor.independentOpen}
      entryKind="independent"
      descriptorLookupIdentity={{ ownerType: "experimentRun", channel: "primary" }}
      lifecycle={{
        participantId: `experiment-run-independent:${editor.independentSessionKey ?? "closed"}`,
        handle: editor.independentSessionKey ?? "closed",
        presentationEpoch: editor.independentPresentationEpoch,
        readSession: editor.readIndependentSession
      }}
      contentIdentity={editor.independentContentIdentity}
      entityTitle={entityTitle}
      readonlyContextItems={outlineItems}
      headerNotice={readOnlyNotice}
      floatingFeedbackContent={<ActionFeedback editor={editor} />}
      saveLabel={ui("保存文稿")}
      cancelLabel={ui("取消")}
      closeLabel={ui("关闭")}
      dirtyLabel={ui("有未保存更改")}
      saveFailedLabel={ui("Run 文稿保存失败。")}
      footerLeadingActions={[
        {
          key: "experiment-run-reload-independent",
          label: ui("重新加载"),
          disabled: editor.busy,
          onClick: () => void editor.reloadIndependent(
            editor.readIndependentSession()?.draftRawText ?? ""
          )
        },
        {
          key: "experiment-run-save-independent-as",
          intent: "save-as",
          label: ui("另存为"),
          disabled: editor.busy || Boolean(readOnly),
          onClick: (snapshot) => editor.saveIndependentAs(snapshot)
        }
      ]}
      disabled={Boolean(editor.choiceDialog)}
      draftReadOnly={Boolean(readOnly)}
      saveDisabled={Boolean(readOnly)}
      onCancel={() => void editor.closeIndependent()}
      onClose={() => void editor.closeIndependent()}
    />
  );
}
