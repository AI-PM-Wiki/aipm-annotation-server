/**
 * 分块(纯函数)。服务端切,不让前端决定 —— 一是防止前端拿超大请求打爆预算,
 * 二是分片策略与 provider 的 batch 上限相关,属于服务端知识。
 */
import type { Chunk, JudgeBlock } from './judge.ts';

export interface ChunkOptions {
  /** 每片块数上限。 */
  chunkBlocks: number;
  /** 每片字符数上限。 */
  chunkChars: number;
}

/**
 * 按「块数」与「字符数」两个上限取小者切片:逐块累加,任一上限先到就开新片。
 * 单块本身就超字符上限时让它独占一片(超限在请求校验阶段已被拒,这里只是兜底)。
 */
export function chunkBlocks(blocks: JudgeBlock[], opts: ChunkOptions): Chunk[] {
  const maxBlocks = Math.max(1, Math.floor(opts.chunkBlocks));
  const maxChars = Math.max(1, Math.floor(opts.chunkChars));
  const chunks: Chunk[] = [];
  let current: JudgeBlock[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ index: chunks.length, blocks: current });
    current = [];
    chars = 0;
  };

  for (const block of blocks) {
    const len = block.text.length;
    if (current.length > 0 && (current.length >= maxBlocks || chars + len > maxChars)) {
      flush();
    }
    current.push(block);
    chars += len;
  }
  flush();
  return chunks;
}
