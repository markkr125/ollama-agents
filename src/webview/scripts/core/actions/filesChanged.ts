import { vscode } from '../state';

export const openFileChangeDiff = (checkpointId: string, filePath: string) => {
  vscode.postMessage({ type: 'openFileChangeDiff', checkpointId, filePath });
};

export const openFileChangeReview = (checkpointId: string, filePath: string) => {
  vscode.postMessage({ type: 'openFileChangeReview', checkpointId, filePath });
};

export const keepFile = (checkpointId: string, filePath: string) => {
  vscode.postMessage({ type: 'keepFile', checkpointId, filePath });
};

export const undoFile = (checkpointId: string, filePath: string) => {
  vscode.postMessage({ type: 'undoFile', checkpointId, filePath });
};

export const keepAllChanges = (checkpointId: string) => {
  vscode.postMessage({ type: 'keepAllChanges', checkpointId });
};

export const undoAllChanges = (checkpointId: string) => {
  vscode.postMessage({ type: 'undoAllChanges', checkpointId });
};

export const requestFilesDiffStats = (checkpointId: string) => {
  vscode.postMessage({ type: 'requestFilesDiffStats', checkpointId });
};
