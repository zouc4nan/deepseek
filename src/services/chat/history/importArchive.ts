import * as db from '../db.js'
import type { Session } from '../types.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

export type ImportProgressCallback = (processed: number, total: number) => void

const fileOwner = (path: string) => /^chat_sessions\/([^/]+)_files\//.exec(path)?.[1]

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const decoder = new TextDecoder('utf-8')
  let text = ''
  for await (const chunk of entry.stream) {
    text += decoder.decode(chunk, { stream: true })
  }
  text += decoder.decode()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      checkManifest(await readJson(entry))
      return
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  fail('backupUnrecognized')
}

/**
 * 按会话读取 JSON 和对应文件，保留归档物理顺序的格式校验。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 */
export const importArchive = async (
  file: File,
  onProgress?: ImportProgressCallback
): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  const firstImageOffset = new Map<string, number>()
  const fileSessions = new Map<string, Set<string>>()
  // 同一图片可能出现在多个会话目录，待写入的原件也参与去重。
  const stored = new Map<string, string>()
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined
  let totalSessions = 0

  const maxSessionBatchCount = 32
  const maxSessionBatchBytes = 2 * 1024 * 1024
  let sessionBatch: Session[] = []
  let sessionBatchBytes = 0
  const flushSessions = async () => {
    if (!sessionBatch.length) {
      return
    }
    await flushImages()
    await db.addStagingSessions(sessionBatch)
    sessionBatch = []
    sessionBatchBytes = 0
    if (imported.size < totalSessions) {
      onProgress?.(imported.size, totalSessions)
    }
  }

  const maxImageBatchCount = 16
  const maxImageBatchBytes = 4 * 1024 * 1024
  let imageBatch: db.StoredFile[] = []
  let imageBatchBytes = 0
  const flushImages = async () => {
    if (!imageBatch.length) {
      return
    }
    await db.saveStagingFiles(imageBatch)
    imageBatch = []
    imageBatchBytes = 0
  }
  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (entry.offset >= (firstImageOffset.get(id) ?? Infinity)) {
      await skipEntry(entry)
      return
    }
    if (imageBatchBytes + entry.size > maxImageBatchBytes) {
      await flushImages()
    }
    const blob = await readEntry(entry, imageType)
    imageBatch.push({ id, blob })
    imageBatchBytes += blob.size
    firstImageOffset.set(id, entry.offset)
    stored.set(id, blob.type)
    if (imageBatch.length >= maxImageBatchCount || imageBatchBytes >= maxImageBatchBytes) {
      await flushImages()
    }
  }

  try {
    const entries: ArchiveEntry[] = []
    const filesBySession = new Map<string, ArchiveEntry[]>()
    for await (const entry of readArchive(file)) {
      entries.push(entry)
      const id = parseSessionPath(entry.path)
      if (id !== null) {
        filesBySession.set(id, [])
      } else {
        filesBySession.get(fileOwner(entry.path) ?? '')?.push(entry)
      }
    }
    totalSessions = filesBySession.size
    onProgress?.(0, totalSessions)
    for (const entry of entries) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        if (sessionBatchBytes + entry.size > maxSessionBatchBytes) {
          await flushSessions()
        }
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        for (const fileEntry of filesBySession.get(sessionId) ?? []) {
          const id = local.images.get(fileEntry.path)
          await (id === undefined ? skipEntry(fileEntry) : saveImage(fileEntry, id))
        }
        for (const message of local.session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const attachment of message.files) {
            let sessions = fileSessions.get(attachment.id)
            if (!sessions) {
              sessions = new Set()
              fileSessions.set(attachment.id, sessions)
            }
            sessions.add(sessionId)
          }
        }
        sessionBatch.push(local.session)
        sessionBatchBytes += entry.size
        if (
          sessionBatch.length >= maxSessionBatchCount ||
          sessionBatchBytes >= maxSessionBatchBytes
        ) {
          await flushSessions()
        }
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
        await flushSessions()
      } else if (
        index
          ? !imported.has(fileOwner(path) ?? '')
          : !currentSessionId || !path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 附件正文已随所属会话处理，此处仍校验归档中的位置。
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  await flushSessions()
  const targetSessions = new Set<string>()
  for (const [id, type] of stored) {
    if (!type) {
      continue
    }
    for (const sessionId of fileSessions.get(id) ?? []) {
      targetSessions.add(sessionId)
    }
  }
  if (targetSessions.size > 0) {
    await db.updateStagingFileTypes(stored, targetSessions)
  }
  if (totalSessions > 0) {
    onProgress?.(imported.size, totalSessions)
  }
}
