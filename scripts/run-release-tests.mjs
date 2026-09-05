import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const nodeTests = [
  "src/app/primaryRouteStability.test.mjs",
  "src/repositories/dataSourceMode.behavior.test.mjs",
  "src/services/planningRepositoryEnvelope.behavior.test.mjs",
  "src/services/projectImportV1.behavior.test.mjs",
  "src/services/firstLaunchWorkspaceDemo.behavior.test.mjs",
  "src/services/sharedCurrentProjectSelection.behavior.test.mjs",
  "src/services/routeNodeDateNormalization.semantic.test.mjs",
  "src/services/routesLatestUpdateResolverService.test.mjs",
  "src/services/lp14A1F9TaskRouteRelation.behavior.test.mjs",
  "src/services/operationLogExplicitId.behavior.test.mjs",
  "src/services/businessOperationFeedbackF1.behavior.test.mjs",
  "src/services/operationCenterReviewRestore.behavior.test.mjs",
  "src/services/reviewPermanentDeleteCoordinator.behavior.test.mjs",
  "src/services/outputDeleteSafetyContract.semantic.test.mjs",
  "src/services/writeFeedbackOwnership.behavior.test.mjs",
  "src/services/experimentRunBusinessRules.test.mjs",
  "src/services/experimentPlanningRelation.behavior.test.mjs",
  "src/services/experimentRunGuard.test.mjs",
  "src/services/experimentCreatedLocalTime.test.mjs",
  "src/services/experimentResultItemSourceTargetMapping.semantic.test.mjs",
  "src/services/literatureOptionalProject.behavior.test.mjs",
  "src/services/literatureSelectionService.behavior.test.mjs",
  "src/services/literatureDetailAuthorityAggregation.behavior.test.mjs",
  "src/services/reviewLifecycleActionService.behavior.test.mjs",
  "src/services/reviewStructuredPersistenceConvergence.behavior.test.mjs",
  "src/services/reviewTargetEntityLinkService.semantic.test.mjs",
  "src/services/outputFiveLayerContract.semantic.test.mjs",
  "src/services/outputChainAggregationContract.semantic.test.mjs",
  "src/services/outputGapConfirmationContract.semantic.test.mjs",
  "src/services/outputConversionRelationsPersistenceContract.semantic.test.mjs",
  "src/services/outputRawManuscript.behavior.test.mjs",
  "src/services/unifiedManuscriptFoundation.behavior.test.mjs",
  "src/services/manuscriptBindingIdentity.behavior.test.mjs",
  "src/services/formalSwitchFoundation.behavior.test.mjs",
  "src/services/canonicalFormalSwitchArchiveConvergence.behavior.test.mjs",
  "src/services/ordinarySaveTenChannel.integration.test.mjs",
  "src/services/manuscriptStructuredOutlineArchive.behavior.test.mjs",
  "src/services/manuscriptProvisioningContract.behavior.test.mjs",
  "src/services/aiConversationApplicationService.behavior.test.mjs",
  "src/services/aiParseMechanicalRetry.behavior.test.mjs",
  "src/services/aiClient.streaming.behavior.test.mjs",
  "src/services/aiParseDynamicContextBudget.behavior.test.mjs",
  "src/services/aiContextB1A2.behavior.test.mjs",
  "src/services/lp14A1F29ContextRequestCanonicalFormatConvergence.behavior.test.mjs",
  "src/services/actionDraftConfirmApplicationService.behavior.test.mjs",
  "src/components/ai/AIParseDraftPanel.filePickerAdmission.behavior.test.mjs",
  "src/components/ai/assistantUIExternalStateAdapter.behavior.test.mjs",
  "src/components/layout/SharedAppLifecycleHost.behavior.test.mjs",
  "src/services/sharedCurrentProjectSelection.pageBindings.semantic.test.mjs"
];

const rustTestFilters = [
  "authorized_material::tests::lp15_a3_parse_draft_user_instruction_matches_frontend_source",
  "commands::ai::tests",
  "commands::ai_streaming::tests",
  "db::tests",
  "db::experiment_planning_relation::tests",
  "db::experiment_run_lifecycle::tests",
  "db::review_permanent_delete::tests",
  "db::manuscript_binding::tests",
  "managed_root_configuration::tests",
  "markdown_file::tests"
];

const requiredPaths = [
  ...nodeTests,
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "tests/fixtures/parse_dynamic_context_budget_v1.json",
  "tests/fixtures/windows_path_budget_utf16.tsv"
];
const missingPaths = requiredPaths.filter(
  (relativePath) => !existsSync(path.join(repositoryRoot, relativePath))
);

if (missingPaths.length > 0) {
  throw new Error(`Release test inputs are missing:\n${missingPaths.join("\n")}`);
}

function run(label, command, args) {
  console.log(`[release-tests] START ${label}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`[release-tests] PASS ${label}`);
}

run("node", process.execPath, [
  "--test",
  "--test-concurrency=1",
  "--test-reporter=dot",
  ...nodeTests.map((relativePath) => path.join(repositoryRoot, relativePath))
]);

const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
for (const filter of rustTestFilters) {
  run(`rust ${filter}`, cargo, [
    "test",
    "--locked",
    "--manifest-path",
    path.join(repositoryRoot, "src-tauri", "Cargo.toml"),
    "--lib",
    "--quiet",
    filter
  ]);
}

console.log(
  `[release-tests] PASS ${nodeTests.length} Node entry files and ${rustTestFilters.length} Rust test filters`
);
