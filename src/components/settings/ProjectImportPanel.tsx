import { useRef, useState, type ChangeEvent } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { getDataSourceModeSnapshot } from "../../repositories/dataSourceMode";
import {
  IMPORT_V1_OBJECT_TYPES,
  PROJECT_IMPORT_V1_MAX_BYTES,
  preflightProjectImportV1,
  type ProjectImportV1PreflightResult
} from "../../services/projectImportV1Authority";
import {
  executeProjectImportV1,
  type ProjectImportV1ExecutionOutcome
} from "../../services/projectImportV1Service";

const EXTERNAL_AI_CONSTRAINT_PATH =
  "/sciloom-project-import-v1-external-ai-data-organization-constraint.md";

function displayType(type: (typeof IMPORT_V1_OBJECT_TYPES)[number]) {
  const labels: Record<(typeof IMPORT_V1_OBJECT_TYPES)[number], string> = {
    project: "Project",
    route: "Route",
    task: "Task",
    experiment: "Experiment",
    experimentRun: "ExperimentRun",
    literature: "Literature",
    review: "Review",
    resultItem: "ResultItem",
    finding: "Finding",
    outputCandidate: "OutputCandidate",
    outputGap: "OutputGap",
    researchOutput: "ResearchOutput"
  };
  return labels[type];
}

export function ProjectImportTechnicalDetails() {
  const { language } = useI18n();
  const zh = language === "zh-CN";

  return (
    <section className="project-import-v1__technical" aria-labelledby="project-import-technical-title">
      <h3 id="project-import-technical-title">
        {zh ? "导入 SciLoom Project 数据" : "Import SciLoom Project data"}
      </h3>
      <p>
        {zh
          ? "选择一个符合 Import v1 的 JSON 文件。每个文件始终创建一个全新 Project；不会更新、合并或去重已有对象。"
          : "Select one Import v1 JSON file. Each file always creates one new Project; existing objects are never updated, merged, or deduplicated."}
      </p>
      <p>
        <a
          href={EXTERNAL_AI_CONSTRAINT_PATH}
          download="SciLoom-Project-Import-v1-External-AI-Data-Organization-Constraint.md"
          data-testid="project-import-constraint-download"
        >
          {zh
            ? "下载给外部 AI 使用的完整数据整理约束"
            : "Download the complete data-organization constraint for an external AI"}
        </a>
      </p>
    </section>
  );
}

