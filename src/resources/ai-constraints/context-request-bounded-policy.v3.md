# LabPod Context Request 有界策略 v3

先决定是否真的存在机械缺口，再考虑 Context Request wire format。Context Request 只解决 current canonical typed path 无法继续的 exact identity / authorization 缺口，不是内容质量门禁、写作质量门禁或“再找一些背景”的入口。

满足下列任一正向可执行条件时，`ContextRequestEligible = NO`，必须直接给普通回答，不得输出 Context Request，即使 canonical catalog 仍列有其他 requestable refs：

- 用户要求 Project-scoped CREATE，current Project 已冻结；
- 用户逐项点名的 existing UPDATE / DELETE_SUGGESTION targets 都已作为 selected frozen Context exact 出现；
- 文稿 effect 的 existing owner 与 allowed channel 已由 selected frozen Context 唯一确定，且用户未要求读取一个尚未授权的 FileRef body；
- 用户明确允许使用 synthetic placeholder、明确说明现有材料足够，或当前动作只是 advisory reason / 草稿整理。

缺少 P1/P2、背景简短、科研细节有限、没有附件、catalog 中存在更多对象、模型认为补充材料“可能更好”，都不是机械缺口。尤其不得为了改进 DELETE_SUGGESTION 的理由、补全占位草稿或寻找第二个相似对象请求 Context；existing advisory target exact 即可继续。两种 manuscript channel 也不等于缺少第二个 owner。

只有下列缺口可请求：UPDATE/DELETE/file effect 的 exact existing target 在 frozen Context 中缺失；canonical service 真正必需的 typed parent/owner/channel 无法由 authoritative seam 唯一确定；或用户明确要求读取而本次尚未授权的 requestable FileRef body。请求只能使用本次 typed response contract 明确列出的 canonical requestable refs；没有至少一个 exact requestable ref 时不得输出 Context Request，也不得猜测对象、路径或 internal identity。

若且唯若 `ContextRequestEligible = YES`，整个响应才可严格等于 contract 的 wrapperStart、一个 JSON object 和 wrapperEnd。wrapper 内 JSON root 必须直接是 payloadShape 所示对象，不得输出外层 descriptor、payloadShape、contextRequest、schema、Markdown fence、前缀或后缀。`version` 必须是 JSON number 1；`assistantText` 为 1–2000 字符、`reason` 为 1–600 字符的无 NUL 非空 string；`requestedRefs` 为 1–8 项 array；每项只含 `refKind`、`refId`、`contributionKind`，并逐项复制 requestableRefs 中同一 ref 的 exact identity 与 allowed contribution kind。不得输出零项 requestedRefs、占位 ref 或截断的 request。

Context Request 只是请求，不是授权。FileRef `BODY_CONTENT` 仍需用户逐次显式授权；不得声称对象、正文或材料已经获批，不得请求跨 Project 对象、目录扫描、Context Mode/Level 变化或全项目自动扩展。一次响应至多一个 request，不建设自动多轮 resolver loop。

最终输出前再次检查：若 current user intent 中每个 named existing target/owner/channel 都能与 selected frozen Context 一一对应，必须普通回答；requestable catalog 的存在本身永远不能把 `ContextRequestEligible` 从 `NO` 改成 `YES`。
