export type ActiveComposerSend = {
  flowId: string;
  nodeIds: string[];
  preferredNodeId: string | null;
  workspaceId: string | null;
};

export type ComposerSendStartGate = {
  isArming: boolean;
};

export const createComposerSendStartGate = (): ComposerSendStartGate => ({
  isArming: false,
});

export const tryBeginComposerSendStart = (gate: ComposerSendStartGate): boolean => {
  if (gate.isArming) return false;
  gate.isArming = true;
  return true;
};

export const finishComposerSendStart = (gate: ComposerSendStartGate): void => {
  gate.isArming = false;
};

export type ShouldShowComposerCancelInput = {
  activeComposerSend: ActiveComposerSend | null;
  isNewThreadTarget: boolean;
  isSelectedNodeRunning: boolean;
};

export const shouldShowComposerCancel = ({
  activeComposerSend,
  isNewThreadTarget,
  isSelectedNodeRunning,
}: ShouldShowComposerCancelInput): boolean => {
  if (isNewThreadTarget) return false;
  return Boolean(activeComposerSend || isSelectedNodeRunning);
};
