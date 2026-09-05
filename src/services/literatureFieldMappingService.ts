import type {
  CustomField,
  EntityId,
  Literature,
  LiteratureLink,
  LiteratureLinkTargetType
} from "../types";
import type {
  LiteratureContextFieldState,
  LiteratureContextProvenance,
  LiteratureFileRefSummary,
  LiteratureFilePathContextSummary,
  LiteratureIntroSummary,
  LiteratureKnowledgeDepositSummary,
  LiteratureKnowledgeDepositContextSummary,
  LiteratureLinkedObjectContextSummary,
  LiteratureLinkedObjectItemSummary,
  LiteratureLinkSummary,
  LiteratureMarkdownContextSummary,
  LiteratureMarkdownFileRefSummary,
  LiteratureMarkdownLinkSummary,
  LiteratureManuscriptStatusSummary,
  LiteratureMarkdownReadonlyContextItem,
  LiteratureReadContext,
  LiteratureStructuredOutlineSummary
} from "../types/literatureContext";

export const LITERATURE_CUSTOM_FIELD_KEYS = {
  outlineResearchProblem: "outlineResearchProblem",
  outlineApplicationObject: "outlineApplicationObject",
  outlineMethodOverview: "outlineMethodOverview",
  outlineMainConclusion: "outlineMainConclusion",
  outlineLimitations: "outlineLimitations",
  outlineOther: "outlineOther",
  knowledgeProjectSummary: "knowledgeProjectSummary",
  knowledgeProjectRelevance: "knowledgeProjectRelevance",
  knowledgeRelatedObjectNotes: "knowledgeRelatedObjectNotes",
  knowledgeReusableMethods: "knowledgeReusableMethods",
  knowledgeComparableConclusions: "knowledgeComparableConclusions",
  knowledgeOther: "knowledgeOther",
  venueRank: "venueRank",
  venueNote: "venueNote"
} as const;

export type LiteratureCustomFieldKey =
  (typeof LITERATURE_CUSTOM_FIELD_KEYS)[keyof typeof LITERATURE_CUSTOM_FIELD_KEYS];

export type LiteratureCustomFieldPatch = Partial<
  Record<LiteratureCustomFieldKey, string | number | boolean | string[] | null | undefined>
>;

export const LITERATURE_CONTROLLED_CUSTOM_FIELD_KEYS = Object.values(
  LITERATURE_CUSTOM_FIELD_KEYS
);

function findCustomField(
  customFields: CustomField[] | undefined,
  key: LiteratureCustomFieldKey
) {
  return (customFields ?? []).find((field) => field.name === key || field.id === key);
}

function trimToUndefined(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function redactAbsolutePaths(value: string) {
  return value
    .replace(/[A-Za-z]:[\\/][^\s|)]+/g, "[local path redacted]")
    .replace(/\\\\[^\s|)]+/g, "[local path redacted]")
    .replace(/(^|[\s(])\/(?:Users|home|mnt|Volumes|var|tmp)\/[^\s)]+/g, "$1[local path redacted]");
}

