import * as vscode from 'vscode';

export interface Step {
  index: number;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  fileReferences: string[];
  error?: string;
}

export interface Task {
  id: string;
  title: string;
  steps: Step[];
  workspace?: vscode.WorkspaceFolder;
  createdAt: number;
  updatedAt: number;
}

export class TaskTracker {
  private tasks: Map<string, Task> = new Map();

  constructor(private context: vscode.ExtensionContext) {
    this.loadTasks();
  }

  /**
   * Create a new task
   */
  createTask(title: string, steps: Omit<Step, 'index'>[], workspace?: vscode.WorkspaceFolder): Task {
    const task: Task = {
      id: this.generateId(),
      title,
      steps: steps.map((step, index) => ({ ...step, index })),
      workspace,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.tasks.set(task.id, task);
    this.saveTasks();

    return task;
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Update step status
   */
  updateStepStatus(taskId: string, stepIndex: number, status: Step['status'], error?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {return;}

    const step = task.steps[stepIndex];
    if (step) {
      step.status = status;
      if (error) {
        step.error = error;
      }
      task.updatedAt = Date.now();
      this.saveTasks();
    }
  }

  /**
   * Update entire task
   */
  updateTask(taskId: string, updates: Partial<Task>): void {
    const task = this.tasks.get(taskId);
    if (!task) {return;}

    Object.assign(task, updates);
    task.updatedAt = Date.now();
    this.saveTasks();
  }

  /**
   * Delete task
   */
  deleteTask(taskId: string): void {
    this.tasks.delete(taskId);
    this.saveTasks();
  }

  /**
   * Clear old completed tasks
   */
  clearOldTasks(olderThanDays: number = 7): void {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    
    for (const [id, task] of this.tasks.entries()) {
      const allCompleted = task.steps.every(s => s.status === 'completed');
      if (allCompleted && task.updatedAt < cutoff) {
        this.tasks.delete(id);
      }
    }

    this.saveTasks();
  }

  /**
   * Get task progress percentage
   */
  getProgress(taskId: string): number {
    const task = this.tasks.get(taskId);
    if (!task || task.steps.length === 0) {return 0;}

    const completed = task.steps.filter(s => s.status === 'completed').length;
    return Math.round((completed / task.steps.length) * 100);
  }

  /**
   * Generate unique task ID
   */
  private generateId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Load tasks from storage
   */
  private loadTasks(): void {
    const stored = this.context.globalState.get<string>('ollamaCopilot.tasks');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        this.tasks = new Map(parsed);
      } catch (error) {
        console.error('Failed to load tasks:', error);
      }
    }
  }

  /**
   * Save tasks to storage
   */
  private saveTasks(): void {
    const serialized = JSON.stringify(Array.from(this.tasks.entries()));
    this.context.globalState.update('ollamaCopilot.tasks', serialized);
  }
}
