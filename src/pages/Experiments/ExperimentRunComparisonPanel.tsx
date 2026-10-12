import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { ExperimentRun } from "../../types";
import { EXPERIMENT_RUN_COMPARISON_MAX, readRunComparison, type ComparisonCell, type RunComparisonColumn } from "../../services/experimentRunComparisonService";
import { presentRunComparison } from "./ExperimentRunComparisonPresentation";

const secondary = "primary-page-action primary-page-action--secondary";
export function ComparisonValue({ text, zh }: { text: string; zh: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => { setExpanded(false); }, [text]);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node || expanded) return;
    const measure = () => setTruncated(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [text, expanded]);
  return <div className="run-comparison__cell">
    <div ref={content} tabIndex={expanded ? 0 : undefined} aria-label={expanded ? (zh ? "完整记录" : "Complete record") : undefined} className={`run-comparison__value${expanded ? " is-expanded" : ""}`}>{text}</div>
    {truncated && <button type="button" className={`run-comparison__expand secondary-button ${secondary}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? (zh ? "收起" : "Collapse") : (zh ? "展开" : "Expand")}</button>}
  </div>;
}
export function ExperimentRunComparisonPanel({ experimentId, runs, language }: { experimentId: string; runs: ExperimentRun[]; language: string }) {
  const zh = language === "zh-CN";
  const [selection, setSelection] = useState<string[]>([]);
  const [selectionOwner, setSelectionOwner] = useState(experimentId);
  const currentOwner = selectionOwner === experimentId;
  const eligible = runs.filter(run => run.experimentId === experimentId);
  const validSelection = currentOwner ? selection.filter(id => eligible.some(run => run.id === id)) : [];
  const [result, setResult] = useState<{ key: string; columns: RunComparisonColumn[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"select" | "compare">("select");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const runIds = eligible.map(run => run.id).join("\0");
  const selectionKey = validSelection.join("\0");
  const key = `${experimentId}:${selectionKey}`;
  useEffect(() => {
    generation.current += 1; setSelectionOwner(experimentId);
    setSelection([]); setResult(null); setOpen(false); setStage("select"); setLoading(false);
  }, [experimentId]);
  useEffect(() => { setSelection(current => current.filter(id => eligible.some(run => run.id === id))); }, [runIds, experimentId]);
  useEffect(() => {
    const request = ++generation.current; setResult(null);
    if (!currentOwner || !open || stage !== "compare" || validSelection.length < 2) { setLoading(false); return; }
    setLoading(true);
    void readRunComparison(experimentId, validSelection).then(columns => {
      if (generation.current === request) setResult({ key, columns });
    }).catch(() => {
      if (generation.current === request) setResult({ key, columns: validSelection.map(id => ({ id, title: id, error: "read_failed", facts: {} })) });
    }).finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current += 1; };
  }, [experimentId, selectionKey, open, stage, refresh, currentOwner]);
  const columns = result?.key === key && currentOwner && validSelection.length >= 2 ? result.columns : [];
  const rows = presentRunComparison(columns, language);
  const renderCell = (value: ComparisonCell, error?: string) => {
    if (error) return zh ? (error === "read_failed" ? "读取失败" : "对象已不可用，请重新选择") : (error === "read_failed" ? "Read failed" : "Unavailable; reselect");
    if (value.kind === "missing") return zh ? "未记录" : "Not recorded";
    if (value.kind === "not_applicable") return zh ? "未关联 / 不适用" : "Not linked / Not applicable";
    return <ComparisonValue text={value.text} zh={zh} />;
  };
  const titleFor = (column: RunComparisonColumn) => column.error
    ? eligible.find(run => run.id === column.id)?.title || (zh ? "Run 名称不可用" : "Run name unavailable") : column.title;
  return <>
    <button ref={trigger} type="button" className={secondary} data-testid="enter-run-comparison" disabled={!experimentId} onClick={() => { setStage("select"); setOpen(true); }}>{zh ? "只读比较" : "Read-only compare"}</button>
    <Dialog.Root open={currentOwner && open} onOpenChange={setOpen}>
      <Dialog.Portal><Dialog.Overlay className="conversation-dialog-overlay" />
        <Dialog.Content className="conversation-dialog run-comparison-dialog" aria-describedby={undefined}
          onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} onEscapeKeyDown={event => event.stopPropagation()}>
          <div className="run-comparison__header">
            <Dialog.Title>{zh ? "Run 只读比较" : "Read-only Run comparison"}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className={`secondary-button experiment-form-close ${secondary}`} aria-label={zh ? "关闭" : "Close"}>{zh ? "关闭" : "Close"}</button></Dialog.Close>
          </div>
          <div className="run-comparison__actions">
            {stage === "select" ? <button type="button" className="primary-page-action primary-page-action--primary" data-testid="compare-runs" disabled={validSelection.length < 2} onClick={() => setStage("compare")}>{zh ? "比较" : "Compare"} ({validSelection.length}/5)</button> : <>
              <button type="button" className={secondary} onClick={() => setStage("select")}>{zh ? "重新选择" : "Change Runs"}</button>
              <button type="button" className={secondary} onClick={() => setRefresh(value => value + 1)}>{zh ? "刷新事实" : "Refresh facts"}</button>
              <button type="button" className={secondary} onClick={() => setSelection(current => [...current].reverse())}>{zh ? "反转顺序" : "Reverse order"}</button>
            </>}
          </div>
          {stage === "select" ? <fieldset className="run-comparison__selection"><legend>{zh ? "选择 2–5 个 Run" : "Select 2–5 Runs"}</legend>
            {eligible.map(run => <label key={run.id}><input type="checkbox" data-comparison-run={run.id} checked={validSelection.includes(run.id)} disabled={!validSelection.includes(run.id) && validSelection.length >= EXPERIMENT_RUN_COMPARISON_MAX}
              onChange={event => { const checked = event.target.checked; setSelection(current => checked ? (current.includes(run.id) || current.length >= EXPERIMENT_RUN_COMPARISON_MAX ? current : [...current, run.id]) : current.filter(id => id !== run.id)); }} />{run.title || (zh ? "未命名 Run" : "Untitled Run")}</label>)}
            {!eligible.length && <p>{zh ? "当前实验暂无 Run。" : "No Runs in this Experiment."}</p>}
          </fieldset> : <>
            {validSelection.length < 2 && <p role="alert">{zh ? "有效 Run 不足两个，请重新选择。" : "Fewer than two valid Runs remain. Reselect."}</p>}
            {loading && <p role="status">{zh ? "正在读取事实…" : "Reading facts…"}</p>}
            {columns.some(column => column.error) && <p role="alert">{zh ? "部分对象无法读取；未用空值代替。" : "Some objects could not be read; they have not been replaced by empty values."}</p>}
            {columns.length > 0 && <div className="run-comparison__scroll"><table>
              <thead><tr><th>{zh ? "科研记录" : "Research record"}</th>{columns.map(column => <th key={column.id}>{titleFor(column)}{column.error ? ` — ${renderCell({ kind: "missing", text: "" }, column.error)}` : ""}</th>)}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.key} data-differs={row.differs}><th scope="row">{row.label}</th>{row.cells.map((value, i) => <td key={columns[i].id} data-value-kind={value.kind}>{renderCell(value, columns[i].error)}</td>)}</tr>)}</tbody>
            </table></div>}
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
