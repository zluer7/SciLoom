export interface StructuredSummaryDisplayField {
  key?: string;
  label: string;
  content: string | string[] | null | undefined;
}

export interface StructuredSummaryDisplayProps {
  fields: StructuredSummaryDisplayField[];
  emptyText: string;
  className?: string;
}

export function splitStructuredSummaryLines(
  content: string | string[] | null | undefined
) {
  const values = Array.isArray(content) ? content : [content ?? ""];
  return values
    .flatMap((value) => value.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

export function StructuredSummaryDisplay({
  fields,
  emptyText,
  className
}: StructuredSummaryDisplayProps) {
  const rootClassName = ["structured-summary-display", className]
    .filter(Boolean)
    .join(" ");
  const fieldClassName = "structured-summary-field";

  return (
    <div className={rootClassName}>
      {fields.map((field, fieldIndex) => {
        const lines = splitStructuredSummaryLines(field.content);
        return (
          <section className={fieldClassName} key={field.key ?? `${field.label}:${fieldIndex}`}>
            <h3>{field.label}</h3>
            {lines.length ? (
              <ul>
                {lines.map((line, index) => (
                  <li key={`${line}:${index}`}>{line}</li>
                ))}
              </ul>
            ) : (
              <ul className="structured-summary-empty">
                <li>{emptyText}</li>
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
