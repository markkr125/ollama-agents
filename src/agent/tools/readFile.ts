import * as fs from 'fs';
import * as readline from 'readline';
import { Tool } from '../../types/agent';
import { resolveMultiRootPath } from './pathUtils';

const CHUNK_SIZE = 100;

/**
 * Count total lines in a file by streaming — never loads the full file.
 */
export async function countFileLines(absPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', () => { count++; });
    rl.on('close', () => resolve(count));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

/**
 * Read a specific line range from a file by streaming.
 * Lines are 1-based inclusive. Never loads the full file into memory.
 */
export async function readFileChunk(absPath: string, startLine: number, endLine: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let lineNum = 0;
    const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      lineNum++;
      if (lineNum >= startLine && lineNum <= endLine) {
        lines.push(line);
      }
      if (lineNum >= endLine) {
        rl.close();
        stream.destroy();
      }
    });
    rl.on('close', () => resolve(lines.join('\n')));
    rl.on('error', reject);
    stream.on('error', (err: any) => {
      // stream.destroy() above may trigger EBADF — ignore it
      if (err.code !== 'EBADF' && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        reject(err);
      }
    });
  });
}

/**
 * read_file — Read the contents of a file relative to the workspace.
 * Accepts `path`, `file`, or `filePath` as the argument name.
 *
 * When called without startLine/endLine from agentToolRunner, the runner
 * handles chunked reading and UI. This execute() is the single-shot fallback.
 */
export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file relative to the workspace.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      file: { type: 'string', description: 'Alternative: file path relative to workspace' }
    },
    required: []
  },
  execute: async (params, context) => {
    // Direct execution fallback (non-agent callers).
    // In agent mode, agentToolRunner intercepts read_file and does chunked streaming.
    const relativePath = params.path || params.file || params.filePath;
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Missing required argument: path (file path relative to workspace)');
    }
    const absPath = resolveMultiRootPath(relativePath, context.workspace, context.workspaceFolders);
    const total = await countFileLines(absPath);
    return readFileChunk(absPath, 1, total);
  }
};

export { CHUNK_SIZE };
