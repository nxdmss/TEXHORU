import { openSync, readSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'

// A large site database must not be loaded into RAM merely to verify a transfer.
export function fileSha256(path) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
  try {
    let count
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
    return hash.digest('hex')
  } finally { closeSync(fd) }
}
