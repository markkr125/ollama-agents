import { OllamaClient } from '../../services/model/ollamaClient';

/**
 * Generates a concise session title from the user's first message using an LLM.
 * Designed to be fire-and-forget — sets an immediate fallback title first,
 * then overwrites with the model-generated title when ready.
 *
 * Returns null if generation fails or times out (caller should keep the
 * fallback title unchanged).
 *
 * @param client   The OllamaClient to use for generation
 * @param model    Model name (e.g. "llama3.2:3b")
 * @param userMessage  The user's first message in the session
 * @param timeoutMs    Timeout in ms (default 15s — prevents thinking models from blocking)
 */
export async function generateSessionTitle(
  client: OllamaClient,
  model: string,
  userMessage: string,
  timeoutMs: number = 15000
): Promise<string | null> {
  const generatePromise = (async () => {
    let result = '';
    const stream = client.chat({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a session title generator. You produce very short titles (max 6 words). Output ONLY the title text — no quotes, no explanation, no punctuation at the end.'
        },
        {
          role: 'user',
          content: `Generate a short title (max 6 words) for a coding session that starts with this request:\n\n${userMessage.substring(0, 500)}`
        }
      ],
      options: { temperature: 0.3, num_predict: 30 }
    });

    for await (const chunk of stream) {
      if (chunk.message?.content) {
        result += chunk.message.content;
      }
      if (chunk.done) break;
    }

    return result;
  })();

  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs)
  );

  try {
    const result = await Promise.race([generatePromise, timeoutPromise]);
    if (!result) return null;

    // Clean up: remove quotes, extra whitespace, only keep first line
    const cleaned = result
      .replace(/^["'\s*]+|["'\s.*]+$/g, '')
      .replace(/\n.*/g, '')
      .trim();

    if (!cleaned || cleaned.length < 2) return null;
    return cleaned.substring(0, 60);
  } catch {
    return null;
  }
}
