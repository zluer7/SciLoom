import type { ManuscriptLocationMode } from "../types/manuscriptOperation";
import {
  type IndependentOpenPreviewDto,
  type IndependentOpenSelectionResult
} from "./independentManuscriptOpenProtocol";
import { createPathIdentityKey } from "./fileRefIdentity";
import { getSafeManuscriptBasename } from "./fileRefService";
import { localMarkdownFileService } from "./localMarkdownFileService";
import {
  sharedManuscriptIdentityResolver
} from "./sharedManuscriptSessionComposition";
import { rawManuscriptGateway } from "./rawManuscriptGateway";

export interface IndependentOpenPreviewWorkspace {
  initialDirectory?: string;
  classify(path: string): ManuscriptLocationMode;
  configuredRoot?: string;
}

export interface IndependentOpenPreviewProviderInput {
  pickerTitle: string;
  resolveWorkspace(): Promise<IndependentOpenPreviewWorkspace>;
  validateRaw?(input: {
    rawText: string;
    fileName: string;
    locationMode: ManuscriptLocationMode;
  }): Promise<{ status: "success"; summary?: string } | {
    status: "error";
    errorCode: string;
  }> | { status: "success"; summary?: string } | {
    status: "error";
    errorCode: string;
  };
}

function error(
  status: "invalid-target" | "owner-or-channel-invalid" | "unexpected-failure",
  errorCode: string
): IndependentOpenSelectionResult {
  return { status, errorCode };
}

export function createIndependentOpenPreviewProvider(
  input: IndependentOpenPreviewProviderInput
) {
  async function read(
    absolutePath: string,
    workspace: IndependentOpenPreviewWorkspace
  ): Promise<IndependentOpenSelectionResult> {
    let pathIdentityKey: string;
    let fileName: string;
    let locationMode: ManuscriptLocationMode;
    try {
      pathIdentityKey = createPathIdentityKey(absolutePath);
      fileName = getSafeManuscriptBasename(absolutePath) ?? "";
      locationMode = workspace.classify(absolutePath);
      if (!fileName || (locationMode !== "managed" && locationMode !== "external")) {
        return error("invalid-target", "INDEPENDENT_OPEN_INVALID_MARKDOWN_TARGET");
      }
    } catch {
      return error("invalid-target", "INDEPENDENT_OPEN_INVALID_PATH");
    }
    let file;
    try {
      file = sharedManuscriptIdentityResolver.resolveEphemeralFile({
        absolutePath,
        locationMode,
        configuredRoot:
          locationMode === "managed" ? workspace.configuredRoot : undefined,
        identityToken:
          globalThis.crypto?.randomUUID?.() ??
          `independent-preview-${Date.now()}`
      });
    } catch {
      return error("invalid-target", "INDEPENDENT_OPEN_IDENTITY_INVALID");
    }
    const readResult = await rawManuscriptGateway.read({ file });
    if (readResult.status !== "success" || !readResult.data) {
      return error(
        "invalid-target",
        readResult.error?.causeCode ??
          readResult.error?.code ??
          "INDEPENDENT_OPEN_PREVIEW_READ_FAILED"
      );
    }
    const validation = input.validateRaw
      ? await input.validateRaw({
          rawText: readResult.data.rawText,
          fileName,
          locationMode
        })
      : { status: "success" as const };
    if (validation.status === "error") {
      return error("invalid-target", validation.errorCode);
    }
    const preview: IndependentOpenPreviewDto = {
      absolutePath,
      pathIdentityKey,
      physicalIdentity: readResult.data.physicalIdentity,
      physicalRevision: readResult.data.revision,
      fileName,
      locationMode,
      configuredRoot:
        locationMode === "managed" ? workspace.configuredRoot : undefined,
      byteLength: readResult.data.byteLength,
      encoding: readResult.data.encoding,
      newline: readResult.data.newline,
      summary: validation.summary
    };
    return { status: "success", preview };
  }

  let lastWorkspace: IndependentOpenPreviewWorkspace | undefined;
  return Object.freeze({
    async selectAndPreview(): Promise<IndependentOpenSelectionResult> {
      try {
        const workspace = await input.resolveWorkspace();
        lastWorkspace = workspace;
        const selected = await localMarkdownFileService.selectMarkdownFile(
          input.pickerTitle,
          workspace.initialDirectory
        );
        if (!selected.ok) {
          return selected.errorCode === "canceled"
            ? { status: "picker-cancelled" }
            : error(
                "invalid-target",
                `INDEPENDENT_OPEN_PICKER_${selected.errorCode.toUpperCase()}`
              );
        }
        return read(selected.path, workspace);
      } catch (cause) {
        return error(
          "owner-or-channel-invalid",
          cause instanceof Error
            ? cause.message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ??
              "INDEPENDENT_OPEN_WORKSPACE_INVALID"
            : "INDEPENDENT_OPEN_WORKSPACE_INVALID"
        );
      }
    },
    async revalidatePreview(
      preview: IndependentOpenPreviewDto
    ): Promise<IndependentOpenSelectionResult> {
      try {
        const workspace = await input.resolveWorkspace();
        lastWorkspace = workspace;
        return read(preview.absolutePath, workspace);
      } catch {
        return error(
          "owner-or-channel-invalid",
          "INDEPENDENT_OPEN_WORKSPACE_INVALID"
        );
      }
    },
    async previewPath(
      absolutePath: string
    ): Promise<IndependentOpenSelectionResult> {
      try {
        const workspace = await input.resolveWorkspace();
        lastWorkspace = workspace;
        return read(absolutePath, workspace);
      } catch {
        return error(
          "owner-or-channel-invalid",
          "INDEPENDENT_OPEN_WORKSPACE_INVALID"
        );
      }
    },
    getLastWorkspace() {
      return lastWorkspace;
    }
  });
}
