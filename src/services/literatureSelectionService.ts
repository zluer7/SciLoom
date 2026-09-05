import type { EntityId, Literature } from "../types";
import type { LiteratureDetailContext } from "../types/literatureContext";
import type { LiteratureManagementDetail } from "./literatureManagementDetailService";

export type LiteratureSelectionFailureCode =
  | "LITERATURE_SELECTION_ROW_MISSING"
  | "LITERATURE_SELECTION_DETAIL_MISSING"
  | "LITERATURE_SELECTION_DETAIL_MISMATCH"
  | "LITERATURE_SELECTION_DETAIL_LOAD_FAILED";

export type LiteratureSelectionResolution =
  | {
      status: "empty";
      selectedLiteratureId: null;
      detailContext: null;
      managementDetail: null;
    }
  | {
      status: "ready" | "degraded";
      selectedLiteratureId: EntityId;
      detailContext: LiteratureDetailContext | null;
      managementDetail: LiteratureManagementDetail;
    }
  | {
      status: "error";
      selectedLiteratureId: null;
      detailContext: null;
      managementDetail: null;
      code: LiteratureSelectionFailureCode;
      message: string;
    };

export async function resolveLiteratureSelection(input: {
  rows: Literature[];
  preferredLiteratureId?: EntityId | null;
  loadDetail(literature: Literature): Promise<LiteratureManagementDetail | null>;
}): Promise<LiteratureSelectionResolution> {
  if (input.rows.length === 0) {
    return {
      status: "empty",
      selectedLiteratureId: null,
      detailContext: null,
      managementDetail: null
    };
  }

  const selectedRow = input.preferredLiteratureId
    ? input.rows.find((row) => row.id === input.preferredLiteratureId)
    : input.rows[0];
  if (!selectedRow) {
    return {
      status: "error",
      selectedLiteratureId: null,
      detailContext: null,
      managementDetail: null,
      code: "LITERATURE_SELECTION_ROW_MISSING",
      message: `Literature row is not available in the current list: ${input.preferredLiteratureId}.`
    };
  }

  try {
    const managementDetail = await input.loadDetail(selectedRow);
    if (!managementDetail) {
      return {
        status: "error",
        selectedLiteratureId: null,
        detailContext: null,
        managementDetail: null,
        code: "LITERATURE_SELECTION_DETAIL_MISSING",
        message: `Literature detail is not available: ${selectedRow.id}.`
      };
    }
    if (managementDetail.baseLiterature.id !== selectedRow.id) {
      return {
        status: "error",
        selectedLiteratureId: null,
        detailContext: null,
        managementDetail: null,
        code: "LITERATURE_SELECTION_DETAIL_MISMATCH",
        message: `Literature detail identity does not match the selected row: ${selectedRow.id}.`
      };
    }
    return {
      status: managementDetail.status,
      selectedLiteratureId: selectedRow.id,
      detailContext: managementDetail.detailContext,
      managementDetail
    };
  } catch (error) {
    return {
      status: "error",
      selectedLiteratureId: null,
      detailContext: null,
      managementDetail: null,
      code: "LITERATURE_SELECTION_DETAIL_LOAD_FAILED",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