function safePreview(value: string | undefined, limit: number) {
  const sanitized = redactAbsolutePaths(value ?? "").trim();
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function safePathDisplayName(path: string) {
  const displayName = path.split(/[\\/]/).filter(Boolean).pop();
  return displayName ? redactAbsolutePaths(displayName) : "[local path hidden]";
}

function fieldGroup(key: LiteratureCustomFieldKey) {
  if (key.startsWith("outline")) return "literatureStructuredOutline";
  if (key.startsWith("knowledge")) return "literatureKnowledgeDeposit";
  if (key.startsWith("venue")) return "literatureIntro";
  return "literature";
}

function toCustomField(
  key: LiteratureCustomFieldKey,
  value: NonNullable<LiteratureCustomFieldPatch[LiteratureCustomFieldKey]>
): CustomField {
  return {
    id: key,
    name: key,
    value,
    valueType: Array.isArray(value) ? "multi_select" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text",
    group: fieldGroup(key)
  };
}

function formatAuthors(literature: Literature) {
  return literature.authors.map((author) => author.name).filter(Boolean).join(", ");
}

function sortImportantLinks(links: LiteratureLinkSummary[]) {
  const strengthRank = new Map<LiteratureLink["strength"] | undefined, number>([
    ["strong", 0],
    ["medium", 1],
    ["weak", 2],
    ["uncertain", 3],
    [undefined, 4]
  ]);
  const confidenceRank = new Map<LiteratureLink["confidence"] | undefined, number>([
    ["confirmed", 0],
    ["probable", 1],
    ["tentative", 2],
    ["ai_suggested", 3],
    [undefined, 4]
  ]);

  return [...links]
    .sort((left, right) => {
      const strengthDiff =
        (strengthRank.get(left.strength) ?? 4) - (strengthRank.get(right.strength) ?? 4);
      const confidenceDiff =
        (confidenceRank.get(left.confidence) ?? 4) -
        (confidenceRank.get(right.confidence) ?? 4);
      return strengthDiff || confidenceDiff || left.linkId.localeCompare(right.linkId);
    })
    .slice(0, 5);
}

function appendReadonlyItem(
  items: LiteratureMarkdownReadonlyContextItem[],
  item: LiteratureMarkdownReadonlyContextItem
) {
  if (item.value.trim()) items.push(item);
}

export function getLiteratureCustomStringField(
  literature: Pick<Literature, "customFields">,
  key: LiteratureCustomFieldKey
) {
  const field = findCustomField(literature.customFields, key);
  return typeof field?.value === "string" ? field.value : "";
}

export function mergeLiteratureCustomFields(
  literature: Pick<Literature, "customFields">,
  patch: LiteratureCustomFieldPatch
): CustomField[] {
  const patchEntries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<
    [LiteratureCustomFieldKey, NonNullable<LiteratureCustomFieldPatch[LiteratureCustomFieldKey]> | null]
  >;
  const patchedKeys = new Set(patchEntries.map(([key]) => key));
  const preservedFields = (literature.customFields ?? []).filter((field) => {
    const idMatches = patchedKeys.has(field.id as LiteratureCustomFieldKey);
    const nameMatches = patchedKeys.has(field.name as LiteratureCustomFieldKey);
    return !idMatches && !nameMatches;
  });
  const nextFields: CustomField[] = [];
  patchEntries.forEach(([key, value]) => {
    if (value !== null) {
      nextFields.push(toCustomField(key, value));
    }
  });

  return [...preservedFields, ...nextFields];
}

export function buildLiteratureIntroSummary(literature: Literature): LiteratureIntroSummary {
  return {
    title: literature.title,
    authors: literature.authors,
    year: literature.year,
    venue: literature.venue,
    publicationType: literature.publicationType,
    doi: literature.doi,
    url: literature.url,
    importance: literature.importance,
    keywords: literature.keywords ?? [],
    venueRank: trimToUndefined(
      getLiteratureCustomStringField(literature, LITERATURE_CUSTOM_FIELD_KEYS.venueRank)
    ),
    venueNote: trimToUndefined(
      getLiteratureCustomStringField(literature, LITERATURE_CUSTOM_FIELD_KEYS.venueNote)
    )
  };
}

export function buildLiteratureStructuredOutlineSummary(
  literature: Literature
): LiteratureStructuredOutlineSummary {
  return {
    abstract: trimToUndefined(literature.abstract),
    researchProblem: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.outlineResearchProblem
      )
    ),
    applicationObject: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.outlineApplicationObject
      )
    ),
    methodOverview: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.outlineMethodOverview
      )
    ),
    mainConclusion: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.outlineMainConclusion
      )
    ),
    limitations: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.outlineLimitations
      )
    ),
    other: trimToUndefined(
      getLiteratureCustomStringField(literature, LITERATURE_CUSTOM_FIELD_KEYS.outlineOther)
    )
  };
}

