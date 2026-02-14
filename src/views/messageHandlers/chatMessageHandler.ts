import * as vscode from 'vscode';
import { GitOperations } from '../../agent/gitOperations';
import { SessionManager } from '../../agent/sessionManager';
import { getConfig, getModeConfig } from '../../config/settings';
import { AgentChatExecutor } from '../../services/agent/agentChatExecutor';
import { DatabaseService } from '../../services/database/databaseService';
import { getModelCapabilities, ModelCapabilities } from '../../services/model/modelCompatibility';
import { OllamaClient } from '../../services/model/ollamaClient';
import { PendingEditReviewService } from '../../services/review/pendingEditReviewService';
import { TokenManager } from '../../services/tokenManager';
import { ExecutorConfig } from '../../types/agent';
import { Model } from '../../types/ollama';
import { ChatSessionStatus, MessageRecord } from '../../types/session';
import { ChatSessionController } from '../chatSessionController';
import { ChatMessage, ContextItem, IMessageHandler, ViewState, WebviewMessageEmitter } from '../chatTypes';
import { SettingsHandler } from '../settingsHandler';
import { mergeCachedCapabilities, ModelMessageHandler } from './modelMessageHandler';

/**
 * Handles core chat lifecycle messages: init, send, stop, model/mode selection, new chat, add context.
 * This is the largest handler because it owns the main message flow and agent/chat orchestration.
 */
export class ChatMessageHandler implements IMessageHandler {
  readonly handledTypes = [
    'ready', 'sendMessage', 'stopGeneration', 'selectModel', 'selectMode', 'newChat', 'addContext'
  ] as const;

  private cancellationTokenSource?: vscode.CancellationTokenSource;

  constructor(
    private readonly state: ViewState,
    private readonly emitter: WebviewMessageEmitter,
    private readonly sessionController: ChatSessionController,
    private readonly settingsHandler: SettingsHandler,
    private readonly agentExecutor: AgentChatExecutor,
    private readonly databaseService: DatabaseService,
    private readonly client: OllamaClient,
    private readonly tokenManager: TokenManager,
    private readonly sessionManager: SessionManager,
    private readonly gitOps: GitOperations,
    private readonly modelHandler: ModelMessageHandler,
    private readonly reviewService?: PendingEditReviewService,
  ) {}

  async handle(data: any): Promise<void> {
    switch (data.type) {
      case 'ready':
        await this.initialize(data.sessionId);
        await this.settingsHandler.sendSettingsUpdate();
        break;
      case 'sendMessage':
        await this.handleMessage(data.text, data.context);
        break;
      case 'stopGeneration':
        this.stopGeneration(data.sessionId);
        break;
      case 'selectModel':
        await this.handleModelChange(data.model);
        break;
      case 'selectMode':
        this.state.currentMode = data.mode;
        break;
      case 'newChat': {
        const idleSessionId = await this.databaseService.findIdleEmptySession();
        if (idleSessionId) {
          await this.sessionController.loadSession(idleSessionId);
        } else {
          await this.sessionController.createNewSession(this.state.currentMode, this.state.currentModel);
          this.emitter.postMessage({ type: 'clearMessages', sessionId: this.sessionController.getCurrentSessionId() });
          this.emitter.postMessage({
            type: 'sessionApprovalSettings',
            sessionId: this.sessionController.getCurrentSessionId(),
            autoApproveCommands: false,
            autoApproveSensitiveEdits: false,
            sessionSensitiveFilePatterns: null
          });
          await this.sessionController.sendSessionsList();
        }
        break;
      }
      case 'addContext':
        await this.handleAddContext();
        break;
    }
  }

