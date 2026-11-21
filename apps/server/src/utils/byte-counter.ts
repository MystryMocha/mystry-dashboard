import { Transform } from 'node:stream';

/** Passes data through unchanged, calling back once per chunk with the byte count and the data itself; when the callback returns an Error, the stream is aborted with that error. */
export function createByteCounter(onChunk: (chunkBytes: number, chunk: Buffer) => Error | undefined): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const error = onChunk(chunk.length, chunk);
      if (error) {
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}
