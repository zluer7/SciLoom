import type { ComparisonCell, RunComparisonColumn } from "../../services/experimentRunComparisonService";

export type PresentedComparisonRow = { key: string; label: string; group: string; cells: ComparisonCell[]; differs: boolean };
const absent: ComparisonCell = { kind: "missing", text: "" };
// Display only the documented research fields from the existing B6 projection.
// The canonical read, exact alignment keys and source facts remain unchanged.
export function presentRunComparison(columns: readonly RunComparisonColumn[], language: string): PresentedComparisonRow[] {
  const zh = language === "zh-CN";
  const t = (cn: string, en: string) => zh ? cn : en;
  const groups = [t("实验条件", "Conditions"), t("变量 / 参数", "Variables / parameters"), t("材料", "Materials"), t("方法", "Method"), t("结果指标", "Result metrics"), t("结果摘要", "Result summary"), t("结论", "Conclusion"), t("其他记录", "Other records"), t("研究关联", "Research context")];
  const roleLabels: Record<string, string> = { independent_variable: t("自变量", "Independent variable"), dependent_variable: t("因变量", "Dependent variable"), control_variable: t("控制变量", "Control variable"), environment: t("环境", "Environment"), sample: t("样本", "Sample"), parameter: t("参数", "Parameter"), other: t("其他", "Other") };
  const typeLabels: Record<string, string> = { number: t("数值", "Number"), text: t("文本", "Text"), boolean: t("是 / 否", "Yes / no"), percentage: t("百分比", "Percentage"), select: t("单选", "Single choice"), multi_select: t("多选", "Multiple choices"), date: t("日期", "Date"), json: t("结构化值", "Structured value") };
  function value(input: unknown, depth = 0): string {
    if (input === null || input === undefined) return t("未记录", "Not recorded");
    if (input === "") return t("空值（已记录）", "Empty value (recorded)");
    if (typeof input === "boolean") return input ? t("是", "Yes") : t("否", "No");
    if (Array.isArray(input)) return input.length ? input.map(item => value(item, depth + 1)).join("; ") : t("空列表（已记录）", "Empty list (recorded)");
    if (typeof input === "object") {
      if (depth > 6) return t("嵌套明细见 Run 详情", "Nested details: see Run detail");
      const entries = Object.entries(input).filter(([key]) => !["id", "runId", "experimentId", "resourceKey", "path", "fullPath", "createdAt", "updatedAt"].includes(key));
      return entries.length ? entries.map(([key, entry]) => `${key}: ${value(entry, depth + 1)}`).join("; ") : t("结构化记录，明细见 Run 详情", "Structured record: see Run detail");
    }
    return String(input);
  }
  function record(text: string, category: string): string {
    // B6 retains duplicate observations as separate JSON lines. Render each
    // known observation in natural language, never as raw DTO/JSON metadata.
    return text.split("\n").map(line => {
      try {
        const data = JSON.parse(line) as Record<string, unknown>;
        if (!data || Array.isArray(data) || typeof data !== "object") throw Error();
        const pieces: string[] = [];
        let primary = category === "Material" ? data.amount : data.value;
        if (data.valueType === "json" && typeof primary === "string") {
          try { primary = JSON.parse(primary); } catch { primary = t("结构化记录暂不可展示，请查看 Run 详情", "Structured record cannot be presented; see Run detail"); }
        }
        if (category !== "Method step") pieces.push(`${value(primary)}${data.unit ? ` ${String(data.unit)}` : ""}`);
        if (data.valueType && typeLabels[String(data.valueType)]) pieces.push(typeLabels[String(data.valueType)]);
        if (data.role && roleLabels[String(data.role)]) pieces.push(roleLabels[String(data.role)]);
        if (category === "Material" && data.materialType) pieces.push(`${t("类型", "Type")}: ${data.materialType}`);
        if (category === "Method step") {
          if (data.order !== undefined) pieces.push(`${t("步骤", "Step")} ${value(data.order)}`);
          if (data.toolOrMethod) pieces.push(`${t("工具 / 方法", "Tool / method")}: ${data.toolOrMethod}`);
          if (data.parameters && Object.keys(data.parameters as object).length) pieces.push(`${t("参数", "Parameters")}: ${value(data.parameters)}`);
        }
        if (data.description) pieces.push(String(data.description));
        if (category === "Metric") {
          if (data.baseline !== undefined && data.baseline !== null) pieces.push(`${t("基线", "Baseline")}: ${value(data.baseline)}${data.unit ? ` ${data.unit}` : ""}`);
          if (data.target !== undefined && data.target !== null) pieces.push(`${t("目标", "Target")}: ${value(data.target)}${data.unit ? ` ${data.unit}` : ""}`);
          if (data.keyResult === true) pieces.push(t("已标记关键结果", "Marked key result"));
          if (data.promotedToResultItem === true) pieces.push(t("已生成结果条目", "Result item generated"));
        }
        return pieces.join(" · ");
      } catch { return t("记录暂不可展示，请查看 Run 详情", "Record cannot be presented; see Run detail"); }
    }).join("\n");
  }
  const summaries: Record<string, [number, string]> = {
    Conditions: [0, t("实验条件", "Conditions")], "Variables / parameters": [1, t("参数 / 变量", "Parameters / variables")], Method: [3, t("方法", "Method")], "Recorded result summary": [5, t("结果", "Results")], "Recorded conclusion": [6, t("结论", "Conclusion")], "Other recorded summary": [7, t("其他记录", "Other records")],
    Project: [8, t("课题", "Project")], Route: [8, t("路线", "Route")], Task: [8, t("任务", "Task")]
  };
  const categories: Record<string, number> = { Condition: 0, Variable: 1, Material: 2, "Method step": 3, Metric: 4, Custom: 7 };
  const keys = [...new Set([...Object.keys(summaries).slice(0, 5), ...columns.flatMap(column => Object.keys(column.facts))])];
  const rows: Array<PresentedComparisonRow & { index: number }> = [];
  for (const key of keys) {
    let mapped = summaries[key]; let category = "";
    if (key.startsWith("[")) {
      try {
        const [kind, name, group] = JSON.parse(key) as string[];
        if (!(kind in categories)) continue;
        category = kind; mapped = [categories[kind], `${groups[categories[kind]]} · ${name}${group ? ` (${group})` : ""}`];
      } catch { continue; }
    }
    if (!mapped) continue;
    const raw = columns.map(column => column.facts[key] ?? absent);
    if (["Other recorded summary", "Project", "Route", "Task"].includes(key) && raw.every(cell => cell.kind !== "value")) continue;
    const cells = raw.map(cell => cell.kind === "value" && category ? { ...cell, text: record(cell.text, category) } : cell);
    rows.push({ key, label: mapped[1], group: groups[mapped[0]], index: mapped[0], cells, differs: new Set(raw.map(cell => JSON.stringify(cell))).size > 1 });
  }
  if (!rows.some(row => row.index === 4)) rows.push({ key: "metrics-empty", label: t("已记录指标", "Recorded metrics"), group: groups[4], index: 4, cells: columns.map(() => absent), differs: false });
  return rows.sort((a, b) => a.index - b.index);
}
