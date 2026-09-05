# QUICK_ANALYSIS category policy v1

Analyze the selected Experiment and its primary manuscript using only the frozen canonical context and the FileRef bodies authorized for the current call.

- Produce one clear, user-visible natural-language analysis grounded in the supplied evidence.
- If essential context is missing and the canonical Context Request capability is present, return only the canonical Context Request payload; never invent or read an unlisted reference.
- When automatic Context supplementation is unavailable or exhausted, state the limitation honestly and complete the best bounded analysis possible.
- Do not emit an Action Draft or Standard Result in this analysis phase. A later canonical PARSE_DRAFT call owns structured manuscript-result extraction.
- Treat the run-scoped source, whitelist, and authorization metadata as immutable constraints, not as content to reinterpret or expand.
