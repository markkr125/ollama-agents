/**
 * Webview reactive state. ⚠️ acquireVsCodeApi() is called at import time below.
 * - Never call acquireVsCodeApi() again (VS Code throws on second call).
 * - In tests, stub it BEFORE importing this module (see tests/webview/setup.ts).
 * - Never import 'vscode' here — this runs in a sandboxed iframe.
 */
import { reactive, ref, watch } from 'vue';
import type { AssistantThreadFilesChangedBlock, AssistantThreadThinkingGroupBlock, ModelInfo, SearchResultGroup, SessionItem, StatusMessage, TimelineItem } from './types';

declare const acquireVsCodeApi: () => {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};

export const vscode = acquireVsCodeApi();

export const messagesEl = ref<HTMLDivElement | null>(null);
export const inputEl = ref<HTMLTextAreaElement | null>(null);

export const timeline = ref<TimelineItem[]>([]);
export const sessions = ref<SessionItem[]>([]);
export const sessionsHasMore = ref(false);
export const sessionsLoading = ref(false);
export const sessionsInitialLoaded = ref(false);
export const sessionsCursor = ref<number | null>(null);
export const modelOptions = ref<string[]>([]);
export const modelInfo = ref<ModelInfo[]>([]);
export const currentMode = ref('agent');
export const currentModel = ref('');
export const currentSessionId = ref<string | null>(null);
export const autoApproveCommands = ref(false);
export const autoApproveSensitiveEdits = ref(false);
export const autoApproveConfirmVisible = ref(false);
export const autoApproveSensitiveEditsConfirmVisible = ref(false);
export const currentPage = ref<'chat' | 'settings' | 'sessions'>('chat');
export const activeSection = ref('connection');
export const isFirstRun = ref(false);
export const isGenerating = ref(false);
export const inputText = ref('');
export const contextList = ref<Array<{ fileName: string; content: string; kind?: string; languageId?: string; lineRange?: string }>>([]);
export const hasToken = ref(false);
export const bearerToken = ref('');
export const tokenVisible = ref(false);

// Implicit context — pushed from the backend on editor change / webview focus
export const implicitFile = ref<{ fileName: string; filePath: string; relativePath: string; languageId: string } | null>(null);
export const implicitSelection = ref<{ fileName: string; relativePath: string; content: string; startLine: number; endLine: number; languageId: string } | null>(null);
export const implicitFileEnabled = ref(true);  // user can toggle off the implicit file chip

export const thinking = reactive({
  visible: false,
  text: 'Thinking...'
});

export const warningBanner = reactive({
  visible: false,
  message: ''
});

export const settings = reactive({
  baseUrl: 'http://localhost:11434',
  enableAutoComplete: true,
  agentModel: '',
  chatModel: '',
  completionModel: '',
  maxIterations: 25,
  toolTimeout: 30000,
  maxActiveSessions: 1,
  enableThinking: true,
  continuationStrategy: 'full' as 'full' | 'standard' | 'minimal',
  temperature: 0.7,
  sensitiveFilePatterns: '',
  storagePath: '',
  maxContextWindow: 65536
});

export const chatSettings = reactive({
  streamResponses: true,
  showToolActions: true
});

export const autocomplete = reactive({
  autoTrigger: true,
  triggerDelay: 500,
  maxTokens: 500
});

export const agentSettings = reactive({
  autoCreateBranch: true,
  autoCommit: false
});

export const sessionSensitiveFilePatterns = ref('');

export const connectionStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });
export const modelsStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });
export const agentStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });
export const dbMaintenanceStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });
export const recreateMessagesStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });

// Capability check progress (Model Capabilities tab)
export const capabilityCheckProgress = reactive<{ running: boolean; completed: number; total: number }>({
  running: false,
  completed: 0,
  total: 0
});

export const tools = ref([
  { name: 'read_file', icon: '📄', desc: 'Read file contents' },
  { name: 'write_file', icon: '✍️', desc: 'Write content to a file' },
  { name: 'create_file', icon: '📄', desc: 'Create a new file' },
  { name: 'list_files', icon: '📁', desc: 'List directory contents' },
  { name: 'search_workspace', icon: '🔍', desc: 'Search for text in files' },
  { name: 'run_terminal_command', icon: '💻', desc: 'Execute shell commands' },
  { name: 'get_diagnostics', icon: '⚠️', desc: 'Get file errors/warnings' }
]);

export const temperatureSlider = ref(70);

export const currentProgressIndex = ref<number | null>(null);
/** Stack of parent progress group indices — pushed when nested sub-agent groups start */
export const progressIndexStack = ref<number[]>([]);
export const currentStreamIndex = ref<number | null>(null);
export const currentAssistantThreadId = ref<string | null>(null);

/**
 * Tracks the currently-open thinking group during live streaming.
 * Set when `streamThinking` creates a new ThinkingGroupBlock, cleared on
 * `finalMessage`, `generationStopped`, or session load.
 */
export const activeThinkingGroup = ref<AssistantThreadThinkingGroupBlock | null>(null);

// Session search state
export const searchQuery = ref('');
export const searchResults = ref<SearchResultGroup[]>([]);
export const allSearchResults = ref<SearchResultGroup[]>([]);
export const searchVisibleCount = ref(20);
export const searchIsRevealing = ref(false);
export const isSearching = ref(false);
export const scrollTargetMessageId = ref<string | null>(null);
export const autoScrollLocked = ref(false);

// Token usage indicator — live-only, not persisted to DB
export const tokenUsage = reactive({
  visible: false,
  promptTokens: 0,
  completionTokens: 0,
  contextWindow: 0,
  categories: {
    system: 0,
    toolDefinitions: 0,
    messages: 0,
    toolResults: 0,
    files: 0,
    total: 0
  }
});

// Plan handoff — shown after plan mode completes
export const pendingPlanContent = ref<string | null>(null);

// Session deletion state
export const deletingSessionIds = ref(new Set<string>());

// Multi-select state
export const selectionMode = ref(false);
export const selectedSessionIds = ref(new Set<string>());
export const deletionProgress = ref<{ completed: number; total: number } | null>(null);

// Standalone files-changed blocks — NOT part of timeline/thread blocks.
// Keyed by checkpointId. Shown as a persistent bottom panel in the chat view.
export const filesChangedBlocks = ref<AssistantThreadFilesChangedBlock[]>([]);

// State persistence for webview collapse/restore
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
watch([currentSessionId, currentPage], () => {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    vscode.setState({
      sessionId: currentSessionId.value,
      currentPage: currentPage.value
    });
  }, 200);
});
