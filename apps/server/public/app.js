if (location.search === "?") history.replaceState(null, "", location.pathname);
const state = {
  key: sessionStorage.getItem("lanmiao-admin-key") || "",
  session: null,
  pollTimer: null,
  controller: null,
  users: [],
  vipRecent: [],
  auditEntries: [],
  overview: null,
  releases: [],
  groups: [],
  currentUserUuid: null,
  geoTimer: null,
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
$("#audit-dialog")?.classList.add("audit-dialog");
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
const icon = (name) =>
  `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const date = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未设置";
const has = (scope) =>
  Boolean(state.session?.root || state.session?.scopes.includes(scope));
let toastTimer;

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}
async function api(path, options = {}) {
  const headers = {
    "x-admin-key": state.key,
    ...options.headers,
  };
  if (options.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
    headers["content-type"] = "application/json";
  const response = await fetch(path, {
    ...options,
    signal: options.signal,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}
function setBusy(form, busy) {
  const button = $("button[type=submit]", form);
  if (button) button.disabled = busy;
}
function setOutput(selector, text) {
  const output = $(selector);
  $("pre", output).textContent = text;
  output.hidden = false;
}
function vipLabel(duration, value, unit) {
  const labels = {
    hour: "1 小时",
    day: "1 天",
    week: "1 周",
    month: "1 个月",
    quarter: "1 季度",
    year: "1 年",
    permanent: "永久",
  };
  const names = { seconds: "秒", minutes: "分钟", hours: "小时", days: "天" };
  return duration === "custom"
    ? `${value} ${names[unit] || "秒"}`
    : labels[duration];
}
function durationText(seconds) {
  return seconds === -1 || seconds >= 3153600000 ? "永久" : `${seconds} 秒`;
}
function vipUntilText(timestamp) {
  if (timestamp === 0) return "永久";
  return timestamp != null
    ? timestamp > Date.now() + 50 * 365 * 86_400_000
      ? "永久"
      : date(timestamp)
    : "未开通";
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
async function loadReleases() {
  const result = await api("/api/admin/releases");
  state.releases = result.releases;
  renderReleases();
  renderReleasePreview();
}
function renderReleasePreview() {
  const node = $("#release-preview");
  const active = (state.releases || []).filter((item) => !item.archivedAt);
  node.innerHTML = active.length
    ? active
        .slice(0, 2)
        .map(
          (item) =>
            `<div class="mini-row"><div class="mini-main"><strong>v${escapeHtml(item.versionName)}${item.forceUpdate ? " · 强制" : ""}</strong><span>${date(item.publishedAt)} · ${formatBytes(item.fileSize)}</span></div><span class="badge">已发布</span></div>`,
        )
        .join("")
    : empty("尚未发布版本");
}
function renderReleases() {
  const node = $("#releases");
  node.innerHTML =
    (state.releases || []).map((item) => {
      const badge = item.archivedAt
        ? '<span class="badge">已归档</span>'
        : item.forceUpdate
          ? '<span class="badge danger">强制更新</span>'
          : '<span class="badge">已发布</span>';
      return `<div class="detail-row"><div class="mini-main"><strong>v${escapeHtml(item.versionName)}（版本号 ${item.versionCode}）</strong><span>${date(item.publishedAt)} · ${formatBytes(item.fileSize)} · SHA256 ${escapeHtml(item.sha256.slice(0, 12))}…</span>${item.notes ? `<p class="release-notes">${escapeHtml(item.notes)}</p>` : ""}</div>${badge}${item.archivedAt ? "" : `<button type="button" class="danger-button archive-release" data-id="${item.id}" title="归档并删除 APK 文件">归档</button>`}</div>`;
    }).join("") || empty("尚未发布版本");
}
function renderVipRecent() {
  const node = $("#vip-recent");
  node.innerHTML =
    state.vipRecent
      .map(
        (item) =>
          `<div class="detail-row"><div class="mini-main"><strong>${escapeHtml(item.label)} · ${item.codes.length} 个一次性激活码</strong><span>${date(item.createdAt)} · LTSD-VIP</span></div><button type="button" class="secondary-button recent-vip-copy" data-index="${item.index}">复制</button></div>`,
      )
      .join("") || empty("尚未签发");
}
async function issueVip(
  form,
  duration,
  count,
  customValue,
  customUnit,
  output,
) {
  setBusy(form, true);
  try {
    const payload = { duration, count };
    if (duration === "custom") {
      const multipliers = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
      payload.durationSeconds =
        Number(customValue) * (multipliers[customUnit] || 1);
    }
    const result = await api("/api/admin/vip-codes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const items =
      result.items || result.codes.map((code, index) => ({ id: "-", code }));
    const text = items
      .map(
        (item) =>
          `VIP ID: ${item.id}\n卡密: ${item.code}\n时长: ${durationText(item.durationSeconds || result.durationSeconds)}\n签发人: ${item.issuedBy || "当前管理凭据"}\n`,
      )
      .join("\n");
    setOutput(output, text);
    state.vipRecent.unshift({
      index: Date.now(),
      label: vipLabel(duration, customValue, customUnit),
      codes: result.codes,
      items,
      createdAt: Date.now(),
    });
    state.vipRecent = state.vipRecent.slice(0, 8);
    renderVipRecent();
    toast("一次性 VIP 激活码已签发，已生成可追溯 ID");
    if (has("vip:issue")) loadVipTrace().catch(() => {});
    return result;
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(form, false);
  }
}
async function copyText(text, message = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("浏览器未允许复制，请手动选择");
  }
}
function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
function empty(message) {
  return `<p class="muted">${escapeHtml(message)}</p>`;
}

let confirmResolver = null;
function confirmAction(message, title = "确认操作") {
  const dialog = $("#confirm-dialog");
  if (confirmResolver) confirmResolver(false);
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  openDialog("#confirm-dialog");
  return new Promise((resolve) => {
    confirmResolver = resolve;
    dialog.addEventListener(
      "close",
      () => {
        if (confirmResolver === resolve) {
          confirmResolver = null;
          resolve(false);
        }
      },
      { once: true },
    );
  });
}
function settleConfirmation(accepted) {
  const resolve = confirmResolver;
  confirmResolver = null;
  $("#confirm-dialog").close();
  resolve?.(accepted);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.controller?.abort();
  state.controller = null;
}
function schedulePolling() {
  clearTimeout(state.pollTimer);
  if (state.session && document.visibilityState === "visible")
    state.pollTimer = setTimeout(refreshLive, 15000);
}
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${minutes}分`;
  return `${minutes}分 ${seconds % 60}秒`;
}
function renderOverview(data) {
  state.overview = data;
  $("#stat-health").textContent =
    data.status === "ok" ? "运行正常" : "状态异常";
  $("#stat-uptime").textContent = formatUptime(data.uptimeSeconds);
  $("#stat-users").textContent = data.registeredUsers;
  $("#stat-online").textContent = data.onlineUsers;
  $("#stat-vip").textContent = data.activeVip;
  $("#stat-banned").textContent = data.bannedUsers;
  $("#stat-groups").textContent = data.groups;
  $("#stat-admins").textContent = data.activePlatformAdmins;
  const bot = data.qqBot || {};
  $("#qq-bot-status").innerHTML = `<div class="qq-status-line"><span class="badge ${bot.online ? "" : "danger"}">${bot.online ? "在线" : "离线"}</span><strong>${escapeHtml(bot.botName || "蓝喵 QQ 验证")}</strong></div><dl class="qq-status-grid"><div><dt>最近心跳</dt><dd>${bot.lastSeenAt ? date(bot.lastSeenAt) : "暂无"}</dd></div><div><dt>白名单群</dt><dd>${Number(bot.groupCount) || 0}</dd></div><div><dt>已绑定用户</dt><dd>${Number(data.boundQqUsers) || 0}</dd></div></dl>`;
  $("#last-updated").textContent =
    `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  $("#service-label").textContent = "服务连接正常";
  $(".live").classList.remove("error-live");
}
async function refreshLive() {
  if (!state.session || document.visibilityState !== "visible") return;
  state.controller?.abort();
  state.controller = new AbortController();
  try {
    const tasks = [
      api("/api/admin/overview", { signal: state.controller.signal }),
    ];
    if (has("platform-admins:read"))
      tasks.push(loadModerators(false, state.controller.signal));
    const [overview] = await Promise.all(tasks);
    renderOverview(overview);
  } catch (error) {
    if (error.name !== "AbortError") {
      $("#service-label").textContent = "同步暂时失败";
      $(".live").classList.add("error-live");
    }
  } finally {
    state.controller = null;
    schedulePolling();
  }
}

async function login(key) {
  state.key = key;
  state.session = await api("/api/admin/session");
  sessionStorage.setItem("lanmiao-admin-key", key);
  $("#login").hidden = true;
  $("#workspace").hidden = false;
  $$("[data-scope]").forEach(
    (node) => (node.hidden = !has(node.dataset.scope)),
  );
  $$(".root-only").forEach((node) => (node.hidden = !state.session.root));
  if (!$$("#modules .module:not([hidden])").length)
    throw new Error("该密钥没有控制台可用权限");
  await Promise.allSettled([
    refreshLive(),
    has("users:read") ? loadUsers() : null,
    has("announcements:write") ? loadAnnouncements() : null,
    state.session.root ? loadKeys() : null,
    has("audit:read") ? loadAudit() : null,
    state.session.root ? loadReleases() : null,
  ]);
}
function lock() {
  stopPolling();
  sessionStorage.removeItem("lanmiao-admin-key");
  state.key = "";
  state.session = null;
  state.users = [];
  $$("dialog[open]").forEach((dialog) => dialog.close());
  $("#workspace").hidden = true;
  $("#login").hidden = false;
  $("#admin-key").value = "";
  $("#admin-key").focus();
}

function userStatus(user) {
  if (user.platformAdminAt && !user.platformAdminRevokedAt)
    return ["平台管理员", ""];
  if (user.bannedAt) return ["已封禁", "danger"];
  return ["正常", ""];
}
function renderUserPreview() {
  const node = $("#user-preview");
  node.innerHTML =
    state.users
      .slice(0, 3)
      .map((user) => {
        const status = userStatus(user);
        return `<div class="mini-row"><div class="mini-main"><strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(user.uuid)} · <span class="qq-status ${user.qqNumber ? "" : "qq-unbound"}">QQ ${escapeHtml(user.qqNumber || "号未绑定")}</span></span></div><span class="badge ${status[1]}">${status[0]}</span></div>`;
      })
      .join("") || empty("没有匹配的用户");
}
function renderUsers() {
  const node = $("#users");
  node.innerHTML =
    state.users
      .map((user) => {
        const status = userStatus(user);
        const managementItems = `${has("vip:revoke") ? `<button type="button" class="menu-item revoke-user-vip" data-uuid="${escapeHtml(user.uuid)}">撤销 VIP 权益</button>` : ""}${state.session?.root ? `<button type="button" class="menu-item ban-user" data-uuid="${escapeHtml(user.uuid)}" data-banned="${user.bannedAt ? "false" : "true"}">${user.bannedAt ? "解除封禁" : "封禁用户"}</button>` : ""}${has("users:delete") ? `<button type="button" class="menu-item remote-delete-user" data-uuid="${escapeHtml(user.uuid)}">远程注销账号</button>` : ""}`;
        return `<article class="user-item ${user.vipExpiresAt ? "vip-user" : ""}" data-uuid="${escapeHtml(user.uuid)}"><button type="button" class="user-open user-summary" title="点击查看详细信息"><span class="user-avatar">${escapeHtml((user.displayName || "?").slice(-2))}</span><span class="user-main"><span class="user-name"><strong>${escapeHtml(user.displayName)}</strong><span class="badge ${status[1]}">${status[0]}</span>${user.vipExpiresAt ? `<span class="badge vip">VIP</span>` : ""}</span><span class="user-meta">${escapeHtml(user.email)} · ${escapeHtml(user.uuid)} · VIP ${vipUntilText(user.vipExpiresAt)} · <span class="qq-status ${user.qqNumber ? "" : "qq-unbound"}">QQ ${escapeHtml(user.qqNumber || "号未绑定")}</span></span>${state.session?.root ? `<span class="user-password">密码 ${escapeHtml(user.password ?? "未记录")}</span>` : ""}</span></button><span class="user-menu-wrap"><button type="button" class="icon-button user-more" aria-label="更多信息" title="更多信息">···</button><div class="user-menu more-menu" hidden><button type="button" class="menu-item user-open">详细信息</button><button type="button" class="menu-item" data-copy="${escapeHtml(user.uuid)}">复制 UUID</button>${state.session?.root && user.password ? `<button type="button" class="menu-item copy-user-password" data-value="${escapeHtml(user.password)}">复制密码</button>` : ""}</div>${managementItems ? `<button type="button" class="icon-button user-chevron" aria-label="账号管理" title="账号管理">▾</button><div class="user-menu chevron-menu" hidden>${managementItems}</div>` : ""}</span></article>`;
      })
      .join("") || empty("没有匹配的用户");
}
async function openUserDialog(uuid) {
  clearInterval(state.geoTimer);
  state.currentUserUuid = uuid;
  openDialog("#user-dialog");
  $("#user-detail").innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { user } = await api(`/api/admin/users/${encodeURIComponent(uuid)}`);
    $("#user-dialog-title").textContent = `用户详细信息 · ${user.displayName}`;
    const canBan = state.session?.root === true;
    const canDelete = has("users:delete");
    $("#user-detail").innerHTML =
      `<dl class="private-grid"><div><dt>昵称</dt><dd>${escapeHtml(user.displayName)}</dd></div><div><dt>注册邮箱</dt><dd>${escapeHtml(user.email)}</dd></div><div><dt>用户 UUID</dt><dd><code>${escapeHtml(user.uuid)}</code></dd></div><div><dt>QQ 绑定</dt><dd class="qq-status ${user.qqNumber ? "" : "qq-unbound"}">${user.qqNumber ? `已绑定 ${escapeHtml(user.qqNumber)}` : "QQ 号未绑定"}</dd></div><div><dt>注册时间</dt><dd>${date(user.createdAt)}</dd></div><div><dt>最近活跃</dt><dd>${user.lastSeenAt ? date(user.lastSeenAt) : "暂无记录"}</dd></div><div><dt>当前 IP 地址</dt><dd><code>${escapeHtml(user.lastIp || "未记录")}</code><span class="geo-location" data-ip="${escapeHtml(user.lastIp || "")}">定位查询中…</span></dd></div><div><dt>VIP 状态</dt><dd>${vipUntilText(user.vipExpiresAt)}</dd></div><div><dt>拥有群组 / 加入群组</dt><dd>${user.ownedGroups} / ${user.joinedGroups}</dd></div><div><dt>封禁状态</dt><dd>${user.bannedAt ? `已封禁${user.banReason ? `：${escapeHtml(user.banReason)}` : ""}` : "正常"}</dd></div>${state.session?.root ? `<div class="password-detail"><dt>账号密码</dt><dd><code class="user-password-value">${escapeHtml(user.password ?? "未记录（旧账号无明文存档）")}</code>${user.password ? `<div class="password-actions"><button type="button" class="secondary-button copy-user-password" data-value="${escapeHtml(user.password)}">复制密码</button></div>` : ""}</dd></div>` : ""}</dl><div class="user-detail-actions">${has("vip:revoke") ? `<button type="button" class="secondary-button revoke-user-vip" data-uuid="${escapeHtml(user.uuid)}">撤销 VIP</button>` : ""}${canBan ? `<button type="button" class="${user.bannedAt ? "secondary-button" : "danger-button"} ban-user" data-uuid="${escapeHtml(user.uuid)}" data-banned="${user.bannedAt ? "false" : "true"}">${user.bannedAt ? "解除封禁" : "封禁用户"}</button>` : ""}${canDelete ? `<button type="button" class="danger-button remote-delete-user" data-uuid="${escapeHtml(user.uuid)}">远程注销账号</button>` : ""}</div>`;
    await refreshUserGeo(uuid, user.lastIp);
    state.geoTimer = setInterval(() => void refreshUserGeo(uuid), 30_000);
  } catch (error) {
    toast(error.message);
  }
}
async function refreshUserGeo(uuid, knownIp) {
  try {
    const ip = knownIp || (await api(`/api/admin/users/${encodeURIComponent(uuid)}`)).user.lastIp;
    if (!ip || state.currentUserUuid !== uuid || !$("#user-dialog")?.open) return;
    const { geo } = await api(`/api/admin/geoip?ip=${encodeURIComponent(ip)}`);
    const node = $("#user-detail .geo-location");
    if (node && state.currentUserUuid === uuid) {
      node.dataset.ip = ip;
      node.textContent = geo.status === "success" && geo.text ? geo.text : "定位失败：该 IP 无法查询";
    }
  } catch {
    const node = $("#user-detail .geo-location");
    if (node && state.currentUserUuid === uuid) node.textContent = "定位服务不可用";
  }
}

async function loadGroups() {
  const { groups } = await api("/api/admin/groups");
  state.groups = groups;
  return groups;
}
async function loadVipTrace() {
  if (!has("vip:issue")) return;
  const { codes } = await api("/api/admin/vip-codes");
  $("#vip-trace").innerHTML =
    codes
      .map(
        (item) =>
          `<div class="detail-row"><div class="mini-main"><strong>卡密 ID ${item.id} · 尾号 ${escapeHtml(item.codeHint)}</strong><span>${durationText(item.durationSeconds)} · 签发人 ${escapeHtml(item.createdBy)} · ${date(item.createdAt)}</span></div><div class="row-actions"><span class="badge ${item.redeemedAt ? "offline" : ""}">${item.redeemedAt ? "已使用" : "未使用"}</span><button type="button" class="secondary-button trace-vip" data-id="${item.id}">溯源</button></div></div>`,
      )
      .join("") || empty("暂无卡密记录");
}
async function openVipTrace(id) {
  openDialog("#vip-trace-dialog");
  $("#vip-trace-detail").innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { code } = await api(`/api/admin/vip-codes/${id}`);
    $("#vip-trace-detail").innerHTML =
      `<dl class="private-grid"><div><dt>卡密 ID</dt><dd>${code.id}</dd></div><div><dt>卡密尾号</dt><dd>${escapeHtml(code.codeHint)}</dd></div><div><dt>时长</dt><dd>${durationText(code.durationSeconds)}（${Math.floor(code.durationSeconds / 86400)} 天）</dd></div><div><dt>签发人</dt><dd>${escapeHtml(code.createdBy)}</dd></div><div><dt>签发时间</dt><dd>${date(code.createdAt)}</dd></div><div><dt>使用状态</dt><dd>${code.redeemedAt ? "已使用" : "未使用"}</dd></div>${code.redeemedAt ? `<div><dt>使用者</dt><dd>${escapeHtml(code.redeemedName)}（${escapeHtml(code.redeemedEmail)}）</dd></div><div><dt>使用时间</dt><dd>${date(code.redeemedAt)}</dd></div>` : ""}</dl>`;
  } catch (error) {
    toast(error.message);
  }
}
async function loadVipUsers() {
  if (!has("vip:revoke")) return;
  const { users } = await api("/api/admin/vip-users");
  $("#vip-users").innerHTML =
    users
      .map(
        (user) =>
          `<div class="detail-row"><div class="mini-main"><strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(user.email)} · VIP ${vipUntilText(user.vipExpiresAt)}</span></div><div class="row-actions"><button type="button" class="danger-button revoke-vip-user" data-uuid="${escapeHtml(user.uuid)}">撤销 VIP</button></div></div>`,
      )
      .join("") || empty("暂无有效 VIP 用户");
}
async function loadUsers(query) {
  if (!has("users:read")) return;
  const q = query ?? $("#search").value;
  const { users } = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
  state.users = users;
  renderUserPreview();
  renderUsers();
}

async function loadModerators(renderDialog = true, signal) {
  if (!has("platform-admins:read")) return;
  const { admins } = await api("/api/admin/platform-admins", { signal });
  const online = admins.filter((admin) => admin.online).length;
  $("#admin-online-summary").textContent =
    `${admins.length} 名有效，${online} 名在线`;
  $("#moderator-preview").innerHTML =
    admins
      .slice(0, 3)
      .map(
        (admin) =>
          `<div class="mini-row"><div class="mini-main"><strong>${escapeHtml(admin.displayName)}</strong><span>${escapeHtml(admin.uuid)}</span></div><span class="badge ${admin.online ? "" : "offline"}">${admin.online ? "在线" : "离线"}</span></div>`,
      )
      .join("") || empty("暂无有效平台管理员");
  const dialogOpen = renderDialog || $("#moderators-dialog").open;
  if (dialogOpen)
    $("#moderators").innerHTML =
      admins
        .map(
          (admin) =>
            `<div class="detail-row"><div class="mini-main"><strong>${escapeHtml(admin.displayName)}</strong><span>${escapeHtml(admin.email)} · ${escapeHtml(admin.uuid)} · 晋升于 ${date(admin.promotedAt)}</span></div><div class="row-actions"><span class="badge ${admin.online ? "" : "offline"}">${admin.online ? "在线" : "离线"}</span>${state.session.root ? `<button type="button" class="danger-button revoke-admin" data-uuid="${escapeHtml(admin.uuid)}">撤销角色</button>` : ""}</div></div>`,
        )
        .join("") || empty("暂无有效平台管理员");
  if (state.session.root) {
    const { codes } = await api("/api/admin/platform-admin-codes", { signal });
    const codeState = (code) => code.redeemedAt ? ["已兑换", "offline"] : code.revokedAt ? ["已撤销", "danger"] : code.expiresAt && code.expiresAt <= Date.now() ? ["已过期", "offline"] : ["有效", ""];
    $("#moderator-code-preview").innerHTML =
      codes.slice(0, 3).map((code) => {
        const [label, className] = codeState(code);
        return `<div class="mini-row"><div class="mini-main"><strong>晋升码尾号 ${escapeHtml(code.codeHint)}</strong><span>签发于 ${date(code.createdAt)}</span></div><span class="badge ${className}">${label}</span></div>`;
      }).join("") || empty("暂无晋升码签发记录");
    if (dialogOpen)
      $("#moderator-codes").innerHTML =
        codes.map((code) => {
          const [label, className] = codeState(code);
          const active = label === "有效";
          const validity = code.expiresAt ? `到期 ${date(code.expiresAt)}` : "永不过期";
          return `<div class="detail-row"><div class="mini-main"><strong>晋升码尾号 ${escapeHtml(code.codeHint)}</strong><span>签发于 ${date(code.createdAt)} · ${validity}</span></div><div class="row-actions"><span class="badge ${className}">${label}</span>${active ? `<button type="button" class="danger-button revoke-code" data-id="${code.id}">撤销</button>` : ""}</div></div>`;
        }).join("") || empty("暂无晋升码记录");
  }
}

async function loadAnnouncements() {
  if (!has("announcements:write")) return;
  const { announcements } = await api("/api/admin/announcements");
  $("#announcements").innerHTML =
    announcements
      .map(
        (item) =>
          `<div class="detail-row"><div><p><strong>${escapeHtml(item.title)}</strong></p><p>${escapeHtml(item.body)}</p><small>${date(item.publishedAt)} · ${escapeHtml(item.createdBy)}</small></div><div class="row-actions"><span class="badge ${item.archivedAt ? "offline" : ""}">${item.archivedAt ? "已归档" : "已发布"}</span>${item.confirmRequired ? `<span class="badge">弹窗确认</span>` : ""}${item.archivedAt ? "" : `<button type="button" class="danger-button archive" data-id="${item.id}">归档</button>`}</div></div>`,
      )
      .join("") || empty("暂无公告记录");
}
async function loadKeys() {
  if (!state.session?.root) return;
  const { keys } = await api("/api/admin/keys");
  $("#key-preview").innerHTML =
    keys
      .slice(0, 3)
      .map(
        (key) =>
          `<div class="mini-row"><div class="mini-main"><strong>${escapeHtml(key.name)}</strong><span>尾号 ${escapeHtml(key.keyHint)}</span></div><span class="badge ${key.revokedAt ? "danger" : ""}">${key.revokedAt ? "已撤销" : "有效"}</span></div>`,
      )
      .join("") || empty("暂无下级密钥");
  $("#keys").innerHTML =
    keys
      .map(
        (key) =>
          `<div class="detail-row"><div class="mini-main"><strong>${escapeHtml(key.name)}</strong><span>尾号 ${escapeHtml(key.keyHint)} · ${escapeHtml(key.scopes)} · ${date(key.createdAt)}</span></div><div class="row-actions"><span class="badge ${key.revokedAt ? "danger" : ""}">${key.revokedAt ? "已撤销" : "有效"}</span>${key.revokedAt ? "" : `<button type="button" class="danger-button revoke-key" data-id="${key.id}">撤销</button>`}</div></div>`,
      )
      .join("") || empty("暂无下级密钥");
}
const actionNames = {
  "vip.issue": "签发 VIP 卡密",
  "vip.redeem": "兑换 VIP",
  "vip.revoke": "撤销 VIP 权益",
  "user.ban": "封禁用户",
  "user.unban": "解除用户封禁",
  "user.remote-delete": "远程注销账号",
  "user.reset-password": "管理员重置用户密码",
  "user.register": "注册账号",
  "account.password": "用户修改密码",
  "account.delete": "注销账号",
  "device.migration": "设备迁移",
  "identity.rotate": "更换设备身份",
  "password.reset": "重置密码",
  "announcement.publish": "发布公告",
  "announcement.archive": "归档公告",
  "key.create": "创建面板访问密钥",
  "key.revoke": "撤销面板访问密钥",
  "platform-admin-code.create": "签发平台管理员授权码",
  "platform-admin-code.revoke": "撤销平台管理员授权码",
  "platform-admin.revoke": "撤销平台管理员身份",
  "platform-admin.redeem": "兑换平台管理员晋升码",
  "security.settings.update": "修改安全设置",
  "disclaimer.accept": "接受使用声明",
  "group.create": "创建群组",
  "group.delete": "解散群组",
  "group.settings": "修改群组设置",
  "group.join": "加入群组",
  "group.join-request": "申请入群",
  "group.join-approve": "批准入群",
  "group.join-reject": "拒绝入群",
  "group.member-add": "添加群成员",
  "group.member-remove": "移除群成员",
  "group.role": "调整群成员角色",
  "group.mute": "群禁言",
  "group.force-join": "平台公开加入群组",
  "message.remove": "移除群消息",
};
function actionName(value) {
  return actionNames[value] || value.replaceAll(".", " · ");
}
function actorName(value) {
  if (value === "root") return "蓝喵喵";
  const match = String(value).match(/^(key|user|platform-admin):(\d+)$/);
  if (!match) return String(value);
  const kinds = {
    key: "面板密钥",
    user: "用户",
    "platform-admin": "平台管理员",
  };
  return `${kinds[match[1]]}#${match[2]}`;
}
function auditPerson(row, kind) {
  const name = kind === "actor" ? row.actorName : row.targetName;
  const uuid = kind === "actor" ? row.actorUuid : row.targetUuid;
  if (!name && !uuid) return null;
  return { name: name || "未知用户", uuid };
}
function auditPersonHtml(row, kind) {
  const person = auditPerson(row, kind);
  if (!person) return null;
  const label = `${person.name}${person.uuid ? ` · ${person.uuid}` : ""}`;
  return person.uuid
    ? `<button type="button" class="audit-user" data-uuid="${escapeHtml(person.uuid)}" title="打开用户详情">${escapeHtml(label)}</button>`
    : escapeHtml(label);
}
function auditActorHtml(row) {
  if (row.actor === "root") return "蓝喵喵";
  return auditPersonHtml(row, "actor") || escapeHtml(row.actorLabel || row.actorKeyName || actorName(row.actor));
}
function auditTargetHtml(row) {
  return auditPersonHtml(row, "target") || escapeHtml(row.target || "未指定");
}
function auditDetails(value) {
  try {
    return JSON.stringify(JSON.parse(value || "{}"), null, 2);
  } catch {
    return String(value || "{}");
  }
}
function renderAudit() {
  const filter = $("#audit-filter")?.value || "all";
  const entries = state.auditEntries.filter(
    (row) =>
      filter === "all" ||
      (filter === "admin"
        ? /^(root|key:|platform-admin:)/.test(row.actor)
        : /^user:/.test(row.actor)),
  );
  $("#audit-count").textContent = `显示 ${entries.length} 条`;
  $("#audit-delete-all").hidden = !has("audit:read") || entries.length === 0;
  $("#audit-preview").innerHTML =
    state.auditEntries
      .slice(0, 3)
      .map(
        (row) =>
          `<div class="mini-row"><div class="mini-main"><strong>${escapeHtml(actionName(row.action))}</strong><span>操作者：${escapeHtml(row.actorLabel || actorName(row.actor))} · ${date(row.createdAt)}</span></div></div>`,
      )
      .join("") || empty("暂无审计记录");
  $("#audit").innerHTML =
    `<table><thead><tr><th>时间</th><th>操作者/凭据</th><th>具体操作</th><th>目标</th><th>来源 IP</th><th>详细内容</th><th>管理</th></tr></thead><tbody>${entries.map((row) => `<tr data-audit-id="${row.id}"><td>${date(row.createdAt)}</td><td>${auditActorHtml(row)}</td><td>${escapeHtml(actionName(row.action))}</td><td>${auditTargetHtml(row)}</td><td>${escapeHtml(row.ip || "未记录")}</td><td><pre class="audit-metadata">${escapeHtml(auditDetails(row.metadata))}</pre></td><td>${has("audit:read") ? `<button type="button" class="icon-button audit-delete" data-id="${row.id}" aria-label="删除此条日志" title="删除此条日志">${icon("trash")}</button>` : ""}</td></tr>`).join("")}</tbody></table>`;
}
async function loadAudit() {
  if (!has("audit:read")) return;
  const { entries } = await api("/api/admin/audit");
  state.auditEntries = entries;
  renderAudit();
}
async function openBannedUsers() {
  openDialog("#users-dialog");
  $("#users-dialog-title").textContent = "封禁用户名单";
  $("#dialog-search").value = "";
  const { users } = await api("/api/admin/users?banned=true");
  state.users = users;
  renderUserPreview();
  renderUsers();
}
async function openOverview(action) {
  const dialog = $("#overview-dialog");
  const title = $("#overview-dialog-title");
  const detail = $("#overview-detail");
  if (!state.overview) return;
  const data = state.overview;
  if (action === "users") {
    openDialog("#users-dialog");
    $("#users-dialog-title").textContent = "注册用户管理";
    loadUsers("");
    return;
  }
  if (action === "banned") {
    openBannedUsers().catch((error) => toast(error.message));
    return;
  }
  if (action === "vip") {
    openDialog("#vip-dialog");
    if (has("vip:issue")) loadVipTrace().catch(() => {});
    if (has("vip:revoke")) loadVipUsers().catch(() => {});
    return;
  }
  if (action === "admins") {
    openDialog("#moderators-dialog");
    loadModerators().catch((error) => toast(error.message));
    return;
  }
  if (action === "groups") {
    title.textContent = "群聊管理";
    detail.innerHTML = '<p class="muted">正在读取群聊…</p>';
    openDialog("#overview-dialog");
    try {
      const groups = await loadGroups();
      detail.innerHTML = `<div class="table-wrap"><table><thead><tr><th>群名称</th><th>群号</th><th>成员</th><th>群主</th><th>管理</th></tr></thead><tbody>${groups.map((group) => `<tr><td>${escapeHtml(group.name)}</td><td><code>${escapeHtml(group.publicNumber || group.id)}</code></td><td>${group.memberCount} 人</td><td>${escapeHtml(group.ownerName)}<small>${escapeHtml(group.ownerUuid)}</small></td><td>${has("groups:manage") ? `<button type="button" class="secondary-button force-join-group" data-number="${escapeHtml(group.publicNumber || group.id)}">管理员进群</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>`;
    } catch (error) { detail.innerHTML = empty(error.message); }
    return;
  }
  title.textContent =
    action === "uptime"
      ? "服务器运行时间详情"
      : action === "health"
        ? "服务器运行状态详情"
        : action === "online"
          ? "在线用户详情"
          : "服务器详细信息";
  detail.innerHTML =
    action === "uptime"
      ? `<dl class="private-grid"><div><dt>服务状态</dt><dd>${escapeHtml(data.status === "ok" ? "运行正常" : "状态异常")}</dd></div><div><dt>启动时间</dt><dd>${date(data.startedAt)}</dd></div><div><dt>已运行</dt><dd>${formatUptime(data.uptimeSeconds)}</dd></div><div><dt>在线用户</dt><dd>${data.onlineUsers}</dd></div></dl>`
      : action === "health"
        ? `<dl class="private-grid"><div><dt>服务状态</dt><dd>${escapeHtml(data.status === "ok" ? "运行正常" : "状态异常")}</dd></div><div><dt>服务启动时间</dt><dd>${date(data.startedAt)}</dd></div><div><dt>当前在线连接</dt><dd>${data.onlineUsers}</dd></div></dl>`
        : action === "online"
          ? `<dl class="private-grid"><div><dt>当前在线用户</dt><dd>${data.onlineUsers}</dd></div><div><dt>注册用户</dt><dd>${data.registeredUsers}</dd></div></dl>`
          : "";
  openDialog("#overview-dialog");
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  setBusy(event.currentTarget, true);
  try {
    await login($("#admin-key").value);
  } catch (error) {
    lock();
    $("#login-error").textContent = error.message;
  } finally {
    setBusy(event.currentTarget, false);
  }
});
$("#lock").addEventListener("click", lock);
$("#refresh").addEventListener("click", async () => {
  stopPolling();
  await refreshLive();
  toast("概览已刷新");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshLive();
  else stopPolling();
});
$$(".dialog-close").forEach((button) =>
  button.addEventListener("click", () => button.closest("dialog").close()),
);
$$("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }),
);
$("#user-dialog")?.addEventListener("close", () => {
  clearInterval(state.geoTimer);
  state.geoTimer = null;
  state.currentUserUuid = null;
});
$("#open-users").addEventListener("click", () => {
  openDialog("#users-dialog");
  $("#dialog-search").focus();
});
$("#open-vip").addEventListener("click", () => {
  openDialog("#vip-dialog");
  if (has("vip:issue")) loadVipTrace().catch(() => {});
  if (has("vip:revoke")) loadVipUsers().catch(() => {});
});
$("#open-moderators").addEventListener("click", async () => {
  openDialog("#moderators-dialog");
  await loadModerators();
});
$("#open-announcements").addEventListener("click", () =>
  openDialog("#announcements-dialog"),
);
$("#open-keys").addEventListener("click", () => openDialog("#keys-dialog"));
$("#open-releases").addEventListener("click", () => {
  openDialog("#releases-dialog");
  loadReleases().catch(() => {});
});
$("#release-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  try {
    const file = $("#release-apk").files[0];
    if (!file) return toast("请选择 APK 文件");
    if (!/\.apk$/i.test(file.name)) return toast("只能发布 APK 文件");
    if (file.size > 25 * 1024 * 1024)
      return toast("APK 文件不能超过 25MB");
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize)
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    const apkBase64 = btoa(binary);
    const result = await api("/api/admin/releases", {
      method: "POST",
      body: JSON.stringify({
        versionName: $("#release-version-name").value,
        versionCode: Number($("#release-version-code").value),
        fileName: file.name,
        notes: $("#release-notes").value,
        forceUpdate: $("#release-force").checked,
        apkBase64,
      }),
    });
    event.currentTarget.reset();
    await loadReleases();
    toast(`版本 v${result.versionName} 已发布`);
    setTimeout(() => {
      $("#releases-dialog").close();
      location.reload();
    }, 700);
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(event.currentTarget, false);
  }
});
$("#open-audit").addEventListener("click", () => openDialog("#audit-dialog"));
$("#audit-filter").addEventListener("change", renderAudit);
$("#audit-delete-all").addEventListener("click", async () => {
  if (!has("audit:read") || !(await confirmAction("确定清空全部审计日志吗？此操作无法恢复。", "清空审计日志"))) return;
  try {
    await api("/api/admin/audit", { method: "DELETE" });
    await loadAudit();
    toast("审计日志已清空");
  } catch (error) {
    toast(error.message);
  }
});
$("#confirm-cancel").addEventListener("click", () => settleConfirmation(false));
$("#confirm-submit").addEventListener("click", () => settleConfirmation(true));
$("#audit").addEventListener("contextmenu", async (event) => {
  const row = event.target.closest("tr[data-audit-id]");
  if (!row || !has("audit:read")) return;
  event.preventDefault();
  if (!(await confirmAction("确定删除这条审计日志吗？此操作无法恢复。", "删除单条日志"))) return;
  await api(`/api/admin/audit/${encodeURIComponent(row.dataset.auditId)}`, { method: "DELETE" });
  await loadAudit();
  toast("审计日志已删除");
});
$("#audit").addEventListener("click", async (event) => {
  const button = event.target.closest(".audit-delete");
  if (!button || !has("audit:read")) return;
  event.preventDefault();
  event.stopPropagation();
  if (!(await confirmAction("确定删除这条审计日志吗？此操作无法恢复。", "删除单条日志"))) return;
  try {
    await api(`/api/admin/audit/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
    await loadAudit();
    toast("审计日志已删除");
  } catch (error) {
    toast(error.message);
  }
});
$$(".stat-clickable").forEach((card) => {
  const open = () => void openOverview(card.dataset.statAction);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
});

async function submitSearch(event, input) {
  event.preventDefault();
  const value = $(input).value;
  $("#search").value = value;
  $("#dialog-search").value = value;
  try {
    await loadUsers(value);
    if (input === "#search") openDialog("#users-dialog");
  } catch (error) {
    toast(error.message);
  }
}
$("#search-form").addEventListener("submit", (event) =>
  submitSearch(event, "#search"),
);
$("#dialog-search-form").addEventListener("submit", (event) =>
  submitSearch(event, "#dialog-search"),
);
$("#vip-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await issueVip(
    event.currentTarget,
    $("#vip-duration").value,
    Number($("#vip-count").value),
    null,
    null,
    "#vip-output",
  );
});
function chooseDuration(picker, value, label) {
  const input =
    picker.id === "vip-duration-picker"
      ? $("#vip-duration")
      : $("#vip-center-duration");
  const labelNode =
    picker.id === "vip-duration-picker"
      ? $("#vip-duration-label")
      : $("#vip-center-duration-label");
  input.value = value;
  labelNode.textContent = label;
  picker.removeAttribute("open");
  if (picker.id === "vip-center-duration-picker") {
    const custom = value === "custom";
    $("#vip-custom-fields").hidden = !custom;
    if (custom) {
      $("#vip-custom-value").focus();
      $("#vip-custom-unit").value = "seconds";
    }
  }
}
$$(".duration-picker").forEach((picker) =>
  $$("[data-duration]", picker).forEach((button) =>
    button.addEventListener("click", () =>
      chooseDuration(picker, button.dataset.duration, button.textContent),
    ),
  ),
);
$("#vip-custom-unit").innerHTML =
  '<option value="seconds">秒</option><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option>';
$("#vip-custom-value").min = "1";
$("#vip-custom-value").max = "3153600000";
$("#vip-custom-value").step = "1";
$("#vip-custom-value").value = "3600";
$("#vip-center-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await issueVip(
    event.currentTarget,
    $("#vip-center-duration").value,
    Number($("#vip-center-count").value),
    Number($("#vip-custom-value").value),
    $("#vip-custom-unit").value,
    "#vip-center-output",
  );
});
$("#vip-copy-all").addEventListener("click", () =>
  copyText($("pre", $("#vip-center-output")).textContent, "全部激活码已复制"),
);
$("#vip-download").addEventListener("click", () => {
  const text = $("pre", $("#vip-center-output")).textContent;
  if (!text || text.length > 100000) return toast("没有可下载的安全文本结果");
  const blob = new Blob([`${text}\n`], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `lanmiao-vip-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast("文本文件已生成");
});
$("#announcement-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  try {
    await api("/api/admin/announcements", {
      method: "POST",
      body: JSON.stringify({
        title: $("#announcement-title").value,
        body: $("#announcement-body").value,
        confirmRequired: $("#announcement-confirm").checked,
      }),
    });
    event.currentTarget.reset();
    await loadAnnouncements();
    toast("公告已发布");
    setTimeout(() => location.reload(), 700);
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(event.currentTarget, false);
  }
});
$("#moderator-code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  try {
    const value = $("#moderator-code-expiry").value;
    const { codes } = await api("/api/admin/platform-admin-codes", {
      method: "POST",
      body: JSON.stringify({
        count: Number($("#moderator-code-count").value),
        expiresAt: value ? new Date(value).getTime() : null,
      }),
    });
    setOutput("#moderator-code-output", codes.join("\n"));
    await loadModerators();
    toast("晋升码已生成，仅显示一次");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(event.currentTarget, false);
  }
});
$("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(event.currentTarget, true);
  const scopes = $$("[name=scope]:checked").map((node) => node.value);
  try {
    const result = await api("/api/admin/keys", {
      method: "POST",
      body: JSON.stringify({ name: $("#key-name").value, scopes }),
    });
    setOutput("#key-output", result.key);
    event.currentTarget.reset();
    await loadKeys();
    toast("密钥已生成，仅显示一次");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(event.currentTarget, false);
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.matches("[data-copy]"))
      await copyText(target.dataset.copy, "UUID 已复制");
    if (target.matches(".copy-output"))
      await copyText($("pre", target.parentElement).textContent);
    if (target.matches(".recent-vip-copy")) {
      const item = state.vipRecent.find(
        (entry) => String(entry.index) === target.dataset.index,
      );
      if (item) await copyText(item.codes.join("\n"), "该批激活码已复制");
    }
    if (target.matches(".force-join-group")) {
      const userUuid = window.prompt("输入要强制加入此群的平台管理员 App 账号 UUID", "")?.trim();
      if (!userUuid) return;
      await api(`/api/admin/groups/${encodeURIComponent(target.dataset.number)}/force-join`, { method: "POST", body: JSON.stringify({ userUuid }) });
      toast("平台管理员账号已加入群聊，可在 App 内进行日常管理");
      await openOverview("groups");
    }
    if (target.matches(".user-more") || target.matches(".user-chevron")) {
      const wrap = target.closest(".user-menu-wrap");
      const menu = target.matches(".user-more")
        ? $(".more-menu", wrap)
        : $(".chevron-menu", wrap);
      const shouldOpen = menu.hidden;
      $$(".user-menu").forEach((other) => (other.hidden = true));
      menu.hidden = !shouldOpen;
      if (shouldOpen) {
        const rect = target.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const top = Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 8);
        const left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
        menu.style.top = `${Math.max(8, top)}px`;
        menu.style.left = `${left}px`;
        menu.style.right = "auto";
      }
      return;
    }
    if (target.matches(".user-open")) {
      const item = target.closest(".user-item");
      await openUserDialog(item.dataset.uuid);
      return;
    }
    if (target.matches(".audit-user")) {
      await openUserDialog(target.dataset.uuid);
      return;
    }
    if (target.matches(".ban-user")) {
      const uuid = target.dataset.uuid;
      const banning = target.dataset.banned === "true";
      let reason = "";
      let durationSeconds = null;
      if (banning) {
        const entered = window.prompt("请输入封禁原因（可选，最长 300 字）");
        if (entered === null) return toast("已取消封禁");
        reason = entered.trim() || "管理操作";
        const duration = window.prompt("请输入封禁时长：1d=1天，24h=24小时，1440m=1440分钟；留空为永久", "1d");
        if (duration === null) return toast("已取消封禁");
        if (duration.trim()) {
          const match = duration.trim().toLowerCase().match(/^(\d+)\s*([dhm]?)$/);
          if (!match) return toast("时长格式错误，请输入 1d、24h 或 1440m");
          const value = Number(match[1]);
          durationSeconds = value * (match[2] === "d" ? 86400 : match[2] === "h" ? 3600 : 60);
          if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 3153600000) return toast("封禁时长必须至少为 1 分钟");
        }
      }
      await api(`/api/admin/users/${encodeURIComponent(uuid)}/ban`, {
        method: "POST",
        body: JSON.stringify({ banned: banning, reason, durationSeconds }),
      });
      await Promise.all([loadUsers(), refreshLive()]);
      toast(banning ? "用户已封禁" : "用户已解除封禁");
    }
    if (
      target.matches(".revoke-user-vip") ||
      target.matches(".revoke-vip-user")
    ) {
      const uuid = target.dataset.uuid;
      if (!window.confirm("确定撤销该用户的 VIP 权益吗？VIP 将立即失效喵"))
        return;
      await api(`/api/admin/users/${encodeURIComponent(uuid)}/revoke-vip`, {
        method: "POST",
        body: "{}",
      });
      await Promise.all([loadUsers(), refreshLive()]);
      if (has("vip:revoke")) loadVipUsers().catch(() => {});
      toast("该用户 VIP 权益已撤销");
    }
    if (target.matches(".copy-user-password")) {
      const password = target.dataset.value;
      if (password) await copyText(password, "密码已复制");
    }
    if (target.matches(".remote-delete-user")) {
      const typed = window.prompt(
        "远程注销将删除该账号全部资料、联系人、群聊和密文队列，无法恢复。请输入「确认注销」继续",
      );
      if (typed === null) return toast("已取消远程注销");
      if (typed !== "确认注销") return toast("输入内容不正确，已取消远程注销");
      await api(
        `/api/admin/users/${encodeURIComponent(target.dataset.uuid)}/delete`,
        { method: "POST", body: "{}" },
      );
      $("#user-dialog")?.close();
      await Promise.all([loadUsers(), refreshLive()]);
      toast("账号已远程注销");
    }
    if (target.matches(".trace-vip")) {
      await openVipTrace(target.dataset.id);
    }
    if (target.matches(".revoke-admin")) {
      await api(
        `/api/admin/platform-admins/${encodeURIComponent(target.dataset.uuid)}/revoke`,
        { method: "POST", body: "{}" },
      );
      await Promise.all([loadModerators(), refreshLive()]);
      toast("平台管理员角色已撤销");
    }
    if (target.matches(".revoke-code")) {
      if (target.disabled) return;
      target.disabled = true;
      try {
        await api(`/api/admin/platform-admin-codes/${target.dataset.id}/revoke`, {
          method: "POST",
          body: "{}",
        });
        toast("晋升码已撤销");
      } catch (error) {
        toast(error.message);
      } finally {
        await loadModerators();
      }
      return;
    }
    if (target.matches(".archive")) {
      await api(`/api/admin/announcements/${target.dataset.id}/archive`, {
        method: "POST",
        body: "{}",
      });
      await loadAnnouncements();
      toast("公告已归档");
    }
    if (target.matches(".revoke-key")) {
      await api(`/api/admin/keys/${target.dataset.id}/revoke`, {
        method: "POST",
        body: "{}",
      });
      await loadKeys();
      toast("密钥已撤销");
    }
    if (target.matches(".archive-release")) {
      if (!(await confirmAction("确定归档该版本并删除其 APK 文件吗？下载链接将立即失效。", "归档版本"))) return;
      await api(`/api/admin/releases/${target.dataset.id}/archive`, {
        method: "POST",
        body: "{}",
      });
      await loadReleases();
      toast("版本已归档");
    }
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".user-menu-wrap"))
    $$(".user-menu").forEach((menu) => (menu.hidden = true));
});

if (state.key) login(state.key).catch(lock);
