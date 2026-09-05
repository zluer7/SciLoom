import type {
  ManuscriptProjectionNode,
  ManuscriptSegmentProjectionSessionState,
  ManuscriptUnmanagedInsertionAnchor
} from "../types/manuscriptSegmentProjection";

export type ManuscriptOrderedProductNode =
  | Readonly<{
      productNodeKind: "PROJECTION_NODE";
      sourcePosition: number;
      node: ManuscriptProjectionNode;
    }>
  | Readonly<{
      productNodeKind: "INSERTION_ANCHOR";
      sourcePosition: number;
      anchor: ManuscriptUnmanagedInsertionAnchor;
    }>;

function projectionNodePosition(
  nodes: readonly ManuscriptProjectionNode[],
  index: number
) {
  const node = nodes[index];
  if (node.nodeKind === "EDITABLE_SOURCE_REGION") {
    return node.sourceRange.startByte;
  }
  for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
    const next = nodes[nextIndex];
    if (next.nodeKind === "EDITABLE_SOURCE_REGION") {
      return next.sourceRange.startByte;
    }
  }
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const previous = nodes[previousIndex];
    if (previous.nodeKind === "EDITABLE_SOURCE_REGION") {
      return previous.sourceRange.endByte;
    }
  }
  return 0;
}

/** Shared ordering authority: source position first, then presentation relation. */
export function buildManuscriptOrderedProductNodes(
  state: ManuscriptSegmentProjectionSessionState
): readonly ManuscriptOrderedProductNode[] {
  if (state.projection.classification !== "PROJECTABLE") return Object.freeze([]);
  const projection = state.projection;
  const projectionNodes = projection.projectionNodes.map((node, index) => ({
    productNodeKind: "PROJECTION_NODE" as const,
    sourcePosition: projectionNodePosition(projection.projectionNodes, index),
    node,
    originalOrder: index,
    tie: node.nodeKind === "EDITABLE_SOURCE_REGION" ? 2 : 1
  }));
  const anchors = projection.insertionAnchors.map((anchor, index) => ({
    productNodeKind: "INSERTION_ANCHOR" as const,
    sourcePosition: anchor.anchorByteOffset,
    anchor,
    originalOrder: index,
    tie: 0
  }));
  return Object.freeze(
    [...projectionNodes, ...anchors]
      .sort((left, right) =>
        left.sourcePosition - right.sourcePosition ||
        left.tie - right.tie ||
        left.originalOrder - right.originalOrder
      )
      .map(({ originalOrder: _originalOrder, tie: _tie, ...node }) => Object.freeze(node))
  );
}

export function buildMarkerFreeManuscriptPreview(
  state: ManuscriptSegmentProjectionSessionState
) {
  if (state.projection.classification !== "PROJECTABLE") {
    throw new Error("MANUSCRIPT_SEGMENT_PREVIEW_NOT_PROJECTABLE");
  }
  const drafts = new Map(state.regionDrafts.map((draft) => [draft.targetId, draft]));
  const chunks: string[] = [];
  for (const productNode of buildManuscriptOrderedProductNodes(state)) {
    if (productNode.productNodeKind === "INSERTION_ANCHOR") {
      const text = drafts.get(productNode.anchor.anchorId)?.currentText ?? "";
      if (text) chunks.push(text);
      continue;
    }
    const node = productNode.node;
    if (node.nodeKind === "SYNTHETIC_MANAGED_HEADING" && node.displayText?.trim()) {
      chunks.push(`### ${node.displayText.trim()}`);
    } else if (node.nodeKind === "UI_SEPARATOR") {
      chunks.push("---");
    } else if (node.nodeKind === "EDITABLE_SOURCE_REGION") {
      const text = drafts.get(node.segmentId)?.currentText ?? node.text;
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n\n");
}
