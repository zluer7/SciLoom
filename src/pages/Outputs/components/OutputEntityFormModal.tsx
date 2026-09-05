import type { FormEvent, ReactNode } from "react";
import type { Language } from "../../../i18n/translations";
import type { OutputSourceSummary } from "../../../types/outputConversion";
import type {
  OutputEntityLayer,
  OutputEntityListItemDto
} from "../../../types/outputSelector";
import type { StructuredSummary } from "../../../types/outputStructuredSummary";
import { OutputSourceManager } from "./OutputSourceManager";
import { DataClearFooterRow } from "../../../components/common/DataClearRow";

export type OutputEntityFormMode = "create" | "edit";

export type OutputEntityFormDraft = {
  mode: OutputEntityFormMode;
  layer: OutputEntityLayer;
  id?: string;
  title: string;
  description: string;
  entityType: string;
  status: string;
  confidence: string;
  maturity: string;
  priority: string;
  resultSummary: string;
  value: string;
  unit: string;
  candidateId: string;
  usableForPaper: boolean;
  researchTraceDisplayChecked: boolean;
  structuredSummary: StructuredSummary;
};

type OutputEntityFormModalProps = {
  draft: OutputEntityFormDraft;
  language: Language;
  projectId: string;
  projectName: string;
  candidates: OutputEntityListItemDto[];
  outputLists: Record<OutputEntityLayer, OutputEntityListItemDto[]>;
  sourceSummary: OutputSourceSummary | null;
  onSourcesChanged: () => Promise<void>;
  saving: boolean;
  error: string;
  onChange: (draft: OutputEntityFormDraft) => void;
  onSave: (draft: OutputEntityFormDraft) => Promise<void> | void;
  onClose: () => void;
  onDelete?: () => Promise<void> | void;
};

type Option = { value: string; zh: string; en: string };

const LAYER_NAMES: Record<OutputEntityLayer, { zh: string; en: string }> = {
  resultItem: { zh: "结果", en: "result" },
  finding: { zh: "关键发现", en: "finding" },
  outputCandidate: { zh: "候选成果", en: "output candidate" },
  outputGap: { zh: "成果缺口", en: "output gap" },
  researchOutput: { zh: "正式成果", en: "research output" }
};

const TYPE_OPTIONS: Record<OutputEntityLayer, Option[]> = {
  resultItem: [
    ["data", "数据", "Data"],
    ["figure", "图件", "Figure"],
    ["table", "表格", "Table"],
    ["metric", "指标", "Metric"],
    ["code", "代码", "Code"],
    ["model", "模型", "Model"],
    ["log", "日志", "Log"],
    ["text", "文本", "Text"],
    ["sample", "样品", "Sample"],
    ["case", "案例", "Case"],
    ["document", "文档", "Document"],
    ["other", "其他", "Other"]
  ].map(([value, zh, en]) => ({ value, zh, en })),
  finding: [
    ["phenomenon", "现象", "Phenomenon"],
    ["comparison", "对比", "Comparison"],
    ["method", "方法", "Method"],
    ["limitation", "局限", "Limitation"],
    ["evidence", "证据", "Evidence"],
    ["hypothesis", "假设", "Hypothesis"],
    ["negative_result", "负结果", "Negative result"],
    ["other", "其他", "Other"]
  ].map(([value, zh, en]) => ({ value, zh, en })),
  outputCandidate: [
    ["paper", "论文", "Paper"],
    ["patent", "专利", "Patent"],
    ["report", "报告", "Report"],
    ["dataset", "数据集", "Dataset"],
    ["software", "软件", "Software"],
    ["method", "方法", "Method"],
    ["model", "模型", "Model"],
    ["caseStudy", "案例研究", "Case study"],
    ["presentation", "汇报", "Presentation"],
    ["futureProject", "后续项目", "Future project"],
    ["other", "其他", "Other"]
  ].map(([value, zh, en]) => ({ value, zh, en })),
  outputGap: [
    ["data", "数据", "Data"],
    ["analysis", "分析", "Analysis"],
    ["validation", "验证", "Validation"],
    ["figure", "图件", "Figure"],
    ["theory", "理论", "Theory"],
    ["literature", "文献", "Literature"],
    ["writing", "写作", "Writing"],
    ["experiment", "实验", "Experiment"],
    ["code", "代码", "Code"],
    ["other", "其他", "Other"]
  ].map(([value, zh, en]) => ({ value, zh, en })),
  researchOutput: [
    ["figure", "图件", "Figure"],
    ["table", "表格", "Table"],
    ["dataset", "数据集", "Dataset"],
    ["result", "研究结果", "Result"],
    ["note", "笔记", "Note"],
    ["report", "报告", "Report"],
    ["paper_draft", "论文草稿", "Paper draft"],
    ["presentation", "汇报", "Presentation"],
    ["code", "代码", "Code"],
    ["other", "其他", "Other"]
  ].map(([value, zh, en]) => ({ value, zh, en }))
};

