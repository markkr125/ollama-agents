import * as vscode from 'vscode';
import { AgentExecutor, ExecutorConfig } from '../agent/executor';
import { GitOperations } from '../agent/gitOperations';
import { PRWorkflow } from '../agent/prWorkflow';
import { SessionManager } from '../agent/sessionManager';
import { ToolRegistry } from '../agent/toolRegistry';
import { getModeConfig } from '../config/settings';
import { OllamaClient } from '../services/ollamaClient';

export class AgentModeHandler {
  constructor(
    private client: OllamaClient,
    private toolRegistry: ToolRegistry,
    private sessionManager: SessionManager,
    private gitOps: GitOperations,
    private outputChannel: vscode.OutputChannel
  ) {}

  async handleAgentRequest(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    const config = getModeConfig('agent');

    if (!config.model) {
      stream.markdown('⚠️ No model configured for Agent mode. Please configure `ollamaCopilot.agentMode.model` in settings.');
      return;
    }

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      stream.markdown('⚠️ No workspace folder open');
      return;
    }

    stream.markdown('🤖 Starting autonomous agent...\n\n');

    // Create session
    const session = this.sessionManager.createSession(prompt, config.model, workspace);

    // Check Git availability
    const hasGit = await this.gitOps.validateGit();
    
    if (!hasGit) {
      stream.markdown('⚠️ Git not available. Branch creation disabled.\n\n');
    }

    // Create branch if Git available
    if (hasGit) {
      try {
        const currentBranch = await this.gitOps.getCurrentBranch(workspace);
        const newBranch = await this.gitOps.createBranch(currentBranch, prompt, workspace);
        session.branch = newBranch;
        
        stream.markdown(`📌 Created branch: \`${newBranch}\`\n\n`);
      } catch (error: any) {
        stream.markdown(`⚠️ Could not create branch: ${error.message}\n\n`);
      }
    }

    stream.markdown('🔧 Executing task...\n\n');
    this.outputChannel.show(true);

    const executorConfig: ExecutorConfig = {
      maxIterations: 20,
      toolTimeout: 30000,
      temperature: config.temperature || 0.7
    };

    const executor = new AgentExecutor(this.client, this.toolRegistry, this.outputChannel);

    try {
      await executor.execute(session, executorConfig, token);

      if (token.isCancellationRequested) {
        this.sessionManager.updateSession(session.id, { status: 'cancelled' });
        stream.markdown('\n\n🛑 Task cancelled\n');
        return;
      }

      // Mark as completed
      this.sessionManager.updateSession(session.id, { status: 'completed' });

      stream.markdown('\n\n✅ **Task completed!**\n\n');
      stream.markdown(`- Files changed: ${session.filesChanged.length}\n`);
      stream.markdown(`- Tool calls: ${session.toolCalls.length}\n`);
      
      if (session.errors.length > 0) {
        stream.markdown(`- Errors: ${session.errors.length}\n`);
      }

      // Commit changes if Git available
      if (hasGit && session.filesChanged.length > 0) {
        try {
          await this.gitOps.stageFiles(session.filesChanged, workspace);
          await this.gitOps.commit(
            `Ollama Copilot: ${prompt}`,
            'Ollama Copilot <copilot@ollama.local>',
            workspace
          );
          
          stream.markdown('\n📝 Changes committed\n');

          // Offer to push and create PR
          const prWorkflow = new PRWorkflow(this.gitOps);
          await prWorkflow.showCompletionPrompt(session);

        } catch (error: any) {
          stream.markdown(`\n⚠️ Could not commit: ${error.message}\n`);
        }
      }

    } catch (error: any) {
      this.sessionManager.updateSession(session.id, { status: 'failed' });
      stream.markdown(`\n\n❌ **Task failed**: ${error.message}\n`);
      
      if (session.errors.length > 0) {
        stream.markdown('\n**Errors encountered:**\n');
        for (const err of session.errors.slice(0, 5)) {
          stream.markdown(`- ${err}\n`);
        }
      }
    }
  }
}

/**
 * Register Agent mode
 */
export function registerAgentMode(
  context: vscode.ExtensionContext,
  client: OllamaClient,
  sessionManager: SessionManager,
  outputChannel: vscode.OutputChannel
): void {
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerBuiltInTools();

  const gitOps = new GitOperations();
  
  const agentHandler = new AgentModeHandler(
    client,
    toolRegistry,
    sessionManager,
    gitOps,
    outputChannel
  );

  // Store handler for access from chat participant
  (context as any).agentHandler = agentHandler;
}
