export function isManuscriptEditorDirty(state: {
  loadedContent: string;
  draftContent: string;
}) {
  return state.loadedContent !== state.draftContent;
}
