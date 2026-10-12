import { useCallback, useEffect, useRef, useState } from "react";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useI18n } from "../../i18n/I18nProvider";
import { planningService } from "../../services/planningService";
import { projectExportV1Service } from "../../services/projectExportV1Service";
import { projectMarkdownExportService } from "../../services/projectMarkdownExportService";
import type { Project } from "../../types/planning";

const projectRefreshKeys = ["project.changed" as const];

export function ProjectExportV1Panel() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState<"json" | "markdown" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const listGeneration = useRef(0);

  const reloadProjects = useCallback(async () => {
    const request = ++listGeneration.current;
    try {
      const items = await planningService.queryProjects({ includeArchived: true });
      if (!mounted.current || request !== listGeneration.current) return;
      setProjects(items);
      setProjectId(current => items.some(project => project.id === current) ? current : (items[0]?.id ?? ""));
    } catch {
      if (mounted.current && request === listGeneration.current) setError(zh ? "课题列表读取失败，请重试。" : "Project list could not be read. Try again.");
    }
  }, [zh]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; listGeneration.current += 1; };
  }, []);

  useEffect(() => {
    void reloadProjects();
  }, [reloadProjects]);

  useRefreshEventReload({ pageName: "ProjectExportV1Panel", watchedKeys: projectRefreshKeys, reload: reloadProjects });

  async function exportProject(format: "json" | "markdown") {
    if (!projectId || inFlight.current) return;
    const request = ++generation.current;
    inFlight.current = true;
    setBusy(format);
    setMessage(null);
    setError(null);
    try {
      const prepared = format === "json"
        ? await projectExportV1Service.prepare(projectId)
        : await projectMarkdownExportService.prepare(projectId, language);
      if (!mounted.current || request !== generation.current) return;
      const result = format === "json"
        ? await projectExportV1Service.savePrepared(prepared as Awaited<ReturnType<typeof projectExportV1Service.prepare>>)
        : await projectMarkdownExportService.savePrepared(prepared as Awaited<ReturnType<typeof projectMarkdownExportService.prepare>>);
      if (!mounted.current || request !== generation.current) return;
      setMessage(result.saved
        ? (zh ? `已保存${result.filePath ? `：${result.filePath}` : "。"}` : `Saved${result.filePath ? `: ${result.filePath}` : "."}`)
        : (zh ? "已取消保存。" : "Save canceled."));
    } catch {
      if (mounted.current && request === generation.current) setError(zh ? "导出失败，未确认文件已保存。请重试。" : "Export failed; no saved file was confirmed. Try again.");
    } finally {
      if (mounted.current && request === generation.current) {
        inFlight.current = false;
        setBusy(null);
      }
    }
  }

  return <section className="settings-data-row project-export-v1" data-project-export-v1="true" aria-label={zh ? "导出 Project" : "Export Project"}>
    <label className="settings-data-row__label" htmlFor="project-export-project">{zh ? "导出 Project" : "Export Project"}</label>
    <div className="settings-data-row__controls">
      <select id="project-export-project" data-testid="project-export-v1-project" aria-label={zh ? "选择 Project" : "Select Project"}
        disabled={busy !== null || projects.length === 0} value={projectId} onChange={event => {
          if (inFlight.current) return;
          generation.current += 1;
          setProjectId(event.target.value);
          setMessage(null);
          setError(null);
        }}>
        {projects.length === 0 ? <option value="">{zh ? "暂无课题" : "No Projects"}</option> : projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      <button className="secondary-button" data-testid="project-export-json" type="button" disabled={!projectId || busy !== null}
        title={zh ? "Import v1 JSON 交换文件，非完整备份；再次导入会创建新课题。" : "Import v1 JSON exchange, not a complete backup; re-import creates a new Project."}
        onClick={() => void exportProject("json")}>{busy === "json" ? (zh ? "导出中…" : "Exporting…") : (zh ? "导出 JSON" : "Export JSON")}</button>
      <button className="secondary-button" data-testid="project-export-markdown" type="button" disabled={!projectId || busy !== null}
        title={zh ? "科研上下文，非完整备份或导入协议；不含附件正文。" : "Research context, not a complete backup or import protocol; no attachment bodies."}
        onClick={() => void exportProject("markdown")}>{busy === "markdown" ? (zh ? "导出中…" : "Exporting…") : (zh ? "导出 Markdown" : "Export Markdown")}</button>
    </div>
    {message ? <p className="settings-data-row__message" role="status" data-testid="project-export-v1-message">{message}</p> : null}
    {error ? <p className="settings-data-row__message" role="alert" data-testid="project-export-v1-error">{error}</p> : null}
  </section>;
}
