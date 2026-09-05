import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("Parse Draft confirmation has no implicit or explicit native target-picker admission", async () => {
  const panel = await read("src/components/ai/AIParseDraftPanel.tsx");
  const host = await read("src/components/ai/GlobalAIChatPanel.tsx");

  assert.doesNotMatch(panel, /onPrepareResultTarget|onPrepareTarget|prepareTarget\(|选择保存位置|保存位置已选择/u);
  assert.doesNotMatch(host, /handlePrepareStandardResultTarget|onPrepareResultTarget/u);
  assert.match(panel, /function cardConfirm\([\s\S]*saveReviewedPayload\([\s\S]*CONFIRMED_READY_TO_EXECUTE/u);
  assert.match(panel, /function confirmExecute\([\s\S]*onConfirmResult/u);
});

test("formal manuscript effects use the existing managed Candidate writer without Save-As acceptance", async () => {
  const application = await read("src/services/aiStandardResultApplicationService.ts");
  const adapter = await read("src/services/aiStandardResultAdapterService.ts");
  const candidate = await read("src/services/standardOperationCandidateApplicationService.ts");

  assert.doesNotMatch(application, /prepareAIStandardResultTargetAcceptance|preparedParentManuscriptAuthorizationId|STANDARD_RESULT_TARGET_ACCEPTANCE_REQUIRED/u);
  assert.match(adapter, /const applyCandidate = input\.candidateEffectApplication \?\? applyStandardOperationCandidateEffect/u);
  assert.match(adapter, /const outcome = await applyCandidate\(\{/u);
  assert.match(candidate, /candidateManuscriptService\.saveCandidate/u);
});

test("rejected card and workspace mutations release their local interaction locks", async () => {
  const panel = await read("src/components/ai/AIParseDraftPanel.tsx");
  const host = await read("src/components/ai/GlobalAIChatPanel.tsx");

  assert.match(panel, /async function runCardAction[\s\S]*finally \{[\s\S]*activeCardActionResultIdRef\.current = undefined[\s\S]*isWorking: false/u);
  assert.match(host, /async function runStandardResultWorkspaceMutation[\s\S]*finally \{[\s\S]*releaseAIStandardResultWorkspaceMutation/u);
});
