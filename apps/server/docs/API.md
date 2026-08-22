# API summary

JSON endpoints return `{ "error": "..." }` on failure. User endpoints use `Authorization: Bearer <jwt>`. Admin endpoints use `X-Admin-Key: <key>`. WebSocket clients connect to `/ws?token=<jwt>` and should use a browser-safe URL encoding for the token.

## User HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/email-code` | Send a verification code to `email` |
| POST | `/api/auth/register` | Register with `email`, `password`, `name`, `code`, and public ECDH `identity`; assigns an immutable RFC UUID and returns `accessToken` only |
| POST | `/api/auth/login` | Login with `email`, `password`, and the registered public `identity`; no refresh token is issued |
| GET/PATCH | `/api/profile` | Read/update profile; profile shapes include immutable `uuid` |
| PUT | `/api/profile/identity` | Rotate the public identity by proving the currently registered fingerprint |
| GET | `/api/disclaimer` | Current transparent service/governance notice (public) |
| POST | `/api/disclaimer/accept` | Record acceptance of the exact current `version` |
| GET | `/api/announcements` | List published, non-archived announcements |
| GET | `/api/contacts` | List relationships and requests |
| POST | `/api/contacts/requests` | Request contact by `userId` |
| PATCH | `/api/contacts/requests/:userId` | Accept/reject with `accept` |
| GET/POST | `/api/groups` | List/create groups, optionally with `joinMode` and `joinQuestion` |
| POST | `/api/groups/:groupId/members` | Owner adds `userId` |
| GET | `/api/groups/:groupId/members` | List visible members, roles, and forced membership attribution |
| PATCH | `/api/groups/:groupId/settings` | Owner/moderator changes join mode/question |
| POST | `/api/groups/:groupId/join` | Join an open group or submit a request and optional answer |
| GET | `/api/groups/:groupId/join-requests` | Owner/moderator lists pending requests |
| POST | `/api/groups/:groupId/join-requests/:requestId` | Owner/moderator approves/rejects |
| PATCH | `/api/groups/:groupId/members/:userId/role` | Owner assigns/removes moderator role |
| POST | `/api/groups/:groupId/mutes` | Owner/moderator creates a timed group mute |
| POST | `/api/vip/redeem` | Redeem `code` |
| POST | `/api/platform-admin/redeem` | Redeem a one-use `LTMY-MOD-` promotion code |

Ordinary users may own 10 groups, each with at most 100 members including the owner. Active VIP removes the owned-group limit and raises each owned group's member limit to 300.

The current disclaimer must be accepted before messaging, contact changes, group creation/join/settings/role/review/mute actions, or platform moderation. Reading a profile, groups, announcements, and the disclaimer remains available so clients can present the gate. Group `joinMode` is `open`, `approval`, `question`, or `closed`. Existing groups migrate to `approval`; existing owners migrate to the `owner` membership role.

## Platform administrator API

These endpoints use an app user's bearer JWT. An active platform-admin role and current disclaimer acceptance are required. Platform admins cannot target another active platform admin; root web administration is not an app user and cannot be targeted through these routes.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/platform-admin/groups/:groupId/force-join` | Join self despite group closure/limits; membership exposes `forcedBy` |
| POST | `/api/platform-admin/messages/:messageId/remove` | Create an audited tombstone from existing metadata and delete queued envelopes |

Platform administrators have no global ban/mute, direct/private intervention, hidden participation, or impersonation API. After visible membership they govern through the ordinary group settings, join review, role, member removal, group mute, and group-message tombstone endpoints, with authority above the owner and no authority over another active platform administrator.

## WebSocket frames

Send encrypted messages as `{"type":"message","id":"client-unique-id","to":2,"envelope":{"version":1,"algorithm":"ECDH-P256/AES-256-GCM","ephemeralPublicKey":{...},"iv":"base64","ciphertext":"base64"}}`. Direct recipients must be accepted contacts. The server rejects plaintext and persists the envelope verbatim only while the recipient is offline. Recipients delete it with `{"type":"ack","id":"client-unique-id"}`.

Send WebRTC/file-transfer signaling as `{"type":"signal","to":2,"signal":{...}}`. Signaling is relayed only to an online peer and never queued. Actual files must travel peer-to-peer over WebRTC data channels. Individual encrypted envelopes/signaling payloads are limited to 64 KiB. WebSocket frames are limited to 20 MiB so a group frame can contain one envelope for each of up to 300 members.

