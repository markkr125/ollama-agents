import { vi } from 'vitest';

// The webview runtime provides this global. Our core state module calls it at import-time.
export const vscodePostMessage = vi.fn();

vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: vscodePostMessage
}));
