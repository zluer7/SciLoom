import { lazy } from "react";
import { LazyComponentBoundary } from "./LazyComponentBoundary";
import type { ManuscriptSegmentEditorWindowProps } from "./ManuscriptSegmentEditorWindow";

export type { MarkdownEditorContextItem } from "../../types/markdownEditor";

const ManuscriptSegmentEditorWindow = lazy(async () => ({
  default: (await import("./ManuscriptSegmentEditorWindow")).ManuscriptSegmentEditorWindow
}));

export function LazyManuscriptSegmentEditorWindow(props: ManuscriptSegmentEditorWindowProps) {
  if (!props.isOpen) return null;
  return (
    <LazyComponentBoundary
      loadingMessage="正在加载分段文稿编辑器…"
      errorMessage="分段文稿编辑器加载失败，请重试。"
      retryLabel="重试"
      resetKey={`${props.contentIdentity ?? props.lifecycle.handle}:${String(props.isOpen)}`}
    >
      <ManuscriptSegmentEditorWindow {...props} />
    </LazyComponentBoundary>
  );
}