export function ProjectImportPanel() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [fileName, setFileName] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<ProjectImportV1PreflightResult | null>(null);
  const [reading, setReading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [outcome, setOutcome] = useState<ProjectImportV1ExecutionOutcome | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [canceled, setCanceled] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setOutcome(null);
    setCanceled(false);
    setSelectionError(null);
    setPreflight(null);
    setFileName(file?.name ?? null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setSelectionError(zh ? "请选择 .json 文件。" : "Select a .json file.");
      return;
    }
    if (file.size > PROJECT_IMPORT_V1_MAX_BYTES) {
      setSelectionError(
        zh
          ? `文件超过 ${PROJECT_IMPORT_V1_MAX_BYTES} 字节的 Import v1 上限。`
          : `The file exceeds the ${PROJECT_IMPORT_V1_MAX_BYTES}-byte Import v1 limit.`
      );
      return;
    }
    setReading(true);
    try {
      const mode = getDataSourceModeSnapshot();
      setPreflight(preflightProjectImportV1(await file.text(), {
        selectedMode: mode.selectedMode,
        effectiveMode: mode.effectiveMode
      }));
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setReading(false);
    }
  }

  function cancelImport() {
    if (executing) return;
    setFileName(null);
    setPreflight(null);
    setOutcome(null);
    setSelectionError(null);
    setCanceled(true);
  }

  async function confirmImport() {
    if (!preflight?.ok || executing) return;
    setExecuting(true);
    setOutcome(null);
    try {
      const mode = getDataSourceModeSnapshot();
      setOutcome(await executeProjectImportV1(preflight, {
        confirmed: true,
        selectedMode: mode.selectedMode,
        effectiveMode: mode.effectiveMode
      }));
    } finally {
      setExecuting(false);
    }
  }

  const nonZeroCounts = preflight?.ok
    ? IMPORT_V1_OBJECT_TYPES.filter((type) => preflight.preview.objectCounts[type] > 0)
    : [];

  return (
    <section
      aria-label={zh ? "数据导入" : "Data import"}
      className="settings-panel project-import-v1"
      data-project-import-v1="true"
    >
      <div className="project-import-v1__body">
        <div className="settings-action-row project-import-v1__selection-row">
          <span id="project-import-file-label">{zh ? "导入数据" : "Import data"}</span>
          <div className="project-import-v1__file-control">
            <button
              aria-describedby="project-import-file-label"
              className="secondary-button project-import-v1__choose-file"
              data-testid="project-import-choose-file"
              disabled={reading || executing}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              {zh ? "选择文件" : "Choose file"}
            </button>
            <span className="project-import-v1__help">
              <button
                aria-describedby="project-import-help-tooltip"
                aria-label={zh ? "导入数据提示" : "Import data guidance"}
                className="project-import-v1__help-button"
                data-testid="project-import-help"
                type="button"
              >
                ?
              </button>
              <span
                className="project-import-v1__help-tooltip"
                id="project-import-help-tooltip"
                role="tooltip"
              >
                {zh
                  ? "首次使用数据导入时，建议先参考公众号「争流儿的科研舱」中的相关教程"
                  : "Before importing data for the first time, see the related tutorials from 争流儿的科研舱"}
              </span>
            </span>
          </div>
          <input
            aria-label={zh ? "选择 Import v1 JSON" : "Select Import v1 JSON"}
            aria-hidden="true"
            className="project-import-v1__native-file-input"
            type="file"
            accept="application/json,.json"
            data-testid="project-import-file"
            ref={fileInputRef}
            tabIndex={-1}
            onChange={(event) => void selectFile(event)}
            disabled={reading || executing}
          />
        </div>

        {fileName ? <p><strong>{zh ? "已选文件：" : "Selected file: "}</strong>{fileName}</p> : null}
        {reading ? <p role="status">{zh ? "正在读取并执行机械预检…" : "Reading and running mechanical preflight…"}</p> : null}
        {selectionError ? <p role="alert">{selectionError}</p> : null}

        {preflight && !preflight.ok ? (
          <div role="alert" data-testid="project-import-preflight-errors">
            <strong>{zh ? "预检未通过；尚未写入任何业务对象。" : "Preflight failed; no business objects were written."}</strong>
            <ul>
              {preflight.issues.map((entry, index) => (
                <li key={`${entry.path}-${entry.code}-${index}`}>
                  <code>{entry.code}</code> {entry.path}: {entry.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {preflight?.ok ? (
          <section aria-labelledby="project-import-preview-title" data-testid="project-import-preview">
            <h3 id="project-import-preview-title">{zh ? "导入预览" : "Import preview"}</h3>
            <p>
              {zh ? "将创建新 Project：" : "New Project to create: "}
              <strong>{preflight.preview.projectTitle}</strong>
            </p>
            <p>
              {zh
                ? `共 ${preflight.preview.totalObjectCount} 个新业务对象、${preflight.preview.relationCount} 条显式关系。`
                : `${preflight.preview.totalObjectCount} new business objects and ${preflight.preview.relationCount} explicit relations.`}
            </p>
            {preflight.warnings.length > 0 ? (
              <div role="status" data-testid="project-import-preflight-warnings">
                <strong>
                  {zh
                    ? `已接受可导入内容；跳过 ${preflight.preview.skippedCounts.fields} 个字段、${preflight.preview.skippedCounts.objects} 个对象、${preflight.preview.skippedCounts.relations} 条关系。`
                    : `Importable content was accepted; ${preflight.preview.skippedCounts.fields} fields, ${preflight.preview.skippedCounts.objects} objects, and ${preflight.preview.skippedCounts.relations} relations were skipped.`}
                </strong>
                <ul>
                  {preflight.warnings.map((warning, index) => (
                    <li key={`${warning.path}-${warning.code}-${index}`}>
                      <code>{warning.code}</code> {warning.path}: {warning.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul>
              {nonZeroCounts.map((type) => (
                <li key={type}>{displayType(type)}: {preflight.preview.objectCounts[type]}</li>
              ))}
            </ul>
            <p>
              {zh
                ? "确认后才会依赖顺序调用现有 canonical CREATE services；取消不会写入。"
                : "Only confirmation invokes existing canonical CREATE services in dependency order; cancel writes nothing."}
            </p>
            <div>
              <button
                type="button"
                className="primary-button"
                data-testid="project-import-confirm"
                onClick={() => void confirmImport()}
                disabled={executing}
              >
                {executing ? (zh ? "导入中…" : "Importing…") : (zh ? "确认创建" : "Confirm create")}
              </button>
              <button
                type="button"
                className="secondary-button"
                data-testid="project-import-cancel"
                onClick={cancelImport}
                disabled={executing}
              >
                {zh ? "取消" : "Cancel"}
              </button>
            </div>
          </section>
        ) : null}

        {canceled ? (
          <p role="status" data-testid="project-import-canceled">
            {zh ? "已取消；未写入任何业务对象。" : "Canceled; no business objects were written."}
          </p>
        ) : null}

        {outcome ? (
          <section aria-live="polite" data-testid="project-import-outcome">
            <h3>{zh ? "导入结果" : "Import result"}</h3>
            <p>
              <strong>{outcome.status.toUpperCase()}</strong>
              {outcome.project
                ? ` — ${outcome.project.title} (${outcome.project.id})`
                : ""}
            </p>
            <p>
              {zh
                ? `已确认创建 ${outcome.created.length} 个对象、${outcome.createdRelationCount} 条关系。`
                : `${outcome.created.length} objects and ${outcome.createdRelationCount} relations were authoritatively read back.`}
            </p>
            {outcome.warnings.length > 0 ? (
              <p role="status">
                {zh
                  ? `实际跳过 ${outcome.skippedCounts.fields} 个字段、${outcome.skippedCounts.objects} 个对象、${outcome.skippedCounts.relations} 条关系；其余内容已按预检结果处理。`
                  : `${outcome.skippedCounts.fields} fields, ${outcome.skippedCounts.objects} objects, and ${outcome.skippedCounts.relations} relations were skipped exactly as previewed.`}
              </p>
            ) : null}
            {outcome.failedAt ? (
              <p role="alert">
                {outcome.failedAt.type}
                {outcome.failedAt.ref ? `/${outcome.failedAt.ref}` : ""}: {outcome.failedAt.message}
              </p>
            ) : null}
            {outcome.warnings.map((warning) => <p role="status" key={warning}>{warning}</p>)}
          </section>
        ) : null}
      </div>
    </section>
  );
}
