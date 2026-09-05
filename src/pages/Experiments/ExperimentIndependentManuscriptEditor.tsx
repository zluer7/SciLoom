import { LazyManuscriptSegmentEditorWindow } from "../../components/common/LazyManuscriptSegmentEditorWindow";
import type { MarkdownEditorContextItem } from "../../types/markdownEditor";
import type { useExperimentManuscriptEditor } from "./useExperimentManuscriptEditor";
import { ExperimentManuscriptActionFeedback } from "./ExperimentManuscriptActionFeedback";

type ExperimentManuscriptEditorState = ReturnType<typeof useExperimentManuscriptEditor>;

export function ExperimentIndependentManuscriptEditor({
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
      isOpen={editor.independentOpen}
      entryKind="independent"
      descriptorLookupIdentity={{ ownerType: "experiment", channel: "primary" }}
      lifecycle={{
        participantId: `experiment-independent:${editor.independentSessionKey ?? "closed"}`,
        handle: editor.independentSessionKey ?? "closed",
        presentationEpoch: editor.independentPresentationEpoch,
        readSession: editor.readIndependentSession
      }}
      contentIdentity={editor.independentContentIdentity}
      entityTitle={entityTitle}
      readonlyContextItems={outlineItems}
      floatingFeedbackContent={(
        <ExperimentManuscriptActionFeedback
          result={editor.independentActionResult}
          ui={ui}
          onDismiss={editor.dismissIndependentActionResult}
        />
      )}
      saveLabel={ui("保存文稿")}
      cancelLabel={ui("取消")}
      dirtyLabel={ui("有未保存更改")}
      unsavedChangesTitle={ui("当前文稿有未保存更改")}
      unsavedChangesLabel={ui("关闭前，请选择保存更改、放弃更改或取消关闭。")}
      saveChangesLabel={ui("保存并关闭")}
      discardChangesLabel={ui("放弃更改")}
      continueEditingLabel={ui("取消")}
      saveFailedLabel={ui("实验文稿保存失败。")}
      footerLeadingActions={[
        {
          key: "experiment-reload-independent-manuscript",
          label: ui("重新加载"),
          disabled: editor.independentBusy,
          onClick: () => void editor.reloadIndependent(
            editor.readIndependentSession()?.draftRawText ?? ""
          )
        },
        {
          key: "experiment-save-independent-manuscript-as",
          intent: "save-as",
          label: ui("另存为"),
          disabled: editor.independentBusy || editor.independentReadOnly,
          onClick: (snapshot) => editor.saveIndependentAs(snapshot)
        }
      ]}
      disabled={editor.independentReadOnly || Boolean(editor.choiceDialog)}
      onCancel={() => void editor.closeIndependent()}
      onClose={() => void editor.closeIndependent()}
    />
  );
}
