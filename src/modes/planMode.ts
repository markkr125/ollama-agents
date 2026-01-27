import * as vscode from 'vscode';
import { Step, Task, TaskTracker } from '../agent/taskTracker';
import { getModeConfig } from '../config/settings';
import { OllamaClient } from '../services/ollamaClient';
import { ChatMessage } from '../types/ollama';

export class PlanModeHandler {
  constructor(
    private client: OllamaClient,
    private taskTracker: TaskTracker
  ) {}

  async handlePlanRequest(
    prompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<Task | null> {
    const config = getModeConfig('plan');

    if (!config.model) {
      stream.markdown('⚠️ No model configured for Plan mode. Please configure `ollamaCopilot.planMode.model` in settings.');
      return null;
    }

    stream.markdown('🤔 Planning your task...\n\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are an expert software architect and project planner. Break down user tasks into 3-7 actionable steps. Each step should be:
- Clear and specific
- Include relevant file references if known
- Ordered logically

Format your response as a numbered list. Be concise.`
      },
      {
        role: 'user',
        content: `Task: ${prompt}\n\nBreak this down into actionable steps:`
      }
    ];

    let fullResponse = '';

    try {
      const chatStream = this.client.chat({
        model: config.model,
        messages,
        options: {
          temperature: config.temperature,
          num_predict: config.maxTokens
        }
      });

      for await (const chunk of chatStream) {
        if (token.isCancellationRequested) {
          return null;
        }

        const content = chunk.message?.content || chunk.response || '';
        if (content) {
          fullResponse += content;
          stream.markdown(content);
        }

        if (chunk.done) {
          break;
        }
      }

      // Parse steps from response
      const steps = this.parseSteps(fullResponse);

      if (steps.length === 0) {
        stream.markdown('\n\n⚠️ Could not parse steps from response.');
        return null;
      }

      // Create task
      const workspace = vscode.workspace.workspaceFolders?.[0];
      const task = this.taskTracker.createTask(prompt, steps, workspace);

      // Display task summary
      stream.markdown('\n\n---\n\n## 📋 Task Plan\n\n');
      
      for (const step of task.steps) {
        const checkbox = step.status === 'completed' ? '✅' : '⬜';
        stream.markdown(`${checkbox} **Step ${step.index + 1}**: ${step.description}\n`);
        
        if (step.fileReferences.length > 0) {
          stream.markdown(`   📁 Files: ${step.fileReferences.join(', ')}\n`);
        }
      }

      stream.markdown('\n\nUse commands to execute steps:\n');
      stream.markdown('- `Ollama Copilot: Execute Step` to run individual steps\n');
      stream.markdown('- Or use Agent mode for autonomous execution\n');

      return task;

    } catch (error: any) {
      if (token.isCancellationRequested) {
        return null;
      }
      
      stream.markdown(`\n\n❌ Error: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse steps from LLM response
   */
  private parseSteps(response: string): Omit<Step, 'index'>[] {
    const steps: Omit<Step, 'index'>[] = [];
    
    // Match numbered list items
    const stepRegex = /^\s*(\d+)[.):]\s+(.+?)$/gm;
    const matches = Array.from(response.matchAll(stepRegex));

    for (const match of matches) {
      const description = match[2].trim();
      const fileReferences = this.extractFileReferences(description);

      steps.push({
        description,
        status: 'pending',
        fileReferences
      });
    }

    return steps;
  }

  /**
   * Extract file references from step description
   */
  private extractFileReferences(text: string): string[] {
    const files: string[] = [];
    
    // Match common file patterns
    const patterns = [
      /`([^`]+\.[a-z]{2,4})`/gi,  // `file.ext`
      /\b([\w/-]+\.(ts|js|py|go|rs|java|cpp|c|h|css|html|json|yaml|yml|md|txt))\b/gi
    ];

    for (const pattern of patterns) {
      const matches = Array.from(text.matchAll(pattern));
      for (const match of matches) {
        const file = match[1];
        if (!files.includes(file)) {
          files.push(file);
        }
      }
    }

    return files;
  }

  /**
   * Execute a single step
   */
  async executeStep(
    taskId: string,
    stepIndex: number,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const task = this.taskTracker.getTask(taskId);
    if (!task) {
      stream.markdown('❌ Task not found');
      return;
    }

    const step = task.steps[stepIndex];
    if (!step) {
      stream.markdown('❌ Step not found');
      return;
    }

    this.taskTracker.updateStepStatus(taskId, stepIndex, 'in-progress');
    
    stream.markdown(`🔄 Executing: ${step.description}\n\n`);

    // For now, just provide guidance
    // In a full implementation, this would integrate with Agent mode
    stream.markdown('This step would be executed by Agent mode.\n\n');
    stream.markdown('To implement this step:\n');
    stream.markdown(`1. ${step.description}\n`);
    
    if (step.fileReferences.length > 0) {
      stream.markdown(`\n📁 Relevant files: ${step.fileReferences.join(', ')}\n`);
    }

    this.taskTracker.updateStepStatus(taskId, stepIndex, 'completed');
    stream.markdown('\n✅ Step marked as completed\n');
  }
}

/**
 * Register Plan mode command
 */
export async function registerPlanMode(
  context: vscode.ExtensionContext,
  client: OllamaClient,
  taskTracker: TaskTracker
): Promise<void> {
  const planHandler = new PlanModeHandler(client, taskTracker);

  // Store handler for access from chat participant
  (context as any).planHandler = planHandler;

  // Register execute step command
  const executeStepCommand = vscode.commands.registerCommand(
    'ollamaCopilot.executeStep',
    async (taskId?: string, stepIndex?: number) => {
      if (!taskId || stepIndex === undefined) {
        // Show task/step picker
        const tasks = taskTracker.getAllTasks();
        if (tasks.length === 0) {
          vscode.window.showInformationMessage('No tasks available');
          return;
        }

        // Simple implementation - just show info
        vscode.window.showInformationMessage('Execute step from chat interface');
        return;
      }

      // Execute step would integrate with chat/agent
      vscode.window.showInformationMessage(`Executing step ${stepIndex + 1} of task ${taskId}`);
    }
  );

  context.subscriptions.push(executeStepCommand);
}
