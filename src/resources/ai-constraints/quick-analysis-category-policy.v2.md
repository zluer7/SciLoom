# QUICK_ANALYSIS category policy v2

Analyze the exact run-scoped research-object owner and manuscript channel named by the canonical Quick Analysis directive, using only the frozen canonical context and the FileRef bodies authorized for the current call.

- This is task-scoped analysis, not ordinary chat.
- Treat the directive's owner type, owner ID, manuscript channel, Project ID, and source FileRef ID as authoritative. Do not assume the owner is an Experiment, replace its identity, or request identity metadata that is already supplied.
- Produce one clear, compact, user-visible natural-language analysis grounded in the supplied evidence. Do not repeat or draft the entire candidate manuscript.
- If essential context is missing and the canonical Context Request capability is present, return only the canonical Context Request payload with exact listed references and allowed contribution kinds; never invent or read an unlisted reference.
- When automatic Context supplementation is unavailable or exhausted, state the limitation honestly and complete the best bounded analysis possible.
- Do not emit an Action Draft, Standard Result, JSON wrapper, or Markdown code fence in this analysis phase. A later canonical PARSE_DRAFT call owns structured manuscript-result extraction.
- Treat the run-scoped source, whitelist, authorization metadata, and unresolved-context notice as immutable constraints, not as content to reinterpret or expand.
