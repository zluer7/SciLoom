import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { exportService } from "../../services/exportService";
import type { Project } from "../../types/planning";

type ExportAction =
  | "all-json"
  | "project-json"
  | "tasks-experiments-md"
  | "outputs-csv";

export function DataExportPanel() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [isRunning, setIsRunning] = useState<ExportAction | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function loadProjects() {
      const projectList = await exportService.listProjects();
      if (isMounted) {
        setProjects(projectList);
        setSelectedProjectId(projectList[0]?.id ?? "");
      }
    }

    loadProjects();

    return () => {
      isMounted = false;
    };
  }, []);

  async function runExport(action: ExportAction) {
    setIsRunning(action);
    setMessage("");

    try {
      const result =
        action === "all-json"
          ? await exportService.exportAllJson()
          : action === "project-json"
            ? await exportService.exportProjectJson(selectedProjectId)
            : action === "tasks-experiments-md"
              ? await exportService.exportTasksAndExperimentsMarkdown()
              : await exportService.exportOutputsCsv();

      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setIsRunning(null);
    }
  }

  return (
    <section className="chart-panel export-panel">
      <h2>{t("exportTitle")}</h2>
      <div className="meta-row">
        <span>{t("runtime")}: {exportService.isDesktopRuntime() ? t("tauriDesktop") : t("browser")}</span>
        <span>{t("projects")}: {projects.length}</span>
      </div>
      <p>{t("exportDescription")}</p>
      <div className="export-controls">
        <label>
          {t("projectScope")}
          <select
            value={selectedProjectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <div className="button-row">
          <button
            type="button"
            disabled={isRunning !== null}
            onClick={() => runExport("all-json")}
          >
            {t("exportAllJson")}
          </button>
          <button
            type="button"
            disabled={isRunning !== null || !selectedProjectId}
            onClick={() => runExport("project-json")}
          >
            {t("exportProjectJson")}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={isRunning !== null}
            onClick={() => runExport("tasks-experiments-md")}
          >
            {t("exportMarkdown")}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={isRunning !== null}
            onClick={() => runExport("outputs-csv")}
          >
            {t("exportOutputsCsv")}
          </button>
        </div>
      </div>
      {message ? <div className="export-result">{message}</div> : null}
    </section>
  );
}
