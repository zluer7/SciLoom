import type { ReactNode } from "react";

type StructuredEditFieldGridProps = {
  children: ReactNode;
  className?: string;
};

export function StructuredEditFieldGrid({
  children,
  className
}: StructuredEditFieldGridProps) {
  return (
    <div
      className={`structured-edit-field-grid semantic-textarea-grid-structured${
        className ? ` ${className}` : ""
      }`}
    >
      {children}
    </div>
  );
}
