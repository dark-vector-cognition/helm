import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initDb, closeDb } from './index'
import { initializeSchema } from './schema'
import {
  insertSnapshot,
  getRecentSnapshots,
  insertAlert,
  getAlertHistory,
  insertBriefing,
  getRecentBriefings,
  insertNotification,
  getNotifications,
  dismissNotification,
  insertTimelineEvent,
  getTimelineEvents,
  insertLogLines,
  getRecentLogLines,
  clearLogLines
} from './queries'
import type {
  SystemState,
  AutoHealEvent,
  BriefingResult,
  HelmNotification,
  LogLine
} from '../../shared/types'

function makeState(overrides: Partial<SystemState> = {}): SystemState {
  return {
    timestamp: Date.now(),
    processes: [],
    ports: [],
    agents: [],
    gitRepos: [],
    cpu: { usage: 30, cores: 10 },
    memory: { total: 32e9, used: 16e9, free: 16e9, usagePercent: 50 },
    ...overrides
  }
}

describe('SQLite persistence', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initDb(db)
  })

  afterEach(() => {
    closeDb()
  })

  describe('schema creation', () => {
    it('should create all persistence tables', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
      const names = tables.map((t) => t.name)
      expect(names).toContain('snapshots')
      expect(names).toContain('alerts')
      expect(names).toContain('briefings')
      expect(names).toContain('notifications')
      expect(names).toContain('logs')
      expect(names).toContain('sessions')
      expect(names).toContain('timeline_events')
    })

    it('should be idempotent - calling initializeSchema twice does not error', () => {
      expect(() => initializeSchema(db)).not.toThrow()
    })

    it('leaves a table from an earlier release alone, with its rows', () => {
      // An upgrade must never drop user data. A table this release no longer creates or reads
      // stays exactly as it was, and initializeSchema neither alters nor empties it.
      db.exec(
        'CREATE TABLE legacy_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, score INTEGER NOT NULL, grade TEXT NOT NULL, verdict TEXT NOT NULL)'
      )
      db.prepare('INSERT INTO legacy_scores (timestamp, score, grade, verdict) VALUES (?, ?, ?, ?)').run(
        1700000000000,
        85,
        'B+',
        'kept'
      )

      initializeSchema(db)
      initializeSchema(db)

      const rows = db.prepare('SELECT score, grade, verdict FROM legacy_scores').all()
      expect(rows).toEqual([{ score: 85, grade: 'B+', verdict: 'kept' }])
    })

    it('does not create the retired history table on a fresh database', () => {
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((t) => t.name)
      expect(names.some((name) => name.endsWith('_history'))).toBe(false)
    })
  })

  describe('snapshots', () => {
    it('should insert and retrieve a snapshot', () => {
      const state = makeState({ cpu: { usage: 75, cores: 8 } })
      insertSnapshot(state)
      const rows = getRecentSnapshots(10)
      expect(rows).toHaveLength(1)
      expect(rows[0].data.cpu.usage).toBe(75)
      expect(rows[0].data.cpu.cores).toBe(8)
    })

    it('should respect the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        insertSnapshot(makeState({ timestamp: Date.now() + i }))
      }
      const rows = getRecentSnapshots(3)
      expect(rows).toHaveLength(3)
    })

    it('should return most recent first', () => {
      insertSnapshot(makeState({ timestamp: 1000 }))
      insertSnapshot(makeState({ timestamp: 2000 }))
      insertSnapshot(makeState({ timestamp: 3000 }))
      const rows = getRecentSnapshots(10)
      expect(rows[0].timestamp).toBe(3000)
      expect(rows[2].timestamp).toBe(1000)
    })
  })

  describe('alerts', () => {
    it('should insert and retrieve an alert', () => {
      const event: AutoHealEvent = {
        timestamp: Date.now(),
        rule: 'high_cpu',
        action: 'notify_only',
        target: 'system',
        success: true,
        message: 'CPU at 95%'
      }
      insertAlert(event)
      const rows = getAlertHistory(10)
      expect(rows).toHaveLength(1)
      expect(rows[0].rule).toBe('high_cpu')
      expect(rows[0].success).toBe(true)
      expect(rows[0].action).toBe('notify_only')
    })

    it('should store success as boolean correctly', () => {
      const event: AutoHealEvent = {
        timestamp: Date.now(),
        rule: 'process_disappeared',
        action: 'restart_process',
        target: 'my-app',
        success: false,
        message: 'Restart failed'
      }
      insertAlert(event)
      const rows = getAlertHistory(10)
      expect(rows[0].success).toBe(false)
    })
  })

  describe('briefings', () => {
    it('should insert and retrieve a briefing', () => {
      const briefing: BriefingResult = {
        timestamp: Date.now(),
        summary: 'All systems nominal',
        alerts: [{ severity: 'info', message: 'CPU normal', source: 'cpu' }],
        suggestions: ['Consider upgrading RAM']
      }
      insertBriefing(briefing)
      const rows = getRecentBriefings(10)
      expect(rows).toHaveLength(1)
      expect(rows[0].summary).toBe('All systems nominal')
      expect(rows[0].alerts).toHaveLength(1)
      expect(rows[0].alerts[0].severity).toBe('info')
      expect(rows[0].suggestions).toEqual(['Consider upgrading RAM'])
    })
  })

  describe('notifications', () => {
    it('should insert and retrieve a notification', () => {
      const notif: HelmNotification = {
        id: 'test-1',
        title: 'High CPU',
        body: 'CPU is at 95%',
        level: 'warning',
        timestamp: Date.now(),
        dismissed: false
      }
      insertNotification(notif)
      const rows = getNotifications(10)
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('test-1')
      expect(rows[0].dismissed).toBe(false)
    })

    it('should dismiss a notification', () => {
      const notif: HelmNotification = {
        id: 'test-dismiss',
        title: 'Alert',
        body: 'Something happened',
        level: 'critical',
        timestamp: Date.now(),
        dismissed: false
      }
      insertNotification(notif)
      dismissNotification('test-dismiss')
      const rows = getNotifications(10)
      expect(rows).toHaveLength(0)
    })

    it('should handle upsert via INSERT OR REPLACE', () => {
      const notif: HelmNotification = {
        id: 'upsert-test',
        title: 'Original',
        body: 'Original body',
        level: 'info',
        timestamp: Date.now(),
        dismissed: false
      }
      insertNotification(notif)
      insertNotification({ ...notif, title: 'Updated' })
      const rows = getNotifications(10)
      expect(rows).toHaveLength(1)
      expect(rows[0].title).toBe('Updated')
    })
  })

  describe('logs', () => {
    it('stores and retrieves recent log lines in chronological order', () => {
      const lines: LogLine[] = [
        { timestamp: 1000, source: 'alpha.log', text: 'alpha', level: 'info' },
        { timestamp: 2000, source: 'beta.log', text: 'beta', level: 'warn' }
      ]

      insertLogLines(lines)

      expect(getRecentLogLines(10)).toEqual(lines)
    })

    it('clears persisted log history', () => {
      insertLogLines([{ timestamp: 1000, source: 'alpha.log', text: 'alpha', level: 'info' }])
      clearLogLines()
      expect(getRecentLogLines(10)).toEqual([])
    })
  })

  describe('timeline events', () => {
    it('stores and retrieves timeline events', () => {
      insertTimelineEvent({
        timestamp: 1700000000000,
        type: 'agent_action',
        source: 'botbotfromuk-v1',
        message: 'botbotfromuk-v1 [t17] post comment via github_api -> example-org/sample-repo#11',
        metadata: JSON.stringify({ tick: 17, eventType: 'external_action' })
      })

      const rows = getTimelineEvents(10)
      expect(rows).toHaveLength(1)
      expect(rows[0].type).toBe('agent_action')
      expect(rows[0].source).toBe('botbotfromuk-v1')
    })

    it('ignores duplicate ingested timeline events with the same ingest key', () => {
      const event = {
        timestamp: 1700000000000,
        type: 'agent_action' as const,
        source: 'botbotfromuk-v1',
        message: 'duplicate-safe event',
        metadata: JSON.stringify({ tick: 17 }),
        ingestKey: 'same-event'
      }

      insertTimelineEvent(event)
      insertTimelineEvent(event)

      const rows = getTimelineEvents(10)
      expect(rows).toHaveLength(1)
      expect(rows[0].message).toBe('duplicate-safe event')
    })
  })
})