  private async initialize(requestedSessionId?: string) {
    const settings = this.settingsHandler.getSettingsPayload();
    const hasToken = await this.tokenManager.hasToken();

    // Run session loading and model listing in parallel
    const sessionLoadPromise = (async () => {
      // Try to restore the session the webview was showing before collapse
      if (requestedSessionId) {
        const session = await this.databaseService.getSession(requestedSessionId);
        if (session) {
          await this.sessionController.loadSession(requestedSessionId);
          return;
        }
      }
      if (!this.sessionController.getCurrentSessionId()) {
        const recentSessions = await this.databaseService.listSessions(1);
        if (recentSessions.sessions.length > 0) {
          await this.sessionController.loadSession(recentSessions.sessions[0].id);
        } else {
          await this.sessionController.createNewSession(this.state.currentMode, this.state.currentModel);
        }
      }
    })();

    const modelListPromise = (async () => {
      try {
        const fetched = await this.client.listModels();
        // Merge capabilities from SQLite cache so the UI isn't blank
        await mergeCachedCapabilities(this.databaseService, fetched);
        // Persist basic model info (fire-and-forget)
        this.databaseService.upsertModels(fetched).catch(err =>
          console.warn('[ChatMessageHandler] Failed to cache models:', err)
        );
        return fetched;
      } catch (err: any) {
        console.warn('Failed to list models during init:', err);
        // Fall back to cached models from SQLite
        try { return await this.databaseService.getCachedModels(); } catch { /* ignore */ }
        return [] as Model[];
      }
    })();

    const [, models] = await Promise.all([sessionLoadPromise, modelListPromise]);

    const modeConfig = getModeConfig('agent');
    this.state.currentModel = modeConfig.model || (models.length > 0 ? models[0].name : '');

    this.emitter.postMessage({
      type: 'init',
      models: models.map((m: any) => {
        const caps = getModelCapabilities(m);
        return {
          name: m.name,
          selected: m.name === this.state.currentModel,
          size: m.size ?? 0,
          parameterSize: m.details?.parameter_size ?? undefined,
          quantizationLevel: m.details?.quantization_level ?? undefined,
          capabilities: caps,
          enabled: m.enabled !== false
        };
      }),
      currentMode: this.state.currentMode,
      settings,
      hasToken
    });

    // Populate the sessions list for the sidebar
    await this.sessionController.sendSessionsList();

    // Auto-pull capabilities in background for models that don't have them yet
    if (models.length > 0) {
      this.modelHandler.refreshCapabilities(/* onlyMissing */ true);
    }

    if (models.length === 0) {
      this.emitter.postMessage({
        type: 'connectionError',
        error: 'No models available. Check your Ollama connection.'
      });
    }
  }

  private async handleAddContext() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.selection;
      const text = editor.document.getText(selection.isEmpty ? undefined : selection);
      const fileName = editor.document.fileName.split('/').pop() || 'file';
      const lineInfo = selection.isEmpty ? '' : `:${selection.start.line + 1}`;