const STATUS_OPTIONS: Record<OutputEntityLayer, Option[]> = {
  resultItem: [
    ["pending_review", "待复核", "Pending review"],
    ["marked", "已标记", "Marked"],
    ["ignored", "已忽略", "Ignored"]
  ].map(([value, zh, en]) => ({ value, zh, en })),
  finding: [
    ["pending_confirmation", "待确认", "Pending confirmation"],
    ["confirmed", "已确认", "Confirmed"],
    ["needs_evidence", "需补证据", "Needs evidence"],
    ["abandoned", "已放弃", "Abandoned"]
  ].map(([value, zh, en]) => ({ value, zh, en })),
  outputCandidate: [
    ["pending_evaluation", "待评估", "Pending evaluation"],
    ["needs_gap_resolution", "需补缺口", "Needs gap resolution"],
    ["ready_for_formal", "可转正式成果", "Ready for research output"],
    ["converted", "已转化", "Converted"]
  ].map(([value, zh, en]) => ({ value, zh, en })),
  outputGap: [
    ["pending", "待处理", "Pending"],
    ["task_created", "已生成任务", "Task created"],
    ["route_feedback_created", "已反馈路线", "Route feedback created"],
    ["resolved", "已解决", "Resolved"],
    ["abandoned", "已放弃", "Abandoned"]
  ].map(([value, zh, en]) => ({ value, zh, en })),
  researchOutput: [
    ["draft", "草稿", "Draft"],
    ["organizing", "整理中", "Organizing"],
    ["archived", "已归档", "Archived"]
  ].map(([value, zh, en]) => ({ value, zh, en }))
};

const CONFIDENCE_OPTIONS: Option[] = [
  ["", "未设置", "Not set"],
  ["high", "高", "High"],
  ["medium", "中", "Medium"],
  ["low", "低", "Low"],
  ["uncertain", "不确定", "Uncertain"]
].map(([value, zh, en]) => ({ value, zh, en }));

const MATURITY_OPTIONS: Option[] = [
  ["", "未设置", "Not set"],
  ["high", "高", "High"],
  ["medium", "中", "Medium"],
  ["low", "低", "Low"],
  ["uncertain", "不确定", "Uncertain"]
].map(([value, zh, en]) => ({ value, zh, en }));

const CANDIDATE_MATURITY_OPTIONS = MATURITY_OPTIONS.filter(
  (option) => option.value !== "uncertain"
);

const PRIORITY_OPTIONS: Option[] = [
  ["", "未设置", "Not set"],
  ["high", "高", "High"],
  ["medium", "中", "Medium"],
  ["low", "低", "Low"]
].map(([value, zh, en]) => ({ value, zh, en }));

function text(language: Language, zh: string, en: string) {
  return language === "zh-CN" ? zh : en;
}

function optionLabel(language: Language, option: Option) {
  return language === "zh-CN" ? option.zh : option.en;
}

function titleFor(draft: OutputEntityFormDraft, language: Language) {
  const layerName = LAYER_NAMES[draft.layer];
  if (language === "zh-CN") {
    return `${draft.mode === "create" ? "新建" : "编辑"}${layerName.zh}`;
  }
  return `${draft.mode === "create" ? "Create" : "Edit"} ${layerName.en}`;
}

