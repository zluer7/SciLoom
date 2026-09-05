import { useEffect, useMemo, useState } from "react";
import type { AIContextPackage, AIPromptPackage, AIResearchObjectType } from "../../types/aiContext";
import { buildAIContextLevelViewerProjection } from "../../services/aiContextPreviewDisplayService";
import type { AIContextViewerProjectionItem } from "../../services/aiContextPreviewDisplayService";

export type AIContextContentMode = "view" | "edit";

type AIContextPreviewPanelProps = {
  contextPackage: AIContextPackage;
  promptPackage?: AIPromptPackage | null;
  contextMarkdown: string;
  defaultContextMarkdown: string;
  isContextModified: boolean;
  disabled: boolean;
  editingDisabled?: boolean;
  mode: AIContextContentMode;
  onDirtyChange?: (dirty: boolean) => void;
  onEdit: () => void;
  onReselect: () => void;
  onSaveContext: (contextMarkdown: string) => void;
  onCancelEdit: () => void;
  onConfirm: () => void;
};

function researchObjectLabel(objectType: AIResearchObjectType): string {
  if (objectType === "route") return "研究路线";
  if (objectType === "task") return "研究任务";
  if (objectType === "review") return "复盘";
  if (objectType === "experiment") return "实验";
  if (objectType === "experimentRun") return "实验运行";
  if (objectType === "literature") return "文献";
  if (objectType === "resultItem") return "结果资产";
  if (objectType === "finding") return "关键发现";
  if (objectType === "outputCandidate") return "候选成果";
  if (objectType === "outputGap") return "成果缺口";
  return "正式成果";
}

function ContextObjectCard({ item }: { item: AIContextViewerProjectionItem }) {
  const hasSummary = item.summary.trim().length > 0;
  return (
    <article data-context-item-id={item.identity}>
      <div className="ai-context-preview__item-heading">
        <span>{item.sectionTitle}</span>
        <strong>{item.title}</strong>
      </div>
      {hasSummary ? <p className="ai-context-preview__item-summary">{item.summary}</p> : null}
    </article>
  );
}

