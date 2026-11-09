export const COMMAND_LIMIT = 12
export const COMMAND_LENGTH_LIMIT = 300

const credentialPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-(?:proj-|ant-)?)[\w-]{12,}/,
  /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{8,}\b/,
  /(?:api[-_]?key|token|secret|pass(?:word|wd)|authorization|cookie)["']?\s*[:=]\s*\S/i,
  /\b(?:bearer|basic)\s+[\w+/=-]{12,}|:\/\/[^\s/@:]+:[^\s/@]+@/i
]

// Exact evidence is withheld when it resembles a credential. This is a narrow guard,
// not a guarantee that arbitrary repository content or command text is safe to share.
export function resemblesCredential(value: string): boolean {
  return credentialPatterns.some((pattern) => pattern.test(value))
}