function fieldLabel(
  layer: OutputEntityLayer,
  key: string,
  language: Language
) {
  const labels: Record<OutputEntityLayer, Record<string, [string, string]>> = {
    resultItem: {
      summary: ["结果摘要", "Result summary"],
      keyPhenomenon: ["关键指标或现象", "Key metric or phenomenon"],
      conditionBrief: ["实验条件简述", "Condition brief"],
      initialJudgement: ["初步判断", "Initial judgement"],
      conversionValue: ["可转化价值", "Conversion value"],
      other: ["其他", "Other"]
    },
    finding: {
      content: ["发现内容", "Finding content"],
      supportingEvidence: ["支撑证据", "Supporting evidence"],
      noveltyDifference: ["创新点或差异点", "Novelty or difference"],
      reliabilityJudgement: ["可靠性判断", "Reliability judgement"],
      boundaryOrMissingEvidence: ["适用边界或待补证据", "Boundary or missing evidence"],
      other: ["其他", "Other"]
    },
    outputCandidate: {
      coreClaim: ["核心主张", "Core claim"],
      outputType: ["成果类型", "Output type"],
      innovationContribution: ["创新贡献", "Innovation contribution"],
      evidenceSummary: ["证据链摘要", "Evidence-chain summary"],
      risksAndGaps: ["风险与缺口", "Risks and gaps"],
      other: ["其他", "Other"]
    },
    outputGap: {
      gapDescription: ["缺口描述", "Gap description"],
      gapType: ["缺口类型", "Gap type"],
      affectedObject: ["影响对象", "Affected object"],
      strengtheningPlan: ["补强方案", "Strengthening plan"],
      completionCriteria: ["完成标准", "Completion criteria"],
      other: ["其他", "Other"]
    },
    researchOutput: {
      summary: ["成果摘要", "Output summary"],
      outputType: ["成果类型", "Output type"],
      coreContribution: ["核心贡献", "Core contribution"],
      sourceChainSummary: ["来源链摘要", "Source-chain summary"],
      archiveUsage: ["归档说明或后续用途", "Archive note or follow-up use"],
      other: ["其他", "Other"]
    }
  };
  const label = labels[layer][key] ?? [key, key];
  return text(language, label[0], label[1]);
}

