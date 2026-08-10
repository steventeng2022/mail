PRAGMA foreign_keys = ON;

CREATE TABLE mail_messages (
  id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'trash')),
  mailbox TEXT NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  from_name TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL,
  reply_to_address TEXT,
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  bcc_addresses TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  raw_r2_key TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE mail_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_id TEXT
);

CREATE INDEX mail_messages_folder_idx ON mail_messages(folder, sent_at DESC);
CREATE INDEX mail_messages_starred_idx ON mail_messages(is_starred, sent_at DESC);
CREATE INDEX mail_attachments_message_idx ON mail_attachments(message_id);
