import type { EntitySummary } from "../types/entityContext";
import type {
  LiteratureAiFieldSchemaItem,
  LiteratureContextProvenance,
  LiteratureDetailContext,
  LiteratureObjectiveOutlineAiInput,
  LiteratureProjectAdaptationAiInput,
  LiteratureProjectContextItem,
  ProjectOrientedLiteratureContext
} from "../types/literatureContext";
import type { EntityId } from "../types";
import { getProjectDetailContext } from "./planningSelectorService";
import { getLiteratureDetailContext } from "./literatureSelectorService";

export const LITERATURE_OBJECTIVE_OUTLINE_FUTURE_WRITE_TARGETS = [
  "Literature.title",
  "Literature.authors",
  "Literature.year",
  "Literature.venue",
  "Literature.publicationType",
  "Literature.doi",
  "Literature.url",
  "Literature.keywords",
  "Literature.abstract",
  "Literature.customFields.outlineResearchProblem",
  "Literature.customFields.outlineApplicationObject",
  "Literature.customFields.outlineMethodOverview",
  "Literature.customFields.outlineMainConclusion",
  "Literature.customFields.outlineLimitations",
  "Literature.customFields.outlineOther",
  "Candidate manuscript draft (explicit user confirmation required)"
] as const;

export const LITERATURE_PROJECT_ADAPTATION_FUTURE_WRITE_TARGETS = [
  "Literature.customFields.knowledgeProjectSummary",
  "Literature.customFields.knowledgeProjectRelevance",
  "Literature.customFields.knowledgeRelatedObjectNotes",
  "Literature.customFields.knowledgeReusableMethods",
  "Literature.customFields.knowledgeComparableConclusions",
  "Literature.customFields.knowledgeOther",
  "LiteratureLink draft (explicit user confirmation required)",
  "Candidate manuscript draft (explicit user confirmation required)",
  "Task draft",
  "OutputGap draft"
] as const;

const INTRO_FIELD_SCHEMA: LiteratureAiFieldSchemaItem[] = [
  {
    field: "title",
    futureWriteTarget: "Literature.title",
    valueType: "string",
    required: true,
    description: "Canonical literature title."
  },
  {
    field: "authors",
    futureWriteTarget: "Literature.authors",
    valueType: "author_array",
    required: false,
    description: "Author names and optional affiliations."
  },
  {
    field: "year",
    futureWriteTarget: "Literature.year",
    valueType: "number",
    required: false,
    description: "Publication year."
  },
  {
    field: "venue",
    futureWriteTarget: "Literature.venue",
    valueType: "string",
    required: false,
    description: "Journal, conference, institution, or source."
  },
  {
    field: "publicationType",
    futureWriteTarget: "Literature.publicationType",
    valueType: "string",
    required: false,
    description: "Existing LiteratureType value."
  },
  {
    field: "doi",
    futureWriteTarget: "Literature.doi",
    valueType: "string",
    required: false,
    description: "DOI metadata only."
  },
  {
    field: "url",
    futureWriteTarget: "Literature.url",
    valueType: "string",
    required: false,
    description: "Source URL metadata only."
  },
  {
    field: "keywords",
    futureWriteTarget: "Literature.keywords",
    valueType: "string_array",
    required: false,
    description: "Literature keywords."
  }
];

const STRUCTURED_OUTLINE_FIELD_SCHEMA: LiteratureAiFieldSchemaItem[] = [
  {
    field: "abstract",
    futureWriteTarget: "Literature.abstract",
    valueType: "string",
    required: false,
    description: "User-provided or explicitly authorized abstract."
  },
  {
    field: "researchProblem",
    futureWriteTarget: "Literature.customFields.outlineResearchProblem",
    valueType: "string",
    required: false,
    description: "Objective research problem summary."
  },
  {
    field: "applicationObject",
    futureWriteTarget: "Literature.customFields.outlineApplicationObject",
    valueType: "string",
    required: false,
    description: "Research or application object."
  },
  {
    field: "methodOverview",
    futureWriteTarget: "Literature.customFields.outlineMethodOverview",
    valueType: "string",
    required: false,
    description: "Method overview."
  },
  {
    field: "mainConclusion",
    futureWriteTarget: "Literature.customFields.outlineMainConclusion",
    valueType: "string",
    required: false,
    description: "Main conclusion."
  },
  {
    field: "limitations",
    futureWriteTarget: "Literature.customFields.outlineLimitations",
    valueType: "string",
    required: false,
    description: "Limitations and uncertainty."
  },
  {
    field: "other",
    futureWriteTarget: "Literature.customFields.outlineOther",
    valueType: "string",
    required: false,
    description: "Other objective outline notes."
  }
];

