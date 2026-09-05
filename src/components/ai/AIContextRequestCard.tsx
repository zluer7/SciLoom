import type { AIContextRequest } from "../../types/aiContextRequest";

type AIContextRequestCardProps = {
  request: AIContextRequest;
  disabled: boolean;
  reviewReady: boolean;
  isReviewing: boolean;
  isDeciding: boolean;
  onApprove: () => void;
  onReject: () => void;
};

function compactIdentity(value: string | undefined): string {
  if (!value) return "—";
  return value.length <= 24 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function requestStateLabel(state: AIContextRequest["state"]): string {
  if (state === "PENDING") return "待处理";
  if (state === "APPROVED") return "已同意";
  if (state === "REJECTED") return "已拒绝";
  return "已失效";
}

function entityTypeLabel(entityType: string): string {
  const labels: Record<string, string> = {
    routeNode: "研究路线",
    task: "研究任务",
    review: "复盘",
    experiment: "实验",
    experimentRun: "实验运行",
    literature: "文献",
    resultItem: "结果资产",
    finding: "关键发现",
    outputCandidate: "候选成果",
    outputGap: "成果缺口",
    researchOutput: "正式成果"
  };
  return labels[entityType] ?? "研究对象";
}

export function AIContextRequestCard({
  request,
  disabled,
  reviewReady,
  isReviewing,
  isDeciding,
  onApprove,
  onReject
}: AIContextRequestCardProps) {
  const pending = request.state === "PENDING";
  return (
    <aside
      aria-label="AI 补充上下文请求"
      className="global-ai-chat-panel__context-request"
      data-context-request-id={request.id}
      data-context-request-state={request.state}
    >
      <div className="global-ai-chat-panel__context-request-heading">
        <strong>AI 请求补充上下文</strong>
        <span>{requestStateLabel(request.state)}</span>
      </div>
      <p>{request.reason}</p>
      <ul>
        {request.reviewedCandidates.map((candidate) => (
          <li key={`${candidate.refKind}:${candidate.refId}:${candidate.contributionKind}`}>
            <span>{candidate.label}</span>
            <small>
              {entityTypeLabel(candidate.entityType)} · {candidate.contributionKind === "BODY_CONTENT" ? "正文内容" : "身份元数据"}
              {candidate.fileBodyAuthorizationRequired ? " · 需要本次单独授权文件正文" : ""}
              {candidate.entityType === "literature"
                ? ` · ${candidate.literatureProjectAssociationKind === "projectless"
                    ? "未归属课题"
                    : `课题 ${candidate.literatureCanonicalProjectId ?? "不可用"}`} · 仅元数据`
                : ""}
            </small>
          </li>
        ))}
      </ul>
      {pending ? (
        <>
          <p className="global-ai-chat-panel__context-request-safety">
            此请求不代表授权。继续前请先审阅刚构建的上下文内容。
          </p>
          <div className="global-ai-chat-panel__context-request-actions">
            <button disabled={disabled || isReviewing || isDeciding} onClick={onApprove} type="button">
              {isReviewing
                ? "正在构建审阅内容…"
                : reviewReady
                  ? "同意并继续"
                  : "审阅所需上下文"}
            </button>
            <button disabled={disabled || isReviewing || isDeciding} onClick={onReject} type="button">
              {isDeciding ? "正在拒绝…" : "拒绝"}
            </button>
          </div>
        </>
      ) : (
        <dl className="global-ai-chat-panel__context-request-receipt">
          <div><dt>处理结果</dt><dd>{request.decisionType ?? requestStateLabel(request.state)}</dd></div>
          <div><dt>来源调用</dt><dd>{compactIdentity(request.sourceCallAttemptId)}</dd></div>
          <div><dt>后续调用</dt><dd>{compactIdentity(request.followupCallAttemptId)}</dd></div>
          {request.decisionReason ? <div><dt>原因</dt><dd>{request.decisionReason}</dd></div> : null}
        </dl>
      )}
    </aside>
  );
}
