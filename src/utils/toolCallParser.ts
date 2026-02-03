export type ParsedToolCall = { name: string; args: any };

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
 */
export function extractToolCalls(response: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];

  const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;

  while ((match = toolCallRegex.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.name && parsed?.arguments) {
        toolCalls.push({ name: parsed.name, args: parsed.arguments });
      }
    } catch {
      // skip invalid JSON
    }
  }

  const bracketToolCallRegex = /\[TOOL_CALLS\]\s*([^\[]+)\[ARGS\]\s*(\{[\s\S]*?\})(?:\n|$)/g;
  while ((match = bracketToolCallRegex.exec(response)) !== null) {
    const name = (match[1] || '').trim();
    const rawArgs = (match[2] || '').trim().replace(/[“”]/g, '"');
    try {
      const args = rawArgs ? JSON.parse(rawArgs) : {};
      if (name) {
        toolCalls.push({ name, args });
      }
    } catch {
      // skip
    }
  }

  return toolCalls;
}