const KNOWLEDGE_DEPOSIT_FIELD_SCHEMA: LiteratureAiFieldSchemaItem[] = [
  {
    field: "projectSummary",
    futureWriteTarget: "Literature.customFields.knowledgeProjectSummary",
    valueType: "string",
    required: false,
    description: "Project-specific value summary."
  },
  {
    field: "projectRelevance",
    futureWriteTarget: "Literature.customFields.knowledgeProjectRelevance",
    valueType: "string",
    required: false,
    description: "Relevance to the selected research project."
  },
  {
    field: "relatedObjectNotes",
    futureWriteTarget: "Literature.customFields.knowledgeRelatedObjectNotes",
    valueType: "string",
    required: false,
    description: "User-written notes about related research objects; not a LiteratureLink."
  },
  {
    field: "reusableMethods",
    futureWriteTarget: "Literature.customFields.knowledgeReusableMethods",
    valueType: "string",
    required: false,
    description: "Reusable method summary."
  },
  {
    field: "comparableConclusions",
    futureWriteTarget: "Literature.customFields.knowledgeComparableConclusions",
    valueType: "string",
    required: false,
    description: "Conclusions suitable for comparison."
  },
  {
    field: "other",
    futureWriteTarget: "Literature.customFields.knowledgeOther",
    valueType: "string",
    required: false,
    description: "Other project-oriented knowledge."
  }
];

function safeContextText(value: string | undefined, limit = 600) {
  const sanitized = (value ?? "")
    .replace(/[A-Za-z]:[\\/][^\s|)]+/g, "[local path redacted]")
    .replace(/\\\\[^\s|)]+/g, "[local path redacted]")
    .replace(/(^|[\s(])\/(?:Users|home|mnt|Volumes|var|tmp)\/[^\s)]+/g, "$1[local path redacted]")
    .trim();
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function entitySummaryItem(summary: EntitySummary): LiteratureProjectContextItem {
  return {
    id: summary.entityId,
    title: safeContextText(summary.title, 180),
    status: summary.status,
    summary: safeContextText(summary.subtitle, 360) || undefined
  };
}

function resolveProjectId(
  detailContext: LiteratureDetailContext,
  preferredProjectId?: EntityId
) {
  return (
    preferredProjectId ??
    detailContext.literature.primaryProjectId ??
    detailContext.readContext.knowledgeDeposit.linkedObjects.linkedProjects.find(
      (link) => !link.isMissing
    )?.targetId
  );
}

