import type { OutputEntityDetailDto } from "../types/outputSelector";
import type { OutputExportLayer } from "../types/outputExportBundle";
import { outputFiveLayerSelectorService } from "./outputFiveLayerSelectorService";
import { getOutputSourceCards } from "./outputSourceSelectorService";
import { outputExportBundleService } from "./outputExportBundleService";
import { exportService, saveTextFile, sanitizeFileName } from "./exportService";

export type OutputEvidenceIdentity = { layer: OutputExportLayer; id: string; projectId: string };
const layers: readonly string[] = ["resultItem", "finding", "outputCandidate", "outputGap", "researchOutput"];

function checkIdentity(identity: OutputEvidenceIdentity, detail: OutputEntityDetailDto) {
  const entity = detail.entity;
  if (!layers.includes(identity.layer) || !entity || entity.deletedAt ||
      detail.layer !== identity.layer || detail.id !== identity.id || entity.projectId !== identity.projectId) {
    throw new Error("unavailable");
  }
}
function exportAllowed(detail: OutputEntityDetailDto) {
  return !(detail.layer === "outputCandidate" && detail.status === "converted") &&
    !(detail.layer === "researchOutput" && detail.status === "archived");
}
function unavailableReads(detail: OutputEntityDetailDto) {
  return detail.boundary.warnings.some(w => /Relation summary unavailable|Relation target lookup failed|FileRef metadata summary unavailable/.test(w));
}
async function detailRead(identity: OutputEvidenceIdentity) {
  if (!layers.includes(identity.layer)) throw new Error("unsupported");
  const detail = await outputFiveLayerSelectorService.getOutputEntityDetail({
    layer: identity.layer, id: identity.id, includeDeleted: false
  });
  checkIdentity(identity, detail);
  return detail;
}

export const outputEvidenceExportPresentationService = {
  async read(identity: OutputEvidenceIdentity) {
    const detail = await detailRead(identity);
    const cards = await getOutputSourceCards(identity.layer, identity.id);
    return { detail, cards, exportAllowed: exportAllowed(detail) && !unavailableReads(detail),
      relationsUnavailable: detail.boundary.warnings.some(w => w.startsWith("Relation summary unavailable")),
      relations: detail.relationSummary.map(relation => {
        const type = relation.direction === "incoming" ? relation.sourceType : relation.targetType;
        const id = relation.direction === "incoming" ? relation.sourceId : relation.targetId;
        const unreadable = detail.boundary.warnings.some(w => w.startsWith(`Relation target lookup failed for ${type}/${id}:`));
        return { ...relation, counterpartType: type, availability: unreadable ? "unavailable" as const :
          relation.targetMissing ? "missing" as const : "available" as const };
      }) };
  },
  async prepare(identity: OutputEvidenceIdentity) {
    const before = await detailRead(identity);
    if (!exportAllowed(before) || unavailableReads(before)) throw new Error("unsupported-or-unreadable");
    const payload = await outputExportBundleService.exportOutputEntity({
      layer: identity.layer, id: identity.id, format: "markdown", includeDeleted: false,
      includeStructuredSummary: true, includeRelations: true, includeFileRefs: true,
      includeEvidenceChain: false, includeSourceChain: false
    });
    const after = await detailRead(identity);
    if (!exportAllowed(after) || unavailableReads(after) || JSON.stringify(before.entity) !== JSON.stringify(after.entity) ||
        JSON.stringify(before.relationSummary) !== JSON.stringify(after.relationSummary) ||
        JSON.stringify(before.fileRefs) !== JSON.stringify(after.fileRefs) ||
        payload.layer !== identity.layer || payload.id !== identity.id || payload.status !== after.status || !payload.markdown ||
        payload.warnings.some(w => /was not found|summary unavailable|lookup failed/.test(w))) {
      throw new Error("stale-or-unreadable");
    }
    return Object.freeze({ ...identity, contents: payload.markdown,
      fileName: `${sanitizeFileName(identity.layer)}-${sanitizeFileName(payload.title)}.md` });
  },
  async save(prepared: { contents: string; fileName: string }) {
    if (!exportService.isDesktopRuntime()) throw new Error("native-save-required");
    return saveTextFile(prepared.fileName, prepared.contents, "text/markdown");
  },
  isDesktop: () => exportService.isDesktopRuntime()
};
export type OutputEvidenceView = Awaited<ReturnType<typeof outputEvidenceExportPresentationService.read>>;
