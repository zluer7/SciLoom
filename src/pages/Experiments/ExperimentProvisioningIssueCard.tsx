import type { Language } from "../../i18n/translations";
import { nonPlanningUi } from "../../i18n/nonPlanningI18n";
import type { ExperimentManuscriptProvisioningIssue } from "../../types/experimentProvisioning";

interface ExperimentProvisioningIssueCardProps {
  issue: ExperimentManuscriptProvisioningIssue;
  language: Language;
  pending?: boolean;
  onRecover?: () => void;
}

export function ExperimentProvisioningIssueCard({
  issue,
  language,
  pending = false,
  onRecover
}: ExperimentProvisioningIssueCardProps) {
  const ui = (source: string) => nonPlanningUi(language, source);
  const summary = issue.causeCode === "PATH_TOO_LONG"
    ? ui("当前文稿根目录与课题目录组合超过安全路径预算。请调整正式文稿根目录或课题命名策略。")
    : ui("文稿工作区仍未完成，请查看错误分类后重试。");
  const canRecover = issue.retryable && issue.recoverability === "retry" && Boolean(onRecover);

  return (
    <div className="experiment-empty-box" role="status">
      <strong>{ui("文稿工作区待恢复")}</strong>
      <p>{summary}</p>
      <dl>
        <div>
          <dt>{ui("阶段")}</dt>
          <dd>{issue.stage}</dd>
        </div>
        <div>
          <dt>{ui("错误分类")}</dt>
          <dd>{issue.code}</dd>
        </div>
        {issue.causeCode ? (
          <div>
            <dt>{ui("原因")}</dt>
            <dd>{issue.causeCode}</dd>
          </div>
        ) : null}
        <div>
          <dt>{ui("元数据类型")}</dt>
          <dd>{issue.metadataKind}</dd>
        </div>
        <div>
          <dt>{ui("操作号")}</dt>
          <dd>{issue.operationId}</dd>
        </div>
        <div>
          <dt>{ui("恢复建议")}</dt>
          <dd>{issue.recoverability}</dd>
        </div>
        {issue.completedSteps.length ? (
          <div>
            <dt>{ui("已完成步骤")}</dt>
            <dd>{issue.completedSteps.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      {canRecover ? (
        <div className="button-row">
          <button type="button" disabled={pending} onClick={onRecover}>
            {pending ? ui("正在准备文稿…") : ui("重试准备文稿")}
          </button>
        </div>
      ) : (
        <p>{ui("当前状态不可直接重试，请保留以上诊断信息。")}</p>
      )}
    </div>
  );
}