function SelectField({
  label,
  value,
  options,
  language,
  disabled,
  className,
  onChange
}: {
  label: string;
  value: string;
  options: Option[];
  language: Language;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`outputs-entity-form-field${className ? ` ${className}` : ""}`}>
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value || "empty"} value={option.value}>
            {optionLabel(language, option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function FieldRow({
  variant,
  children
}: {
  variant: "single" | "two" | "three" | "project-status-type";
  children: ReactNode;
}) {
  return <div className={`outputs-entity-form-row is-${variant}`}>{children}</div>;
}

export function OutputEntityFormModal({
  draft,
  language,
  projectId,
  projectName,
  candidates: _candidates,
  outputLists,
  sourceSummary,
  onSourcesChanged,
  saving,
  error,
  onChange,
  onSave,
  onClose,
  onDelete
}: OutputEntityFormModalProps) {
  const update = <K extends keyof OutputEntityFormDraft>(
    key: K,
    value: OutputEntityFormDraft[K]
  ) => onChange({ ...draft, [key]: value });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void onSave(draft);
  };

  const clearDraft = () => {
    onChange({
      ...draft,
      title: "",
      description: "",
      confidence: "",
      maturity: "",
      priority: "",
      resultSummary: "",
      researchTraceDisplayChecked: false,
      structuredSummary: draft.structuredSummary.map((section) => ({
        ...section,
        value: ""
      }))
    });
  };

  const typeLabel =
    draft.layer === "resultItem"
      ? text(language, "结果类型", "Result type")
      : draft.layer === "finding"
        ? text(language, "发现类型", "Finding type")
        : draft.layer === "outputGap"
          ? text(language, "缺口类型", "Gap type")
          : text(language, "成果类型", "Output type");

  const titleField = (
    <label className="outputs-entity-form-field is-title">
      <span>
        {draft.layer === "researchOutput"
          ? text(language, "成果名称", "Output name")
          : text(language, "标题", "Title")}
      </span>
      <input
        required
        value={draft.title}
        onChange={(event) => update("title", event.target.value)}
      />
    </label>
  );

  const projectField = (
    <label className="outputs-entity-form-field is-project">
      <span>{text(language, "所属课题", "Project")}</span>
      <input value={projectName} disabled />
    </label>
  );

  const statusField = (
    <SelectField
      label={text(language, "状态", "Status")}
      value={draft.status}
      options={STATUS_OPTIONS[draft.layer]}
      language={language}
      className="is-status"
      onChange={(value) => update("status", value)}
    />
  );

  const typeField = (
    <SelectField
      label={typeLabel}
      value={draft.entityType}
      options={TYPE_OPTIONS[draft.layer]}
      language={language}
      className="is-type"
      onChange={(value) => update("entityType", value)}
    />
  );

  const confidenceField = (
    <SelectField
      label={text(language, "置信度", "Confidence")}
      value={draft.confidence}
      options={CONFIDENCE_OPTIONS}
      language={language}
      className="is-confidence"
      onChange={(value) => update("confidence", value)}
    />
  );

  const maturityField = (
    <SelectField
      label={text(language, "成熟度", "Maturity")}
      value={draft.maturity}
      options={
        draft.layer === "outputCandidate"
          ? CANDIDATE_MATURITY_OPTIONS
          : MATURITY_OPTIONS
      }
      language={language}
      className="is-maturity"
      onChange={(value) => update("maturity", value)}
    />
  );

  const priorityField = (
    <SelectField
      label={text(language, "优先级", "Priority")}
      value={draft.priority}
      options={PRIORITY_OPTIONS}
      language={language}
      className="is-priority"
      onChange={(value) => update("priority", value)}
    />
  );

  const descriptionField = (
    <label className="outputs-entity-form-field is-description">
      <span>
        {draft.layer === "outputGap"
          ? text(language, "缺口描述", "Gap description")
          : text(language, "简要说明", "Description")}
      </span>
      <textarea
        className="semantic-textarea-compact-summary"
        rows={2}
        value={draft.description}
        onChange={(event) => update("description", event.target.value)}
      />
    </label>
  );

  const resultSummaryField = (
    <label className="outputs-entity-form-field is-description">
      <span>{text(language, "简要说明", "Brief note")}</span>
      <textarea
        className="semantic-textarea-compact-summary"
        rows={2}
        value={draft.resultSummary}
        onChange={(event) => update("resultSummary", event.target.value)}
      />
    </label>
  );

  const researchTraceDisplayField = (
      <label className="outputs-entity-form-field is-checkbox research-trace-preference-row">
        <span>
          <input
            type="checkbox"
            checked={draft.researchTraceDisplayChecked}
            onChange={(event) =>
              update("researchTraceDisplayChecked", event.target.checked)
            }
          />
          {text(language, "显示在课题研究脉络中", "Show in project research trace")}
        </span>
      </label>
  );

  function renderBasicFields() {
    if (draft.layer === "resultItem") {
      return (
        <>
          <FieldRow variant="single">{titleField}</FieldRow>
          <FieldRow variant="project-status-type">
            {projectField}
            {statusField}
            {typeField}
          </FieldRow>
          <FieldRow variant="single">{resultSummaryField}</FieldRow>
          <FieldRow variant="single">{researchTraceDisplayField}</FieldRow>
        </>
      );
    }
    if (draft.layer === "finding") {
      return (
        <>
          <FieldRow variant="single">{titleField}</FieldRow>
          <FieldRow variant="two">
            {projectField}
            {typeField}
          </FieldRow>
          <FieldRow variant="three">
            {statusField}
            {confidenceField}
            {maturityField}
          </FieldRow>
          <FieldRow variant="single">{descriptionField}</FieldRow>
          <FieldRow variant="single">{researchTraceDisplayField}</FieldRow>
        </>
      );
    }
    if (draft.layer === "outputCandidate") {
      return (
        <>
          <FieldRow variant="single">{titleField}</FieldRow>
          <FieldRow variant="two">
            {projectField}
            {typeField}
          </FieldRow>
          <FieldRow variant="three">
            {statusField}
            {priorityField}
            {maturityField}
          </FieldRow>
          <FieldRow variant="single">{descriptionField}</FieldRow>
          <FieldRow variant="single">{researchTraceDisplayField}</FieldRow>
        </>
      );
    }
    if (draft.layer === "outputGap") {
      return (
        <>
          <FieldRow variant="single">{titleField}</FieldRow>
          <FieldRow variant="two">
            {projectField}
            {typeField}
          </FieldRow>
          <FieldRow variant="two">
            {statusField}
            {priorityField}
          </FieldRow>
          <FieldRow variant="single">{descriptionField}</FieldRow>
          <FieldRow variant="single">{researchTraceDisplayField}</FieldRow>
        </>
      );
    }
    return (
      <>
        <FieldRow variant="single">{titleField}</FieldRow>
        <FieldRow variant="single">{projectField}</FieldRow>
        <FieldRow variant="two">
          {typeField}
          {statusField}
        </FieldRow>
        <FieldRow variant="single">{descriptionField}</FieldRow>
        <FieldRow variant="single">{researchTraceDisplayField}</FieldRow>
      </>
    );
  }

  return (
    <div className="modal-backdrop outputs-entity-form-backdrop" role="presentation">
      <section
        className="outputs-entity-form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="outputs-entity-form-title"
      >
        <form onSubmit={onSubmit}>
          <header className="outputs-entity-form-header">
            <h2 id="outputs-entity-form-title">{titleFor(draft, language)}</h2>
            <button type="button" className="outputs-entity-form-close" onClick={onClose}>
              {text(language, "关闭", "Close")}
            </button>
          </header>

          <div className="outputs-entity-form-scroll">
            <section className="outputs-entity-form-card">
              <h3>{text(language, "基础信息", "Basic information")}</h3>
              <div className={`outputs-entity-form-grid is-${draft.layer}`}>
                {renderBasicFields()}
              </div>
            </section>

            <OutputSourceManager
              ownerType={draft.layer}
              ownerId={draft.id}
              projectId={projectId}
              outputLists={outputLists}
              summary={sourceSummary}
              onSourcesChanged={onSourcesChanged}
            />

            <section className="outputs-entity-form-card">
              <h3>{text(language, "结构化纲要", "Structured outline")}</h3>
              <div className="outputs-entity-summary-form">
                {draft.structuredSummary.map((section, index) => (
                  <label className="outputs-entity-form-field" key={section.key}>
                    <span>{fieldLabel(draft.layer, section.key, language)}</span>
                    <textarea
                      className="semantic-textarea-structured"
                      rows={3}
                      value={section.value}
                      onChange={(event) =>
                        update(
                          "structuredSummary",
                          draft.structuredSummary.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, value: event.target.value } : item
                          )
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            </section>

            {error ? <div className="outputs-entity-form-error" role="alert">{error}</div> : null}

          </div>

          <DataClearFooterRow
            className="outputs-entity-form-footer"
            contextKey={`output:${draft.layer}:${draft.mode}:${draft.id ?? "new"}`}
            regionLabel={text(language, "数据清除", "Data clearing")}
            clearLabel={text(language, "清空", "Clear")}
            deleteLabel={text(language, "删除", "Delete")}
            onClear={clearDraft}
            onDelete={draft.mode === "edit" ? onDelete : undefined}
            clearDisabled={saving}
            deleteDisabled={saving}
          >
            <button type="submit" className="outputs-entity-form-save" disabled={saving}>
              {saving ? text(language, "保存中...", "Saving...") : text(language, "保存", "Save")}
            </button>
            <button type="button" className="outputs-entity-form-cancel" disabled={saving} onClick={onClose}>
              {text(language, "取消", "Cancel")}
            </button>
          </DataClearFooterRow>
        </form>
      </section>
    </div>
  );
}
