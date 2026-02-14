import * as vscode from 'vscode';
import { Tool } from '../../types/agent';
import { resolveWorkspacePath } from './pathUtils';

/**
 * write_file — Write content to a file relative to the workspace.
 *
 * In native tool-calling mode, the schema exposes `path` + `description`
 * (NOT `content`). The agent model provides a short description of the
 * intended changes, and the AgentFileEditHandler makes a **separate**
 * streaming LLM call to generate the actual file content. This avoids
 * Ollama's silent 60-80s buffering of tool_call JSON for large files.
 *
 * In XML-fallback mode (or if `content` is provided directly), the tool
 * writes the content as-is for backward compatibility.
 *
 * Accepts `path`, `file`, or `filePath` as the argument name.
 */
export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write or create a file. Provide the file path and a brief description of what to write — the system will generate the content. Do NOT include the full file content, only describe the changes.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      file: { type: 'string', description: 'Alternative: file path relative to workspace' },
      description: { type: 'string', description: 'Brief description of the file content or changes to make (NOT the actual file content)' },
      content: { type: 'string', description: 'Full file content (only used in XML fallback mode — do NOT provide this in normal usage)' }
    },
    required: ['path', 'description']
  },
  execute: async (params, context) => {
    const relativePath = params.path || params.file || params.filePath;
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Missing required argument: path (file path relative to workspace)');
    }
    const filePath = resolveWorkspacePath(relativePath, context.workspace);
    const uri = vscode.Uri.file(filePath);

    try {
      const content = new TextEncoder().encode(params.content);
      await vscode.workspace.fs.writeFile(uri, content);
      return `Successfully wrote to ${relativePath}`;
    } catch (error: any) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }
};
