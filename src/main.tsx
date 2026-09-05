import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./app/App";
import { bootstrapPlanningAuthorityProducer } from "./services/planningAuthorityTransport";
import { primeAICallAttemptLifecycle } from "./services/aiCallAttemptLifecycleService";
import "./styles/global.css";

const activeUiSource =
  window.location.protocol.startsWith("http") && window.location.port === "1420"
    ? "vite-dev-src"
    : "dist-build";
document.documentElement.dataset.uiSource = activeUiSource;
console.log("ACTIVE ENTRY:", window.location.href);
console.log("ACTIVE UI SOURCE:", activeUiSource);

async function bootstrap() {
  void primeAICallAttemptLifecycle().catch((error) => {
    console.error("AI CallAttempt lifecycle initialization failed; Provider admission is blocked.", error);
  });
  await bootstrapPlanningAuthorityProducer();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>
  );
}

void bootstrap().catch((error) => {
  console.error("Planning authority producer bootstrap failed.", error);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = "SciLoom startup failed: Planning authority is unavailable.";
  }
});
