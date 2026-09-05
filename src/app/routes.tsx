import { Navigate, type RouteObject } from "react-router-dom";
import { AppLayout } from "../components/layout/AppLayout";
import { ExperimentsPage } from "../pages/Experiments/ExperimentsPage";
import { LiteraturePage } from "../pages/Literature/LiteraturePage";
import { OutputsPage } from "../pages/Outputs/OutputsPage";
import { ProjectsPage } from "../pages/Projects/ProjectsPage";
import { RoutesPage } from "../pages/Routes/RoutesPage";
import { ReviewsPage } from "../pages/Reviews/ReviewsPage";
import { SettingsPage } from "../pages/Settings/SettingsPage";
import { TasksPage } from "../pages/Tasks/TasksPage";

function RouteNotFound() {
  return (
    <section className="empty-state" role="alert">
      <h2>页面不存在</h2>
      <p>请从左侧导航选择一个 SciLoom 模块。</p>
    </section>
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "routes", element: <RoutesPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "experiments", element: <ExperimentsPage /> },
      { path: "literature", element: <LiteraturePage /> },
      { path: "reviews", element: <ReviewsPage /> },
      { path: "outputs", element: <OutputsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <RouteNotFound /> }
    ]
  }
];
