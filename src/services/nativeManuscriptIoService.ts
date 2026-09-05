import { invoke } from "@tauri-apps/api/core";
import type {
  NativeReadManuscriptInput,
  NativeReadManuscriptResult,
  NativeWriteManuscriptInput,
  NativeWriteManuscriptResult
} from "../types/manuscriptIo";
import type {
  NativeCreateCandidateManuscriptInput,
  NativeCreateCandidateManuscriptResult
} from "../types/candidateManuscript";

export function readManuscriptFile(input: NativeReadManuscriptInput) {
  return invoke<NativeReadManuscriptResult>("read_markdown_file", {
    filePath: input.filePath,
    locationMode: input.locationMode,
    configuredRoot: input.configuredRoot
  });
}

export function writeCurrentManuscriptFileAtomic(input: NativeWriteManuscriptInput) {
  return invoke<NativeWriteManuscriptResult>("write_current_markdown_file_atomic", {
    filePath: input.filePath,
    content: input.content,
    locationMode: input.locationMode,
    configuredRoot: input.configuredRoot
  });
}

export function createManagedCandidateManuscript(input: NativeCreateCandidateManuscriptInput) {
  return invoke<NativeCreateCandidateManuscriptResult>("create_managed_candidate_markdown", {
    configuredRoot: input.configuredRoot,
    workspaceDirectory: input.workspaceDirectory,
    layout: input.layout,
    ownerType: input.ownerType,
    manuscriptChannel: input.manuscriptChannel,
    source: input.source,
    occurredAt: input.occurredAt,
    requestId: input.requestId,
    expectedFileName: input.expectedFileName,
    content: input.content
  });
}

export function createManagedWorkspaceMarkdownCopy(input: {
  configuredRoot: string;
  workspaceDirectory: string;
  manuscriptChannel: "literature_outline" | "dedicated_notes";
  sourceFileRefId: string;
  expectedFileName: string;
  content: string;
}) {
  return invoke<NativeCreateCandidateManuscriptResult>("create_managed_workspace_markdown_copy", {
    configuredRoot: input.configuredRoot,
    workspaceDirectory: input.workspaceDirectory,
    manuscriptChannel: input.manuscriptChannel,
    sourceFileRefId: input.sourceFileRefId,
    expectedFileName: input.expectedFileName,
    content: input.content
  });
}

export const nativeManuscriptIoService = {
  readManuscriptFile,
  writeCurrentManuscriptFileAtomic,
  createManagedCandidateManuscript,
  createManagedWorkspaceMarkdownCopy
};
