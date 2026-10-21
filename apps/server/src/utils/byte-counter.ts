import { Transform } from 'node:stream';

/** 原样透传数据，每个数据块回调一次字节数；回调返回 Error 时以该错误中止流。 */
export function createByteCounter(onChunk: (chunkBytes: number) => Error | undefined): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const error = onChunk(chunk.length);
      if (error) {
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}
