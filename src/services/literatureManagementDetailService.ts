import type { EntityId, Literature, Project } from "../types";
import type { LiteratureDetailContext } from "../types/literatureContext";
import { queryProjects } from "./planningService";
import { getLiteratureDetailContext } from "./literatureSelectorService";

export type LiteratureProjectRelation =
  | { status: "unassigned" }
  | { status: "ready"; projectId: EntityId; projectTitle: string }
  | { status: "orphaned"; projectId: EntityId }
  | { status: "unavailable"; projectId: EntityId; reason: string };

export type LiteratureManuscriptReadiness = "ready" | "degraded" | "missing" | "blocked";

export type LiteratureDetailDegradationKind =
  | "project-reference-orphaned"
  | "planning-authority-unavailable"
  | "manuscript-readiness-degraded"
  | "physical-file-missing"
  | "detail-aggregation-failed";

export interface LiteratureManagementCapabilities {
  canViewBaseDetail: boolean;
  canEditMetadata: boolean;
  canDelete: boolean;
  canOpenOutline: boolean;
  canOpenNotes: boolean;
  canRepairRelation: boolean;
}

export interface LiteratureProjectCatalog {
  status: "ready" | "unavailable";
  projects: Project[];
  reason?: string;
}

export interface LiteratureManagementDetail {
  status: "ready" | "degraded";
  baseLiterature: Literature;
  detailContext: LiteratureDetailContext | null;
  projectRelation: LiteratureProjectRelation;
  manuscriptReadiness: LiteratureManuscriptReadiness;
  capabilities: LiteratureManagementCapabilities;
  degradationKinds: LiteratureDetailDegradationKind[];
}

export async function loadLiteratureProjectCatalog(
  loadProjects: typeof queryProjects = queryProjects
): Promise<LiteratureProjectCatalog> {
  try {
    return {
      status: "ready",
      projects: await loadProjects({ includeArchived: true })
    };
  } catch (error) {
    return {
      status: "unavailable",
      projects: [],
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export function resolveLiteratureProjectRelation(
  literature: Pick<Literature, "primaryProjectId">,
  catalog: LiteratureProjectCatalog
): LiteratureProjectRelation {
  const projectId = literature.primaryProjectId?.trim();
  if (!projectId) {
    return { status: "unassigned" };
  }
  if (catalog.status === "unavailable") {
    return {
      status: "unavailable",
      projectId,
      reason: catalog.reason ?? "PLANNING_AUTHORITY_UNAVAILABLE"
    };
  }
  const project = catalog.projects.find((candidate) => candidate.id === projectId);
  return project
    ? { status: "ready", projectId, projectTitle: project.title }
    : { status: "orphaned", projectId };
}

function readinessFromDetail(detailContext: LiteratureDetailContext) {
  const outlineReady =
    detailContext.provisioningReadiness.channels.literature_outline.readiness
      .currentResourceReady === "ready";
  const notesReady =
    detailContext.provisioningReadiness.channels.dedicated_notes.readiness
      .currentResourceReady === "ready";
  const blockerCodes = detailContext.provisioningReadiness.blockers.map((blocker) => blocker.code);
  const missing = blockerCodes.some((code) => code === "MANUSCRIPT_RESOURCE_MISSING");
  const manuscriptReadiness: LiteratureManuscriptReadiness =
    outlineReady && notesReady ? "ready" : missing ? "missing" : "degraded";
  return { outlineReady, notesReady, manuscriptReadiness };
}

function degradationForThrownDetail(
  relation: LiteratureProjectRelation,
  error: unknown
): LiteratureDetailDegradationKind {
  if (relation.status === "orphaned") {
    return "project-reference-orphaned";
  }
  if (relation.status === "unavailable") {
    return "planning-authority-unavailable";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/MANUSCRIPT_RESOURCE_MISSING|FILE.*MISSING|PHYSICAL.*MISSING/iu.test(message)) {
    return "physical-file-missing";
  }
  if (/MANUSCRIPT|FILE_REF|BINDING|READINESS/iu.test(message)) {
    return "manuscript-readiness-degraded";
  }
  return "detail-aggregation-failed";
}

export async function loadLiteratureManagementDetail(input: {
  baseLiterature: Literature;
  projectCatalog: LiteratureProjectCatalog;
  loadDetail?: typeof getLiteratureDetailContext;
}): Promise<LiteratureManagementDetail | null> {
  const projectRelation = resolveLiteratureProjectRelation(
    input.baseLiterature,
    input.projectCatalog
  );
  try {
    const detailContext = await (input.loadDetail ?? getLiteratureDetailContext)(
      input.baseLiterature.id
    );
    if (!detailContext || detailContext.literature.id !== input.baseLiterature.id) {
      return null;
    }
    const readiness = readinessFromDetail(detailContext);
    const degradationKinds: LiteratureDetailDegradationKind[] = [];
    if (projectRelation.status === "orphaned") {
      degradationKinds.push("project-reference-orphaned");
    } else if (projectRelation.status === "unavailable") {
      degradationKinds.push("planning-authority-unavailable");
    }
    if (readiness.manuscriptReadiness === "missing") {
      degradationKinds.push("physical-file-missing");
    } else if (readiness.manuscriptReadiness === "degraded") {
      degradationKinds.push("manuscript-readiness-degraded");
    }
    return {
      status: degradationKinds.length ? "degraded" : "ready",
      baseLiterature: detailContext.literature,
      detailContext,
      projectRelation,
      manuscriptReadiness: readiness.manuscriptReadiness,
      capabilities: {
        canViewBaseDetail: true,
        canEditMetadata: true,
        canDelete: true,
        canOpenOutline: readiness.outlineReady,
        canOpenNotes: readiness.notesReady,
        canRepairRelation: false
      },
      degradationKinds
    };
  } catch (error) {
    const degradationKind = degradationForThrownDetail(projectRelation, error);
    return {
      status: "degraded",
      baseLiterature: input.baseLiterature,
      detailContext: null,
      projectRelation,
      manuscriptReadiness:
        degradationKind === "physical-file-missing" ? "missing" : "blocked",
      capabilities: {
        canViewBaseDetail: true,
        canEditMetadata: true,
        canDelete: true,
        canOpenOutline: false,
        canOpenNotes: false,
        canRepairRelation: false
      },
      degradationKinds: [degradationKind]
    };
  }
}