export async function buildProjectOrientedLiteratureContext(
  detailContext: LiteratureDetailContext,
  preferredProjectId?: EntityId
): Promise<ProjectOrientedLiteratureContext> {
  const projectId = resolveProjectId(detailContext, preferredProjectId);
  const baseProvenance = [...detailContext.readContext.provenance];
  if (!projectId) {
    return {
      literatureId: detailContext.literature.id,
      currentLiteratureIntro: detailContext.readContext.intro,
      currentLiteratureStructuredOutline: detailContext.readContext.structuredOutline,
      currentLiteratureManuscriptStatus: detailContext.readContext.manuscriptStatus,
      currentLiteratureKnowledgeDeposit: detailContext.readContext.knowledgeDeposit,
      routeSummary: [],
      taskProgressSummary: [],
      experimentProgressSummary: [],
      outputGapSummary: [],
      provenance: baseProvenance,
      warnings: ["No project is available for project-oriented literature context."],
      missing: ["projectContext"],
      partial: true
    };
  }

  const projectContext = await getProjectDetailContext(projectId);
  if (!projectContext) {
    return {
      literatureId: detailContext.literature.id,
      projectId,
      currentLiteratureIntro: detailContext.readContext.intro,
      currentLiteratureStructuredOutline: detailContext.readContext.structuredOutline,
      currentLiteratureManuscriptStatus: detailContext.readContext.manuscriptStatus,
      currentLiteratureKnowledgeDeposit: detailContext.readContext.knowledgeDeposit,
      routeSummary: [],
      taskProgressSummary: [],
      experimentProgressSummary: [],
      outputGapSummary: [],
      provenance: baseProvenance,
      warnings: [`Project context is unavailable: ${projectId}.`],
      missing: ["projectContext"],
      partial: true
    };
  }

  const planningProvenance: LiteratureContextProvenance = {
    section: "projectContext",
    sourceType: "planningSelector",
    sourceId: projectId,
    fields: [
      "currentProjectGoal",
      "researchDirection",
      "routeSummary",
      "taskProgressSummary",
      "experimentProgressSummary",
      "outputGapSummary"
    ]
  };
  const currentProjectGoal =
    projectContext.project.objective ??
    projectContext.project.researchQuestion ??
    projectContext.project.scope;
  const researchDirection = [
    projectContext.project.background,
    projectContext.project.researchQuestion,
    projectContext.project.scope
  ]
    .filter(Boolean)
    .join(" | ");
  const safeCurrentProjectGoal = safeContextText(currentProjectGoal, 800);
  const safeResearchDirection = safeContextText(researchDirection, 1000);
  const missing = [
    ...(!safeCurrentProjectGoal ? ["currentProjectGoal"] : []),
    ...(!safeResearchDirection ? ["researchDirection"] : [])
  ];
  const warnings = [
    ...detailContext.readContext.warnings,
    ...projectContext.warnings,
    ...projectContext.missingReferences.map(
      (reference) =>
        `Missing project-context reference ${reference.targetType}:${reference.targetId}.`
    )
  ].map((warning) => safeContextText(warning, 500));

  return {
    literatureId: detailContext.literature.id,
    projectId,
    currentProjectGoal: safeCurrentProjectGoal || undefined,
    researchDirection: safeResearchDirection || undefined,
    routeSummary: projectContext.routeNodes.slice(0, 12).map(entitySummaryItem),
    taskProgressSummary: projectContext.tasks.slice(0, 20).map(entitySummaryItem),
    experimentProgressSummary: projectContext.crossModule.experiments
      .slice(0, 12)
      .map(entitySummaryItem),
    outputGapSummary: projectContext.crossModule.outputGaps.slice(0, 12).map(entitySummaryItem),
    currentLiteratureIntro: detailContext.readContext.intro,
    currentLiteratureStructuredOutline: detailContext.readContext.structuredOutline,
    currentLiteratureManuscriptStatus: detailContext.readContext.manuscriptStatus,
    currentLiteratureKnowledgeDeposit: detailContext.readContext.knowledgeDeposit,
    provenance: [...baseProvenance, planningProvenance],
    warnings: [...new Set(warnings)],
    missing,
    partial:
      detailContext.readContext.partial ||
      projectContext.partial ||
      warnings.length > 0 ||
      missing.length > 0
  };
}

function missingAdapterWarnings(literatureId: EntityId) {
  return [`Literature context is unavailable: ${literatureId}.`];
}

export async function buildLiteratureObjectiveOutlineAiInput(
  literatureId: EntityId
): Promise<LiteratureObjectiveOutlineAiInput> {
  const detailContext = await getLiteratureDetailContext(literatureId);
  if (!detailContext) {
    return {
      adapterVersion: "lp6-5",
      stage: "objective_outline",
      literatureId,
      currentLiteratureSnapshot: null,
      missingFieldHints: ["literature"],
      introFieldSchema: INTRO_FIELD_SCHEMA,
      structuredOutlineFieldSchema: STRUCTURED_OUTLINE_FIELD_SCHEMA,
      filePathSummary: null,
      allowedUserInputTypes: [
        "metadata",
        "abstract",
        "manual_text",
        "reading_markdown_preview",
        "project_specific_notes_markdown_preview"
      ],
      constraintDocumentHint:
        "Read-only adapter. No PDF or local file body is loaded. Full literature outline Markdown and project-specific notes Markdown require explicit user confirmation in a future flow.",
      futureWriteTargets: [...LITERATURE_OBJECTIVE_OUTLINE_FUTURE_WRITE_TARGETS],
      provenance: [],
      warnings: missingAdapterWarnings(literatureId),
      missing: ["literatureContext"],
      partial: true,
      requiresUserConfirmation: true
    };
  }

  const readContext = detailContext.readContext;
  return {
    adapterVersion: "lp6-5",
    stage: "objective_outline",
    literatureId,
    currentLiteratureSnapshot: {
      readingStatus: readContext.readingStatus,
      intro: readContext.intro,
      structuredOutline: readContext.structuredOutline,
      manuscriptStatus: readContext.manuscriptStatus
    },
    missingFieldHints: readContext.fieldStates
      .filter((state) => !state.hasValue && Boolean(state.futureAiSuggestionTarget))
      .map((state) => state.field),
    introFieldSchema: INTRO_FIELD_SCHEMA,
    structuredOutlineFieldSchema: STRUCTURED_OUTLINE_FIELD_SCHEMA,
    filePathSummary: readContext.filePaths,
    allowedUserInputTypes: [
      "metadata",
      "abstract",
      "manual_text",
      "reading_markdown_preview",
      "project_specific_notes_markdown_preview"
    ],
    constraintDocumentHint:
      "Use whitelisted summaries only. PDF and local file bodies are absent. Full literature outline Markdown and project-specific notes Markdown are absent unless a future user-confirmed flow explicitly supplies them.",
    futureWriteTargets: [...LITERATURE_OBJECTIVE_OUTLINE_FUTURE_WRITE_TARGETS],
    provenance: readContext.provenance,
    warnings: readContext.warnings,
    missing: readContext.missingFields,
    partial: readContext.partial,
    requiresUserConfirmation: true
  };
}

