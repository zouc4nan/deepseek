import { Inflate } from 'fflate'

const READ_CHUNK_BYTES = 256 * 1024
const READ_WINDOW_BYTES = 512 * 1024
// 控制每轮同步解压的工作量；输出交给调用方保存后才继续读取。
const INFLATE_CHUNK_BYTES = 8 * 1024

type ReadWindow = { start: number; bytes: Uint8Array<ArrayBuffer> }
// 会话 JSON 和图片可能分处两段，分别保留最近的读窗口。
const fileWindows = new WeakMap<File, ReadWindow[]>()

/** ZIP 结构损坏或使用了不支持的特性 */
export class ArchiveError extends Error {
  constructor() {
    super('Invalid or unsupported history archive')
    this.name = 'ArchiveError'
  }
}

const invalid = (): never => {
  throw new ArchiveError()
}

/** 本地文件头签名 PK\x03\x04，用于在解析前区分 ZIP 与其他文件。 */
export const isZipFile = async (file: File) => {
  if (file.size < 4) {
    return false
  }
  const cached = fileWindows.get(file)?.find((window) => window.start === 0)
  const bytes =
    cached && cached.bytes.length >= 4
      ? cached.bytes.subarray(0, 4)
      : new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return bytes.length === 4 && bytes.every((byte, index) => byte === [0x50, 0x4b, 3, 4][index])
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const readBytes = async (file: File, start: number, length: number) => {
  if (start < 0 || length < 0 || start + length > file.size) {
    invalid()
  }
  if (length === 0) {
    return new Uint8Array(0)
  }
  const windows = fileWindows.get(file) ?? []
  const cached = windows.find(
    (window) => start >= window.start && start <= window.start + window.bytes.length
  )
  if (cached && cached !== windows[0]) {
    windows.reverse()
  }
  const other = cached ? windows[1] : windows[0]
  const saveWindow = (window: ReadWindow) =>
    fileWindows.set(file, other ? [window, other] : [window])
  if (cached) {
    const cachedEnd = cached.start + cached.bytes.length
    if (start >= cached.start && start + length <= cachedEnd) {
      const offset = start - cached.start
      return cached.bytes.subarray(offset, offset + length)
    }
    if (start >= cached.start && start < cachedEnd) {
      const head = cached.bytes.subarray(start - cached.start)
      const remaining = length - head.length
      const readLength = Math.min(file.size - cachedEnd, Math.max(READ_WINDOW_BYTES, remaining))
      const tail = new Uint8Array(await file.slice(cachedEnd, cachedEnd + readLength).arrayBuffer())
      if (tail.length !== readLength) {
        invalid()
      }
      saveWindow({ start: cachedEnd, bytes: tail })
      const merged = new Uint8Array(length)
      merged.set(head, 0)
      merged.set(tail.subarray(0, remaining), head.length)
      return merged
    }
  }
  const readLength = Math.min(file.size - start, Math.max(READ_WINDOW_BYTES, length))
  const bytes = new Uint8Array(await file.slice(start, start + readLength).arrayBuffer())
  if (bytes.length !== readLength) {
    invalid()
  }
  saveWindow({ start, bytes })
  return bytes.subarray(0, length)
}

/** ZIP64、分卷与加密文件不属于导出格式，一律拒绝。 */
const checkExtra = (bytes: Uint8Array) => {
  const view = viewOf(bytes)
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length || view.getUint16(offset, true) === 1) {
      invalid()
    }
    offset += 4 + view.getUint16(offset + 2, true)
    if (offset > bytes.length) {
      invalid()
    }
  }
}

const decodePath = (bytes: Uint8Array, flags: number) => {
  // 非 UTF-8 编码的 ZIP 文件名仅接受 ASCII，确保附件路径解码准确。
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    invalid()
  }
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    invalid()
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    invalid()
  }
  return path
}

