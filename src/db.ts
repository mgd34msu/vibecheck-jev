import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { BoardError } from "./errors.js";
import {
  cursorSchema,
  jsonValueSchema,
  projectRecordSchema,
  recordChangeSchema,
  sessionRecordSchema,
  taskRecordSchema,
  workRecordSchema,
  type Cursor,
  type JsonValue,
  type ProjectFields,
  type ProjectId,
  type ProjectRecord,
  type RecordChange,
  type SessionFields,
  type SessionId,
  type SessionRecord,
  type TaskFields,
  type TaskId,
  type TaskRecord,
  type WorkFields,
  type WorkId,
  type WorkRecord,
} from "./schemas.js";
import {
  isSqliteBusy,
  openSqlite,
  type SqlConnection,
  type SqlValue,
} from "./sqlite.js";

export const SCHEMA_VERSION = 1;
const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS records (
    project_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    revision INTEGER NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (project_id, kind, id)
  )`,
  `CREATE TABLE IF NOT EXISTS changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS changes_project_seq ON changes(project_id, seq)",
  `CREATE INDEX IF NOT EXISTS records_work_task
    ON records(project_id, kind, json_extract(body, '$.task_id'))`,
  `CREATE INDEX IF NOT EXISTS records_work_session
    ON records(project_id, kind, json_extract(body, '$.session_id'))`,
  `CREATE INDEX IF NOT EXISTS records_open_contributors
    ON records(project_id, json_extract(body, '$.task_id'))
    WHERE kind = 'work' AND json_extract(body, '$.role') = 'contributor'
      AND json_extract(body, '$.status') NOT IN
        ('complete', 'cancelled', 'released', 'abandoned')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS records_session_identity
    ON records(project_id, json_extract(body, '$.vendor'),
      json_extract(body, '$.runtime'), json_extract(body, '$.external_session_id'))
    WHERE kind = 'session'`,
  `CREATE TABLE IF NOT EXISTS requests (
    project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
    digest TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, actor_id, request_id)
  )`,
  // Additive tables and triggers. They leave schema version 1 and every
  // existing table unchanged, so databases written by earlier releases open
  // as they are and earlier releases can still open this one.
  "CREATE INDEX IF NOT EXISTS requests_created ON requests(project_id, created_at)",
  `CREATE TABLE IF NOT EXISTS plan_details (
    project_id TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (project_id, scope, id, plan_revision)
  )`,
  `CREATE TABLE IF NOT EXISTS verifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    project_id TEXT, task_id TEXT, work_id TEXT, session_id TEXT,
    kind TEXT NOT NULL, battery_id TEXT, source TEXT NOT NULL,
    created_at TEXT NOT NULL, body TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS verifications_task ON verifications(project_id, task_id, seq)",
  "CREATE INDEX IF NOT EXISTS verifications_work ON verifications(project_id, work_id, seq)",
  "CREATE INDEX IF NOT EXISTS verifications_battery ON verifications(kind, battery_id, seq)",
  "CREATE INDEX IF NOT EXISTS verifications_session ON verifications(session_id, seq)",
  ...["changes", "verifications", "plan_details"].flatMap((table) =>
    ["UPDATE", "DELETE"].map(
      (event) =>
        `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${event.toLowerCase()}
         BEFORE ${event} ON ${table}
         BEGIN SELECT RAISE(ABORT, 'history is immutable'); END`,
    ),
  ),
];

/** Idempotency receipts older than this are pruned on write. */
export const REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const bodyRowSchema = z.object({ body: z.string() });
const cachedRowSchema = z.object({ digest: z.string(), response: z.string() });
const cursorRowSchema = z.object({ seq: cursorSchema });
const versionRowSchema = z.object({ user_version: z.number().int() });

function compareCodepoints(left: string, right: string): number {
  const leftPoints = Array.from(
    left,
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0) ?? 0,
  );
  for (const [index, point] of leftPoints.entries()) {
    const other = rightPoints[index];
    if (other === undefined) return 1;
    if (point !== other) return point - other;
  }
  return leftPoints.length - rightPoints.length;
}

function encodeJson(value: JsonValue): string {
  if (value === null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(encodeJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareCodepoints(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${encodeJson(child)}`)
    .join(",")}}`;
}

export function encode(value: unknown): string {
  return encodeJson(jsonValueSchema.parse(value));
}

/** Row access shared by project transactions and unscoped verification writes. */
export interface SqlAccess {
  readonly now: string;
  queryRows<T>(schema: z.ZodType<T>, sql: string, values: SqlValue[]): T[];
  execute(sql: string, values: SqlValue[]): void;
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

export class Transaction implements SqlAccess {
  readonly now = timestamp();
  actorId: SessionId | undefined;
  private readonly changes = new Map<string, RecordChange>();
  private flushed = false;

  constructor(
    private readonly connection: SqlConnection,
    readonly projectId: ProjectId,
  ) {}

  queryRows<T>(schema: z.ZodType<T>, sql: string, values: SqlValue[]): T[] {
    return this.connection.all(sql, values).map((row) => schema.parse(row));
  }

  execute(sql: string, values: SqlValue[]): void {
    this.connection.run(sql, values);
  }

  private findRecord<T>(
    schema: z.ZodType<T>,
    kind: string,
    id: string,
  ): T | undefined {
    const row = this.queryRows(
      bodyRowSchema,
      "SELECT body FROM records WHERE project_id = ? AND kind = ? AND id = ?",
      [this.projectId, kind, id],
    )[0];
    return row === undefined ? undefined : schema.parse(JSON.parse(row.body));
  }

  private requireRecord<T>(record: T | undefined, kind: string, id: string): T {
    if (record === undefined) {
      throw new BoardError(
        "not_found",
        `${kind} '${id}' was not found in this project`,
      );
    }
    return record;
  }

  private allRecords<T>(schema: z.ZodType<T>, kind: string): T[] {
    return this.queryRows(
      bodyRowSchema,
      "SELECT body FROM records WHERE project_id = ? AND kind = ? ORDER BY id",
      [this.projectId, kind],
    ).map((row) => schema.parse(JSON.parse(row.body)));
  }

  private metadata(
    kind: RecordChange["kind"],
    id: string,
    previous: { revision: number; created_at: string } | undefined,
  ) {
    // A record written more than once in one transaction keeps a single
    // revision, so every stored revision appears in the change stream.
    const rewrite = previous !== undefined && this.changes.has(`${kind}:${id}`);
    return {
      revision:
        previous === undefined
          ? 1
          : rewrite
            ? previous.revision
            : previous.revision + 1,
      created_at: previous === undefined ? this.now : previous.created_at,
      updated_at: this.now,
    };
  }

  private store(change: RecordChange): void {
    if (this.flushed)
      throw new Error("cannot write after flushing a transaction");
    this.execute(
      `INSERT INTO records(project_id, kind, id, revision, body) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(project_id, kind, id)
       DO UPDATE SET revision = excluded.revision, body = excluded.body`,
      [
        this.projectId,
        change.kind,
        change.id,
        change.record.revision,
        encode(change.record),
      ],
    );
    this.changes.set(
      `${change.kind}:${change.id}`,
      recordChangeSchema.parse(change),
    );
  }

  findProject(id: ProjectId): ProjectRecord | undefined {
    return this.findRecord(projectRecordSchema, "project", id);
  }
  getProject(id: ProjectId): ProjectRecord {
    return this.requireRecord(this.findProject(id), "project", id);
  }
  putProject(id: ProjectId, fields: ProjectFields): ProjectRecord {
    const record = projectRecordSchema.parse({
      ...fields,
      id,
      ...this.metadata("project", id, this.findProject(id)),
    });
    this.store({ kind: "project", id, record });
    return record;
  }
  findSession(id: SessionId): SessionRecord | undefined {
    return this.findRecord(sessionRecordSchema, "session", id);
  }
  getSession(id: SessionId): SessionRecord {
    return this.requireRecord(this.findSession(id), "session", id);
  }
  allSessions(): SessionRecord[] {
    return this.allRecords(sessionRecordSchema, "session");
  }
  putSession(id: SessionId, fields: SessionFields): SessionRecord {
    const record = sessionRecordSchema.parse({
      ...fields,
      id,
      ...this.metadata("session", id, this.findSession(id)),
    });
    this.store({ kind: "session", id, record });
    return record;
  }
  findTask(id: TaskId): TaskRecord | undefined {
    return this.findRecord(taskRecordSchema, "task", id);
  }
  getTask(id: TaskId): TaskRecord {
    return this.requireRecord(this.findTask(id), "task", id);
  }
  allTasks(): TaskRecord[] {
    return this.allRecords(taskRecordSchema, "task");
  }
  putTask(id: TaskId, fields: TaskFields): TaskRecord {
    const record = taskRecordSchema.parse({
      ...fields,
      id,
      ...this.metadata("task", id, this.findTask(id)),
    });
    this.store({ kind: "task", id, record });
    return record;
  }
  findWork(id: WorkId): WorkRecord | undefined {
    return this.findRecord(workRecordSchema, "work", id);
  }
  getWork(id: WorkId): WorkRecord {
    return this.requireRecord(this.findWork(id), "work", id);
  }
  allWork(): WorkRecord[] {
    return this.allRecords(workRecordSchema, "work");
  }
  putWork(id: WorkId, fields: WorkFields): WorkRecord {
    const record = workRecordSchema.parse({
      ...fields,
      id,
      ...this.metadata("work", id, this.findWork(id)),
    });
    this.store({ kind: "work", id, record });
    return record;
  }

  cursor(): Cursor {
    const row = this.queryRows(
      cursorRowSchema,
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM changes WHERE project_id = ?",
      [this.projectId],
    )[0];
    if (row === undefined)
      throw new Error("SQLite returned no cursor aggregate");
    return row.seq;
  }

  flush(): Cursor {
    if (this.flushed) throw new Error("a transaction may be flushed only once");
    const pending = new Set<SessionId>();
    if (this.changes.size > 0 && this.actorId !== undefined)
      pending.add(this.actorId);
    for (const change of this.changes.values()) {
      if (change.kind === "work") pending.add(change.record.session_id);
      if (change.kind === "project")
        pending.add(change.record.coordinator_session_id);
      if (
        change.kind === "session" &&
        change.record.parent_session_id !== null
      ) {
        pending.add(change.record.parent_session_id);
      }
    }
    const seen = new Set<SessionId>();
    for (const sessionId of pending) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const session = this.getSession(sessionId);
      const key = `session:${sessionId}`;
      if (!this.changes.has(key)) {
        this.changes.set(key, {
          kind: "session",
          id: sessionId,
          record: session,
          context: true,
        });
      }
      if (session.parent_session_id !== null)
        pending.add(session.parent_session_id);
    }
    if (this.changes.size > 0) {
      if (this.actorId === undefined)
        throw new Error("a change batch requires a session actor");
      this.execute(
        "INSERT INTO changes(project_id, actor_id, created_at, body) VALUES(?, ?, ?, ?)",
        [
          this.projectId,
          this.actorId,
          this.now,
          encode([...this.changes.values()]),
        ],
      );
    }
    this.flushed = true;
    return this.cursor();
  }

  /** Deletes idempotency receipts older than the retention window. */
  pruneRequests(olderThan: string): void {
    this.execute(
      "DELETE FROM requests WHERE project_id = ? AND created_at < ?",
      [this.projectId, olderThan],
    );
  }

  getRequest(
    actorKey: string,
    requestId: string,
  ): { digest: string; response: JsonValue } | undefined {
    const row = this.queryRows(
      cachedRowSchema,
      "SELECT digest, response FROM requests WHERE project_id = ? AND actor_id = ? AND request_id = ?",
      [this.projectId, actorKey, requestId],
    )[0];
    return row === undefined
      ? undefined
      : {
          digest: row.digest,
          response: jsonValueSchema.parse(JSON.parse(row.response)),
        };
  }

  putRequest(
    actorKey: string,
    requestId: string,
    digest: string,
    response: JsonValue,
  ): void {
    this.execute(
      `INSERT INTO requests(project_id, actor_id, request_id, digest, response, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [this.projectId, actorKey, requestId, digest, encode(response), this.now],
    );
  }
}