export function AIContextPreviewPanel({
  contextPackage,
  promptPackage,
  contextMarkdown,
  defaultContextMarkdown,
  isContextModified,
  disabled,
  editingDisabled = false,
  mode,
  onDirtyChange,
  onEdit,
  onReselect,
  onSaveContext,
  onCancelEdit,
  onConfirm
}: AIContextPreviewPanelProps) {
  const [draftContext, setDraftContext] = useState(contextMarkdown);
  const researchObjects = contextPackage.researchObjects ?? [];
  const materials = contextPackage.materialDecisions ?? [];
  const warnings = promptPackage?.warnings ?? contextPackage.warnings ?? [];
  const editing = mode === "edit";
  const dirty = editing && draftContext !== contextMarkdown;
  const levelProjection = useMemo(
    () => buildAIContextLevelViewerProjection(contextPackage),
    [contextPackage]
  );
  const providerContextMatch = promptPackage
    ? promptPackage.providerPromptEnvelope.researchContext === contextMarkdown
    : null;
  const promptViewerSameSnapshot = promptPackage
    ? providerContextMatch &&
      promptPackage.contextPackageId === contextPackage.id &&
      promptPackage.contextPackageVersion === contextPackage.version &&
      promptPackage.contextReviewFingerprint === contextPackage.reviewFingerprint
    : null;

  useEffect(() => {
    setDraftContext(contextMarkdown);
  }, [contextMarkdown, contextPackage.id]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function cancelEditing() {
    setDraftContext(contextMarkdown);
    onDirtyChange?.(false);
    onCancelEdit();
  }

  function saveEditing() {
    onSaveContext(draftContext);
    onDirtyChange?.(false);
  }

  function restoreDefault() {
    setDraftContext(defaultContextMarkdown);
    onDirtyChange?.(defaultContextMarkdown !== contextMarkdown);
  }

  return (
    <section
      className="ai-context-preview"
      aria-label={editing ? "编辑上下文内容" : "查看上下文内容"}
      data-context-content-state={editing ? "C" : "B"}
      data-context-editor-dirty={dirty ? "true" : "false"}
      data-context-package-id={contextPackage.id}
      data-context-package-version={contextPackage.version}
      data-context-review-fingerprint={contextPackage.reviewFingerprint}
      data-prompt-context-package-id={promptPackage?.contextPackageId}
      data-provider-context-match={providerContextMatch === null ? "not-built" : String(providerContextMatch)}
      data-prompt-viewer-same-snapshot={promptViewerSameSnapshot === null
        ? "not-built"
        : String(promptViewerSameSnapshot)}
    >
      <header className="ai-context-preview__header">
        <div>
          <strong>{contextPackage.scope.label || "当前课题"}</strong>
          <p>{researchObjects.length} 个研究对象 · {materials.length} 份关联文档</p>
        </div>
        <span className={isContextModified ? "ai-context-preview__modified" : ""}>
          {isContextModified ? "已保存编辑" : "默认内容"}
        </span>
      </header>

      <div className="ai-context-preview__workspace">
        <aside className="ai-context-preview__source-list" aria-label="已选择对象列表">
          <strong>已选择对象列表</strong>
          <div className="ai-context-preview__source-items">
            {researchObjects.map((object) => (
              <article key={`${object.objectType}:${object.objectId}`}>
                <span>{researchObjectLabel(object.objectType)}</span>
                <strong>{object.label}</strong>
              </article>
            ))}
            {materials.map((material) => (
              <article key={`material:${material.fileRefId}`}>
                <span>关联文档</span>
                <strong>{material.displayName}</strong>
              </article>
            ))}
            {researchObjects.length === 0 && materials.length === 0 ? (
              <p>当前仅使用课题基础信息。</p>
            ) : null}
          </div>
        </aside>

        <main className="ai-context-preview__outbound" aria-label="上下文内容">
          <div className="ai-context-preview__outbound-heading">
            <strong>上下文内容</strong>
            <span>编辑仅影响本次对话上下文，不会覆盖科研记录或原始材料。</span>
          </div>
          {editing ? (
            <div className="ai-context-preview__editor">
              <textarea
                aria-label="编辑上下文内容"
                disabled={disabled}
                onChange={(event) => setDraftContext(event.target.value)}
                spellCheck={false}
                value={draftContext}
              />
            </div>
          ) : isContextModified ? (
            <pre className="ai-context-preview__human-markdown">{contextMarkdown}</pre>
          ) : (
            <div className="ai-context-preview__levels" aria-label="按 L1-L4 分级的上下文">
              {levelProjection.levelGroups.map((group) => (
                <section
                  aria-label={`${group.label} 上下文`}
                  className="ai-context-preview__level"
                  data-context-level={group.label}
                  key={group.label}
                >
                  <header>
                    <strong>{group.label}</strong>
                    <span>{group.items.length} 项</span>
                  </header>
                  <div>
                    {group.items.map((item) => (
                      <ContextObjectCard item={item} key={item.identity} />
                    ))}
                  </div>
                </section>
              ))}
              {levelProjection.unclassifiedItems.length > 0 ? (
                <section
                  aria-label="未分级上下文"
                  className="ai-context-preview__level ai-context-preview__level--unclassified"
                  data-context-level="unclassified"
                >
                  <header>
                    <strong>未分级</strong>
                    <span>缺少可信层级元数据</span>
                  </header>
                  <div>
                    {levelProjection.unclassifiedItems.map((item) => (
                      <ContextObjectCard item={item} key={item.identity} />
                    ))}
                  </div>
                </section>
              ) : null}
              {levelProjection.levelGroups.length === 0 && levelProjection.unclassifiedItems.length === 0 ? (
                <p className="ai-context-preview__levels-empty">当前 ContextPackage 没有可展示对象。</p>
              ) : null}
            </div>
          )}
          {warnings.length > 0 ? (
            <details className="ai-context-preview__warnings">
              <summary>查看 {warnings.length} 条构建提示</summary>
              <ul aria-label="上下文提示">
                {warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>{warning.message}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </main>
      </div>

      <footer className="ai-context-preview__actions">
        {editing ? (
          <>
            <button disabled={disabled || defaultContextMarkdown === draftContext} onClick={restoreDefault} type="button">
              恢复默认内容
            </button>
            <button disabled={disabled} onClick={cancelEditing} type="button">取消</button>
            <button className="is-primary" disabled={disabled || !dirty} onClick={saveEditing} type="button">保存</button>
          </>
        ) : (
          <>
            <button disabled={disabled} onClick={onReselect} type="button">重新选择对象</button>
            <button className="ai-context-preview__edit" disabled={disabled || editingDisabled} onClick={onEdit} type="button">
              编辑内容
            </button>
            <button className="is-primary" disabled={disabled} onClick={onConfirm} type="button">确认</button>
          </>
        )}
      </footer>
    </section>
  );
}