export function buildLiteratureKnowledgeDepositSummary(
  literature: Literature,
  linkSummaries: LiteratureLinkSummary[]
): LiteratureKnowledgeDepositSummary {
  return {
    projectSummary: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectSummary
      )
    ),
    projectRelevance: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectRelevance
      )
    ),
    relatedObjectNotes: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeRelatedObjectNotes
      )
    ),
    reusableMethods: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeReusableMethods
      )
    ),
    comparableConclusions: trimToUndefined(
      getLiteratureCustomStringField(
        literature,
        LITERATURE_CUSTOM_FIELD_KEYS.knowledgeComparableConclusions
      )
    ),
    other: trimToUndefined(
      getLiteratureCustomStringField(literature, LITERATURE_CUSTOM_FIELD_KEYS.knowledgeOther)
    ),
    linkCount: linkSummaries.length,
    importantLinks: sortImportantLinks(linkSummaries)
  };
}

function toMarkdownFileRefSummary(
  fileRef: LiteratureFileRefSummary
): LiteratureMarkdownFileRefSummary {
  return {
    id: fileRef.id,
    title: fileRef.title,
    fileType: fileRef.fileType,
    description: fileRef.description,
    pathSummary: fileRef.pathSummary
  };
}

function toMarkdownLinkSummary(summary: LiteratureLinkSummary): LiteratureMarkdownLinkSummary {
  return {
    linkId: summary.linkId,
    targetType: summary.targetType,
    targetId: summary.targetId,
    targetTitle: summary.target.title,
    relationType: summary.relationType,
    role: summary.role,
    strength: summary.strength,
    confidence: summary.confidence,
    description: summary.description,
    note: summary.note
  };
}

function buildReadonlyContextItems(input: {
  literature: Literature;
  intro: LiteratureIntroSummary;
  structuredOutline: LiteratureStructuredOutlineSummary;
  knowledgeDeposit: LiteratureKnowledgeDepositSummary;
  fileRefs: LiteratureMarkdownFileRefSummary[];
  linkSummaries: LiteratureMarkdownLinkSummary[];
}) {
  const items: LiteratureMarkdownReadonlyContextItem[] = [];
  appendReadonlyItem(items, {
    label: "Title",
    value: input.intro.title,
    source: "intro",
    sourceId: input.literature.id
  });
  appendReadonlyItem(items, {
    label: "Authors",
    value: formatAuthors(input.literature),
    source: "intro",
    sourceId: input.literature.id
  });
  appendReadonlyItem(items, {
    label: "Venue",
    value: [input.intro.venue, input.intro.year].filter(Boolean).join(" "),
    source: "intro",
    sourceId: input.literature.id
  });
  appendReadonlyItem(items, {
    label: "Structured outline",
    value: [
      input.structuredOutline.researchProblem,
      input.structuredOutline.methodOverview,
      input.structuredOutline.mainConclusion
    ]
      .filter(Boolean)
      .join(" | "),
    source: "structuredOutline",
    sourceId: input.literature.id
  });
  appendReadonlyItem(items, {
    label: "Project-specific notes",
    value: [
      input.knowledgeDeposit.projectSummary,
      input.knowledgeDeposit.projectRelevance,
      input.knowledgeDeposit.relatedObjectNotes,
      input.knowledgeDeposit.reusableMethods,
      input.knowledgeDeposit.comparableConclusions
    ]
      .filter(Boolean)
      .join(" | "),
    source: "knowledgeDeposit",
    sourceId: input.literature.id
  });
  input.fileRefs.slice(0, 5).forEach((fileRef) => {
    appendReadonlyItem(items, {
      label: `Path ${fileRef.title}`,
      value: [fileRef.fileType, fileRef.pathSummary, fileRef.description].filter(Boolean).join(" | "),
      source: "fileRef",
      sourceId: fileRef.id
    });
  });
  input.linkSummaries.slice(0, 5).forEach((link) => {
    appendReadonlyItem(items, {
      label: `Link ${link.targetTitle ?? link.targetId}`,
      value: [link.relationType, link.role, link.description].filter(Boolean).join(" | "),
      source: "link",
      sourceId: link.linkId
    });
  });
  return items;
}

