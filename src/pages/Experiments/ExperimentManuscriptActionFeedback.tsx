import type { ExperimentManuscriptActionResult } from "./useExperimentManuscriptEditor";

type Ui = (source: string) => string;

export function ExperimentManuscriptActionFeedback({
  result,
  ui,
  onDismiss
}: {
  result: ExperimentManuscriptActionResult | null;
  ui: Ui;
  onDismiss(): void;
}) {
  if (!result) return null;
  return (
    <section
      className={`experiment-manuscript-action-feedback experiment-manuscript-action-feedback--compact experiment-manuscript-action-feedback--${result.severity}`}
      role={result.severity === "error" ? "alert" : "status"}
      aria-live={result.severity === "error" ? "assertive" : "polite"}
    >
      <div>
        <strong>
          {result.action === "switch"
            ? ui("切换文稿")
            : result.action === "save"
              ? ui("保存文稿")
              : result.action === "reload"
                ? ui("重新加载")
                : ui("打开文稿")}
        </strong>
        <span>{result.message}</span>
        {result.targetFileName ? (
          <small>{ui("目标文稿")}：{result.targetFileName}</small>
        ) : null}
      </div>
      <button type="button" aria-label={ui("关闭操作结果")} onClick={onDismiss}>
        ×
      </button>
    </section>
  );
}
