export type ParsedToolCall = { name: string; args: any };

/**
 * Normalizes smart quotes to regular quotes.
 * Matches: " (U+201C), " (U+201D), and regular " (U+0022)
 */
function normalizeQuotes(str: string): string {
  return str.replace(/[\u201C\u201D"]/g, '"');
}

/**
 * Extracts a balanced JSON object from a string by counting braces.
 * Handles nested objects properly.
 */
function extractBalancedJson(str: string): string | null {
  if (!str.startsWith('{')) return null;
  
  let depth = 0;
  let inString = false;
  let escaped = false;
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    
    if (escaped) {
      escaped = false;
      continue;
    }
    
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (inString) continue;
    
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(0, i + 1);
      }
    }
  }
  
  // If we didn't find balanced braces, try to repair by adding closing braces
  if (depth > 0) {
    return str + '}'.repeat(depth);
  }
  
  return null;
}

/**
 * Detects an in-progress XML tool call, used to update UI while streaming.
 */
export function detectPartialToolCall(response: string): string | null {
  const match = response.match(/<tool_call>\s*\{\s*"name"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Removes any tool-call markup/content so the assistant text can be displayed as plain prose.
 * This intentionally mirrors the current parsing contracts used by AgentChatExecutor.
 */
export function removeToolCalls(response: string): string {
  return response
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/g, '')
    .replace(/```json\s*\{[\s\S]*?"name"[\s\S]*?\}[\s\S]*?```/g, '')
    .replace(/\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
    .replace(/^\[TOOL_CALLS\][\s\S]*?(?:\n|$)/gm, '')
    .replace(/\[TASK_COMPLETE\]/g, '')
    .trim();
}

/**
 * Extracts tool calls from either:
 *  - XML blocks: <tool_call>{"name":"x","arguments":{...}}</tool_call>
 *  - Bracket format: [TOOL_CALLS] tool_name [ARGS] {...}
 *  - Incomplete XML: <tool_call>{...} (no closing tag - LLM got cut off)
 * 
 * Handles various LLM quirks like:
 *  - Using "args", "params", "parameters" instead of "arguments"
 *  - Putting args at top level instead of nested under "arguments"
 *  - Using "tool" or "function" instead of "name"
 */
export function extractToolCalls(response: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];

  // Find all <tool_call> blocks (complete or incomplete)
  const toolCallBlockRegex = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  let match: RegExpExecArray | null;

  while ((match = toolCallBlockRegex.exec(response)) !== null) {
    const jsonContent = match[1].trim();
    if (!jsonContent.startsWith('{')) continue;
    
    // Try to extract valid JSON by finding balanced braces
    const extracted = extractBalancedJson(jsonContent);
    if (!extracted) continue;
    
    try {
      const parsed = JSON.parse(extracted);
      const toolName = parsed?.name || parsed?.tool || parsed?.function;
      if (toolName) {
        // Try multiple possible argument field names
        let args = parsed?.arguments || parsed?.args || parsed?.params || parsed?.parameters;
        
        // If no arguments field found, maybe the args are at the top level
        // (e.g., {"name": "read_file", "path": "package.json"})
        if (!args || Object.keys(args).length === 0) {
          const { name: _name, tool: _tool, function: _fn, arguments: _a, args: _b, params: _c, parameters: _d, ...rest } = parsed;
          if (Object.keys(rest).length > 0) {
            args = rest;
          }
        }
        
        toolCalls.push({ name: toolName, args: args || {} });
      }
    } catch {
      // skip invalid JSON
    }
  }

  // Bracket format: [TOOL_CALLS] tool_name [ARGS] {...}
  const bracketToolCallRegex = /\[TOOL_CALLS\]\s*([^[]+)\[ARGS\]\s*(\{[\s\S]*?)(?:\n|$)/g;
  while ((match = bracketToolCallRegex.exec(response)) !== null) {
    const name = (match[1] || '').trim();
    // Normalize smart quotes to regular quotes BEFORE extracting balanced JSON
    const rawArgs = normalizeQuotes((match[2] || '').trim());
    
    // Use balanced JSON extraction for the args
    const extracted = extractBalancedJson(rawArgs);
    if (!extracted) continue;
    
    try {
      const args = JSON.parse(extracted);
      if (name) {
        toolCalls.push({ name, args });
      }
    } catch {
      // skip
    }
  }

  return toolCalls;
}
