import { existsSync } from "node:fs";
import { backup, DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type SqliteStatementRunResult = { changes: number; lastInsertRowid: number | bigint };

export interface SqliteStatement {
  run(...args: unknown[]): SqliteStatementRunResult;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  iterate(...args: unknown[]): Iterable<unknown>;
}

export interface SqliteDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
}

export class NodeSqliteDatabase {
  private readonly database: DatabaseSync;
  private savepointSequence = 0;

  constructor(databasePath: string, options: SqliteDatabaseOptions = {}) {
    if (options.fileMustExist && !existsSync(databasePath)) {
      const error = new Error(`SQLite database does not exist: ${databasePath}`) as Error & { code?: string };
      error.code = "SQLITE_CANTOPEN";
      throw error;
    }
    this.database = new DatabaseSync(databasePath, {
      readOnly: options.readonly ?? false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: true,
    });
    if (options.timeout !== undefined) this.database.exec(`PRAGMA busy_timeout = ${normalizeTimeout(options.timeout)}`);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.database.prepare(sql));
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }

  pragma(query: string, options?: { simple?: boolean }): unknown {
    const rows = this.database.prepare(`PRAGMA ${query}`).all();
    if (!options?.simple) return rows;
    const first = rows[0];
    if (!first) return undefined;
    return Object.values(first)[0];
  }

  transaction<T extends (...args: never[]) => unknown>(operation: T): T {
    const database = this.database;
    const nextSavepoint = () => `hermes_${++this.savepointSequence}`;
    return function transaction(this: unknown, ...args: never[]): unknown {
      const savepoint = nextSavepoint();
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = operation.apply(this, args);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    } as T;
  }

  backup(destination: string, options?: { progress?: () => void }): Promise<void> {
    return backup(this.database, destination, {
      progress: () => {
        options?.progress?.();
      },
    }).then(() => undefined);
  }
}

class NodeSqliteStatement implements SqliteStatement {
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  run(...args: unknown[]): SqliteStatementRunResult {
    const result = this.statement.run(...toSqlInputValues(args));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get(...args: unknown[]): unknown {
    return this.statement.get(...toSqlInputValues(args));
  }

  all(...args: unknown[]): unknown[] {
    return this.statement.all(...toSqlInputValues(args));
  }

  iterate(...args: unknown[]): Iterable<unknown> {
    return this.statement.iterate(...toSqlInputValues(args));
  }
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid SQLite timeout: ${value}`);
  return Math.floor(value);
}

function toSqlInputValues(values: unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "string" ||
      ArrayBuffer.isView(value)
    ) {
      return value as SQLInputValue;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    throw new TypeError(`Unsupported SQLite parameter type: ${typeof value}`);
  });
}