export function buildLiteratureMarkdownContextSummary(input: {
  literature: Literature;
  linkSummaries: LiteratureLinkSummary[];
  fileRefs: LiteratureFileRefSummary[];
  manuscriptStatus: LiteratureManuscriptStatusSummary;
}): LiteratureMarkdownContextSummary {
  const intro = buildLiteratureIntroSummary(input.literature);
  const structuredOutline = buildLiteratureStructuredOutlineSummary(input.literature);
  const knowledgeDeposit = buildLiteratureKnowledgeDepositSummary(
    input.literature,
    input.linkSummaries
  );
  const fileRefs = input.fileRefs.map(toMarkdownFileRefSummary);
  const linkSummaries = input.linkSummaries.map(toMarkdownLinkSummary);
  const readonlyContextItems = buildReadonlyContextItems({
    literature: input.literature,
    intro,
    structuredOutline,
    knowledgeDeposit,
    fileRefs,
    linkSummaries
  });

  return {
    intro,
    structuredOutline,
    knowledgeDeposit,
    fileRefs,
    linkSummaries,
    readonlyContextItems,
    manuscriptStatus: input.manuscriptStatus
  };
}

function countBy<T extends string>(items: T[]) {
  return items.reduce<Partial<Record<T, number>>>((counts, item) => {
    counts[item] = (counts[item] ?? 0) + 1;
    return counts;
  }, {});
}

export function buildLiteratureFilePathContextSummary(
  fileRefs: LiteratureFileRefSummary[],
  literature?: Pick<Literature, "id" | "pdfPath" | "localFilePath">
): LiteratureFilePathContextSummary {
  const sourcePathItems = [
    ...(literature?.pdfPath
      ? [
          {
            id: `${literature.id}:source-pdf-path`,
            displayName: safePathDisplayName(literature.pdfPath),
            fileType: "pdf",
            pathSummary: safePathDisplayName(literature.pdfPath),
            canOpen: true,
            canCopyPath: true,
            canRevealInFolder: true
          }
        ]
      : []),
    ...(literature?.localFilePath
      ? [
          {
            id: `${literature.id}:source-local-file-path`,
            displayName: safePathDisplayName(literature.localFilePath),
            fileType: "other",
            pathSummary: safePathDisplayName(literature.localFilePath),
            canOpen: true,
            canCopyPath: true,
            canRevealInFolder: true
          }
        ]
      : [])
  ];
  const fileRefItems = fileRefs.slice(0, 20).map((fileRef) => ({
    id: fileRef.id,
    displayName: fileRef.title || fileRef.pathSummary,
    fileType: fileRef.fileType,
    description: trimToUndefined(redactAbsolutePaths(fileRef.description ?? "")),
    pathSummary: redactAbsolutePaths(fileRef.pathSummary),
    canOpen: Boolean(fileRef.path),
    canCopyPath: Boolean(fileRef.path),
    canRevealInFolder: Boolean(fileRef.path)
  }));
  const items = [...fileRefItems, ...sourcePathItems];
  const types = [...fileRefs.map((fileRef) => fileRef.fileType), ...sourcePathItems.map((item) => item.fileType)];
  return {
    hasPdf: types.includes("pdf"),
    hasSupplement: types.includes("supplement"),
    hasExternalNote: types.includes("external_note"),
    hasImageOrScreenshot: types.some((type) => type === "image" || type === "screenshot"),
    hasCodeOrDataReference: types.some(
      (type) => type === "code_or_data" || type === "code" || type === "data_folder"
    ),
    fileCount: fileRefs.length + sourcePathItems.length,
    fileTypeDistribution: countBy(types),
    items,
    fullPathsExcludedFromAiReadyContext: true,
    fileBodiesIncluded: false
  };
}

