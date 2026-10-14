export type AttachmentType = 'image/png' | 'image/jpeg' | 'application/pdf'

/** What the bytes really are. The declared content type is never trusted. */
export function sniff(b: Buffer): AttachmentType | undefined {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  return undefined
}

/** A filename safe to show and to put in a header: no path, no control characters, bounded. */
export function safeFilename(name: string, type: AttachmentType): string {
  const ext = type === 'image/png' ? '.png' : type === 'image/jpeg' ? '.jpg' : '.pdf'
  const base = name.replace(/^.*[\\/]/, '').replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '').slice(0, 80).trim()
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'attachment'
  return stem + ext
}
