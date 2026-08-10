export type MailFolder = "inbox" | "sent" | "starred" | "trash";

export type MailSummary = {
  id: string;
  direction: "inbound" | "outbound";
  folder: "inbox" | "sent" | "trash";
  mailbox: string;
  fromName: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  preview: string;
  hasAttachments: boolean;
  isRead: boolean;
  isStarred: boolean;
  sentAt: number;
};

export type MailAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type MailDetail = MailSummary & {
  replyToAddress: string | null;
  ccAddresses: string[];
  bccAddresses: string[];
  textBody: string;
  attachments: MailAttachment[];
};

export type MailCounts = {
  inbox: number;
  unread: number;
  sent: number;
  starred: number;
  trash: number;
};

export type Session = {
  email: string;
  mailboxAddress: string;
  mailboxName: string;
};
