// 客户端与服务端共享的 TypeScript 类型定义
export type Gender = "female" | "male" | "nonbinary" | "private";
export type UserRole = "user" | "platform-admin";
export type JoinMode = "open" | "approval" | "question" | "closed";

export interface ModerationState {
  bannedUntil?: string;
  mutedUntil?: string;
  reason?: string;
}

export interface UserProfile {
  id: string;
  uuid?: string;
  email: string;
  name: string;
  handle: string;
  avatar?: string;
  bio: string;
  gender: Gender;
  role: UserRole;
  fingerprint?: string;
  vipUntil?: string;
  vipInfo?: { type: string; durationSeconds: number; activatedAt: string; issuedAt: string; expiresAt: string | null; issuedBy: string };
  publicKey?: JsonWebKey;
  moderation?: ModerationState;
  vip?: boolean;
  disclaimerAcceptedVersion?: string;
  qqNumber?: string;
  qqBoundAt?: string;
}

export interface Contact {
  id: string;
  uuid?: string;
  email?: string;
  name: string;
  handle: string;
  avatar?: string;
  status: string;
  publicKey: JsonWebKey;
  fingerprint?: string;
  role?: UserRole;
  moderation?: ModerationState;
  vip?: boolean;
  qqNumber?: string;
  requestedBy?: string;
  requestMessage?: string;
  remark?: string;
  pinned?: boolean;
  blocked?: boolean;
}

export interface GroupMember extends Contact {
  groupRole: "member" | "administrator" | "owner";
  forced?: boolean;
  memberTitle?: string;
  memberLevel?: number;
}

export interface GroupSettings {
  name?: string;
  joinMode: JoinMode;
  joinQuestion?: string;
  autoReview?: boolean;
  joinAnswer?: string;
  avatar?: string | null;
  description?: string;
  mentionMode?: "always" | "never";
}

export interface Conversation {
  id: string;
  name: string;
  description?: string;
  preview: string;
  updatedAt: string;
  unread: number;
  muted?: boolean;
  disappearingSeconds?: number;
  pinned?: boolean;
  blocked?: boolean;
  group?: boolean;
  groupNumber?: string;
  avatar?: string;
  members: GroupMember[];
  groupSettings?: GroupSettings;
  canManage?: boolean;
  viewerGroupRole?: "member" | "administrator" | "owner";
}

export interface Reaction {
  userId: string;
  displayName: string;
  emoji: string;
  createdAt: string;
}

export interface StatusUpdate {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  kind: "text" | "image";
  text?: string;
  imageId?: string;
  createdAt: string;
  viewed: boolean;
  viewCount?: number;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  localUrl?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderRole?: UserRole;
  senderVip?: boolean;
  body: string;
  sentAt: string;
  status: "sending" | "sent" | "delivered" | "failed";
  attachment?: AttachmentMeta;
  governance?: boolean;
  recalled?: boolean;
  edited?: boolean;
  disappearing?: boolean;
  disappearsAt?: string;
  reactions?: Reaction[];
  readBy?: string[];
  quote?: { id: string; senderName: string; body: string };
}

export interface EncryptedMessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderRole?: UserRole;
  senderVip?: boolean;
  envelope: import("./lib/crypto").EncryptedEnvelope;
  sentAt: string;
  attachment?: AttachmentMeta;
  governance?: boolean;
}

export interface Disclaimer {
  version: string;
  title: string;
  content: string;
  publishedAt: string;
  accepted: boolean;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  authorName: string;
  authorRole: "platform-admin";
  confirmRequired?: boolean;
  readAt?: string | null;
}

export interface JoinRequest {
  id: string;
  groupId: string;
  groupName?: string;
  groupNumber?: string;
  user?: Contact;
  answer?: string;
  status?: "pending" | "approved" | "rejected";
  rejectionReason?: string;
  reviewedAt?: string;
  createdAt: string;
}

export interface GroupJoinInfo {
  groupId: string;
  groupName: string;
  groupNumber?: string;
  joinMode: JoinMode;
  joinQuestion?: string;
  autoReview?: boolean;
}
