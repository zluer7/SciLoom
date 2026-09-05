import { useState, type ReactNode } from "react";

export type DataClearRowProps = {
  contextKey: string;
  regionLabel: string;
  clearLabel?: string;
  deleteLabel?: string;
  onClear?: () => void;
  onDelete?: () => void;
  clearDisabled?: boolean;
  deleteDisabled?: boolean;
};

type DataClearFooterRowProps = DataClearRowProps & {
  className?: string;
  children: ReactNode;
};

export function DataClearRow({
  contextKey,
  regionLabel,
  clearLabel,
  deleteLabel,
  onClear,
  onDelete,
  clearDisabled = false,
  deleteDisabled = false
}: DataClearRowProps) {
  const [disclosure, setDisclosure] = useState({ contextKey, expanded: false });
  const expanded = disclosure.contextKey === contextKey && disclosure.expanded;

  return (
    <div className="data-clear-region" data-data-clear-context={contextKey}>
      <div className="data-clear-row" data-data-clear-row>
        <button
          type="button"
          className="data-clear-toggle"
          aria-expanded={expanded}
          onClick={() => setDisclosure({ contextKey, expanded: !expanded })}
        >
          <span aria-hidden="true">{expanded ? "▶" : "▼"}</span>
          <span>{regionLabel}</span>
        </button>
        <div
          className="data-clear-actions"
          data-visible={expanded ? "true" : "false"}
          aria-hidden={!expanded}
        >
          {onClear && clearLabel ? (
            <button
              type="button"
              className="data-clear-action data-clear-action-clear"
              disabled={!expanded || clearDisabled}
              tabIndex={expanded ? 0 : -1}
              onClick={onClear}
            >
              {clearLabel}
            </button>
          ) : null}
          {onDelete && deleteLabel ? (
            <button
              type="button"
              className="data-clear-action data-clear-action-delete"
              disabled={!expanded || deleteDisabled}
              tabIndex={expanded ? 0 : -1}
              onClick={onDelete}
            >
              {deleteLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function DataClearFooterRow({
  className,
  children,
  ...dataClearProps
}: DataClearFooterRowProps) {
  const footerClassName = [className, "data-clear-footer-row"].filter(Boolean).join(" ");

  return (
    <footer className={footerClassName} data-data-clear-footer-row>
      <DataClearRow {...dataClearProps} />
      <div className="data-clear-footer-actions">{children}</div>
    </footer>
  );
}
