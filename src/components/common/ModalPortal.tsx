import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

type ModalEnvironmentSnapshot = {
  bodyOverflow: string;
  bodyOverscrollBehavior: string;
  documentOverflow: string;
  rootAriaHidden: string | null;
  rootHadInert: boolean;
};

let activeModalPortalCount = 0;
let modalEnvironmentSnapshot: ModalEnvironmentSnapshot | null = null;

function acquireModalEnvironmentLock() {
  if (typeof document === "undefined") return undefined;

  const root = document.getElementById("root");
  if (activeModalPortalCount === 0) {
    modalEnvironmentSnapshot = {
      bodyOverflow: document.body.style.overflow,
      bodyOverscrollBehavior: document.body.style.overscrollBehavior,
      documentOverflow: document.documentElement.style.overflow,
      rootAriaHidden: root?.getAttribute("aria-hidden") ?? null,
      rootHadInert: root?.hasAttribute("inert") ?? false
    };
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.documentElement.style.overflow = "hidden";
    root?.setAttribute("inert", "");
    root?.setAttribute("aria-hidden", "true");
  }
  activeModalPortalCount += 1;

  return () => {
    activeModalPortalCount = Math.max(0, activeModalPortalCount - 1);
    if (activeModalPortalCount !== 0 || !modalEnvironmentSnapshot) return;

    const snapshot = modalEnvironmentSnapshot;
    modalEnvironmentSnapshot = null;
    document.body.style.overflow = snapshot.bodyOverflow;
    document.body.style.overscrollBehavior = snapshot.bodyOverscrollBehavior;
    document.documentElement.style.overflow = snapshot.documentOverflow;
    if (root) {
      if (snapshot.rootHadInert) root.setAttribute("inert", "");
      else root.removeAttribute("inert");
      if (snapshot.rootAriaHidden === null) root.removeAttribute("aria-hidden");
      else root.setAttribute("aria-hidden", snapshot.rootAriaHidden);
    }
  };
}

export function ModalPortal({ children }: { children: ReactNode }) {
  useEffect(() => acquireModalEnvironmentLock(), []);

  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