function rollback(connection: SqlConnection): void {
  try {
    connection.exec("ROLLBACK");
  } catch {
    // SQLite already ended the transaction (for example after SQLITE_FULL);
    // the original error is the one the caller needs.
  }
}

export class Database {
  readonly path: string;
  private initialization: Promise<void> | undefined;

  constructor(path: string) {
    if (path === ":memory:")
      throw new Error("use a database file; each call has its own connection");
    this.path = resolve(
      path === "~"
        ? homedir()
        : path.startsWith("~/")
          ? `${homedir()}/${path.slice(2)}`
          : path,
    );
  }

  private async connect(): Promise<SqlConnection> {
    const connection = await openSqlite(this.path);
    try {
      connection.exec("PRAGMA busy_timeout = 0");
      connection.exec("PRAGMA synchronous = NORMAL");
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = await open(this.path, "a", 0o600);
    await file.close();
    const deadline = performance.now() + 30_000;
    while (true) {
      let connection: SqlConnection | undefined;
      let started = false;
      try {
        connection = await this.connect();
        connection.exec("PRAGMA journal_mode = WAL");
        connection.exec("BEGIN IMMEDIATE");
        started = true;
        const version = versionRowSchema.parse(
          connection.all("PRAGMA user_version", [])[0],
        ).user_version;
        if (version !== 0 && version !== SCHEMA_VERSION) {
          throw new Error(`unsupported database schema version ${version}`);
        }
        for (const statement of schemaStatements) connection.exec(statement);
        connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        connection.exec("COMMIT");
        started = false;
        return;
      } catch (error) {
        if (started && connection !== undefined) rollback(connection);
        if (!isSqliteBusy(error) || performance.now() >= deadline) throw error;
      } finally {
        connection?.close();
      }
      await setTimeout(Math.min(25, Math.max(0, deadline - performance.now())));
    }
  }

  read<T>(
    projectId: ProjectId,
    callback: (transaction: Transaction) => T,
  ): Promise<T> {
    return this.transaction(projectId, false, callback);
  }

  /** A transaction over rows that belong to no single project, such as verdicts from a session outside any ledger project. */
  unscoped<T>(write: boolean, callback: (access: SqlAccess) => T): Promise<T> {
    return this.run(write, (connection) => {
      const now = timestamp();
      return callback({
        now,
        queryRows: (schema, sql, values) =>
          connection.all(sql, values).map((row) => schema.parse(row)),
        execute: (sql, values) => connection.run(sql, values),
      });
    });
  }

  write<T>(
    projectId: ProjectId,
    callback: (transaction: Transaction) => T,
  ): Promise<T> {
    return this.transaction(projectId, true, callback);
  }

  private transaction<T>(
    projectId: ProjectId,
    write: boolean,
    callback: (transaction: Transaction) => T,
  ): Promise<T> {
    return this.run(write, (connection) =>
      callback(new Transaction(connection, projectId)),
    );
  }

  private async run<T>(
    write: boolean,
    callback: (connection: SqlConnection) => T,
  ): Promise<T> {
    const initialization = (this.initialization ??= this.initialize());
    try {
      await initialization;
    } catch (error) {
      if (this.initialization === initialization)
        this.initialization = undefined;
      throw error;
    }
    const deadline = performance.now() + 30_000;
    while (true) {
      let connection: SqlConnection | undefined;
      let started = false;
      try {
        connection = await this.connect();
        if (!write) connection.exec("PRAGMA query_only = ON");
        connection.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
        started = true;
        const result = callback(connection);
        if (result instanceof Promise)
          throw new Error("database transaction callbacks must be synchronous");
        connection.exec("COMMIT");
        started = false;
        return result;
      } catch (error) {
        if (started && connection !== undefined) rollback(connection);
        if (started || !isSqliteBusy(error) || performance.now() >= deadline)
          throw error;
      } finally {
        connection?.close();
      }
      await setTimeout(Math.min(25, Math.max(0, deadline - performance.now())));
    }
  }
}
