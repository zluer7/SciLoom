import type {
  AIContextMaterialDecision,
  AIResearchObjectDescriptor
} from "../../types/aiContext";

const CONTEXT_OBJECT_LABELS: Readonly<Record<string, string>> = {
  route: "路线",
  task: "任务",
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

function compact(value: string, maxCharacters: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= maxCharacters
    ? normalized
    : `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
}

function contextModeLabel(mode: string | undefined): string {
  if (mode === "MINIMAL") return "精简";
  if (mode === "DETAILED") return "详细";
  if (mode === "FULL") return "充分";
  return "标准";
}

function summarizedNames(label: string, names: readonly string[]): string {
  const bounded = names.map((name) => compact(name, 24)).filter(Boolean);
  if (bounded.length === 0) return `${label}：${names.length} 项`;
  const visible = bounded.slice(0, 2).join("、");
  return `${label}：${visible}${bounded.length > 2 ? ` 等 ${bounded.length} 项` : ""}`;
}

export function buildAIChatContextCompactPresentation(input: {
  contextMode?: string;
  researchObjects: readonly AIResearchObjectDescriptor[];
  materials: readonly AIContextMaterialDecision[];
}): { title: string; detail: string } {
  const grouped = new Map<string, string[]>();
  for (const descriptor of input.researchObjects) {
    const label = CONTEXT_OBJECT_LABELS[descriptor.objectType] ?? "研究对象";
    grouped.set(label, [...(grouped.get(label) ?? []), descriptor.label]);
  }
  const parts = [...grouped.entries()].map(([label, names]) => summarizedNames(label, names));
  if (input.materials.length > 0) {
    parts.push(summarizedNames("材料", input.materials.map((material) => material.displayName)));
  }
  return {
    title: `上下文内容（${contextModeLabel(input.contextMode)}）`,
    detail: compact(parts.join("；") || "未包含研究对象或材料", 150)
  };
}
