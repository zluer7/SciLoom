export type ManuscriptChannel = "primary" | "literature_outline" | "dedicated_notes";

export const PRIMARY_MANUSCRIPT_CHANNEL: ManuscriptChannel = "primary";

export const MANUSCRIPT_CHANNEL_CONTRACT_ERROR_CODES = {
  literatureChannelRequired: "LITERATURE_MANUSCRIPT_CHANNEL_REQUIRED",
  unsupportedOwnerChannel: "MANUSCRIPT_CHANNEL_OWNER_MISMATCH"
} as const;

export class ManuscriptChannelContractError extends Error {
  readonly code: (typeof MANUSCRIPT_CHANNEL_CONTRACT_ERROR_CODES)[keyof typeof MANUSCRIPT_CHANNEL_CONTRACT_ERROR_CODES];

  constructor(
    code: (typeof MANUSCRIPT_CHANNEL_CONTRACT_ERROR_CODES)[keyof typeof MANUSCRIPT_CHANNEL_CONTRACT_ERROR_CODES],
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "ManuscriptChannelContractError";
    this.code = code;
  }
}

export function normalizeManuscriptChannel(
  value?: ManuscriptChannel | null
): ManuscriptChannel {
  return value ?? PRIMARY_MANUSCRIPT_CHANNEL;
}

export function assertValidManuscriptChannelForOwner(
  ownerType: string,
  value?: ManuscriptChannel | null
): ManuscriptChannel {
  if (ownerType === "literature") {
    if (value === "literature_outline" || value === "dedicated_notes") {
      return value;
    }
    throw new ManuscriptChannelContractError(
      MANUSCRIPT_CHANNEL_CONTRACT_ERROR_CODES.literatureChannelRequired,
      "Literature manuscript operations must explicitly use literature_outline or dedicated_notes."
    );
  }

  const channel = normalizeManuscriptChannel(value);
  if (channel !== PRIMARY_MANUSCRIPT_CHANNEL) {
    throw new ManuscriptChannelContractError(
      MANUSCRIPT_CHANNEL_CONTRACT_ERROR_CODES.unsupportedOwnerChannel,
      `${ownerType} only supports the primary manuscript channel.`
    );
  }
  return channel;
}