function linkedObjectGroup(
  items: LiteratureLinkedObjectItemSummary[],
  targetType: LiteratureLinkTargetType
) {
  return items.filter((item) => item.targetType === targetType);
}

export function buildLiteratureLinkedObjectContextSummary(
  linkSummaries: LiteratureLinkSummary[]
): LiteratureLinkedObjectContextSummary {
  const all = linkSummaries
    .filter((summary) =>
      [
        "project",
        "route",
        "task",
        "experiment",
        "experimentRun",
        "resultMetric",
        "finding",
        "outputCandidate",
        "outputGap",
        "output",
        "review"
      ].includes(summary.targetType)
    )
    .map((summary): LiteratureLinkedObjectItemSummary => {
      const isMissing = !summary.target.sourceAvailable;
      return {
        linkId: summary.linkId,
        targetType: summary.targetType,
        targetId: summary.targetId,
        targetTitle: trimToUndefined(safePreview(summary.target.title, 180)),
        status: summary.target.status,
        relationType: summary.relationType,
        role: summary.role,
        description: trimToUndefined(safePreview(summary.description, 280)),
        confidence: summary.confidence,
        isMissing,
        warning: isMissing
          ? safePreview(
              summary.target.missingReason ?? `Linked ${summary.targetType} is unavailable.`,
              500
            )
          : undefined
      };
    });
  const warnings = all.flatMap((item) => (item.warning ? [item.warning] : []));
  return {
    all,
    linkedProjects: linkedObjectGroup(all, "project"),
    linkedRoutes: linkedObjectGroup(all, "route"),
    linkedTasks: linkedObjectGroup(all, "task"),
    linkedExperiments: linkedObjectGroup(all, "experiment"),
    linkedExperimentRuns: linkedObjectGroup(all, "experimentRun"),
    linkedResultMetrics: linkedObjectGroup(all, "resultMetric"),
    linkedFindings: linkedObjectGroup(all, "finding"),
    linkedOutputCandidates: linkedObjectGroup(all, "outputCandidate"),
    linkedOutputGaps: linkedObjectGroup(all, "outputGap"),
    linkedOutputs: linkedObjectGroup(all, "output"),
    linkedReviews: linkedObjectGroup(all, "review"),
    warnings,
    partial: warnings.length > 0
  };
}

function buildFieldState(
  field: string,
  value: unknown,
  futureAiSuggestionTarget?: string,
  required = false
): LiteratureContextFieldState {
  const hasValue = Array.isArray(value)
    ? value.length > 0
    : typeof value === "string"
      ? Boolean(value.trim())
      : value !== undefined && value !== null;
  return {
    field,
    status: hasValue ? "implemented" : required ? "warning" : "missing",
    hasValue,
    futureAiSuggestionTarget,
    requiresUserConfirmation: Boolean(futureAiSuggestionTarget),
    warning: !hasValue && required ? `${field} is required but unavailable.` : undefined
  };
}

