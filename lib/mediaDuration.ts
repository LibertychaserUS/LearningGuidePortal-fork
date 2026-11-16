/**
 * BUG-0348：从 MP4 字节中解析时长（秒），无需 ffprobe。
 *
 * 与 Admin `server/src/commerce-courses/media-duration.ts` 等价：只读 moov/mvhd。
 * 额外提供 `mp4DurationSecondsFromReader`，用 ranged GET 逐层跳过顶层 box，
 * 因此 moov 在文件尾部（非 faststart）的 mp4 也不需要整份下载。
 */

type BoxHeader = { type: string; size: number; headerSize: number };

/** 读一个 box 头；`limit` 是 box 起点到容器末尾的剩余字节数。 */
function readBoxHeader(head: Buffer, limit: number): BoxHeader | null {
  if (head.length < 8) return null;
  let size = head.readUInt32BE(0);
  const type = head.toString("latin1", 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = Number(head.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit;
  }
  return size < headerSize ? null : { type, size, headerSize };
}

/** 同步走查 [start, end) 内的 box，返回首个 type 匹配 box 的 payload 区间。 */
function findBox(buf: Buffer, start: number, end: number, type: string): { payloadStart: number; end: number } | null {
  for (let offset = start; offset + 8 <= end;) {
    const header = readBoxHeader(buf.subarray(offset, Math.min(end, offset + 16)), end - offset);
    if (!header) return null;
    const boxEnd = offset + header.size;
    if (boxEnd > end) return null;
    if (header.type === type) return { payloadStart: offset + header.headerSize, end: boxEnd };
    offset = boxEnd;
  }
  return null;
}

function mvhdSeconds(buf: Buffer, p: number, end: number): number | null {
  if (p >= end) return null;
  const version = buf[p];
  if (version === 1) {
    if (p + 32 > end) return null;
    const timescale = buf.readUInt32BE(p + 20);
    const duration = Number(buf.readBigUInt64BE(p + 24));
    return timescale > 0 ? duration / timescale : null;
  }
  if (p + 20 > end) return null;
  const timescale = buf.readUInt32BE(p + 12);
  const duration = buf.readUInt32BE(p + 16);
  return timescale > 0 ? duration / timescale : null;
}

/** 从一份完整的 moov（或整个文件）字节中读 mvhd。解析失败返回 null。 */
export function mp4DurationSeconds(buf: Buffer): number | null {
  try {
    const moov = findBox(buf, 0, buf.length, "moov");
    if (!moov) return null;
    const mvhd = findBox(buf, moov.payloadStart, moov.end, "mvhd");
    if (!mvhd) return null;
    return mvhdSeconds(buf, mvhd.payloadStart, mvhd.end);
  } catch {
    return null;
  }
}

export type RangeReader = (start: number, length: number) => Promise<Buffer>;

const MAX_BOXES = 64;

async function findBoxFromReader(read: RangeReader, start: number, end: number, type: string): Promise<{ start: number; end: number } | null> {
  let offset = start;
  for (let box = 0; box < MAX_BOXES && offset + 8 <= end; box += 1) {
    const header = readBoxHeader(await read(offset, Math.min(16, end - offset)), end - offset);
    if (!header) return null;
    const boxEnd = offset + header.size;
    if (boxEnd > end) return null;
    if (header.type === type) return { start: offset, end: boxEnd };
    offset = boxEnd;
  }
  return null;
}

/**
 * 沿顶层 box 走查，只读到 moov 为止。`size` 是对象总字节数。
 * 读不大包大揽：每个 box 只取 16 字节头，跳过后读下一个；mdat 直接被跳过。
 */
export async function mp4DurationSecondsFromReader(
  read: RangeReader,
  size: number,
): Promise<number | null> {
  const moov = await findBoxFromReader(read, 0, size, "moov");
  if (!moov) return null;
  return mp4DurationSeconds(await read(moov.start, moov.end - moov.start));
}
