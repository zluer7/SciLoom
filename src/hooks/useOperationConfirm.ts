import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationImpactPreview } from "../types/operationSafety";

type ConfirmationResolver = (confirmed: boolean) => void;

export function useOperationConfirm() {
  const [preview, setPreview] = useState<OperationImpactPreview | null>(null);
  const resolverRef = useRef<ConfirmationResolver | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPreview(null);
    resolve?.(confirmed);
  }, []);

  const requestConfirmation = useCallback((nextPreview: OperationImpactPreview) => {
    resolverRef.current?.(false);
    setPreview(nextPreview);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(
    () => () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    },
    []
  );

  return {
    preview,
    requestConfirmation,
    confirm: () => settle(true),
    cancel: () => settle(false)
  };
}