export async function buildLiteratureProjectAdaptationAiInput(
  literatureId: EntityId,
  options: {
    projectId?: EntityId;
    objectiveOutlineReportSummaryOrReference?: string;
  } = {}
): Promise<LiteratureProjectAdaptationAiInput> {
  const detailContext = await getLiteratureDetailContext(literatureId);
  if (!detailContext) {
    return {
      adapterVersion: "lp6-5",
      stage: "project_adaptation",
      literatureId,
      objectiveOutlineReportSummaryOrReference:
        safeContextText(options.objectiveOutlineReportSummaryOrReference, 1200) || undefined,
      currentLiteratureIntro: null,
      currentLiteratureStructuredOutline: null,
      currentLiteratureManuscriptStatus: null,
      currentLiteratureKnowledgeDeposit: null,
      existingLinkedObjectSummary: null,
      projectContext: null,
      knowledgeDepositFieldSchema: KNOWLEDGE_DEPOSIT_FIELD_SCHEMA,
      futureWriteTargets: [...LITERATURE_PROJECT_ADAPTATION_FUTURE_WRITE_TARGETS],
      provenance: [],
      warnings: missingAdapterWarnings(literatureId),
      missing: ["literatureContext", "projectContext"],
      partial: true,
      requiresUserConfirmation: true
    };
  }

  const projectContext = await buildProjectOrientedLiteratureContext(
    detailContext,
    options.projectId
  );
  const readContext = detailContext.readContext;
  const warnings = [...new Set([...readContext.warnings, ...projectContext.warnings])];
  const missing = [...new Set([...readContext.missingFields, ...projectContext.missing])];
  return {
    adapterVersion: "lp6-5",
    stage: "project_adaptation",
    literatureId,
    objectiveOutlineReportSummaryOrReference:
      safeContextText(options.objectiveOutlineReportSummaryOrReference, 1200) || undefined,
    currentLiteratureIntro: readContext.intro,
    currentLiteratureStructuredOutline: readContext.structuredOutline,
    currentLiteratureManuscriptStatus: readContext.manuscriptStatus,
    currentLiteratureKnowledgeDeposit: readContext.knowledgeDeposit,
    existingLinkedObjectSummary: readContext.knowledgeDeposit.linkedObjects,
    projectContext,
    knowledgeDepositFieldSchema: KNOWLEDGE_DEPOSIT_FIELD_SCHEMA,
    futureWriteTargets: [...LITERATURE_PROJECT_ADAPTATION_FUTURE_WRITE_TARGETS],
    provenance: projectContext.provenance,
    warnings,
    missing,
    partial:
      readContext.partial ||
      projectContext.partial ||
      warnings.length > 0 ||
      missing.length > 0,
    requiresUserConfirmation: true
  };
}

export const literatureAiInputAdapterService = {
  buildProjectOrientedLiteratureContext,
  buildLiteratureObjectiveOutlineAiInput,
  buildLiteratureProjectAdaptationAiInput
};

export type LiteratureAiInputAdapterService = typeof literatureAiInputAdapterService;
