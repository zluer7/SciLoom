import { createManuscriptIdentityResolver } from "./manuscriptIdentityResolver";
import { manuscriptWritableAdmissionPort } from "./manuscriptWritableAdmissionPort";
import { rawManuscriptGateway } from "./rawManuscriptGateway";
import { createManuscriptSegmentSessionAdapter } from "./manuscriptSegmentSessionAdapter";
import { createSharedManuscriptSessionRuntime } from "./sharedManuscriptSessionRuntime";

export const sharedManuscriptIdentityResolver =
  createManuscriptIdentityResolver();

export const sharedManuscriptSessionRuntime =
  createSharedManuscriptSessionRuntime({
    gateway: rawManuscriptGateway,
    admission: manuscriptWritableAdmissionPort,
    identityResolver: sharedManuscriptIdentityResolver
  });

export const sharedManuscriptSegmentSessionAdapter =
  createManuscriptSegmentSessionAdapter({
    runtime: sharedManuscriptSessionRuntime,
    gateway: rawManuscriptGateway
  });
