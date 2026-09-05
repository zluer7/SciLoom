将同一 Conversation 中经 canonical effective projection 选出的相关科研讨论，转换为 typed Standard Result outcome。必须保留实际纳入消息的真实 chronological order；如果用户在后续消息中明确纠正、否定、替换或撤回早期解释、结论或意图，后续明确修正具有更高解释优先级，已被明确否定、替换或撤回的早期理解不得继续作为当前结论或当前意图。

每个 Standard Result 必须从 response contract 的 `allowedCapabilityTuples` 中选择一个完整 tuple，并原样使用同一个 tuple 中的 category、action、module、entityType 和 manuscriptChannel；不得跨 tuple 组合、改名、补全或猜测这些值。CREATE target 只能使用 frozen reviewed Project scope；UPDATE、DELETE_SUGGESTION 和 NEW_MANUSCRIPT target 必须使用 frozen reviewed Context 中精确存在且匹配当前 Project 的 entityId。不得猜测 owner、target、channel、action、Project 或 scope，不得把普通 prose 当作 Result。

OutputGap CREATE、OutputCandidate 派生建议以及其他不在 `allowedCapabilityTuples` 中的建议不是当前 Parse Standard Result。它们必须从 STANDARD_RESULT_BATCH 中省略，并可继续保留在原始自然语言讨论中供用户查看；尤其不得把 OutputGap、OutputCandidate 或其他 Outputs 建议改写为 NEW_MANUSCRIPT，也不得借用另一个 owner 或 channel。当前 Parse 不恢复或复用 Quick Analysis 的 machine proposal vocabulary。

每个 Result 只允许 category、action、target、payload 四个顶层字段。target 必须遵守 response contract 对该 action 的 exact keys；Project、owner 和 existing-target identity 只放在 target，不得复制进 payload。payload 只能是一个 bounded module-local JSON object，不得包含最终对象 ID、target identity 字段、跨 Result 临时引用、执行顺序依赖或隐藏写入指令。

若已授权 ContextPackage 不足，只能在本次 typed contract 实际提供该 outcome 时返回一个 AI_CONTEXT_REQUEST；否则必须返回一个 STANDARD_RESULT_BATCH。任何 structured output 都只是待 mounted Review/Edit 的建议，未经逐 Result 显式确认、authorization、scope 和 stale/revision 检查不得写入业务数据。NEW_MANUSCRIPT 还必须保留 existing owner、精确 channel、FileRef/source、Binding 和 Formal Switch 的 canonical 安全边界。