      this.emitter.postMessage({
        type: 'addContextItem',
        context: {
          fileName: fileName + lineInfo,
          content: text.substring(0, 8000)
        }
      });
    }
  }

  private stopGeneration(sessionId?: string) {
    const targetSessionId = sessionId || this.sessionController.getCurrentSessionId();
    const tokenSource = targetSessionId ? this.state.activeSessions.get(targetSessionId) : undefined;
    if (tokenSource) {
      tokenSource.cancel();
      this.state.activeSessions.delete(targetSessionId);
    }
    if (this.cancellationTokenSource === tokenSource) {
      this.cancellationTokenSource = undefined;
    }
    this.emitter.postMessage({ type: 'generationStopped', sessionId: targetSessionId });
    void this.sessionController.setSessionStatus('completed', targetSessionId);
  }

  private async handleMessage(text: string, contextItems?: ContextItem[]) {
    if (!text.trim()) return;

    const sessionIdAtStart = this.sessionController.getCurrentSessionId();
    const session = await this.sessionController.getCurrentSession();
    if (!session || !sessionIdAtStart) return;

    console.log('handleMessage received user input:', {
      sessionId: sessionIdAtStart,
      textLength: text.length,
      mode: this.state.currentMode
    });

    const sessionMessagesSnapshot = [...this.sessionController.getCurrentMessages()];
    const { agent } = getConfig();

    if (this.state.activeSessions.has(sessionIdAtStart)) {
      return;
    }

    if (this.state.activeSessions.size >= agent.maxActiveSessions) {
      this.emitter.postMessage({
        type: 'addMessage',
        sessionId: sessionIdAtStart,
        message: {
          role: 'assistant',
          content: 'Too many sessions are running. Stop a session or increase the limit in Settings → Agent → Max Active Sessions.'
        }
      });
      return;
    }

    const tokenSource = new vscode.CancellationTokenSource();
    this.cancellationTokenSource = tokenSource;
    this.state.activeSessions.set(sessionIdAtStart, tokenSource);
    const token = tokenSource.token;
    await this.sessionController.setSessionStatus('generating', sessionIdAtStart);

    let contextStr = '';
    if (contextItems && contextItems.length > 0) {
      contextStr = contextItems.map(c => `[${c.fileName}]\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
    }

    const fullPrompt = contextStr ? `${contextStr}\n\n${text}` : text;

    console.log('Persisting user message to database:', { sessionId: sessionIdAtStart });
    const userMessage = await this.databaseService.addMessage(sessionIdAtStart, 'user', text);
    if (this.sessionController.getCurrentSessionId() === sessionIdAtStart) {
      this.sessionController.pushMessage(userMessage);
    }

    if (sessionMessagesSnapshot.length === 0) {
      const newTitle = text.substring(0, 40) + (text.length > 40 ? '...' : '');
      await this.databaseService.updateSession(sessionIdAtStart, { title: newTitle });
      await this.sessionController.sendSessionsList();
    }

    const chatMessage: ChatMessage = { role: 'user', content: text, timestamp: userMessage.timestamp };
    this.emitter.postMessage({ type: 'addMessage', message: chatMessage, sessionId: sessionIdAtStart });
    this.emitter.postMessage({ type: 'generationStarted', sessionId: sessionIdAtStart });

    if (!this.state.currentModel) {
      await this.sessionController.setSessionStatus('error', sessionIdAtStart);
      this.state.activeSessions.delete(sessionIdAtStart);
      this.emitter.postMessage({ type: 'generationStopped', sessionId: sessionIdAtStart });
      this.emitter.postMessage({ type: 'showError', message: 'No model selected', sessionId: sessionIdAtStart });
      return;
    }

    let finalStatus: ChatSessionStatus = 'completed';
    try {
      if (this.state.currentMode === 'agent') {
        await this.handleAgentMode(fullPrompt, token, sessionIdAtStart);
      } else {
        await this.handleChatMode(fullPrompt, token, sessionIdAtStart, sessionMessagesSnapshot);
      }
    } catch (error: any) {
      finalStatus = 'error';
      this.emitter.postMessage({ type: 'showError', message: error.message, sessionId: sessionIdAtStart });
    } finally {
      await this.sessionController.setSessionStatus(finalStatus, sessionIdAtStart);
      this.state.activeSessions.delete(sessionIdAtStart);
      this.emitter.postMessage({ type: 'generationStopped', sessionId: sessionIdAtStart });
      // Refresh session list so pending stats badge appears immediately
      await this.sessionController.sendSessionsList();
    }
  }

  private async handleAgentMode(prompt: string, token: vscode.CancellationToken, sessionId: string) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.emitter.postMessage({ type: 'showError', message: 'No workspace folder open', sessionId });
      return;
    }

    const agentSession = this.sessionManager.createSession(prompt, this.state.currentModel, workspace);

    this.emitter.postMessage({ type: 'showThinking', message: 'Analyzing request...', sessionId });

    const hasGit = await this.gitOps.validateGit();
    if (hasGit) {
      try {
        const currentBranch = await this.gitOps.getCurrentBranch(workspace);
        const newBranch = await this.gitOps.createBranch(currentBranch, prompt, workspace);
        agentSession.branch = newBranch;

        // Persist git branch action so history matches live chat
        await this.agentExecutor.persistGitBranchAction(sessionId, newBranch);
      } catch {
        // Continue without branch
      }
    }

    const config: ExecutorConfig = { maxIterations: getConfig().agent.maxIterations, toolTimeout: getConfig().agent.toolTimeout, temperature: 0.7 };

    // Fetch model capabilities to decide native vs XML tool calling
    let capabilities: ModelCapabilities | undefined;
    try {
      const cached = await this.databaseService.getCachedModels();
      const modelRecord = cached.find(m => m.name === this.state.currentModel);
      if (modelRecord) {
        capabilities = getModelCapabilities(modelRecord);
      }
    } catch { /* proceed without — executor will default to XML fallback */ }

    // Register per-file review callback so CodeLens appears as each file is written
    if (this.reviewService) {
      const reviewSvc = this.reviewService;
      const emitter = this.emitter;
      this.agentExecutor.onFileWritten = (checkpointId: string) => {
        reviewSvc.startReviewForCheckpoint(checkpointId).then(() => {
          const pos = reviewSvc.getChangePosition(checkpointId);
          if (pos) {
            emitter.postMessage({ type: 'reviewChangePosition', checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
          }
        }).catch(() => {});
      };
    }

    const result = await this.agentExecutor.execute(agentSession, config, token, sessionId, this.state.currentModel, capabilities);

    // Clear the per-write callback
    this.agentExecutor.onFileWritten = undefined;

    if (this.sessionController.getCurrentSessionId() === sessionId) {
      this.sessionController.pushMessage(result.assistantMessage);
    }

    // Auto-start inline review for any already-open editors
    if (result.checkpointId && this.reviewService) {
      await this.reviewService.startReviewForCheckpoint(result.checkpointId);
      const pos = this.reviewService.getChangePosition(result.checkpointId);
      if (pos) {
        this.emitter.postMessage({ type: 'reviewChangePosition', checkpointId: result.checkpointId, current: pos.current, total: pos.total, filePath: pos.filePath });
      }
    }
  }

  private async handleChatMode(
    prompt: string,
    token: vscode.CancellationToken,
    sessionId: string,
    sessionMessages: MessageRecord[]
  ) {
    let fullResponse = '';

    const chatMessages = sessionMessages
      .filter(m => m.role !== 'tool')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const systemPrompt = this.state.currentMode === 'edit'
      ? 'You are a code editor. Provide clear, concise code modifications.'
      : 'You are a helpful coding assistant.';

    const stream = this.client.chat({
      model: this.state.currentModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...chatMessages,
        { role: 'user', content: prompt }
      ]
    });

    // Show thinking spinner until first token arrives
    this.emitter.postMessage({ type: 'showThinking', message: 'Thinking...', sessionId });
    let firstChunk = true;

    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    const STREAM_THROTTLE_MS = 32; // ~30fps — balances responsiveness with CPU usage

    for await (const chunk of stream) {
      if (token.isCancellationRequested) break;
      if (chunk.message?.content) {
        fullResponse += chunk.message.content;
        if (firstChunk) {
          firstChunk = false;
          this.emitter.postMessage({ type: 'hideThinking', sessionId });
        }
        // Throttle: schedule a trailing-edge post instead of posting every token
        if (!streamTimer) {
          streamTimer = setTimeout(() => {
            streamTimer = null;
            this.emitter.postMessage({ type: 'streamChunk', content: fullResponse, model: this.state.currentModel, sessionId });
          }, STREAM_THROTTLE_MS);
        }
      }
    }

    // Flush any pending throttled update
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }

    const assistantMessage = await this.databaseService.addMessage(
      sessionId,
      'assistant',
      fullResponse,
      { model: this.state.currentModel }
    );
    if (this.sessionController.getCurrentSessionId() === sessionId) {
      this.sessionController.pushMessage(assistantMessage);
    }

    this.emitter.postMessage({ type: 'finalMessage', content: fullResponse, model: this.state.currentModel, sessionId });
  }

  private async handleModelChange(modelName: string) {
    if (!modelName) return;
    this.state.currentModel = modelName;
    await vscode.workspace.getConfiguration('ollamaCopilot')
      .update('agentMode.model', modelName, vscode.ConfigurationTarget.Global);
  }
}