Group messages are `{"type":"group-message","id":"client-unique-id","groupId":4,"envelopes":[{"recipientId":2,"envelope":{...}}]}`. The sender must be a visible member and supply exactly one valid encrypted envelope for every other visible member. The server routes or temporarily queues each envelope only for its named recipient and never decrypts, copies between recipients, or accepts plaintext. A global or matching group mute rejects the frame. `ack` deletes both direct and group deliveries for that recipient.

For accepted direct/group messages the server retains only routing metadata (`id`, sender, direct recipient or group, timestamp) to support moderation. Removal sets `removedAt`, `removedBy`, and a reason, deletes still-queued encrypted envelopes, and emits a `moderation-tombstone`; it does not expose or recover content. Metadata is not a chat-history API.

## Admin scopes

### Credential hierarchy

The three generated credential types are strictly distinct and cannot be used interchangeably:

1. `LTMY-VIP-` is a one-use app activation code. Successful redemption only extends the redeeming user's VIP entitlement; it grants no administrator or panel authority.
2. `LTMY-MOD-` is a one-use app-account promotion code. Successful redemption only promotes that app account to platform administrator; it is not a panel login key. Only the Root MM key can create/revoke these codes or revoke the resulting role.
3. `LTMY-ADM-` is a panel access key with selected ordinary scopes. It can never become Root or create/revoke panel keys, `LTMY-MOD` codes, or platform-admin roles, even when assigned `keys:read` or `platform-admins:read`.

The separately configured Root MM key is the sole highest authority. `users:read`, `vip:issue`, `platform-admins:read`, `announcements:write`, `audit:read`, and `keys:read` are independently assignable to `LTMY-ADM` keys. Account bans require Root even though the internal route retains the `users:ban` scope name.

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/api/admin/session` | Any valid admin credential |
| GET | `/api/admin/overview` | Any valid admin credential; safe uptime and aggregate service counts |
| GET | `/api/admin/users`, `/api/admin/users/:uuid` | `users:read`; `q` matches UUID, email, or display name; legacy numeric identifiers remain accepted on detail routes |
| POST | `/api/admin/users/:uuid/ban` | Root only (`users:ban` internally); legacy numeric identifiers remain accepted |
| POST | `/api/admin/vip-codes` | `vip:issue`; issues one-use `LTMY-VIP` activation codes |
| GET/POST | `/api/admin/platform-admin-codes` | Root only |
| POST | `/api/admin/platform-admin-codes/:id/revoke` | Root only |
| GET | `/api/admin/platform-admins` | `platform-admins:read` |
| POST | `/api/admin/platform-admins/:uuid/revoke` | Root only; legacy numeric identifiers remain accepted |
| GET/POST | `/api/admin/announcements` | `announcements:write` |
| POST | `/api/admin/announcements/:id/archive` | `announcements:write` |
| GET | `/api/admin/audit` | `audit:read` |
| GET/POST | `/api/admin/keys` | Root only |
| POST | `/api/admin/keys/:id/revoke` | Root only |

Promotion codes are returned in plaintext only by the creation response. Storage and lookup use SHA-256 only, with a six-character display hint. A code is one-use, optionally expires, can be revoked only while unused, and redemption plus role assignment occurs inside `BEGIN IMMEDIATE`. Active admin listings include live WebSocket online status. Every governance state change writes an audit entry.

VIP issuance accepts the existing `duration` values plus `hour`: `hour`, `day`, `week`, `month`, `quarter`, or `year`. Custom requests use `duration: "custom"` and exactly one explicit positive `durationSeconds` or `durationHours`. The duration must resolve to an integer from 3,600 seconds (1 hour) through 315,360,000 seconds (10 years). `count` remains 1 through 100. The response includes `codes`, normalized `durationSeconds`, and `oneTime: true`. Each code is atomically marked redeemed before the entitlement transaction commits, so only one successful redemption is possible.

`GET /api/admin/overview` returns `status`, `uptimeSeconds`, `startedAt`, `registeredUsers`, actual unique `onlineUsers` from authenticated sockets, `activeVip`, `bannedUsers`, `groups`, and `activePlatformAdmins`. It deliberately omits environment values, host/process identifiers, memory, paths, and other deployment details.
