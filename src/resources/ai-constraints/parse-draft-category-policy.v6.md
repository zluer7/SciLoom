# LabPod 标准操作约束 v6

把同一 Conversation 中 canonical effective projection 选出的科研讨论转换为一个 `LABPOD_STANDARD_RESULT_OUTCOME_V2` outcome。Natural Chat 可以宽容地起草；本阶段必须严格执行 whole-tuple、target、payload、validator 与 Review/Confirm 合同。只返回一个完整 JSON object，不得添加 Markdown fence、解释前后缀或第二个顶层对象。

## 解释顺序与身份

保持实际纳入消息的 chronological order。后续消息明确纠正、否定、替换或撤回早期意图时，以后续明确修正为准，被撤回内容不得继续成为当前结果。CREATE 只能绑定 frozen reviewed Project scope。UPDATE、DELETE_SUGGESTION 与 NEW_MANUSCRIPT 的 entityId 必须精确来自 frozen reviewed Context；当 Context 中符合类型的现有对象恰好一个时可使用其 canonical identity，零个或多个时不得猜测。不得从自然语言、标题相似度或其他课题搜索生成身份。

每个 Result 必须从 response contract 的 `allowedCapabilityTuples` 复制一个完整 tuple，category、action、module、entityType 与 manuscriptChannel 不得跨 tuple 拼接、改名或替换。Result 顶层只能有 `category`、`action`、`target`、`payload`。target 必须使用该 action 的 exact keys；Project/owner/existing-target identity 只放 target，不得复制到 payload。payload 只能是一个 bounded module-local object，不得含最终 ID、projectId、entityId、owner/channel、跨 Result 临时引用、执行顺序依赖或隐藏写入指令。

## 当前受支持 payload

只生成下列 adapter 已支持的字段；未列字段必须省略。

- Route CREATE (`module=route`, `entityType=routeNode`)：`title` 必填；可选 `description`、`objective`、`expectedOutput`、`nodeType`（literature/experiment/algorithm/analysis/writing/output/review/other）、`status`（planned/active/paused/adjusted）、`startDate`、`endDate`、`timeLabel`、`timePrecision`（day/week/month/quarter/phase/free）、`showInGantt`、`tags`。不得指定 parentNodeId、captureState、orderIndex、完成/归档状态或现有路线身份。
- Task CREATE：`title` 必填；可选 `description`、`routeNodeId`、`priority`（high/medium/low）、`status`（todo/doing/delayed/blocked/cancelled）、`taskType`（reading/experiment/coding/writing/analysis/meeting/idea/review/other）、`timeBucket`（today/this_week/this_month/long_term/none）、`scheduledDate`、`dueDate`、`timeLabel`、`acceptanceCriteria`、`blockedReason`、`tags`。非关键默认值可用 medium/todo/other/none；blocked 必须有 blockedReason。
- Task UPDATE：只放用户明确要求改变的上述字段，至少一个；其他字段不复制、不补默认值。目标必须是 Context 中唯一可解析的现有 Task。Task DELETE_SUGGESTION payload 只能是 `{ "reason": "..." }`，它是信息建议且没有 delete executor。
- Review CREATE：`title` 必填；可选 `description`、`reviewType`（stage/periodic/experiment_comparison/literature_comparison/custom）、`periodStart`、`periodEnd`、`periodLabel`、`outlineSections`、`targets`、`tags`。`outlineSections` 项只含受支持的 canonical outline key 与 content；`targets` 只能引用 Context 中精确存在的 routeNode/task/experiment/experimentRun/literature。缺少现有对象时省略 targets，不造 ID。
- Experiment CREATE/UPDATE：CREATE 需要 `title`，UPDATE 只含明确 changed fields；可用 `purposeAndQuestion`、`conditionSummary`、`methodSummary`、`resultSummary`、`conclusionAndNextSteps`、`other`、`status`（planned/running/completed/paused/failed）、`rating`（excellent/good/usable/inconclusive/failed）、`routeId`、`taskId`、`tags`、`usableForPaper`、`usableForReport`、`usableForPatent`。routeId/taskId 只能来自 Context。测试草稿不得把预期内容冒充已发生结果。
- ExperimentRun CREATE/UPDATE：父 Experiment 必须是 Context 中唯一精确目标。可用 `title`、`runLabel`、`status`、`startedAt`、`completedAt`、`conditionSummary`、`variableParameterSummary`、`methodSummary`、`resultSummary`、`conclusion`、`summaryOther`、`rating`、`routeId`、`taskId`、`tags`、`conditionItems`、`methodSteps`、`variables`、`materials`、`customFields`；结构化子项必须遵守现有 validator，不确定时优先使用摘要字段而不是猜测结构。
- Literature CREATE/UPDATE：CREATE 需要 `title` 与 `authors`；可用 `year`、`venue`、`publicationType`、`abstract`、`keywords`、`doi`、`readingStatus`、`importance`、`tags`。不得把 URL、本地/PDF 路径、外部 ID、归档状态或 Project identity 放入 payload。UPDATE 只含明确 changed fields。
- Finding CREATE：`title` 必填；可用 `summary`、`findingType`（phenomenon/comparison/method/limitation/evidence/hypothesis/negative_result/other）、`confidence`、`maturity`（high/medium/low/uncertain）、`tags`、`routeId`、`taskId`、`experimentId`、`resultItemIds`。所有关系 ID 必须来自 frozen Context；缺少证据时省略，不猜测。
- NEW_MANUSCRIPT：只用于 allowed tuple 中精确现有 owner 与精确 channel；payload 只能是 `{ "body": "有效 Markdown" }`。Review/Experiment/ExperimentRun channel 必须是 primary；Literature 只能是 literature_outline 或 dedicated_notes。它只创建候选文稿，不得自动 Formal Switch、覆盖当前文稿或改变 Binding。

OutputGap CREATE、OutputCandidate 派生建议、ResearchOutput 写入、Route UPDATE 及其他不在 `allowedCapabilityTuples` 中的动作不是当前 Standard Result。必须省略，且不得误映射为 Task、Finding 或 NEW_MANUSCRIPT。普通讨论仍可保留这些自然语言建议供用户查看。

如果没有可精确映射的建议，返回合法的空 `STANDARD_RESULT_BATCH`；不得用错误对象凑数。若 typed contract 本次确实提供且 Context 不足，可返回一个 canonical AI_CONTEXT_REQUEST，否则返回 STANDARD_RESULT_BATCH。所有结果只是待 mounted Review/Edit 的建议；逐 Result 显式 Confirm、authorization、scope、stale/revision、FileRef/Binding 与 canonical service 边界必须保持。
