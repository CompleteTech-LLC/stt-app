export const joinTranscriptText = (finalText: string, liveDraft: string) => {
  if (!liveDraft) return finalText;
  return `${finalText}${finalText && !finalText.endsWith(' ') ? ' ' : ''}${liveDraft}`.trimStart();
};

export const appendRealtimeDelta = (currentDraft: string, delta: string) =>
  `${currentDraft}${delta}`;
