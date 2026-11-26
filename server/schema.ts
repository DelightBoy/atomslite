import { mysqlTable, varchar, char, text, longtext, datetime, int, json, primaryKey, uniqueIndex, index } from 'drizzle-orm/mysql-core';

export const visitors = mysqlTable('atoms_visitors', {
  id: char('id', { length: 36 }).primaryKey(),
  tokenHash: char('token_hash', { length: 64 }).notNull(),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
}, table => [uniqueIndex('atoms_visitor_token').on(table.tokenHash)]);

export const projects = mysqlTable('atoms_projects', {
  id: char('id', { length: 36 }).primaryKey(), ownerId: char('owner_id', { length: 36 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(), prompt: text('prompt').notNull(),
  mode: varchar('mode', { length: 16 }).notNull(), artifactId: char('artifact_id', { length: 36 }),
  activeRunId: char('active_run_id', { length: 36 }),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
}, table => [index('atoms_project_owner').on(table.ownerId, table.updatedAt)]);

export const artifacts = mysqlTable('atoms_artifacts', {
  id: char('id', { length: 36 }).primaryKey(), projectId: char('project_id', { length: 36 }).notNull(),
  ownerId: char('owner_id', { length: 36 }).notNull(), html: longtext('html').notNull(),
  title: varchar('title', { length: 255 }).notNull(), model: varchar('model', { length: 255 }),
  usage: json('token_usage'), createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
}, table => [index('atoms_artifact_project').on(table.projectId)]);

export const runs = mysqlTable('atoms_runs', {
  id: char('id', { length: 36 }).primaryKey(), projectId: char('project_id', { length: 36 }).notNull(),
  ownerId: char('owner_id', { length: 36 }).notNull(), requestId: varchar('request_id', { length: 128 }).notNull(),
  prompt: text('prompt').notNull(), mode: varchar('mode', { length: 16 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(), events: json('events').notNull(), error: text('error'),
  model: varchar('model', { length: 255 }), usage: json('token_usage'), bootId: char('boot_id', { length: 36 }).notNull(),
  heartbeatAt: datetime('heartbeat_at', { mode: 'date', fsp: 3 }).notNull(),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
}, table => [uniqueIndex('atoms_run_request').on(table.ownerId, table.requestId), index('atoms_run_status').on(table.status, table.heartbeatAt)]);

export const states = mysqlTable('atoms_states', {
  artifactId: char('artifact_id', { length: 36 }).primaryKey(), ownerId: char('owner_id', { length: 36 }).notNull(),
  data: json('data').notNull(), version: int('version', { unsigned: true }).notNull().default(0),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
});

// A dedicated counter table avoids counting races or using volatile process memory.
export const dailyUsage = mysqlTable('atoms_daily_usage', {
  day: char('day', { length: 10 }).notNull(), subject: varchar('subject', { length: 48 }).notNull(),
  count: int('count', { unsigned: true }).notNull().default(0),
}, table => [primaryKey({ columns: [table.day, table.subject] })]);
