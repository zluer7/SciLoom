import type { WriteFeedbackDisplayEntry } from "../../services/writeFeedbackDisplayService";

interface WriteFeedbackPanelProps {
  entries: WriteFeedbackDisplayEntry[];
  onDismiss: (id: string) => void;
  presentation?: "default" | "primary-page";
}

function severityLabel(severity: WriteFeedbackDisplayEntry["severity"]) {
  if (severity === "partial") return "Partial";
  if (severity === "skipped") return "Skipped";
  if (severity === "warning") return "Notice";
  if (severity === "error") return "Error";
  if (severity === "success") return "Done";
  return "Info";
}

function renderList(label: string, values: string[]) {
  if (values.length === 0) {
    return null;
  }

  return (
    <div className="write-feedback-meta-group">
      <span>{label}</span>
      <ul>
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </div>
  );
}

function actionableGuidance(entry: WriteFeedbackDisplayEntry) {
  if (entry.details.length > 0) return entry.details;
  return entry.summary ? [entry.summary] : [entry.title];
}

export function WriteFeedbackPanel({
  entries,
  onDismiss,
  presentation = "default"
}: WriteFeedbackPanelProps) {
  const visibleEntries = entries.filter(
    (entry) =>
      entry.formalCrudTerminalPresentation !== "suppress" &&
      (presentation !== "primary-page" || entry.severity !== "skipped")
  );
  if (visibleEntries.length === 0) {
    return null;
  }

  return (
    <section
      className={`write-feedback-panel${
        presentation === "primary-page" ? " write-feedback-panel--primary-page" : ""
      }`}
      aria-live="polite"
      aria-label="Write feedback"
    >
      {visibleEntries.map((entry) => {
        if (presentation === "primary-page") {
          const primaryMessage =
            entry.formalCrudTerminalPresentation === "guidance-only"
              ? actionableGuidance(entry)[0]
              : entry.summary || entry.title;
          return (
            <article
              className={`write-feedback-entry write-feedback-entry-${entry.severity} write-feedback-entry--primary-page`}
              key={entry.id}
              role={entry.severity === "error" ? "alert" : "status"}
            >
              <p>{primaryMessage}</p>
              <button
                type="button"
                className="write-feedback-dismiss"
                aria-label="Close notice"
                onClick={() => onDismiss(entry.id)}
              >
                ×
              </button>
            </article>
          );
        }
        if (entry.formalCrudTerminalPresentation === "guidance-only") {
          return (
            <aside
              className={`write-feedback-guidance write-feedback-guidance-${entry.severity}`}
              data-formal-crud-actionable-guidance="true"
              key={entry.id}
            >
              <ul>
                {actionableGuidance(entry).map((value) => <li key={value}>{value}</li>)}
              </ul>
              <button
                type="button"
                className="write-feedback-dismiss"
                onClick={() => onDismiss(entry.id)}
              >
                Dismiss
              </button>
            </aside>
          );
        }
        return (
          <article
            className={`write-feedback-entry write-feedback-entry-${entry.severity}`}
            key={entry.id}
          >
            <div className="write-feedback-entry-main">
              <div className="write-feedback-heading">
                <span className="write-feedback-severity">{severityLabel(entry.severity)}</span>
                <div>
                  <h2>{entry.title}</h2>
                  {entry.summary ? <p>{entry.summary}</p> : null}
                </div>
              </div>
              <button
                type="button"
                className="write-feedback-dismiss"
                onClick={() => onDismiss(entry.id)}
              >
                Dismiss
              </button>
            </div>

            {entry.operationLabel || entry.reason ? (
              <div className="write-feedback-context">
                {entry.operationLabel ? <span>{entry.operationLabel}</span> : null}
                {entry.reason ? <span>{entry.reason}</span> : null}
              </div>
            ) : null}

            {entry.details.length > 1 ? renderList("Details", entry.details.slice(1)) : null}
            {renderList("Entities", entry.affectedEntities)}
            {renderList("Scopes", entry.affectedScopes)}
          </article>
        );
      })}
    </section>
  );
}
