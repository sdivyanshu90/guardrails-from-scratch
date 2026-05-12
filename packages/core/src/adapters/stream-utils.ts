export async function* iterateUtf8Lines(
  stream: ReadableStream<Uint8Array> | null
): AsyncIterable<string> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let lineBreak = buffer.indexOf('\n');
    while (lineBreak >= 0) {
      const line = buffer.slice(0, lineBreak).trimEnd();
      buffer = buffer.slice(lineBreak + 1);
      yield line;
      lineBreak = buffer.indexOf('\n');
    }
  }

  const tail = `${buffer}${decoder.decode()}`.trimEnd();
  if (tail) {
    yield tail;
  }
}