// Keep synchronized with drizzle/0000_atoms.sql. Each statement is independently idempotent.
export const migrations = [
  `CREATE TABLE IF NOT EXISTS atoms_visitors (
    id CHAR(36) PRIMARY KEY, token_hash CHAR(64) NOT NULL,
    expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL,
    UNIQUE KEY atoms_visitor_token (token_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS atoms_projects (
    id CHAR(36) PRIMARY KEY, owner_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL, prompt TEXT NOT NULL, mode VARCHAR(16) NOT NULL,
    artifact_id CHAR(36) NULL, active_run_id CHAR(36) NULL,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY atoms_project_owner (owner_id, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS atoms_artifacts (
    id CHAR(36) PRIMARY KEY, project_id CHAR(36) NOT NULL, owner_id CHAR(36) NOT NULL,
    html LONGTEXT NOT NULL, title VARCHAR(255) NOT NULL, model VARCHAR(255) NULL, token_usage JSON NULL,
    created_at DATETIME(3) NOT NULL, KEY atoms_artifact_project (project_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS atoms_runs (
    id CHAR(36) PRIMARY KEY, project_id CHAR(36) NOT NULL, owner_id CHAR(36) NOT NULL,
    request_id VARCHAR(128) NOT NULL, prompt TEXT NOT NULL, mode VARCHAR(16) NOT NULL,
    status VARCHAR(32) NOT NULL, events JSON NOT NULL, error TEXT NULL, model VARCHAR(255) NULL, token_usage JSON NULL,
    boot_id CHAR(36) NOT NULL, heartbeat_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY atoms_run_request (owner_id, request_id), KEY atoms_run_status (status, heartbeat_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS atoms_states (
    artifact_id CHAR(36) PRIMARY KEY, owner_id CHAR(36) NOT NULL,
    data JSON NOT NULL, version INT UNSIGNED NOT NULL DEFAULT 0, updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS atoms_daily_usage (
    day CHAR(10) NOT NULL, subject VARCHAR(48) NOT NULL, count INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (day, subject)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
