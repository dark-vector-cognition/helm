import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { VaultClient } from './vault-client'

vi.mock('child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: Function) => callback(null, '', '')
}))
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
it('persists content and tags, rejects traversal and preserves an existing note', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm-vault-test-'))
  directories.push(directory)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'offline' }))
  const config = { vaultRagEndpoint: 'http://127.0.0.1:8742', vaultPath: directory,
    vaultRagLocation: 'local' as const, vaultRagRemoteHost: 'unused' }
  const saved = await new VaultClient(config).pushNote('Note', 'The exact body', 'Inbox', ['first'])
  expect(saved.success).toBe(true)
  const content = await readFile(saved.file_path!, 'utf8')
  expect(content).toContain('The exact body')
  expect(content).toContain('tags: ["first"]')
  const collision = await new VaultClient(config).pushNote('Note', 'replacement', 'Inbox')
  expect(collision.success).toBe(false)
  expect(await readFile(saved.file_path!, 'utf8')).toBe(content)
  const escape = await new VaultClient(config).pushNote('Escape', 'outside', '../outside')
  expect(escape).toMatchObject({ success: false, error: 'The note folder must be inside the vault' })
})

it('rejects a symlinked folder and escapes multiline titles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'helm-outside-'))
  directories.push(root, outside)
  await symlink(outside, join(root, 'Linked'))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'offline' }))
  const client = new VaultClient({ vaultRagEndpoint: 'http://127.0.0.1:8742', vaultPath: root,
    vaultRagLocation: 'local', vaultRagRemoteHost: 'unused' })
  expect(await client.pushNote('Escape', 'outside', 'Linked')).toMatchObject({ success: false })
  expect(await client.pushNote('Escape', 'outside', 'Linked/new')).toMatchObject({ success: false })
  await expect(access(join(outside, 'new'))).rejects.toThrow()
  const title = 'First\nsecond\rline'
  const saved = await client.pushNote(title, 'body')
  expect(saved.success).toBe(true)
  expect(await readFile(saved.file_path!, 'utf8')).toContain(`title: ${JSON.stringify(title)}\n`)
})
