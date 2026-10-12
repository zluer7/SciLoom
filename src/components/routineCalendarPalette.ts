import type { RoutineCalendarColor } from "../types/planning";

// Presentation colors; only the fixed key is saved on ResearchRoutine.
export const routineCalendarPalette: Record<RoutineCalendarColor, { color: string; zh: string; en: string }> = {
  sage: { color: "#739b85", zh: "鼠尾草绿", en: "Sage green" },
  steel: { color: "#7896b3", zh: "钢蓝", en: "Steel blue" },
  lavender: { color: "#9b8db2", zh: "薰衣草紫", en: "Lavender" },
  sand: { color: "#b6a06a", zh: "沙金", en: "Sand gold" },
  rose: { color: "#b58891", zh: "灰玫瑰", en: "Dusty rose" }
};