export function buildLiteratureReadContext(input: {
  literature: Literature;
  linkSummaries: LiteratureLinkSummary[];
  fileRefs: LiteratureFileRefSummary[];
  manuscriptStatus: LiteratureManuscriptStatusSummary;
  warnings?: string[];
  missingReferenceWarnings?: string[];
}): LiteratureReadContext {
  const rawIntro = buildLiteratureIntroSummary(input.literature);
  const intro: LiteratureIntroSummary = {
    ...rawIntro,
    title: safePreview(rawIntro.title, 300),
    authors: rawIntro.authors.slice(0, 30).map((author) => ({
      ...author,
      name: safePreview(author.name, 160),
      affiliation: trimToUndefined(safePreview(author.affiliation, 220)),
      orcid: trimToUndefined(safePreview(author.orcid, 80))
    })),
    venue: trimToUndefined(safePreview(rawIntro.venue, 240)),
    doi: trimToUndefined(safePreview(rawIntro.doi, 180)),
    url: trimToUndefined(safePreview(rawIntro.url, 500)),
    keywords: rawIntro.keywords.slice(0, 30).map((keyword) => safePreview(keyword, 100)),
    venueRank: trimToUndefined(safePreview(rawIntro.venueRank, 100)),
    venueNote: trimToUndefined(safePreview(rawIntro.venueNote, 400))
  };
  const rawStructuredOutline = buildLiteratureStructuredOutlineSummary(input.literature);
  const structuredOutline: LiteratureStructuredOutlineSummary = {
    abstract: trimToUndefined(safePreview(rawStructuredOutline.abstract, 1800)),
    researchProblem: trimToUndefined(safePreview(rawStructuredOutline.researchProblem, 1000)),
    applicationObject: trimToUndefined(safePreview(rawStructuredOutline.applicationObject, 800)),
    methodOverview: trimToUndefined(safePreview(rawStructuredOutline.methodOverview, 1400)),
    mainConclusion: trimToUndefined(safePreview(rawStructuredOutline.mainConclusion, 1400)),
    limitations: trimToUndefined(safePreview(rawStructuredOutline.limitations, 1000)),
    other: trimToUndefined(safePreview(rawStructuredOutline.other, 1000))
  };
  const linkedObjects = buildLiteratureLinkedObjectContextSummary(input.linkSummaries);
  const filePaths = buildLiteratureFilePathContextSummary(input.fileRefs, input.literature);
  const knowledgeDeposit: LiteratureKnowledgeDepositContextSummary = {
    projectSummary: trimToUndefined(
      safePreview(
        getLiteratureCustomStringField(
          input.literature,
          LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectSummary
        ),
        1200
      )
    ),
    projectRelevance: trimToUndefined(
      safePreview(
        getLiteratureCustomStringField(
          input.literature,
          LITERATURE_CUSTOM_FIELD_KEYS.knowledgeProjectRelevance
        ),
        1200
      )
    ),
    relatedObjectNotes: trimToUndefined(
      safePreview(
        getLiteratureCustomStringField(
          input.literature,
          LITERATURE_CUSTOM_FIELD_KEYS.knowledgeRelatedObjectNotes
        ),
        1200
      )
    ),
    reusableMethods: trimToUndefined(
      safePreview(
        getLiteratureCustomStringField(
          input.literature,
          LITERATURE_CUSTOM_FIELD_KEYS.knowledgeReusableMethods
        ),
        1200
      )
    ),
    comparableConclusions: trimToUndefined(
      safePreview(
        getLiteratureCustomStringField(
          input.literature,
          LITERATURE_CUSTOM_FIELD_KEYS.knowledgeComparableConclusions
        ),
        1200
      )
    ),
    other: trimToUndefined(
      safePreview(
        getLiteratureCustomStringField(
          input.literature,
          LITERATURE_CUSTOM_FIELD_KEYS.knowledgeOther
        ),
        1000
      )
    ),
    linkedObjects
  };
  const outlineValues = Object.values(structuredOutline).filter(Boolean);
  const knowledgeValues = [
    knowledgeDeposit.projectSummary,
    knowledgeDeposit.projectRelevance,
    knowledgeDeposit.relatedObjectNotes,
    knowledgeDeposit.reusableMethods,
    knowledgeDeposit.comparableConclusions,
    knowledgeDeposit.other
  ].filter(Boolean);
  const hasKnowledgeContext =
    knowledgeValues.length > 0 ||
    linkedObjects.all.length > 0;
  const fieldStates: LiteratureContextFieldState[] = [
    {
      field: "introSection",
      status: intro.title ? "implemented" : "warning",
      hasValue: Boolean(intro.title),
      requiresUserConfirmation: false,
      warning: intro.title ? undefined : "Literature intro is missing its required title."
    },
    {
      field: "structuredOutlineSection",
      status:
        outlineValues.length === Object.keys(structuredOutline).length
          ? "implemented"
          : outlineValues.length > 0
            ? "partial"
            : "missing",
      hasValue: outlineValues.length > 0,
      requiresUserConfirmation: true
    },
    {
      field: "knowledgeDepositSection",
      status:
        knowledgeValues.length === 6
          ? "implemented"
          : hasKnowledgeContext
            ? "partial"
            : "missing",
      hasValue: hasKnowledgeContext,
      requiresUserConfirmation: true
    },
    buildFieldState("title", intro.title, "Literature.title", true),
    buildFieldState("authors", intro.authors, "Literature.authors"),
    buildFieldState("year", intro.year, "Literature.year"),
    buildFieldState("venue", intro.venue, "Literature.venue"),
    buildFieldState("publicationType", intro.publicationType, "Literature.publicationType"),
    buildFieldState("doi", intro.doi, "Literature.doi"),
    buildFieldState("url", intro.url, "Literature.url"),
    buildFieldState("keywords", intro.keywords, "Literature.keywords"),
    buildFieldState("abstract", structuredOutline.abstract, "Literature.abstract"),
    buildFieldState(
      "researchProblem",
      structuredOutline.researchProblem,
      "Literature.customFields.outlineResearchProblem"
    ),
    buildFieldState(
      "applicationObject",
      structuredOutline.applicationObject,
      "Literature.customFields.outlineApplicationObject"
    ),
    buildFieldState(
      "methodOverview",
      structuredOutline.methodOverview,
      "Literature.customFields.outlineMethodOverview"
    ),
    buildFieldState(
      "mainConclusion",
      structuredOutline.mainConclusion,
      "Literature.customFields.outlineMainConclusion"
    ),
    buildFieldState(
      "limitations",
      structuredOutline.limitations,
      "Literature.customFields.outlineLimitations"
    ),
    buildFieldState(
      "projectSummary",
      knowledgeDeposit.projectSummary,
      "Literature.customFields.knowledgeProjectSummary"
    ),
    buildFieldState(
      "projectRelevance",
      knowledgeDeposit.projectRelevance,
      "Literature.customFields.knowledgeProjectRelevance"
    ),
    buildFieldState(
      "relatedObjectNotes",
      knowledgeDeposit.relatedObjectNotes,
      "Literature.customFields.knowledgeRelatedObjectNotes"
    ),
    buildFieldState(
      "reusableMethods",
      knowledgeDeposit.reusableMethods,
      "Literature.customFields.knowledgeReusableMethods"
    ),
    buildFieldState(
      "comparableConclusions",
      knowledgeDeposit.comparableConclusions,
      "Literature.customFields.knowledgeComparableConclusions"
    ),
    buildFieldState(
      "knowledgeOther",
      knowledgeDeposit.other,
      "Literature.customFields.knowledgeOther"
    ),
    {
      field: "currentManuscriptBody",
      status: input.manuscriptStatus.manuscriptStatus === "ready"
        ? "requires_user_confirmation"
        : "not_available",
      hasValue: input.manuscriptStatus.manuscriptStatus === "ready",
      requiresUserConfirmation: input.manuscriptStatus.manuscriptStatus === "ready",
      warning: input.manuscriptStatus.manuscriptStatus === "ready"
        ? "Current Markdown body is not read by selectors and requires a future explicit user-confirmed read."
        : undefined
    },
    {
      field: "pdfContent",
      status: "not_available",
      hasValue: false,
      requiresUserConfirmation: filePaths.hasPdf,
      warning: filePaths.hasPdf
        ? "PDF exists, but content is not loaded by design."
        : "PDF content is not part of the default AI-ready context."
    },
    {
      field: "absoluteFilePaths",
      status: "not_available",
      hasValue: false,
      requiresUserConfirmation: false,
      warning:
        filePaths.fileCount > 0
          ? "Absolute file path hidden from AI-ready context by design."
          : "Absolute file paths are not part of the default AI-ready context."
    }
  ];
  const missingFields = fieldStates
    .filter((state) => state.status === "missing" || state.status === "warning")
    .map((state) => state.field);
  const warnings = [
    ...(input.warnings ?? []),
    ...(input.missingReferenceWarnings ?? []),
    ...linkedObjects.warnings,
    ...(filePaths.hasPdf ? ["PDF exists, but content was not loaded."] : []),
    ...(filePaths.fileCount > 0
      ? ["Absolute file paths are hidden from the read-only AI-ready context."]
      : []),
    ...(input.manuscriptStatus.manuscriptStatus === "ready"
      ? ["Current Markdown body is not read by the default literature context."]
      : [])
  ];
  const provenance: LiteratureContextProvenance[] = [
    {
      section: "intro",
      sourceType: "literature",
      sourceId: input.literature.id,
      fields: Object.keys(intro)
    },
    {
      section: "structuredOutline",
      sourceType: "customField",
      sourceId: input.literature.id,
      fields: Object.keys(structuredOutline)
    },
    {
      section: "knowledgeDeposit",
      sourceType: "customField",
      sourceId: input.literature.id,
      fields: [
        "projectSummary",
        "projectRelevance",
        "relatedObjectNotes",
        "reusableMethods",
        "comparableConclusions",
        "other"
      ]
    },
    {
      section: "manuscriptBinding",
      sourceType: "manuscriptBinding",
      sourceId: input.literature.id,
      fields: ["hasBinding", "currentFileRefId", "currentFileName", "currentLocationMode", "manuscriptStatus"]
    },
    ...linkedObjects.all.map(
      (link): LiteratureContextProvenance => ({
        section: "literatureLink",
        sourceType: "literatureLink",
        sourceId: link.linkId,
        fields: ["targetType", "targetTitle", "relationType", "role", "description"]
      })
    ),
    ...filePaths.items.map((file): LiteratureContextProvenance => {
      const isSourcePath = file.id.startsWith(`${input.literature.id}:source-`);
      return {
        section: "fileRef",
        sourceType: isSourcePath ? "literature" : "fileRef",
        sourceId: isSourcePath ? input.literature.id : file.id,
        fields: ["displayName", "fileType", "description", "pathSummary"]
      };
    })
  ];
  return {
    literatureId: input.literature.id,
    readingStatus: input.literature.readingStatus,
    intro,
    structuredOutline,
    knowledgeDeposit,
    filePaths,
    manuscriptStatus: input.manuscriptStatus,
    fieldStates,
    provenance,
    warnings: [...new Set(warnings.map((warning) => safePreview(warning, 500)))],
    missingFields,
    partial:
      warnings.length > 0 ||
      missingFields.length > 0 ||
      linkedObjects.partial,
    limitations: [
      "PDF and local file bodies are not included.",
      "Full local paths are excluded.",
      "Current Markdown body is excluded unless a future explicit user-confirmed flow reads it.",
      "This context is read-only and does not execute AI or business writes."
    ]
  };
}

export function buildLiteratureStructuredSummaries(input: {
  literature: Literature;
  linkSummaries: LiteratureLinkSummary[];
}) {
  return {
    introSummary: buildLiteratureIntroSummary(input.literature),
    structuredOutlineSummary: buildLiteratureStructuredOutlineSummary(input.literature),
    knowledgeDepositSummary: buildLiteratureKnowledgeDepositSummary(
      input.literature,
      input.linkSummaries
    )
  };
}
