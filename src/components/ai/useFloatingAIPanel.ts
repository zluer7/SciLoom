import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";

export type FloatingAIPanelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const FLOATING_AI_PANEL_MIN_WIDTH = 680;
export const FLOATING_AI_PANEL_MIN_HEIGHT = 520;
export const FLOATING_AI_PANEL_MARGIN = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function constrainFloatingAIPanelRect(
  rect: FloatingAIPanelRect,
  viewportWidth: number,
  viewportHeight: number
): FloatingAIPanelRect {
  const availableWidth = Math.max(1, viewportWidth - (FLOATING_AI_PANEL_MARGIN * 2));
  const availableHeight = Math.max(1, viewportHeight - (FLOATING_AI_PANEL_MARGIN * 2));
  const minimumWidth = Math.min(FLOATING_AI_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(FLOATING_AI_PANEL_MIN_HEIGHT, availableHeight);
  const width = clamp(rect.width, minimumWidth, availableWidth);
  const height = clamp(rect.height, minimumHeight, availableHeight);
  const x = clamp(
    rect.x,
    FLOATING_AI_PANEL_MARGIN,
    Math.max(FLOATING_AI_PANEL_MARGIN, viewportWidth - width - FLOATING_AI_PANEL_MARGIN)
  );
  const y = clamp(
    rect.y,
    FLOATING_AI_PANEL_MARGIN,
    Math.max(FLOATING_AI_PANEL_MARGIN, viewportHeight - height - FLOATING_AI_PANEL_MARGIN)
  );
  return { x, y, width, height };
}

export function createDefaultFloatingAIPanelRect(
  viewportWidth: number,
  viewportHeight: number
): FloatingAIPanelRect {
  const preferredX = FLOATING_AI_PANEL_MARGIN;
  const width = viewportWidth - preferredX - FLOATING_AI_PANEL_MARGIN;
  const height = viewportHeight - (FLOATING_AI_PANEL_MARGIN * 2);
  return constrainFloatingAIPanelRect(
    { x: preferredX, y: FLOATING_AI_PANEL_MARGIN, width, height },
    viewportWidth,
    viewportHeight
  );
}

type PointerInteraction = {
  mode: "drag" | "resize";
  pointerId: number;
  originClientX: number;
  originClientY: number;
  originRect: FloatingAIPanelRect;
};

export function useFloatingAIPanel() {
  const [rect, setRect] = useState<FloatingAIPanelRect>(() => (
    typeof window === "undefined"
      ? createDefaultFloatingAIPanelRect(1_200, 800)
      : createDefaultFloatingAIPanelRect(window.innerWidth, window.innerHeight)
  ));
  const [interactionMode, setInteractionMode] = useState<PointerInteraction["mode"]>();
  const interactionRef = useRef<PointerInteraction>();

  const beginInteraction = useCallback((
    mode: PointerInteraction["mode"],
    event: ReactPointerEvent<HTMLElement>
  ) => {
    if (event.button !== 0) return;
    if (
      mode === "drag" &&
      (event.target as HTMLElement).closest("button, a, input, select, textarea, summary")
    ) return;
    event.preventDefault();
    interactionRef.current = {
      mode,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      originClientY: event.clientY,
      originRect: rect
    };
    setInteractionMode(mode);
  }, [rect]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    function handlePointerMove(event: PointerEvent) {
      const interaction = interactionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) return;
      const deltaX = event.clientX - interaction.originClientX;
      const deltaY = event.clientY - interaction.originClientY;
      const next = interaction.mode === "drag"
        ? {
            ...interaction.originRect,
            x: interaction.originRect.x + deltaX,
            y: interaction.originRect.y + deltaY
          }
        : {
            ...interaction.originRect,
            width: interaction.originRect.width + deltaX,
            height: interaction.originRect.height + deltaY
          };
      setRect(constrainFloatingAIPanelRect(next, window.innerWidth, window.innerHeight));
    }

    function finishInteraction(event: PointerEvent) {
      if (interactionRef.current?.pointerId !== event.pointerId) return;
      interactionRef.current = undefined;
      setInteractionMode(undefined);
    }

    function handleViewportResize() {
      setRect((current) => constrainFloatingAIPanelRect(
        current,
        window.innerWidth,
        window.innerHeight
      ));
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishInteraction);
    window.addEventListener("pointercancel", finishInteraction);
    window.addEventListener("resize", handleViewportResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishInteraction);
      window.removeEventListener("pointercancel", finishInteraction);
      window.removeEventListener("resize", handleViewportResize);
    };
  }, []);

  const style: CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height
  };

  return {
    rect,
    style,
    isDragging: interactionMode === "drag",
    isResizing: interactionMode === "resize",
    dragHandleProps: {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => beginInteraction("drag", event)
    },
    resizeHandleProps: {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => beginInteraction("resize", event)
    }
  };
}
