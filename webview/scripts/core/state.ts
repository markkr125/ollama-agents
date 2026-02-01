import { reactive, ref } from 'vue';
import type { SearchResultGroup, SessionItem, StatusMessage, TimelineItem } from './types';

declare const acquireVsCodeApi: () => { postMessage: (message: any) => void };

export const vscode = acquireVsCodeApi();

export const messagesEl = ref<HTMLDivElement | null>(null);
export const inputEl = ref<HTMLTextAreaElement | null>(null);

export const timeline = ref<TimelineItem[]>([]);
export const sessions = ref<SessionItem[]>([]);
export const sessionsHasMore = ref(false);
export const sessionsLoading = ref(false);
export const sessionsCursor = ref<number | null>(null);
export const modelOptions = ref<string[]>([]);
export const currentMode = ref('agent');
export const currentModel = ref('');
export const currentPage = ref<'chat' | 'settings' | 'sessions'>('chat');
export const activeSection = ref('connection');
export const isGenerating = ref(false);
export const inputText = ref('');
export const contextList = ref<Array<{ fileName: string; content: string }>>([]);
export const hasToken = ref(false);
export const bearerToken = ref('');
export const tokenVisible = ref(false);

export const thinking = reactive({
  visible: false,
  text: 'Thinking...'
});

export const settings = reactive({
  baseUrl: 'http://localhost:11434',
  enableAutoComplete: true,
  agentModel: '',
  askModel: '',
  editModel: '',
  completionModel: '',
  maxIterations: 25,
  toolTimeout: 30000,
  temperature: 0.7
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

export const connectionStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });
export const modelsStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });
export const agentStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });
export const dbMaintenanceStatus = reactive<StatusMessage>({ visible: false, success: true, message: '' });

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
export const currentStreamIndex = ref<number | null>(null);

// Session search state
export const searchQuery = ref('');
export const searchResults = ref<SearchResultGroup[]>([]);
export const allSearchResults = ref<SearchResultGroup[]>([]);
export const searchVisibleCount = ref(20);
export const searchIsRevealing = ref(false);
export const isSearching = ref(false);
export const scrollTargetMessageId = ref<string | null>(null);
export const autoScrollLocked = ref(false);
