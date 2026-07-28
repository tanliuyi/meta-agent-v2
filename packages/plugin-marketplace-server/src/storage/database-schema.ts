export const DATABASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publishers (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	verified BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'user',
	created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at BIGINT NOT NULL,
	expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS publisher_members (
	publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	PRIMARY KEY (publisher_id, user_id)
);
CREATE TABLE IF NOT EXISTS plugins (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	publisher_id TEXT NOT NULL REFERENCES publishers(id),
	categories TEXT NOT NULL,
	icon_asset_id TEXT,
	published_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_versions (
	plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
	version TEXT NOT NULL,
	status TEXT NOT NULL,
	draft BOOLEAN NOT NULL DEFAULT FALSE,
	changelog TEXT NOT NULL,
	published_at BIGINT NOT NULL,
	desktop TEXT NOT NULL,
	configuration TEXT,
	capabilities TEXT NOT NULL,
	PRIMARY KEY (plugin_id, version)
);
CREATE TABLE IF NOT EXISTS plugin_artifacts (
	plugin_id TEXT NOT NULL,
	version TEXT NOT NULL,
	artifact_id TEXT NOT NULL,
	target TEXT NOT NULL,
	contains_native_code BOOLEAN NOT NULL,
	preferred BOOLEAN NOT NULL,
	entry TEXT NOT NULL,
	sha256 TEXT,
	size INTEGER,
	object_key TEXT,
	manifest TEXT,
	signature TEXT,
	PRIMARY KEY (plugin_id, version, artifact_id),
	FOREIGN KEY (plugin_id, version) REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ratings (
	plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	stars INTEGER NOT NULL,
	review TEXT,
	updated_at BIGINT NOT NULL,
	PRIMARY KEY (plugin_id, user_id)
);
CREATE TABLE IF NOT EXISTS downloads (
	plugin_id TEXT NOT NULL,
	version TEXT NOT NULL,
	artifact_id TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (plugin_id, version, artifact_id),
	FOREIGN KEY (plugin_id, version) REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS revocations (
	id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	plugin_id TEXT NOT NULL,
	version TEXT NOT NULL,
	artifact_ids TEXT,
	status TEXT NOT NULL,
	reason_code TEXT NOT NULL,
	message TEXT NOT NULL,
	replacement_version TEXT
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE plugin_versions ADD COLUMN IF NOT EXISTS configuration TEXT;
ALTER TABLE plugin_artifacts ADD COLUMN IF NOT EXISTS object_key TEXT;
`;
