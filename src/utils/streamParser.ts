// NDJSON stream parser utility

export async function* parseNDJSON(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        // Process any remaining data in buffer
        if (buffer.trim()) {
          try {
            yield JSON.parse(buffer);
          } catch (e) {
            // Ignore parse errors for incomplete data
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            yield JSON.parse(trimmed);
          } catch (e) {
            // NDJSON streams can contain transient/incomplete lines; avoid noisy logs by default.
            // Enable by setting OLLAMA_COPILOT_DEBUG_NDJSON=1.
            if (process.env.OLLAMA_COPILOT_DEBUG_NDJSON === '1') {
              console.error('Failed to parse JSON line:', trimmed, e);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