type Entry = {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

type Directory = { entries: Entry[]; offset: number }
const directories = new WeakMap<File, Directory>()

const readDirectory = async (file: File): Promise<Directory> => {
  const cached = directories.get(file)
  if (cached) {
    return cached
  }
  if (file.size < 22) {
    invalid()
  }
  const tailStart = Math.max(0, file.size - 22 - 0xffff)
  const tail = await readBytes(file, tailStart, file.size - tailStart)
  const tailView = viewOf(tail)
  let end = tail.length - 22
  while (
    end >= 0 &&
    (tailView.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + tailView.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (end < 0) {
    invalid()
  }
  const count = tailView.getUint16(end + 10, true)
  const size = tailView.getUint32(end + 12, true)
  const offset = tailView.getUint32(end + 16, true)
  if (
    tailView.getUint16(end + 4, true) !== 0 ||
    tailView.getUint16(end + 6, true) !== 0 ||
    tailView.getUint16(end + 8, true) !== count ||
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    offset + size !== tailStart + end
  ) {
    invalid()
  }
  const entries: Entry[] = []
  const paths = new Set<string>()
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size) {
      invalid()
    }
    const view = viewOf(await readBytes(file, offset + cursor, 46))
    if (view.getUint32(0, true) !== 0x02014b50) {
      invalid()
    }
    const flags = view.getUint16(8, true)
    const method = view.getUint16(10, true)
    const compressedSize = view.getUint32(20, true)
    const entrySize = view.getUint32(24, true)
    const nameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const next = cursor + 46 + nameLength + extraLength + view.getUint16(32, true)
    const entryOffset = view.getUint32(42, true)
    // 只允许 deflate 选项、data descriptor 与 UTF-8 标志。
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      entrySize === 0xffffffff ||
      (method === 0 && compressedSize !== entrySize) ||
      entryOffset >= offset ||
      view.getUint16(34, true) !== 0 ||
      ((view.getUint32(38, true) >>> 16) & 0xf000) === 0xa000 ||
      next > size
    ) {
      invalid()
    }
    const name = await readBytes(file, offset + cursor + 46, nameLength)
    const path = decodePath(name, flags)
    // 目录和同名文件也不能互相覆盖。
    const identity = path.endsWith('/') ? path.slice(0, -1) : path
    if (paths.has(identity) || (path.endsWith('/') && entrySize !== 0)) {
      invalid()
    }
    paths.add(identity)
    checkExtra(await readBytes(file, offset + cursor + 46 + nameLength, extraLength))
    entries.push({
      path,
      name: name.slice(),
      flags,
      method,
      crc: view.getUint32(16, true),
      compressedSize,
      size: entrySize,
      offset: entryOffset,
    })
    cursor = next
  }
  if (cursor !== size) {
    invalid()
  }
  const directory = { entries: entries.sort((a, b) => a.offset - b.offset), offset }
  directories.set(file, directory)
  return directory
}

const checkDataDescriptor = async (file: File, entry: Entry, end: number, boundary: number) => {
  if (!(entry.flags & 8)) {
    return
  }
  if (end + 12 > boundary) {
    invalid()
  }
  const descriptor = viewOf(await readBytes(file, end, Math.min(16, boundary - end)))
  const shift = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0
  if (
    shift + 12 > descriptor.byteLength ||
    descriptor.getUint32(shift, true) !== entry.crc ||
    descriptor.getUint32(shift + 4, true) !== entry.compressedSize ||
    descriptor.getUint32(shift + 8, true) !== entry.size
  ) {
    invalid()
  }
}

const readEntryOffset = async (file: File, entry: Entry, boundary: number) => {
  if (entry.offset + 30 > boundary) {
    invalid()
  }
  const view = viewOf(await readBytes(file, entry.offset, 30))
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== entry.flags ||
    view.getUint16(8, true) !== entry.method ||
    nameLength !== entry.name.length ||
    end > boundary ||
    (entry.flags & 8 && end + 12 > boundary)
  ) {
    invalid()
  }
  for (const [position, expected] of [
    [14, entry.crc],
    [18, entry.compressedSize],
    [22, entry.size],
  ]) {
    const actual = view.getUint32(position, true)
    if (actual !== expected && (!(entry.flags & 8) || actual !== 0)) {
      invalid()
    }
  }
  const metadata = await readBytes(file, entry.offset + 30, nameLength + extraLength)
  if (entry.name.some((byte, index) => byte !== metadata[index])) {
    invalid()
  }
  checkExtra(metadata.subarray(nameLength))
  return start
}

