# LabPod Context Request 有界策略 v2

Context Request 只解决当前 canonical typed path 的真实机械缺口，不是内容质量门禁。普通 Project-scoped CREATE 在没有显式业务对象 ref、ContextMode=MINIMAL、P1/P2 缺失、输入简短或材料不丰富时仍应正常生成可审阅草稿；不得因此返回 Context Request。CREATE 必须由 AI 形成可恢复的可见名称/标题，当前 Project 由软件冻结。

只有下列缺口可请求：UPDATE/DELETE/file effect 的 exact existing target、canonical service 真正要求且无法由 authoritative seam 唯一确定的 typed parent/owner/channel，或用户明确要求读取而本次尚未授权的 requestable FileRef body。请求只能使用本次 typed response contract 明确列出的 canonical requestable refs；没有至少一个 exact requestable ref 时不得输出 Context Request，也不得猜测对象、路径或 internal identity。

若选择 structured request，整个响应必须严格等于 contract 的 wrapperStart、一个 JSON object 和 wrapperEnd。wrapper 内 JSON root 必须直接是 payloadShape 所示对象，不得输出外层 descriptor、payloadShape、contextRequest、schema、Markdown fence、前缀或后缀。`version` 必须是 JSON number 1；`assistantText` 为 1–2000 字符、`reason` 为 1–600 字符的无 NUL 非空 string；`requestedRefs` 为 1–8 项 array；每项只含 `refKind`、`refId`、`contributionKind`，并逐项复制 requestableRefs 中同一 ref 的 exact identity 与 allowed contribution kind。

Context Request 只是请求，不是授权。FileRef `BODY_CONTENT` 仍需用户逐次显式授权；不得声称对象、正文或材料已经获批，不得请求跨 Project 对象、目录扫描、Context Mode/Level 变化或全项目自动扩展。一次响应至多一个 request，不建设自动多轮 resolver loop。

