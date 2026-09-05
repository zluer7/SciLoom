export interface ManuscriptRequestTokenController {
  begin(): number;
  isCurrent(token: number): boolean;
  shouldCommitSuccess(token: number): boolean;
  shouldCommitError(token: number): boolean;
  shouldFinishLoading(token: number): boolean;
  dispose(): void;
  current(): number;
}

export function createManuscriptRequestTokenController(): ManuscriptRequestTokenController {
  let latestToken = 0;
  let active = true;
  const isCurrent = (token: number) => active && token === latestToken;
  return {
    begin() {
      latestToken += 1;
      return latestToken;
    },
    isCurrent,
    shouldCommitSuccess: isCurrent,
    shouldCommitError: isCurrent,
    shouldFinishLoading: isCurrent,
    dispose() {
      active = false;
      latestToken += 1;
    },
    current() {
      return latestToken;
    }
  };
}

export const manuscriptRequestTokenController = createManuscriptRequestTokenController();