export type ArchiveEntry = {
  path: string
  size: number
  offset: number
  stream: AsyncIterable<Uint8Array>
}

/**
 * 按物理顺序枚举文件，校验并跳过目录。各文件可按需逐块读取并校验 CRC。
 * 数据块可能共享读窗口，请勿修改。
 */
export async function* readArchive(file: File): AsyncGenerator<ArchiveEntry> {
  const directory = await readDirectory(file)
  for (const [index, entry] of directory.entries.entries()) {
    const boundary = directory.entries[index + 1]?.offset ?? directory.offset
    if (entry.path.endsWith('/')) {
      const start = await readEntryOffset(file, entry, boundary)
      await checkDataDescriptor(file, entry, start + entry.compressedSize, boundary)
      continue
    }
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      const start = await readEntryOffset(file, entry, boundary)
      let written = 0
      let crc = 0xffffffff
      const pending: Uint8Array[] = []
      const append = (chunk: Uint8Array) => {
        written += chunk.length
        if (written > entry.size) {
          invalid()
        }
        for (const byte of chunk) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
        }
        if (chunk.length) {
          pending.push(chunk)
        }
      }
      const inflate = entry.method === 8 ? new Inflate(append) : null
      for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
        const chunk = await readBytes(
          file,
          start + offset,
          Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
        )
        if (!inflate) {
          append(chunk)
          yield* pending.splice(0)
          continue
        }
        for (let cursor = 0; cursor < chunk.length; cursor += INFLATE_CHUNK_BYTES) {
          const sliceEnd = Math.min(cursor + INFLATE_CHUNK_BYTES, chunk.length)
          inflate.push(chunk.subarray(cursor, sliceEnd), offset + sliceEnd === entry.compressedSize)
          // yield 暂停解压，等待调用方完成异步写入；不缓存整个条目。
          yield* pending.splice(0)
        }
      }
      if (inflate && entry.compressedSize === 0) {
        inflate.push(new Uint8Array(), true)
        yield* pending.splice(0)
      }
      if (written !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
        invalid()
      }
      // 读完正文再检查描述符，避免提前跳到条目末尾。
      await checkDataDescriptor(file, entry, start + entry.compressedSize, boundary)
    }
    yield { path: entry.path, size: entry.size, offset: entry.offset, stream: stream() }
  }
  fileWindows.delete(file)
}

/** detectType 最多接收条目的前 16 字节。 */
export const readEntry = async (
  entry: ArchiveEntry,
  detectType?: (prefix: Uint8Array) => string
): Promise<Blob> => {
  const prefix = new Uint8Array(detectType ? Math.min(entry.size, 16) : 0)
  let prefixLength = 0
  const parts: BlobPart[] = []
  let chunks: Uint8Array<ArrayBuffer>[] = []
  let buffered = 0
  for await (const chunk of entry.stream) {
    if (prefixLength < prefix.length) {
      const head = chunk.subarray(0, prefix.length - prefixLength)
      prefix.set(head, prefixLength)
      prefixLength += head.length
    }
    chunks.push(chunk as Uint8Array<ArrayBuffer>)
    buffered += chunk.length
    if (buffered >= READ_CHUNK_BYTES) {
      parts.push(new Blob(chunks))
      chunks = []
      buffered = 0
    }
  }
  return new Blob([...parts, ...chunks], {
    type: detectType?.(prefix.subarray(0, prefixLength)),
  })
}

/** 不需要的条目也要读完，以校验大小与 CRC。 */
export const skipEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据。
  }
}
