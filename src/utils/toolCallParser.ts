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
 *
 * @param response - The LLM response text to parse
 * @param knownToolNames - Optional set of valid tool names. When provided,
 *   bare JSON matches with unrecognized tool names are rejected (prevents
 *   false positives from arbitrary JSON in the response).
 */
export function extractToolCalls(response: string, knownToolNames?: Set<string>): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];

  // Find all <tool_call> blocks (complete or incomplete)
  const toolCallBlockRegex = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  let match: RegExpExecArray | null;

  while ((match = toolCallBlockRegex.exec(response)) !== null) {
    // Normalize smart/curly quotes → straight quotes BEFORE any JSON parsing.
    // Models (especially smaller ones) sometimes emit \u201C/\u201D instead of \u0022.
    const jsonContent = normalizeQuotes(match[1].trim());
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

  // Bare JSON fallback — catches models (e.g., Qwen2.5-Coder) that emit tool calls
  // as raw JSON objects without <tool_call> wrapping or [TOOL_CALLS] prefix.
  // Only activates if no tool calls were found via structured formats above.
  if (toolCalls.length === 0) {
    // Match JSON objects that look like tool calls: {"name": "...", "arguments": {...}}
    // Also handles code-fenced JSON: ```json\n{...}\n```
    const bareJsonRegex = /(?:```(?:json)?\s*)?\{[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?"(?:arguments|args)"\s*:\s*\{/g;
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = bareJsonRegex.exec(response)) !== null) {
      // Find the start of the actual JSON object (skip code fence)
      const objStart = response.indexOf('{', bareMatch.index);
      if (objStart < 0) continue;
      const normalized = normalizeQuotes(response.substring(objStart));
      const extracted = extractBalancedJson(normalized);
      if (!extracted) continue;
      try {
        const parsed = JSON.parse(extracted);
        const toolName = parsed?.name || parsed?.tool || parsed?.function;
        if (toolName) {
          // Validate against known tool names to avoid false positives
          if (knownToolNames && !knownToolNames.has(toolName)) continue;
          let args = parsed?.arguments || parsed?.args || parsed?.params || parsed?.parameters;
          if (!args || Object.keys(args).length === 0) {
            const { name: _name, tool: _tool, function: _fn, arguments: _a, args: _b, params: _c, parameters: _d, ...rest } = parsed;
            if (Object.keys(rest).length > 0) args = rest;
          }
          toolCalls.push({ name: toolName, args: args || {} });
        }
      } catch { /* skip */ }
    }
  }

  return toolCalls;
}

/**
 * Strips bare JSON tool call objects from a response string so they don't
 * leak into the user-visible assistant text. Handles both raw JSON and
 * code-fenced JSON blocks.
 *
 * @param response - The LLM response text
 * @param knownToolNames - Set of valid tool names to identify tool call JSON
 * @returns The response with bare JSON tool calls removed
 */
export function stripBareJsonToolCalls(response: string, knownToolNames: Set<string>): string {
  // Remove code-fenced blocks that contain tool call JSON
  let result = response.replace(/```(?:json)?\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?```/g, (match, name) => {
    return knownToolNames.has(name) ? '' : match;
  });
  // Remove bare JSON objects that look like tool calls
  const bareJsonRegex = /\{[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?"(?:arguments|args)"\s*:\s*\{/g;
  let bareMatch: RegExpExecArray | null;
  // Process from end to start to preserve indices
  const removals: Array<{ start: number; end: number }> = [];
  while ((bareMatch = bareJsonRegex.exec(result)) !== null) {
    const toolName = bareMatch[1];
    if (!knownToolNames.has(toolName)) continue;
    const objStart = result.indexOf('{', bareMatch.index);
    if (objStart < 0) continue;
    const normalized = normalizeQuotes(result.substring(objStart));
    const extracted = extractBalancedJson(normalized);
    if (!extracted) continue;
    removals.push({ start: objStart, end: objStart + extracted.length });
  }
  // Apply removals from end to start
  for (let i = removals.length - 1; i >= 0; i--) {
    result = result.substring(0, removals[i].start) + result.substring(removals[i].end);
  }
  return result.trim();
}
