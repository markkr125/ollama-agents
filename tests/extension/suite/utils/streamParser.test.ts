import * as assert from 'assert';
import { parseNDJSON } from '../../../../src/utils/streamParser';

function makeReaderFromChunks(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return stream.getReader();
}

suite('parseNDJSON', () => {
  test('parses complete JSON lines', async () => {
    const reader = makeReaderFromChunks(['{"a":1}\n{"b":2}\n']);
    const out: any[] = [];

    for await (const item of parseNDJSON(reader)) {
      out.push(item);
    }

    assert.deepStrictEqual(out, [{ a: 1 }, { b: 2 }]);
  });

  test('handles JSON split across chunks', async () => {
    const reader = makeReaderFromChunks(['{"a":', '1}\n{"b":', '2}\n']);
    const out: any[] = [];

    for await (const item of parseNDJSON(reader)) {
      out.push(item);
    }

    assert.deepStrictEqual(out, [{ a: 1 }, { b: 2 }]);
  });

  test('skips invalid JSON line but continues', async () => {
    const reader = makeReaderFromChunks(['{"a":1}\nnot-json\n{"b":2}\n']);

    const out: any[] = [];
    for await (const item of parseNDJSON(reader)) {
      out.push(item);
    }

    assert.deepStrictEqual(out, [{ a: 1 }, { b: 2 }]);
  });

  test('ignores trailing incomplete JSON at end-of-stream', async () => {
    const reader = makeReaderFromChunks(['{"a":1}\n{"b":']);
    const out: any[] = [];

    for await (const item of parseNDJSON(reader)) {
      out.push(item);
    }

    assert.deepStrictEqual(out, [{ a: 1 }]);
  });
});
