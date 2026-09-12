// REST 客户端 + WebSocket 消息通道：封装所有服务端通信
import type {
  Announcement,
  AttachmentMeta,
  Conversation,
  Contact,
  Disclaimer,
  EncryptedMessageRecord,
  GroupJoinInfo,
  GroupSettings,
  JoinRequest,
  UserProfile,
} from "../types";
import type { EncryptedEnvelope, PublicIdentity } from "../lib/crypto";
import version from "../../version.json";

export const APP_VERSION_CODE = version.versionCode;
export const APP_VERSION_NAME = version.versionName;

export interface Session {
  accessToken: string;
  user: UserProfile;
}

export interface SendMessageRequest {
  clientId: string;
  recipientIds: string[];
  envelopes: Record<string, EncryptedEnvelope>;
}

export interface AccountBanNotice {
  bannedUntil?: number | null;
  reason: string;
}

function banExpiry(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class ApiClient {
  private updateRequired?: () => void;
  private accountBanned?: (notice: AccountBanNotice) => void;
  constructor(
    private readonly baseUrl = import.meta.env.VITE_API_URL ?? "/api",
    private token?: string,
  ) {}

  setToken(token?: string) {
    this.token = token;
  }
  setUpdateRequiredHandler(handler?: () => void) { this.updateRequired = handler; }
  setAccountBannedHandler(handler?: (notice: AccountBanNotice) => void) { this.accountBanned = handler; }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    const hasBody = init.body !== undefined && init.body !== null;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          "X-App-Version-Code": String(APP_VERSION_CODE),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new ApiError("网络连接失败，请检查网络后重试", "NETWORK");
    }
    if (!response.ok) {
      const payload = await response
        .json()
        .catch(() => ({ error: "请求失败，请稍后重试喵" }));
      if (response.status === 426 && payload.code === "UPDATE_REQUIRED") this.updateRequired?.();
      if (payload.code === "ACCOUNT_BANNED") this.accountBanned?.({ bannedUntil: banExpiry(payload.expiresAt ?? payload.bannedUntil ?? payload.banExpiresAt), reason: String(payload.reason ?? payload.banReason ?? "管理操作") });
      throw new ApiError(
        payload.error ?? `HTTP ${response.status}`,
        payload.code,
        response.status,
      );
    }
    return response.status === 204
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }

  requestRegistrationCode(email: string) {
    return this.request<void>("/auth/email-code", {
      method: "POST",
      body: JSON.stringify({ email, purpose: "register" }),
    });
  }
  requestPasswordResetCode(email: string) {
    return this.request<void>("/auth/password-reset-code", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }
  resetPassword(email: string, code: string, password: string) {
    return this.request<void>("/auth/password-reset", {
      method: "POST",
      body: JSON.stringify({ email, code, password }),
    });
  }
  loginWithResetCode(email: string, code: string, identity: PublicIdentity) {
    return this.request<Session>("/auth/password-reset-login", {
      method: "POST",
      body: JSON.stringify({ email, code, identity }),
    });
  }
  requestDeviceMigrationCode(
    email: string,
    password: string,
    identity: PublicIdentity,
  ) {
    return this.request<void>("/auth/device-migration-code", {
      method: "POST",
      body: JSON.stringify({ email, password, identity }),
    });
  }
  migrateDevice(email: string, code: string, identity: PublicIdentity) {
    return this.request<Session>("/auth/device-migration", {
      method: "POST",
      body: JSON.stringify({ email, code, identity }),
    });
  }
  changePassword(currentPassword: string, newPassword: string) {
    return this.request<void>("/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }
  getVipOverage() {
    return this.request<{
      over: boolean;
      vip: boolean;
      ownedGroupLimit: number;
      memberLimit: number;
      ownedGroups: Array<{ id: number; name: string; memberCount: number }>;
    }>("/vip/overage");
  }
  createQqBindingRequest(qqNumber?: string) {
    return this.request<{ requestId: string; qqNumber: string; token: string; expiresAt: string; ttlSeconds: number }>("/qq/binding-request", {
      method: "POST",
      body: JSON.stringify(qqNumber ? { qqNumber } : {}),
    });
  }
  getQqBinding() {
    return this.request<{
      bound: boolean;
      qqNumber: string | null;
      boundAt: string | null;
      request: { qqNumber: string; expiresAt: string; remainingSeconds: number } | null;
    }>("/qq/binding");
  }
  deleteGroup(groupId: string) {
    return this.request<void>(`/groups/${encodeURIComponent(groupId.replace(/^g-/, ""))}`, {
      method: "DELETE",
    });
  }
  register(input: {
    email: string;
    code: string;
    password: string;
    name: string;
    identity: PublicIdentity;
    disclaimerVersion: string;
  }) {
    return this.request<Session>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  recordRegistrationDeclined(email: string) { return this.request<void>("/auth/register-declined", { method: "POST", body: JSON.stringify({ email }) }) }
  login(input: { email: string; password: string; identity: PublicIdentity }) {
    return this.request<Session>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  me() {
    return this.request<UserProfile>("/profile");
  }
  getDisclaimer() {
    return this.request<Disclaimer>("/disclaimer");
  }
  acceptDisclaimer(version: string) {
    return this.request<void>("/disclaimer/accept", {
      method: "POST",
      body: JSON.stringify({ version }),
    });
  }
  async listAnnouncements() {
    return this.request<{ announcements: Announcement[]; unreadCount: number }>("/announcements");
  }
  markAnnouncementRead(id: string) {
    return this.request<void>(`/announcements/${encodeURIComponent(id)}/read`, { method: "POST", body: "{}" });
  }
  markAllAnnouncementsRead() {
    return this.request<{ updated: number }>("/announcements/read-all", { method: "POST", body: "{}" });
  }
  async listConversations() {
    return (
      await this.request<{ conversations: Conversation[] }>("/conversations")
    ).conversations;
  }
  async listContacts() {
    return (await this.request<{ contacts: Contact[] }>("/contacts")).contacts;
  }
  async addContact(handle: string, message: string) {
    const users = (
      await this.request<{ users: Contact[] }>(
        `/users/search?q=${encodeURIComponent(handle)}`,
      )
    ).users;
    const query = handle.trim().replace(/^@/, "").toLowerCase();
    const contact = users.find((item) => item.uuid?.toLowerCase() === query || item.email?.toLowerCase() === query || item.qqNumber === query);
    if (!contact) throw new Error("没有找到该用户");
    await this.request("/contacts", {
      method: "POST",
      body: JSON.stringify({ userId: contact.id, message }),
    });
    return { ...contact, status: "pending" };
  }
  reviewContactRequest(userId: string, accept: boolean) {
    return this.request<void>(`/contacts/requests/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ accept }),
    });
  }
  removeContact(userId: string) {
    return this.request<void>(`/contacts/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }
  updateContactRemark(userId: string, remark: string) {
    return this.request<void>(`/contacts/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ remark }),
    });
  }
  updateContactPreferences(userId: string, preferences: { pinned?: boolean; blocked?: boolean }) {
    return this.request<{ pinned: boolean; blocked: boolean }>(`/contacts/${encodeURIComponent(userId)}/preferences`, {
      method: "PATCH",
      body: JSON.stringify(preferences),
    });
  }
  async uploadAttachment(file: File, conversationId: string, onProgress?: (percent: number) => void): Promise<AttachmentMeta> {
    return new Promise<AttachmentMeta>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `${this.baseUrl}/attachments`);
      request.setRequestHeader("Content-Type", file.type);
      request.setRequestHeader("X-Attachment-Name", encodeURIComponent(file.name));
      request.setRequestHeader("X-Conversation-Id", conversationId);
      request.setRequestHeader("X-App-Version-Code", String(APP_VERSION_CODE));
      if (this.token) request.setRequestHeader("Authorization", `Bearer ${this.token}`);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.min(99, Math.round(event.loaded / event.total * 100)));
      };
      request.onerror = () => reject(new ApiError("网络连接失败，请检查网络后重试", "NETWORK"));
      request.onload = () => {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(request.responseText) as Record<string, unknown>; } catch { /* handled below */ }
        if (request.status < 200 || request.status >= 300) {
          reject(new ApiError(String(payload.error ?? `HTTP ${request.status}`), typeof payload.code === "string" ? payload.code : undefined, request.status));
          return;
        }
        onProgress?.(100);
        resolve(payload as unknown as AttachmentMeta);
      };
      request.send(file);
    });
  }
  async downloadAttachment(id: string): Promise<Blob> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/attachments/${encodeURIComponent(id)}`, {
        headers: {
          "X-App-Version-Code": String(APP_VERSION_CODE),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      });
    } catch {
      throw new ApiError("附件下载失败，请检查网络后重试", "NETWORK");
    }
    if (!response.ok) throw new ApiError("附件已过期或暂时无法下载", undefined, response.status);
    return response.blob();
  }
  recallMessage(messageId: string) {
    return this.request<{ recalled: true }>(`/messages/${encodeURIComponent(messageId)}/recall`, { method: "POST", body: "{}" });
  }
  publishStatus(input: { kind: "text" | "image"; text?: string; imageId?: string }) {
    return this.request<{ id: string }>("/statuses", { method: "POST", body: JSON.stringify(input) });
  }
  listStatusFeed() {
    return this.request<{ statuses: import("../types").StatusUpdate[] }>("/statuses/feed");
  }
  markStatusViewed(statusId: string) {
    return this.request<{ viewed: true }>(`/statuses/${encodeURIComponent(statusId)}/view`, { method: "POST", body: "{}" });
  }
  deleteStatus(statusId: string) {
    return this.request<{ deleted: true }>(`/statuses/${encodeURIComponent(statusId)}`, { method: "DELETE" });
  }
  markMessageRead(messageId: string) {
    return this.request<{ read: true }>(`/messages/${encodeURIComponent(messageId)}/read`, { method: "POST", body: "{}" });
  }
  editMessage(messageId: string, envelopes: Record<string, unknown>) {
    return this.request<{ edited: true; editedAt: string; editCount: number }>(`/messages/${encodeURIComponent(messageId)}/edit`, { method: "POST", body: JSON.stringify({ envelopes }) });
  }
  setMessageReaction(messageId: string, emoji: string) {
    return this.request<{ reactions: import("../types").Reaction[] }>(`/messages/${encodeURIComponent(messageId)}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
  }
  setConversationMute(conversationId: string, mutedUntil: number | null) {
    return this.request<{ muted: boolean; mutedUntil: number | null }>(`/conversations/${encodeURIComponent(conversationId)}/mute`, { method: "PATCH", body: JSON.stringify({ mutedUntil }) });
  }
  setConversationDisappearing(conversationId: string, seconds: number) {
    return this.request<{ seconds: number }>(`/conversations/${encodeURIComponent(conversationId)}/disappearing`, { method: "PATCH", body: JSON.stringify({ seconds }) });
  }
  getConversationMedia(conversationId: string) {
    return this.request<{ media: Array<{ id: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: number }> }>(`/conversations/${encodeURIComponent(conversationId)}/media`);
  }
  getCommonGroups(userId: string) {
    return this.request<{ groups: Array<{ id: string; name: string; avatar?: string; groupNumber: string; memberCount: number }> }>(`/users/${encodeURIComponent(userId)}/common-groups`);
  }
  leaveGroup(groupId: string) {
    return this.request<{ left: true }>(`/groups/${groupId.replace(/^g-/, "")}/leave`, { method: "POST", body: "{}" });
  }
  startDirectConversation(contactId: string) {
    return this.request<Conversation>("/conversations/direct", {
      method: "POST",
      body: JSON.stringify({ contactId }),
    });
  }
  updateProfile(
    profile: Partial<Pick<UserProfile, "name" | "bio" | "gender" | "avatar">>,
  ) {
    return this.request<UserProfile>("/profile", {
      method: "PATCH",
      body: JSON.stringify(profile),
    });
  }
  createGroup(input: { name: string; memberIds: string[] }) {
    return this.request<Conversation>("/groups", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  updateGroupSettings(groupId: string, settings: GroupSettings) {
    return this.request<Conversation>(
      `/groups/${groupId.replace(/^g-/, "")}/settings`,
      { method: "PATCH", body: JSON.stringify(settings) },
    );
  }
  updateGroupAvatar(groupId: string, avatar: string | null) {
    return this.request<Conversation>(`/groups/${groupId.replace(/^g-/, "")}/profile`, {
      method: "PATCH",
      body: JSON.stringify({ avatar }),
    });
  }
  getGroupJoinInfo(groupId: string) {
    return this.request<GroupJoinInfo>(
      `/groups/${groupId.replace(/^g-/, "")}/join-info`,
    );
  }
  joinGroup(groupId: string, answer?: string) {
    return this.request<{ state: "joined" | "pending" }>(
      `/groups/${groupId.replace(/^g-/, "")}/join`,
      { method: "POST", body: JSON.stringify({ answer }) },
    );
  }
  searchGroupByNumber(groupNumber: string) {
    return this.request<{ group: { id: string; name: string; avatar?: string; groupNumber: string; description?: string; joinMode: string; memberCount: number; isMember: boolean } }>(
      `/groups/search/${encodeURIComponent(groupNumber)}`,
    );
  }
  getGroupFullMembers(groupId: string) {
    return this.request<{ members: Array<{ id: string; name: string; avatar?: string; qqNumber?: string; groupRole: string; memberTitle: string; memberLevel: number; vip: boolean; forced: boolean }> }>(
      `/groups/${groupId.replace(/^g-/, "")}/full`,
    );
  }
  forceJoinGroup(groupId: string) {
    return this.request<{ joined: true; visible: true }>(
      `/platform-admin/groups/${groupId.replace(/^g-/, "")}/force-join`,
      { method: "POST", body: "{}" },
    );
  }
  async listJoinRequests(groupId: string) {
    return (
      await this.request<{ requests: JoinRequest[] }>(
        `/groups/${groupId.replace(/^g-/, "")}/join-requests`,
      )
    ).requests;
  }
  async listAllJoinRequests() {
    return (
      await this.request<{ requests: JoinRequest[] }>("/group-join-requests")
    ).requests;
  }
  async listMyJoinRequests() {
    return (await this.request<{ requests: JoinRequest[] }>("/my-group-join-requests")).requests;
  }
  addGroupMember(groupId: string, userId: string) {
    return this.request<{ added: true }>(
      `/groups/${groupId.replace(/^g-/, "")}/members`,
      { method: "POST", body: JSON.stringify({ userId: Number(userId) }) },
    );
  }
  reviewJoinRequest(
    groupId: string,
    requestId: string,
    decision: "approve" | "reject",
    reason?: string,
  ) {
    return this.request<void>(
      `/groups/${groupId.replace(/^g-/, "")}/join-requests/${requestId}`,
      {
        method: "POST",
        body: JSON.stringify({ approve: decision === "approve", reason }),
      },
    );
  }
  setGroupMemberRole(
    groupId: string,
    userId: string,
    role: "member" | "moderator",
  ) {
    return this.request<void>(
      `/groups/${groupId.replace(/^g-/, "")}/members/${userId}/role`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
  }
  updateGroupMemberProfile(groupId: string, userId: string, title: string, level: number) {
    return this.request<void>(`/groups/${groupId.replace(/^g-/, "")}/members/${userId}/profile`, {
      method: "PATCH",
      body: JSON.stringify({ title, level }),
    });
  }
  muteGroupMember(groupId: string, userId: string, expiresAt: number) {
    return this.request<void>(`/groups/${groupId.replace(/^g-/, "")}/mutes`, {
      method: "POST",
      body: JSON.stringify({ userId: Number(userId), expiresAt }),
    });
  }
  unmuteGroupMember(groupId: string, userId: string) {
    return this.request<void>(`/groups/${groupId.replace(/^g-/, "")}/mutes/${userId}`, { method: "DELETE" });
  }
  muteAllGroupMembers(groupId: string, expiresAt: number) {
    return this.request<{ count: number }>(`/groups/${groupId.replace(/^g-/, "")}/mutes/all`, {
      method: "POST",
      body: JSON.stringify({ expiresAt }),
    });
  }
  unmuteAllGroupMembers(groupId: string) {
    return this.request<void>(`/groups/${groupId.replace(/^g-/, "")}/mutes/all`, { method: "DELETE" });
  }
  removeGroupMember(groupId: string, userId: string) {
    return this.request<void>(
      `/groups/${groupId.replace(/^g-/, "")}/members/${userId}`,
      { method: "DELETE" },
    );
  }
  redeemVip(code: string) {
    return this.request<{ expiresAt: number; permanent?: boolean }>("/vip/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
    }).then((value) => ({ vipUntil: value.permanent ? "9999-12-31T23:59:59.999Z" : new Date(value.expiresAt).toISOString() }));
  }
  redeemPlatformAdmin(code: string) {
    return this.request<UserProfile>("/platform-admin/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }
  getSecuritySettings() {
    return this.request<{
      settings: {
        selfDestructDays: number | null;
        messageAutoDeleteSeconds: number | null;
      };
    }>("/security/settings");
  }
  updateSecuritySettings(settings: {
    selfDestructDays: number | null;
    messageAutoDeleteSeconds: number | null;
  }) {
    return this.request<{ settings: typeof settings }>("/security/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
  }
  deleteAccount() {
    return this.request<void>("/account/delete", {
      method: "POST",
      body: JSON.stringify({ confirmation: "我确认注销账号" }),
    });
  }
  async checkLatestRelease() {
    const payload = await this.request<{
      release: {
        id: number;
        versionName: string;
        versionCode: number;
        fileSize: number;
        sha256: string;
        notes: string;
        forceUpdate: boolean;
        publishedAt: string;
        downloadUrl: string;
      } | null;
    }>("/releases/latest");
    return payload.release;
  }
  downloadReleaseUrl(release: { id: number; downloadUrl?: string }) {
    const base = this.baseUrl.replace(/\/+$/, "");
    if (release.downloadUrl?.startsWith("http")) return release.downloadUrl;
    if (release.downloadUrl?.startsWith("/api/"))
      return `${base.replace(/\/api$/, "")}${release.downloadUrl}`;
    return `${base}/releases/${release.id}/download`;
  }
  async createInvite(type: 'group' | 'user', targetId: number): Promise<{ url: string; token: string; expiresAt: string }> {
    return (await this.request(`/invite/create`, { method: 'POST', body: JSON.stringify({ type, targetId }) })) as { url: string; token: string; expiresAt: string };
  }
}

export type SocketEvent =
  | ({ type: "message.created" } & EncryptedMessageRecord)
  | {
      type: "moderation-tombstone";
      messageId: string;
      groupId: number;
      removedAt: number;
      reason: string;
    }
  | { type: "message-recalled"; messageId: string; conversationId: string }
  | { type: "message-edited"; messageId: string; conversationId: string; senderId: string; envelope: EncryptedEnvelope; editedAt: string; editCount: number }
  | { type: "message-read"; messageId: string; conversationId: string; readerId: string }
  | { type: "message-reactions"; messageId: string; conversationId: string; reactions: import("../types").Reaction[] }
  | { type: "message-disappeared"; messageId: string; conversationId: string }
  | { type: "typing"; from: string; conversationId: string }
  | { type: "call-signal"; from: string; signal: unknown }
  | { type: "avatar-updated"; userId: string; avatar?: string }
  | { type: "contact-request"; from: string }
  | { type: "system-notification"; id: string; groupId: number; body: string; createdAt: number };

export class MessagingSocket {
  private socket?: WebSocket;
  private token?: string;
  private url?: string;
  private manualClose = false;
  private updateRequired?: () => void;
  private accountBanned?: (notice: AccountBanNotice) => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatDeadline?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(event: SocketEvent) => void>();
  private pending = new Map<
    string,
    {
      resolve: (value: { id: string; acceptedAt: string }) => void;
      reject: (error: Error) => void;
    }
  >();

  connect(
    token: string,
    url = import.meta.env.VITE_WS_URL ??
      `${location.origin.replace(/^http/, "ws")}/ws`,
  ) {
    this.close();
    this.manualClose = false;
    this.token = token;
    this.url = url;
    const attempt = () => {
      if (this.manualClose || !this.token || !this.url) return;
      try {
        this.socket = new WebSocket(`${this.url}?token=${encodeURIComponent(this.token)}&versionCode=${APP_VERSION_CODE}`);
      } catch {
        this.scheduleReconnect();
        return;
      }
      this.socket.onclose = (event) => {
        this.stopHeartbeat();
        this.pending.forEach((pending) => pending.reject(new Error("消息通道已断开")));
        this.pending.clear();
        if (event.reason === "UPDATE_REQUIRED") { this.manualClose = true; this.updateRequired?.(); return; }
        if (event.reason === "ACCOUNT_BANNED") { this.manualClose = true; return; }
        this.scheduleReconnect();
      };
      this.socket.onerror = () => { /* onclose handles retry */ };
      this.socket.onopen = () => this.startHeartbeat();
      this.socket.onmessage = ({ data }) => {
        try {
          const frame = JSON.parse(data) as Record<string, unknown>;
          if (frame.type === "pong") {
            if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
            this.heartbeatDeadline = undefined;
            return;
          }
          if (frame.type === "account-banned") {
            this.accountBanned?.({ bannedUntil: banExpiry(frame.expiresAt ?? frame.bannedUntil ?? frame.banExpiresAt), reason: String(frame.reason ?? frame.banReason ?? "管理操作") });
            return;
          }
          const id = typeof frame.id === "string" ? frame.id : undefined;
          if (
            (frame.type === "accepted" || frame.type === "error") &&
            id &&
            this.pending.has(id)
          ) {
            const pending = this.pending.get(id)!;
            this.pending.delete(id);
            if (frame.type === "error")
              pending.reject(new Error(String(frame.error ?? "消息发送失败")));
            else
              pending.resolve({
                id,
                acceptedAt: new Date(Number(frame.createdAt)).toISOString(),
              });
            return;
          }
          if (frame.type === "message" || frame.type === "group-message") {
            const conversationId =
              frame.type === "group-message"
                ? `g-${frame.groupId}`
                : `d-${frame.senderId}`;
            this.listeners.forEach((listener) =>
              listener({
                type: "message.created",
                id: String(frame.id),
                conversationId,
                senderId: String(frame.senderId),
                senderName: `#${frame.senderId}`,
                senderVip: frame.senderVip === true,
                envelope: frame.envelope as EncryptedEnvelope,
                sentAt: new Date(Number(frame.createdAt)).toISOString(),
              }),
            );
          } else if (frame.type === "moderation-tombstone")
            this.listeners.forEach((listener) => listener(frame as SocketEvent));
          else if (frame.type === "message-recalled")
            this.listeners.forEach((listener) => listener({ type: "message-recalled", messageId: String(frame.messageId), conversationId: String(frame.conversationId) }));
          else if (frame.type === "message-edited")
            this.listeners.forEach((listener) => listener({ type: "message-edited", messageId: String(frame.messageId), conversationId: String(frame.conversationId), senderId: String(frame.senderId), envelope: frame.envelope as EncryptedEnvelope, editedAt: new Date(Number(frame.editedAt)).toISOString(), editCount: Number(frame.editCount ?? 1) }));
          else if (frame.type === "message-read")
            this.listeners.forEach((listener) => listener({ type: "message-read", messageId: String(frame.messageId), conversationId: String(frame.conversationId), readerId: String(frame.readerId) }));
          else if (frame.type === "message-reactions")
            this.listeners.forEach((listener) => listener({ type: "message-reactions", messageId: String(frame.messageId), conversationId: String(frame.conversationId), reactions: (frame.reactions as Array<{ userId: string; displayName: string; emoji: string; createdAt: string }>) ?? [] }));
          else if (frame.type === "message-disappeared")
            this.listeners.forEach((listener) => listener({ type: "message-disappeared", messageId: String(frame.messageId), conversationId: String(frame.conversationId) }));
          else if (frame.type === "typing")
            this.listeners.forEach((listener) => listener({ type: "typing", from: String(frame.from), conversationId: frame.groupId ? `g-${frame.groupId}` : `d-${frame.from}` }));
          else if (frame.type === "signal")
            this.listeners.forEach((listener) => listener({ type: "call-signal", from: String(frame.senderId), signal: frame.signal }));
          else if (frame.type === "avatar-updated")
            this.listeners.forEach((listener) => listener({ type: "avatar-updated", userId: String(frame.userId), avatar: typeof frame.avatar === 'string' ? frame.avatar : undefined }));
          else if (frame.type === "contact-request")
            this.listeners.forEach((listener) => listener({ type: "contact-request", from: String(frame.from) }));
        } catch {
          // Malformed server events are ignored; no unencrypted fallback is permitted.
        }
      };
    };
    attempt();
  }

  setUpdateRequiredHandler(handler?: () => void) { this.updateRequired = handler; }
  setAccountBannedHandler(handler?: (notice: AccountBanNotice) => void) { this.accountBanned = handler; }
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private startHeartbeat() {
    this.stopHeartbeat();
    const beat = () => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify({ type: "ping", sentAt: Date.now() }));
      if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = setTimeout(() => {
        this.socket?.close(4000, "HEARTBEAT_TIMEOUT");
      }, 25_000);
    };
    beat();
    this.heartbeatTimer = setInterval(beat, 20_000);
  }
  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = undefined;
    this.heartbeatDeadline = undefined;
  }
  private scheduleReconnect() {
    if (this.manualClose || !this.token || !this.url) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(this.token!, this.url!), 2000);
  }
  subscribe(listener: (event: SocketEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  acknowledge(messageId: string) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "ack", id: messageId }));
  }
  sendTyping(conversationId: string) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const frame = conversationId.startsWith("g-")
      ? { type: "typing", groupId: Number(conversationId.slice(2)) }
      : { type: "typing", to: Number(conversationId.slice(2)) };
    this.socket.send(JSON.stringify(frame));
  }
  sendSignal(toUserId: string, signal: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "signal", to: Number(toUserId), signal }));
    return true;
  }
  sendMessage(conversation: Conversation, payload: SendMessageRequest) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("消息通道尚未连接"));
    const directRecipientId = payload.recipientIds[0];
    if (!conversation.group && !directRecipientId)
      return Promise.reject(new Error("缺少直接消息接收方"));
    const frame = conversation.group
      ? {
          type: "group-message",
          id: payload.clientId,
          groupId: Number(conversation.id.replace(/^g-/, "")),
          envelopes: payload.recipientIds.map((recipientId) => ({
            recipientId: Number(recipientId),
            envelope: payload.envelopes[recipientId],
          })),
        }
      : {
          type: "message",
          id: payload.clientId,
          to: Number(directRecipientId),
          envelope: payload.envelopes[directRecipientId!],
        };
    return new Promise<{ id: string; acceptedAt: string }>(
      (resolve, reject) => {
        this.pending.set(payload.clientId, { resolve, reject });
        this.socket!.send(JSON.stringify(frame));
        setTimeout(() => {
          if (this.pending.delete(payload.clientId))
            reject(new Error("消息发送确认超时"));
        }, 20_000);
      },
    );
  }
  close() {
    this.manualClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
  }
}
