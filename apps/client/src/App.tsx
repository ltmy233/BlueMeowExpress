// 蓝喵速递客户端主组件：全部页面、状态管理、设置、通话
import { Component, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import {
  ArrowLeft,
  BadgeCheck,
  Ban,
  Bell,
  BellOff,
  BellRing,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Copy,
  Download,
  ContactRound,
  Crown,
  FileImage,
  Info,
  KeyRound,
  Link,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageCircle,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pause,
  Pin,
  PenLine,
  Phone,
  PhoneOff,
  Plus,
  Play,
  Search,
  Send,
  Reply,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  UserPlus,
  Users,
  Video,
  X,
  PaintBucket,
  Database,
  Lock,
  Clock,
  AtSign,
  Volume2,
} from "lucide-react";
import {
  ApiClient,
  ApiError,
  APP_VERSION_CODE,
  APP_VERSION_NAME,
  MessagingSocket,
  type AccountBanNotice,
  type Session,
  type SocketEvent,
} from "./api/client";
import { cacheServerAttachment, clearAttachmentCache, loadCachedAttachment } from "./lib/attachments";
import {
  decryptEnvelope,
  encryptEnvelope,
  exportPublicIdentity,
} from "./lib/crypto";
import { clearSession, loadSession, saveSession } from "./lib/session";
import { getPinHash, verifyPin } from "./lib/pin";
import { clearPin, setPin } from "./lib/pin";
import { VoiceCallManager, type CallResult, type CallState } from "./lib/call";
import { loadAppearance, saveAppearance, type AppearanceSettings } from "./lib/appearance";
import { loadUnread, saveUnread } from "./lib/unread";
import { appendHistory, loadHistory, recallHistory, removeHistory, tombstoneHistory } from "./lib/history";
import { conversationAppearance, defaultPreferences, loadPreferences, savePreferences, type AppPreferences, type ConversationAppearance } from "./lib/preferences";
import { useBackground } from "./context/BackgroundContext";
import SlideTransition from "./components/SlideTransition";
import { isValidEmail, validateAttachment } from "./lib/validation";
import type {
  Announcement,
  AttachmentMeta,
  ChatMessage,
  Contact,
  Conversation,
  Disclaimer,
  Gender,
  GroupJoinInfo,
  GroupMember,
  GroupSettings,
  JoinRequest,
  StatusUpdate,
  UserProfile,
} from "./types";

type Tab = "messages" | "statuses" | "contacts" | "announcements" | "profile";
type Sheet =
  | "new-group"
  | "join-group"
  | "settings"
  | "vip"
  | "edit-profile"
  | "attachments"
  | "cache-confirm"
  | "add-contact"
  | "requests"
  | "group-settings"
  | "contact-settings"
  | "update"
  | null;

const api = new ApiClient();
const socket = new MessagingSocket();
const SETTINGS_BACK_EVENT = "lanmiao-settings-back";

const displayName = (contact: Pick<Contact, "name" | "remark">) => contact.remark || contact.name;
const alphabetic = (a: string, b: string) => a.localeCompare(b, "zh-CN", { sensitivity: "base", numeric: true });

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; message: string }> {
  state = { failed: false, message: "" };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.setState({ message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) });
  }
  render() {
    if (this.state.failed)
      return (
        <div className="crash-screen">
          <h2>界面加载出错</h2>
          <pre className="crash-detail">{this.state.message || "未知错误"}</pre>
          <button className="primary-button" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      );
    return this.props.children;
  }
}

function AppSplash() {
  return <div className="app-splash"><div className="splash-icon"><img src="/app-icon.png" alt="蓝喵速递" /></div><strong>蓝喵速递</strong><span>LANMIAO EXPRESS</span></div>;
}
const avatarColors = ["#ec4899", "#db2777", "#16a34a", "#9d174d"];
const messageTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const vipTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
const errorText = (cause: unknown) => {
  let message =
    cause instanceof Error ? cause.message : "请求失败，请稍后重试";
  const friendly: Array<[RegExp, string]> = [
    [/failed to fetch|fetch failed|networkerror|load failed|err_/i, "网络连接失败，请检查网络后重试"],
    [/timeout|timed out/i, "请求超时，请稍后重试"],
  ];
  for (const [pattern, text] of friendly) {
    if (pattern.test(message)) {
      message = text;
      break;
    }
  }
  return `主人，${message.replace(/^主人[，,]?\s*/, "").replace(/[喵。！!]$/, "")}喵`;
};
const vipCardType = (seconds?: number) => seconds === undefined || seconds === -1 ? "永久卡" : seconds < 86400 ? "临时卡" : `${Math.floor(seconds / 86400)} 天卡`;

async function copyText(value: string) {
  try { await navigator.clipboard.writeText(value); return; } catch { /* Use the legacy WebView fallback. */ }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("复制失败，请长按文字手动复制");
}

function Avatar({
  name,
  size = "medium",
  image,
}: {
  name: string;
  size?: "small" | "medium" | "large";
  image?: string;
}) {
  const color = avatarColors[(name.charCodeAt(0) || 0) % avatarColors.length];
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{
        backgroundColor: image ? undefined : color,
        backgroundImage: image ? `url(${image})` : undefined,
      }}
    >
      {image ? "" : name.slice(-2)}
    </span>
  );
}

function MediaAttachment({ attachment }: { attachment: AttachmentMeta }) {
  const [url, setUrl] = useState(attachment.localUrl ?? "");
  const [thumbnail, setThumbnail] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [downloadState, setDownloadState] = useState("");
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioSeconds, setAudioSeconds] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    void (async () => {
      try {
        const cached = await loadCachedAttachment(attachment.id);
        const resolved = cached ?? await cacheServerAttachment(attachment, await api.downloadAttachment(attachment.id));
        objectUrl = resolved.localUrl ?? "";
        if (active) setUrl(objectUrl);
      } catch (cause) {
        if (active) setError(errorText(cause));
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id]);
  const image = attachment.mime.startsWith("image/");
  const audio = attachment.mime.startsWith("audio/");
  const toggleAudio = async () => {
    const player = audioRef.current;
    if (!player || !url) return;
    if (player.paused) await player.play().catch(() => setError("语音播放失败"));
    else player.pause();
  };
  useEffect(() => {
    if (!url || image || audio) return;
    let active = true;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onloadedmetadata = () => { video.currentTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration / 2 : 0.1); };
    video.onseeked = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (active) setThumbnail(canvas.toDataURL("image/jpeg", 0.76));
    };
    video.src = url;
    return () => { active = false; video.removeAttribute("src"); video.load(); };
  }, [url, image]);
  const download = async () => {
    if (!url) return;
    setDownloadState("正在保存...");
    try {
      const blob = await fetch(url).then((response) => response.blob());
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsDataURL(blob);
      });
      if (Capacitor.isNativePlatform()) {
        await Filesystem.writeFile({ path: `蓝喵速递/${Date.now()}-${attachment.name.replace(/[\\/:*?"<>|]/g, "_")}`, data, directory: Directory.Documents, recursive: true });
      } else {
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = attachment.name; anchor.click();
      }
      setDownloadState("已保存到文档/蓝喵速递");
    } catch (cause) { setDownloadState(errorText(cause)); }
  };
  return <>
    <button type="button" className="media-message" onClick={() => { if (audio) void toggleAudio(); else if (url) setPreview(true); }} disabled={!url}>
      {url ? image ? <img className="bubble-image" src={url} alt={attachment.name} /> : audio ? <span className={`audio-bubble ${audioPlaying ? "playing" : ""}`}>{audioPlaying ? <Pause /> : <Play />}<span className="audio-wave"><i /><i /><i /><i /><i /><i /><i /><i /></span><strong>{audioPlaying ? `${audioSeconds}s` : "语音消息"}</strong><audio ref={audioRef} src={url} preload="metadata" onPlay={() => setAudioPlaying(true)} onPause={() => setAudioPlaying(false)} onEnded={() => { setAudioPlaying(false); setAudioSeconds(0); }} onTimeUpdate={(event) => setAudioSeconds(Math.floor(event.currentTarget.currentTime))} /></span> : thumbnail ? <img className="bubble-video" src={thumbnail} alt={`${attachment.name} 视频缩略图`} /> : <video className="bubble-video" src={url} muted playsInline preload="auto" /> : <span className="media-loading"><LoaderCircle className="spin" />{error || "正在接收附件..."}</span>}
      {!image && !audio && <span className="video-caption"><Video />{attachment.name}<small>{formatBytes(attachment.size)}</small></span>}
    </button>
    {preview && url && !audio && createPortal(<div className="media-preview" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={() => setPreview(false)}>
      <div className="media-preview-toolbar" onClick={(event) => event.stopPropagation()}>
        <IconButton label="关闭预览" onClick={() => setPreview(false)}><X /></IconButton>
        {downloadState && <span>{downloadState}</span>}
        <IconButton label="下载原文件" onClick={() => void download()}><Download /></IconButton>
      </div>
      {image ? <img src={url} alt={attachment.name} onClick={(event) => event.stopPropagation()} /> : <video src={url} controls autoPlay playsInline onClick={(event) => event.stopPropagation()} />}
    </div>, document.body)}
  </>;
}
const vipDurationText = (seconds: number) => seconds === -1 ? '永久' : seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时` : `${Math.floor(seconds / 86400)} 天`;

function IconButton({
  label,
  children,
  onClick,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MigrationModal({
  email,
  onClose,
  onMigrated,
}: {
  email: string;
  onClose: () => void;
  onMigrated: (session: Session) => Promise<void>;
}) {
  const [accountEmail, setAccountEmail] = useState(email);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(
      () => setCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [cooldown]);
  const send = async () => {
    if (!isValidEmail(accountEmail))
      return setError("主人，请输入有效的邮箱地址喵");
    if (password.length < 10) return setError("主人，请输入账号密码喵");
    if (cooldown)
      return setError(`主人，请等待 ${cooldown} 秒后再获取验证码喵`);
    setBusy(true);
    setError("");
    try {
      await api.requestDeviceMigrationCode(
        accountEmail.trim(),
        password,
        await exportPublicIdentity(),
      );
      setSent(true);
      setCooldown(60);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const migrate = async () => {
    if (!/^\d{6}$/.test(code)) return setError("主人，请输入 6 位迁移验证码喵");
    setBusy(true);
    setError("");
    try {
      await onMigrated(
        await api.migrateDevice(
          accountEmail.trim(),
          code,
          await exportPublicIdentity(),
        ),
      );
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <Modal title="设备迁移" onClose={onClose}>
      <div className="modal-content">
        <p className="setting-note">
          主人，当前账号已绑定其他设备身份。验证码会发送到注册邮箱，确认后本设备接管账号，旧设备身份将失效喵
        </p>
        <label>
          注册邮箱
          <input
            type="text"
            inputMode="email"
            value={accountEmail}
            onChange={(e) => setAccountEmail(e.target.value)}
            placeholder="输入注册邮箱"
          />
        </label>
        <label>
          账号密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入账号密码"
          />
        </label>
        <label>
          迁移验证码
          <span className="inline-field">
            <input
              className="code-input"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
            />
            <button
              type="button"
              className="outline-button"
              disabled={busy || cooldown > 0}
              onClick={() => void send()}
            >
              {cooldown > 0
                ? `${cooldown} 秒后重发`
                : sent
                  ? "重新发送"
                  : "获取验证码"}
            </button>
          </span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <button
          className="primary-button"
          disabled={busy || !sent || !/^\d{6}$/.test(code)}
          onClick={() => void migrate()}
        >
          <BadgeCheck />
          确认迁移并登录
        </button>
      </div>
    </Modal>
  );
}

function AuthScreen({
  onAuthenticated,
}: {
  onAuthenticated: (session: Session) => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [forgotCooldown, setForgotCooldown] = useState(0);
  const [forgotSent, setForgotSent] = useState(false);
  const [resetPassword, setResetPassword] = useState("");
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState("");
  const [resetSuccess, setResetSuccess] = useState("");
  const [migrateEmail, setMigrateEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!forgotCooldown) return;
    const timer = window.setInterval(
      () => setForgotCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [forgotCooldown]);

  const sendResetCode = async () => {
    if (!isValidEmail(email)) return setError("主人，请输入有效的邮箱地址喵");
    if (forgotCooldown) return;
    setBusy(true);
    setError("");
    try {
      await api.requestPasswordResetCode(email.trim());
      setForgotSent(true);
      setForgot(true);
      setCode("");
      setForgotCooldown(60);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const submitReset = async () => {
    if (!/^\d{6}$/.test(code)) return setError("主人，请输入 6 位验证码喵");
    if (resetPassword.length < 10) return setError("主人，新密码至少需要 10 位喵");
    if (resetPassword !== resetPasswordConfirm) return setError("主人，两次输入的新密码不一致喵");
    setBusy(true);
    setError("");
    try {
      await api.resetPassword(email.trim(), code, resetPassword);
      setForgot(false);
      setForgotSent(false);
      setCode("");
      setResetPassword("");
      setResetPasswordConfirm("");
      setResetSuccess("密码已重置，请使用新密码登录喵");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!email.trim()) {
      setCooldown(0);
      return;
    }
    const key = `lanmiao-code-cooldown:${email.trim().toLowerCase()}`;
    const update = () =>
      setCooldown(
        Math.max(
          0,
          Math.ceil(
            (Number(localStorage.getItem(key) ?? 0) - Date.now()) / 1000,
          ),
        ),
      );
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [email]);

  const requestCode = async () => {
    if (!isValidEmail(email)) return setError("主人，请输入有效的邮箱地址喵");
    setBusy(true);
    setError("");
    if (cooldown > 0)
      return setError(`主人，请等待 ${cooldown} 秒后再获取验证码喵`);
    try {
      await api.requestRegistrationCode(email.trim());
      setCodeSent(true);
      const key = `lanmiao-code-cooldown:${email.trim().toLowerCase()}`;
      localStorage.setItem(key, String(Date.now() + 60_000));
      setCooldown(60);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isValidEmail(email)) return setError("主人，请输入有效的邮箱地址喵");
    if (password.length < 10) return setError("主人，密码至少需要 10 位喵");
    if (mode === "register" && !name.trim())
      return setError("主人，还没有填写昵称喵");
    if (mode === "register" && !codeSent)
      return setError("主人，请先获取邮箱验证码喵");
    if (mode === "register" && !/^\d{6}$/.test(code))
      return setError("主人，请输入 6 位注册验证码喵");
    setBusy(true);
    setError("");
    try {
      const identity = await exportPublicIdentity();
      const session =
        mode === "login"
          ? await api.login({ email: email.trim(), password, identity })
          : await (async () => {
              const disclaimer = await api.getDisclaimer();
              return api.register({
                email: email.trim(),
                code,
                password,
                name: name.trim(),
                identity,
                disclaimerVersion: disclaimer.version,
              });
            })();
      await onAuthenticated(session);
    } catch (cause) {
      if (
        mode === "login" &&
        cause instanceof ApiError &&
        cause.code === "DEVICE_BOUND"
      ) {
        setMigrateEmail(email.trim());
        setError("");
      } else setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <main className="auth-page">
        <section className="cover-panel" aria-label="蓝喵速递">
          <div className="cover-shade" />
          <div className="cover-copy">
            <span className="brand-mark">蓝</span>
            <h1>蓝喵速递</h1>
            <p>主人，悄悄话会被认真送到该看到的人手里喵</p>
          </div>
        </section>
        <section className="auth-panel">
          <div className="auth-inner">
            {forgot ? (
              <div className="auth-recovery">
                <div className="auth-heading">
                  <span className="eyebrow">账号恢复</span>
                  <h2>忘记密码</h2>
                  <p>验证码已发送到 {email.trim()}，设置新密码后返回登录喵</p>
                </div>
                <form onSubmit={(e) => e.preventDefault()}>
                    <label>
                      验证码
                      <span className="inline-field">
                        <input
                          className="code-input"
                          inputMode="numeric"
                          maxLength={6}
                          value={code}
                          onChange={(e) =>
                            setCode(e.target.value.replace(/\D/g, ""))
                          }
                          placeholder="000000"
                        />
                        <button
                          type="button"
                          className="outline-button"
                          disabled={busy || forgotCooldown > 0}
                          onClick={() => void sendResetCode()}
                        >
                          {forgotCooldown > 0
                            ? `${forgotCooldown} 秒后重发`
                            : forgotSent
                              ? "重新发送"
                              : "获取验证码"}
                        </button>
                      </span>
                    </label>
                    <label>新密码<input type="password" autoComplete="new-password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="至少 10 位" /></label>
                    <label>确认新密码<input type="password" autoComplete="new-password" value={resetPasswordConfirm} onChange={(e) => setResetPasswordConfirm(e.target.value)} placeholder="再次输入新密码" /></label>
                    {error && <p className="form-error">{error}</p>}
                    <button
                      className="primary-button"
                      disabled={
                        busy ||
                        !forgotSent ||
                        !/^\d{6}$/.test(code) || !resetPassword || resetPassword !== resetPasswordConfirm
                      }
                      onClick={() => void submitReset()}
                    >
                      {busy ? <LoaderCircle className="spin" /> : <KeyRound />}
                      重置密码
                    </button>
                </form>
                <button type="button" className="text-button" onClick={() => { setForgot(false); setError(""); }}>
                  返回登录
                </button>
              </div>
            ) : (
              <>
                <div className="auth-heading">
                  <span className="eyebrow">身份验证</span>
              <h2>{mode === "login" ? "欢迎回来，主人" : "创建你的账号"}</h2>
              <p>
                {mode === "login"
                  ? "邮箱和密码准备好，就带主人回到消息里喵"
                  : "主人，验证邮箱后就可以开始安全通信喵"}
              </p>
            </div>
            {resetSuccess && <p className="transfer-state">{resetSuccess}</p>}
            <div className="segmented">
              <button
                type="button"
                className={mode === "login" ? "active" : ""}
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
              >
                登录
              </button>
              <button
                type="button"
                className={mode === "register" ? "active" : ""}
                onClick={() => {
                  setMode("register");
                  setError("");
                }}
              >
                注册
              </button>
            </div>
            <form onSubmit={submit}>
              {mode === "register" && (
                <label>
                  昵称
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    placeholder="主人想被怎样称呼"
                  />
                </label>
              )}
              <label>
                邮箱
                <input
                  type="text"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="输入主人常用的邮箱地址"
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  placeholder="至少 10 位"
                />
              </label>
              {mode === "register" && (
                <label>
                  邮箱验证码
                  <span className="inline-field">
                    <input
                      className="code-input"
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, ""))
                      }
                      placeholder="000000"
                    />
                    <button
                      type="button"
                      className="outline-button"
                      disabled={busy || cooldown > 0}
                      onClick={requestCode}
                    >
                      {cooldown > 0
                        ? `${cooldown} 秒后重发`
                        : codeSent
                          ? "重新发送"
                          : "获取验证码"}
                    </button>
                  </span>
                </label>
              )}
              {error && <p className="form-error">{error}</p>}
              <button
                className="primary-button"
                disabled={
                  busy ||
                  (mode === "register" && (!codeSent || !/^\d{6}$/.test(code)))
                }
                type="submit"
              >
                {busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}
                {mode === "login" ? "安全登录" : "完成注册"}
              </button>
            </form>
            {mode === "login" && (
              <button type="button" className="text-button" disabled={busy} onClick={() => void sendResetCode()}>
                忘记密码
              </button>
            )}
            <p className="security-note">
              <LockKeyhole /> 主人的身份私钥只留在当前设备中喵
            </p>
              </>
        )}
      </div>
        </section>
      </main>
      {migrateEmail !== null && (
        <MigrationModal
          email={migrateEmail}
          onClose={() => setMigrateEmail(null)}
          onMigrated={onAuthenticated}
        />
      )}
    </>
  );
}

function DisclaimerGate({
  disclaimer,
  onAccept,
}: {
  disclaimer: Disclaimer;
  onAccept: () => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className="gate-page">
      <section className="gate-document">
        <span className="eyebrow">首次使用确认 · {disclaimer.version}</span>
        <h1>{disclaimer.title}</h1>
        <time>{messageTime(disclaimer.publishedAt)}</time>
        <div className="disclaimer-copy">{disclaimer.content}</div>
        <label className="accept-row">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>主人已阅读并明确接受以上内容喵</span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <button
          className="primary-button"
          disabled={!checked || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onAccept();
            } catch (cause) {
              setError(errorText(cause));
              setBusy(false);
            }
          }}
        >
          {busy ? <LoaderCircle className="spin" /> : <Check />}接受并进入
        </button>
      </section>
    </main>
  );
}

function Header({
  title,
  subtitle,
  back,
  actions,
  centered = false,
}: {
  title: string;
  subtitle?: string;
  back?: () => void;
  actions?: React.ReactNode;
  centered?: boolean;
}) {
  return (
    <header className={`app-header ${centered ? "centered" : ""}`}>
      {back && (
        <IconButton label="返回" onClick={back}>
          <ArrowLeft />
        </IconButton>
      )}
      <div className="header-title">
        <h1>{title}</h1>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="header-actions">{actions}</div>
    </header>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <MessageCircle />
      <p>{children}</p>
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = options.find((option) => option.value === value);
  return (
    <div className={`custom-select ${open ? "open" : ""} ${disabled ? "disabled" : ""}`}>
      <span className="custom-select-label">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span>{active?.label ?? "请选择"}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="custom-select-menu">
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              className={option.value === value ? "active" : ""}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  );
}

const chatColorOptions = [
  { value: "#ec4899", label: "樱花粉" },
  { value: "#db2777", label: "玫红" },
  { value: "#be185d", label: "莓果" },
  { value: "#f472b6", label: "浅粉" },
  { value: "#8b5cf6", label: "紫罗兰" },
  { value: "#6366f1", label: "靛蓝" },
  { value: "#0891b2", label: "湖蓝" },
  { value: "#16a34a", label: "青绿" },
];

function ChatColorPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="chat-color-picker" role="radiogroup" aria-label="聊天颜色">
      {chatColorOptions.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value.toLowerCase() === option.value.toLowerCase() ? "active" : ""}
          role="radio"
          aria-checked={value.toLowerCase() === option.value.toLowerCase()}
          aria-label={option.label}
          title={option.label}
          style={{ "--swatch-color": option.value } as React.CSSProperties}
          onClick={() => onChange(option.value)}
        >
          <i />
          <span>{option.label}</span>
          {value.toLowerCase() === option.value.toLowerCase() && <Check />}
        </button>
      ))}
    </div>
  );
}

function MessagesScreen({
  conversations,
  open,
  onGroup,
}: {
  conversations: Conversation[];
  open: (id: string) => void;
  onGroup: () => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"direct" | "group">("direct");
  const filtered = conversations
    .filter((item) => (kind === "group" ? item.group : !item.group))
    .filter((item) => item.name.includes(query) || item.preview.includes(query))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
  return (
    <>
      <Header
        title="消息"
        subtitle="安全送达每一句话"
        actions={
          <IconButton label="创建群聊" onClick={onGroup}>
            <PenLine />
          </IconButton>
        }
      />
      <div className="screen-body screen-enter">
        <div className="search-field">
          <Search />
          <input
            aria-label="搜索消息"
            placeholder="搜索会话或消息"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="conversation-tabs" role="tablist" aria-label="会话分类">
          <button className={kind === "direct" ? "active" : ""} onClick={() => setKind("direct")}>个人</button>
          <button className={kind === "group" ? "active" : ""} onClick={() => setKind("group")}>群聊</button>
        </div>
        {filtered.length === 0 ? (
          <EmptyState>
            {query
              ? "主人，没有找到相符的会话，换个关键词试试喵"
              : "主人，还没有会话，去联系人页发起第一句问候喵"}
          </EmptyState>
        ) : (
          <div className="conversation-list list-stagger">
            {filtered.map((item) => (
              <button
                className="conversation-row"
                key={item.id}
                onClick={() => open(item.id)}
              >
                 <Avatar name={item.name} image={item.group ? item.avatar : item.avatar ?? item.members?.[0]?.avatar} />
                <span className="conversation-content">
                  <span className="row-title">
                    <strong>{item.name}{item.group ? `（${item.members?.length ?? 0} 人）` : ""}</strong>
                    <time>{messageTime(item.updatedAt)}</time>
                  </span>
                  <span className="row-preview">
                    {item.pinned && "置顶 · "}
                    {item.muted && "已静音 · "}
                    {Number(item.disappearingSeconds ?? 0) > 0 ? "阅后即焚 · " : null}
                    {item.preview}
                  </span>
                </span>
                {item.unread > 0 && (
                  <span className="unread">{item.unread}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function StatusBanner({ profile }: { profile: UserProfile }) {
  const state = profile.moderation;
  if (!state?.bannedUntil && !state?.mutedUntil) return null;
  return (
    <div className="moderation-banner">
      <ShieldCheck />
      <span>
        {state.bannedUntil && `账号封禁至 ${messageTime(state.bannedUntil)}`}
        {state.bannedUntil && state.mutedUntil && " · "}
        {state.mutedUntil && `禁言至 ${messageTime(state.mutedUntil)}`}
        {state.reason && `：${state.reason}`}
      </span>
    </div>
  );
}

function ChatScreen({
  profile,
  conversation,
  messages,
  loading,
  onBack,
  onSend,
  onSendVoice,
  onRecall,
  onEdit,
  onReact,
  onAttachments,
  onSettings,
  onMute,
  onDisappear,
  onCall,
  callLog,
  displayName,
  typingNames,
  onTyping,
  preferences,
  conversationPreferences,
}: {
  profile: UserProfile;
  conversation: Conversation;
  messages: ChatMessage[];
  loading: boolean;
  onBack: () => void;
  onSend: (text: string, quote?: ChatMessage["quote"]) => Promise<void>;
  onSendVoice: (file: File) => Promise<void>;
  onRecall: (message: ChatMessage) => Promise<void>;
  onEdit: (message: ChatMessage, text: string) => Promise<void>;
  onReact: (message: ChatMessage, emoji: string) => Promise<void>;
  onAttachments: () => void;
  onSettings: () => void;
  onMute: (conversationId: string, mutedUntil: number | null) => Promise<void>;
  onDisappear: (conversationId: string, seconds: number) => Promise<void>;
  onCall: (peerId: string) => void;
  callLog: { callId: string; peerId: string; duration: number; result: CallResult; message: string } | null;
  displayName?: string;
  typingNames: string[];
  onTyping?: () => void;
  preferences: AppPreferences;
  conversationPreferences: ConversationAppearance;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ChatMessage | null>(null);
  const [quote, setQuote] = useState<ChatMessage["quote"]>();
  const [editTarget, setEditTarget] = useState<ChatMessage | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [reactOpen, setReactOpen] = useState(false);
  const [prefOpen, setPrefOpen] = useState(false);
  const [mutedLocal, setMutedLocal] = useState(Boolean(conversation.muted));
  const [disappearLocal, setDisappearLocal] = useState(conversation.disappearingSeconds ?? 0);
  const [recording, setRecording] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const discardRecordingRef = useRef(false);
  const voicePressRef = useRef(false);
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportedReadsRef = useRef(new Set<string>());
  const memberList = Array.isArray(conversation.members) ? conversation.members : [];
  const messageList = Array.isArray(messages) ? messages : [];
  const reactEmojis = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];
  useEffect(() => {
    const stream = messageStreamRef.current;
    if (!stream) return;
    const scrollToLatest = () => { stream.scrollTop = stream.scrollHeight; };
    scrollToLatest();
    const raf = requestAnimationFrame(scrollToLatest);
    const timer = window.setTimeout(scrollToLatest, 150);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, [conversation.id, messageList]);
  useEffect(() => () => composerRef.current?.blur(), []);
  useEffect(() => {
    if (!profile.id) return;
    const unread = messageList.filter((m) => m.senderId !== profile.id && !m.recalled && !reportedReadsRef.current.has(m.id));
    if (!preferences.readReceipts) return;
    for (const m of unread) {
      reportedReadsRef.current.add(m.id);
      void api.markMessageRead(m.id).catch(() => reportedReadsRef.current.delete(m.id));
    }
  }, [conversation.id, messageList, profile.id, preferences.readReceipts]);
  const submit = async () => {
    if (!draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    setError("");
    try {
      await onSend(text, quote);
      setQuote(undefined);
    } catch (cause) {
      setDraft(text);
      setError(errorText(cause));
    }
  };
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      discardRecordingRef.current = false;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) recordingChunksRef.current.push(event.data); };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000);
      if (!voicePressRef.current) void stopRecording(true);
    } catch {
      setError("无法访问麦克风，请检查录音权限喵");
    }
  };
  const stopRecording = async (discard = false) => {
    const recorder = mediaRecorderRef.current;
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    if (!recorder) { setRecording(false); return; }
    discardRecordingRef.current = discard;
    const stopped = recorder.state === "inactive"
      ? Promise.resolve()
      : new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
    setRecording(false);
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    recorder.stream.getTracks().forEach((track) => track.stop());
    const chunks = [...recordingChunksRef.current];
    mediaRecorderRef.current = null;
    if (discardRecordingRef.current) { recordingChunksRef.current = []; return; }
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    if (blob.size < 1000) { setError("录音太短了喵"); return; }
    const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
    setError("");
    try {
      await onSendVoice(file);
      setQuote(undefined);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const muted =
    profile.moderation?.mutedUntil &&
    new Date(profile.moderation.mutedUntil) > new Date();
  return (
    <div className="chat-screen anim-fade-up">
      <Header
        title={conversation.group ? `${conversation.name}（${memberList.length}）` : (displayName ?? conversation.name)}
        subtitle={
          conversation.group
            ? `${memberList.length} 位成员`
            : memberList[0]?.status
        }
        back={() => {
          composerRef.current?.blur();
          onBack();
        }}
        actions={<>{!conversation.group && <IconButton label="语音通话" onClick={() => onCall(conversation.members[0]?.id ?? "")}><Phone /></IconButton>}<IconButton label={mutedLocal ? "取消静音" : "静音会话"} onClick={() => setPrefOpen(true)}>{mutedLocal ? <BellRing /> : <BellOff />}</IconButton><IconButton label={conversation.group ? "群聊设置" : "好友设置"} onClick={onSettings}><MoreHorizontal /></IconButton></>}
        centered={Boolean(conversation.group)}
      />
      {prefOpen && <div className="modal-backdrop" onClick={() => setPrefOpen(false)}>
        <div className="modal-content" onClick={(event) => event.stopPropagation()}>
          <h3>会话设置</h3>
          <SelectField
            label="静音"
            value={mutedLocal ? "1" : "0"}
            options={[
              { value: "0", label: "不静音" },
              { value: "1", label: "静音 1 小时" },
              { value: "8", label: "静音 8 小时" },
              { value: "24", label: "静音 24 小时" },
              { value: "168", label: "静音 7 天" },
            ]}
            onChange={(v) => { const hours = Number(v); const until = hours === 0 ? null : Date.now() + hours * 3600 * 1000; setMutedLocal(until !== null); void onMute(conversation.id, until); }}
          />
          <SelectField
            label="消息自动销毁"
            value={String(disappearLocal)}
            options={[
              { value: "0", label: "关闭" },
              { value: "30", label: "30 秒" },
              { value: "300", label: "5 分钟" },
              { value: "3600", label: "1 小时" },
              { value: "86400", label: "1 天" },
              { value: "604800", label: "7 天" },
            ]}
            onChange={(v) => { const seconds = Number(v); setDisappearLocal(seconds); void onDisappear(conversation.id, seconds); }}
          />
          <p className="setting-note"><Info /><span>开启后，会话中的新消息将在设定时间后自动销毁</span></p>
          <div className="button-row"><button className="outline-button" onClick={() => setPrefOpen(false)}>完成</button></div>
        </div>
      </div>}
      <div className="message-stream" ref={messageStreamRef} style={{ position: "relative", backgroundImage: conversationPreferences.wallpaper ? `url(${conversationPreferences.wallpaper})` : undefined, backgroundSize: "cover", backgroundPosition: "center" }}>
        {conversationPreferences.wallpaper && conversationPreferences.dimWallpaper && <div style={{ position: "absolute", inset: 0, background: "rgba(9,13,18,.42)", pointerEvents: "none" }} />}
        {loading ? (
          <div className="message-skeleton" aria-label="正在读取本地消息">
            <i />
            <i />
            <i />
          </div>
        ) : messageList.length === 0 ? (
          <EmptyState>主人，这里很安静，发出第一条消息吧喵</EmptyState>
        ) : (
          messageList.map((message) => {
            if (message.body.startsWith("__call__:")) {
              const [, result = "completed", durationText = "0", ...labelParts] = message.body.split(":");
              const duration = Number(durationText) || 0;
              const label = labelParts.join(":") || (result === "completed" ? "通话结束" : "通话未完成");
              return <div className="call-log-message" key={message.id}><Phone size={14} /><span>{result === "completed" ? <>通话结束 · {Math.floor(duration / 60).toString().padStart(2, "0")}:{(duration % 60).toString().padStart(2, "0")}</> : <strong>{label}</strong>}</span></div>;
            }
            const member = memberList.find((item) => item.id === message.senderId);
            const senderName = member?.name || message.senderName;
            return (
            <div
              className={`message-line message-in ${message.senderId === profile.id ? "mine" : ""} ${message.governance ? "governance-message" : ""}`}
              key={message.id}
              onContextMenu={(event) => { event.preventDefault(); if (!message.recalled) setSelected(message); }}
              onPointerDown={() => { if (!message.recalled) pressTimer.current = setTimeout(() => setSelected(message), 550); }}
              onPointerUp={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
              onPointerCancel={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
            >
              {message.senderId !== profile.id && (
                <Avatar name={senderName} image={member?.avatar} size="small" />
              )}
              <div className="message-wrap">
                <span className={`sender-label ${message.senderId === profile.id ? 'own' : ''}`}>
                    {member?.memberTitle && <b className="group-title-badge">{member.memberTitle}</b>}
                    {member?.memberLevel != null && member.memberLevel > 0 && <b className="group-level-badge">LV{member.memberLevel}</b>}
                    {senderName}{" "}
                    {message.senderVip || member?.vip || (message.senderId === profile.id && Boolean(profile.vipUntil)) ? (
                      <b className="vip-sender-badge">VIP </b>
                    ) : null}
                    {!member && <b>ID {message.senderId}</b>}
                    {message.senderRole === "platform-admin" && (
                      <b>
                        <ShieldCheck /> 平台管理员
                      </b>
                    )}
                </span>
                <div className="bubble" style={message.senderId === profile.id ? { background: conversationPreferences.color, borderColor: conversationPreferences.color } : undefined}>
                  {message.quote && <div className="message-quote"><strong>{message.quote.senderName}</strong><span>{message.quote.body}</span></div>}
                  {message.recalled && <span className="recalled-message">{message.senderId === profile.id ? "你撤回了一条消息" : `${senderName} 撤回了一条消息`}</span>}
                  {!message.recalled && message.attachment && <MediaAttachment attachment={message.attachment} />}
                  {!message.recalled && message.body && <span>{message.body}</span>}
                  <small>
                    {messageTime(message.sentAt)}{" "}
                    {message.edited && <em className="edited-mark">已编辑</em>}
                    {message.disappearing && <em className="edited-mark">阅后即焚</em>}
                    {message.senderId === profile.id &&
                      (message.status === "failed" ? "发送失败" : <Check />)}
                  </small>
                </div>
                {Array.isArray(message.reactions) && message.reactions.length > 0 && (
                  <div className="reaction-row">
                    {message.reactions.map((reaction) => (
                      <span key={reaction.userId} className={reaction.userId === profile.id ? "own" : ""} title={reaction.displayName}>{reaction.emoji}</span>
                    ))}
                  </div>
                )}
              </div>
              {message.senderId === profile.id && (
                <Avatar name={profile.name} image={profile.avatar} size="small" />
              )}
            </div>
            );
          })
        )}
        {callLog && callLog.peerId === conversation.id && (
          <div className="call-log-message">
            <Phone size={14} />
            <span>
              {callLog.result === "completed" ? <>通话结束 · {Math.floor(callLog.duration / 60).toString().padStart(2, "0")}:{(callLog.duration % 60).toString().padStart(2, "0")}</> : <strong style={{ color: "#ef4444" }}>{callLog.message}</strong>}
            </span>
          </div>
        )}
      </div>
      {error && <p className="composer-error">{error}</p>}
      {preferences.typingIndicators && typingNames.length > 0 && <div className="typing-indicator">{typingNames.join("、")} 正在输入<span className="typing-dots"><i /><i /><i /></span></div>}
      {quote && <div className="composer-quote"><span><strong>引用 {quote.senderName}</strong><small>{quote.body}</small></span><IconButton label="取消引用" onClick={() => setQuote(undefined)}><X /></IconButton></div>}
      <div className={`composer ${voiceMode ? "voice-mode" : ""}`}>
        <IconButton label="添加附件" onClick={onAttachments}>
          <Plus />
        </IconButton>
        {!voiceMode ? <textarea
          ref={composerRef}
          rows={1}
          aria-label="消息"
          disabled={Boolean(muted)}
          placeholder={muted ? "主人当前处于禁言状态喵" : "写消息..."}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (preferences.typingIndicators) onTyping?.(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && preferences.enterToSend) {
              e.preventDefault();
              void submit();
            }
          }}
        /> : <button
          type="button"
          className={`hold-to-talk ${recording ? "recording" : ""}`}
          aria-label="长按录音，松开发送"
          onPointerDown={(event) => { voicePressRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); void startRecording(); }}
          onPointerUp={(event) => { voicePressRef.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (recording || mediaRecorderRef.current) void stopRecording(false); }}
          onPointerCancel={() => { voicePressRef.current = false; if (recording || mediaRecorderRef.current) void stopRecording(true); }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <Mic />
          <span>{recording ? `松开发送 · ${recordingSeconds}s` : "按住说话"}</span>
        </button>}
        <IconButton
          label={voiceMode ? "切换文字输入" : "切换语音输入"}
          className={recording ? "record-button active" : "record-button"}
          onClick={() => { if (recording) void stopRecording(true); setVoiceMode((value) => !value); }}
        >
          {voiceMode ? <MessageCircle /> : <Mic />}
        </IconButton>
        {!voiceMode && <IconButton
          label="发送"
          className="send-button"
          onClick={() => void submit()}
        >
          <Send />
        </IconButton>}
      </div>
      {selected && <div className="message-action-backdrop" onClick={() => setSelected(null)}>
        <div className="message-actions" onClick={(event) => event.stopPropagation()}>
          <button onClick={() => { setQuote({ id: selected.id, senderName: selected.senderName, body: selected.body || (selected.attachment ? `[${selected.attachment.mime.startsWith("image/") ? "图片" : "视频"}]` : "消息") }); setSelected(null); }}><Reply />引用</button>
          <button onClick={() => { setReactOpen(true); }}><Plus />回应</button>
          {selected.body && <button onClick={() => { void copyText(selected.body).catch((cause) => setError(errorText(cause))); setSelected(null); }}><Copy />复制</button>}
          {selected.senderId === profile.id && selected.status !== "sending" && <button onClick={() => { const target = selected; setSelected(null); void onRecall(target).catch((cause) => setError(errorText(cause))); }}><RotateCcw />撤回</button>}
          {selected.senderId === profile.id && selected.body && selected.status !== "sending" && <button onClick={() => { setEditDraft(selected.body); setEditTarget(selected); setSelected(null); }}><PenLine />编辑</button>}
          <button onClick={() => setSelected(null)}><X />取消</button>
        </div>
      </div>}
      {reactOpen && selected && <div className="message-action-backdrop" onClick={() => { setReactOpen(false); setSelected(null); }}>
        <div className="reaction-picker" onClick={(event) => event.stopPropagation()}>
          <div className="reaction-picker-grid">
            {reactEmojis.map((emoji) => (
              <button key={emoji} onClick={() => { const target = selected; setReactOpen(false); setSelected(null); void onReact(target, emoji).catch((cause) => setError(errorText(cause))); }}>{emoji}</button>
            ))}
            <button onClick={() => { const target = selected; setReactOpen(false); setSelected(null); void onReact(target, "").catch((cause) => setError(errorText(cause))); }} title="移除回应"><X /></button>
          </div>
        </div>
      </div>}
      {editTarget && <div className="modal-backdrop" onClick={() => setEditTarget(null)}>
        <div className="modal-content" onClick={(event) => event.stopPropagation()}>
          <h3>编辑消息</h3>
          <textarea rows={3} maxLength={5000} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} placeholder="修改消息内容" autoFocus />
          <div className="button-row">
            <button className="outline-button" onClick={() => setEditTarget(null)}>取消</button>
            <button className="primary-button" disabled={!editDraft.trim()} onClick={() => { const target = editTarget; const text = editDraft; setEditTarget(null); void onEdit(target, text).catch((cause) => setError(errorText(cause))); }}>保存</button>
          </div>
        </div>
      </div>}
    </div>
  );
}

function StatusesScreen({
  myName,
  myAvatar,
  statuses,
  refresh,
  publish,
  view,
  remove,
  openMedia,
  onBack,
}: {
  myName: string;
  myAvatar?: string;
  statuses: StatusUpdate[];
  refresh: () => Promise<void>;
  publish: (input: { kind: "text" | "image"; text?: string; imageId?: string }) => Promise<void>;
  view: (statusId: string) => void;
  remove: (statusId: string) => void;
  openMedia: (imageId: string) => Promise<string>;
  onBack: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<StatusUpdate | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const imageInput = useRef<HTMLInputElement>(null);
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!viewing || viewing.kind !== "image" || !viewing.imageId) return;
    let active = true;
    setImageUrl("");
    void openMedia(viewing.imageId).then((url) => { if (active) setImageUrl(url); }).catch(() => setImageUrl(""));
    return () => { active = false; setImageUrl(""); };
  }, [viewing]);
  useEffect(() => {
    if (!imageFile) { setPreviewUrl(""); return; }
    const url = URL.createObjectURL(imageFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (imageFile) {
        const meta = await api.uploadAttachment(imageFile, "status");
        await publish({ kind: "image", imageId: meta.id, text: text.trim() || undefined });
      } else {
        await publish({ kind: "text", text });
      }
      setText("");
      setImageFile(null);
      setComposing(false);
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };
  const myStatuses = statuses.filter((item) => item.authorName === myName);
  const feed = statuses.filter((item) => item.authorName !== myName);
  return (
    <div className="statuses-screen">
      <Header title="动态" actions={<IconButton label="返回" onClick={onBack}><ChevronLeft /></IconButton>} />
      <div className="statuses-body">
        <div className="stories-row">
          <button className="story-item story-add" onClick={() => setComposing(true)}>
            <div className="story-avatar-ring add-ring"><Avatar name={myName} image={myAvatar} size="medium" /><span className="story-add-icon"><Plus /></span></div>
            <span className="story-name">我的动态</span>
          </button>
          {feed.map((status) => (
            <button key={status.id} className="story-item" onClick={() => { view(status.id); setViewing(status); }}>
              <div className={`story-avatar-ring ${status.viewed ? "" : "unread"}`}><Avatar name={status.authorName} image={status.authorAvatar} size="medium" /></div>
              <span className="story-name">{status.authorName}</span>
            </button>
          ))}
        </div>
        {myStatuses.length > 0 && (
          <section className="statuses-section">
            <h3 className="statuses-section-title">我的动态</h3>
            <div className="status-cards">
              {myStatuses.map((status) => (
                <div key={status.id} className="status-card" onClick={() => setViewing(status)}>
                  {status.kind === "image" && status.imageId ? (
                    <StatusImagePreview imageId={status.imageId} openMedia={openMedia} />
                  ) : (
                    <div className="status-card-text"><p>{status.text}</p></div>
                  )}
                  <div className="status-card-footer">
                    <span className="status-card-time">{messageTime(status.createdAt)}</span>
                    <span className="status-card-meta">{status.viewCount ?? 0} 次查看</span>
                    <button className="status-card-delete" onClick={(e) => { e.stopPropagation(); remove(status.id); }}><Trash2 /></button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        <section className="statuses-section">
          <h3 className="statuses-section-title">好友动态</h3>
          {feed.length === 0 ? <EmptyState>暂时没有好友动态喵</EmptyState> : (
            <div className="status-cards">
              {feed.map((status) => (
                <div key={status.id} className="status-card" onClick={() => { view(status.id); setViewing(status); }}>
                  {status.kind === "image" && status.imageId ? (
                    <StatusImagePreview imageId={status.imageId} openMedia={openMedia} />
                  ) : (
                    <div className="status-card-text"><p>{status.text}</p></div>
                  )}
                  <div className="status-card-footer">
                    <Avatar name={status.authorName} image={status.authorAvatar} size="small" />
                    <span className="status-card-author">{status.authorName}</span>
                    <span className="status-card-time">{messageTime(status.createdAt)}</span>
                    {!status.viewed && <i className="unread-dot" />}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      {composing && <div className="modal-backdrop" onClick={() => { setComposing(false); setImageFile(null); setText(""); }}>
        <div className="modal-content status-compose" onClick={(e) => e.stopPropagation()}>
          <h3>发布动态</h3>
          <textarea rows={5} maxLength={700} value={text} onChange={(e) => setText(e.target.value)} placeholder="分享此刻的想法..." autoFocus />
          <input ref={imageInput} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) setImageFile(file); }} />
          {previewUrl && <div className="status-preview-img"><img src={previewUrl} alt="预览" /><button className="status-preview-remove" onClick={() => setImageFile(null)}><X /></button></div>}
          {!imageFile && <button className="outline-button" onClick={() => imageInput.current?.click()}><FileImage />添加图片</button>}
          {error && <p className="form-error">{error}</p>}
          <div className="button-row">
            <button className="outline-button" onClick={() => { setComposing(false); setImageFile(null); setText(""); }}>取消</button>
            <button className="primary-button" disabled={busy || (!text.trim() && !imageFile)} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <Check />}发布</button>
          </div>
        </div>
      </div>}
      {viewing && <StatusViewer status={viewing} imageUrl={imageUrl} onClose={() => setViewing(null)} onRemove={(id) => { remove(id); setViewing(null); }} ownName={myName} />}
    </div>
  );
}

function StatusImagePreview({ imageId, openMedia }: { imageId: string; openMedia: (id: string) => Promise<string> }) {
  const [url, setUrl] = useState("");
  useEffect(() => { let active = true; void openMedia(imageId).then((u) => { if (active && u) setUrl(u); }).catch(() => {}); return () => { active = false; }; }, [imageId]);
  if (!url) return <div className="status-card-loading" />;
  return <div className="status-card-image"><img src={url} alt="" loading="lazy" /></div>;
}

function StatusViewer({ status, imageUrl, onClose, onRemove, ownName }: { status: StatusUpdate; imageUrl: string; onClose: () => void; onRemove: (id: string) => void; ownName: string }) {
  const [progress, setProgress] = useState(0);
  useEffect(() => { setProgress(0); const start = Date.now(); const duration = status.kind === "image" ? 8000 : Math.max(3000, (status.text?.length ?? 10) * 80); const tick = () => { const elapsed = Date.now() - start; const pct = Math.min(100, (elapsed / duration) * 100); setProgress(pct); if (pct < 100) requestAnimationFrame(tick); else onClose(); }; const raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [status.id]);
  return (
    <div className="status-viewer" onClick={onClose}>
      <div className="status-viewer-progress"><div className="status-viewer-progress-bar" style={{ width: `${progress}%` }} /></div>
      <div className="status-viewer-header">
        <div className="status-viewer-user"><Avatar name={status.authorName} image={status.authorAvatar} size="small" /><span><strong>{status.authorName}</strong><small>{messageTime(status.createdAt)}</small></span></div>
        <div className="status-viewer-actions">
          {status.authorName === ownName && <button className="status-viewer-btn" onClick={(e) => { e.stopPropagation(); onRemove(status.id); }}><Trash2 /></button>}
          <button className="status-viewer-btn" onClick={(e) => { e.stopPropagation(); onClose(); }}><X /></button>
        </div>
      </div>
      <div className="status-viewer-body" onClick={(e) => e.stopPropagation()}>
        {status.kind === "image" ? (imageUrl ? <img src={imageUrl} alt="" /> : <div className="media-loading"><LoaderCircle className="spin" /></div>) : <div className="status-viewer-text"><p>{status.text}</p></div>}
        {status.kind === "image" && status.text && <div className="status-viewer-caption"><p>{status.text}</p></div>}
      </div>
    </div>
  );
}

function ContactsScreen({
  contacts,
  groups,
  onGroup,
  onJoin,
  onAdd,
  onRequests,
  onOpen,
  onOpenGroup,
  onCall,
}: {
  contacts: Contact[];
  groups: Conversation[];
  onGroup: () => void;
  onJoin: () => void;
  onAdd: () => void;
  onRequests: () => void;
  onOpen: (id: string) => Promise<void>;
  onOpenGroup: (id: string) => Promise<void>;
  onCall: (peerId: string) => void;
}) {
  const [kind, setKind] = useState<"direct" | "group">("direct");
  const accepted = contacts.filter((contact) => contact.status === "accepted" && !contact.blocked).sort((a, b) => alphabetic(displayName(a), displayName(b)));
  const sortedGroups = groups.filter((item) => item.group).sort((a, b) => alphabetic(a.name, b.name));
  const pendingCount = contacts.filter((contact) => contact.status === "pending").length;
  return (
    <>
      <Header
        title="联系人"
        actions={
          <IconButton label="添加联系人" onClick={onAdd}>
            <UserPlus />
          </IconButton>
        }
      />
      <div className="screen-body">
        <div className="quick-actions">
          <button onClick={onGroup}>
            <span className="square-icon green">
              <Users />
            </span>
            <span>
              <strong>创建群聊</strong>
              <small>邀请真实联系人开始会话</small>
            </span>
            <ChevronRight />
          </button>
          <button onClick={onJoin}>
            <span className="square-icon blue">
              <Users />
            </span>
            <span>
              <strong>加入群聊</strong>
              <small>按群组规则申请加入</small>
            </span>
            <ChevronRight />
          </button>
          <button onClick={onAdd}>
            <span className="square-icon coral">
              <UserPlus />
            </span>
            <span>
              <strong>新的好友</strong>
               <small>通过邮箱、QQ号或 UUID 添加</small>
            </span>
            <ChevronRight />
          </button>
          <button onClick={onRequests}>
            <span className="square-icon gold">
              <BellRing />
            </span>
            <span>
              <strong>申请</strong>
              <small>集中处理好友申请和群聊申请{pendingCount ? ` · ${pendingCount}` : ""}</small>
            </span>
            <ChevronRight />
          </button>
        </div>
        <div className="conversation-tabs" role="tablist" aria-label="通讯录分类">
          <button className={kind === "direct" ? "active" : ""} onClick={() => setKind("direct")}>联系人 · {accepted.length}</button>
          <button className={kind === "group" ? "active" : ""} onClick={() => setKind("group")}>群聊 · {sortedGroups.length}</button>
        </div>
        {kind === "direct" && (accepted.length === 0 ? (
          <EmptyState>主人，联系人列表还是空的喵</EmptyState>
        ) : (
          <div className="contact-list list-stagger">
            {accepted.map((contact) => (
              <div
                className={`contact-row ${contact.vip ? "vip-card" : ""}`}
                key={contact.id}
                role="button"
                tabIndex={0}
                onClick={() => void onOpen(contact.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onOpen(contact.id);
                }}
              >
                <Avatar name={contact.name} image={contact.avatar} />
                <span>
                  <strong>
                    {contact.remark || contact.name}{" "}
                    {contact.role === "platform-admin" && (
                      <i className="role-inline">平台管理员</i>
                    )}
                    {contact.vip && <i className="vip-inline">VIP</i>}
                  </strong>
                  <small>
                    {contact.remark
                      ? `${contact.name} · @${contact.handle} · ${contact.status}`
                      : `@${contact.handle} · ${contact.status}`}
                  </small>
                </span>
                <span className="contact-actions" onClick={(e) => e.stopPropagation()}>
                  <IconButton label="语音通话" onClick={() => onCall(contact.id)}><Phone /></IconButton>
                  <IconButton label="发消息" onClick={() => void onOpen(contact.id)}><MessageCircle /></IconButton>
                </span>
              </div>
            ))}
          </div>
        ))}
        {kind === "group" && (sortedGroups.length === 0 ? <EmptyState>主人，还没有加入群聊喵</EmptyState> : <div className="contact-list">
          {sortedGroups.map((group) => <div className="contact-row" key={group.id} role="button" tabIndex={0} onClick={() => void onOpenGroup(group.id)} onKeyDown={(event) => { if (event.key === "Enter") void onOpenGroup(group.id); }}>
            <Avatar name={group.name} image={group.avatar} />
            <span><strong>{group.name}</strong><small>群号 {group.groupNumber ?? group.id.replace(/^g-/, "")} · {group.members.length} 位成员</small></span>
            <MessageCircle />
          </div>)}
        </div>)}
      </div>
    </>
  );
}

function AnnouncementsScreen({
  announcements,
  onOpen,
  onReadAll,
}: {
  announcements: Announcement[];
  onOpen: (item: Announcement) => void;
  onReadAll: () => void;
}) {
  const unread = announcements.filter((item) => !item.readAt).length;
  return (
    <>
      <Header
        title="公告"
        subtitle="由平台管理员署名发布"
        actions={
          unread > 0 ? (
            <button className="outline-button read-all-button" onClick={onReadAll}>
              一键已读
            </button>
          ) : undefined
        }
      />
      <div className="screen-body announcement-list anim-slide-left">
        {announcements.length === 0 ? (
          <EmptyState>主人，目前没有公告喵</EmptyState>
        ) : (
          <div className="list-stagger">
          {announcements.map((item) => (
            <article
              className={`announcement ${item.readAt ? "read" : ""}`}
              key={item.id}
              onClick={() => onOpen(item)}
            >
              <header>
                <BellRing />
                <span>
                  <strong>{item.title}</strong>
                  <small>{messageTime(item.publishedAt)}</small>
                </span>
                {!item.readAt && <i className="unread-dot" aria-label="未读" />}
              </header>
              <p>{item.body}</p>
              <footer>
                <ShieldCheck /> {item.authorName} · 平台管理员
                {item.confirmRequired && <span className="announcement-confirm-tag">需确认</span>}
              </footer>
            </article>
          ))}
          </div>
        )}
      </div>
    </>
  );
}

function ProfileScreen({
  profile,
  openSheet,
  onOpenSettings,
  onProfile,
  onStatuses,
}: {
  profile: UserProfile;
  openSheet: (sheet: Sheet) => void;
  onOpenSettings: () => void;
  onProfile: (profile: UserProfile) => void;
  onStatuses: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const avatarInput = useRef<HTMLInputElement>(null);
  const copyUuid = async () => {
    if (!profile.uuid) return;
    try {
      await copyText(profile.uuid);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <Header
        title="我的"
        subtitle="主人的身份与偏好"
        actions={
          <>
            <IconButton label="编辑资料" onClick={() => openSheet("edit-profile")}>
              <PenLine />
            </IconButton>
            <IconButton label="设置" onClick={onOpenSettings}>
              <Settings />
            </IconButton>
          </>
        }
      />
      <div className="screen-body profile-screen screen-enter">
        <StatusBanner profile={profile} />
        <section className="profile-hero">
          <div className="avatar-wrap">
            <Avatar name={profile.name} image={profile.avatar} size="large" />
            <button
              aria-label="更换头像"
              disabled={avatarBusy}
              onClick={() => avatarInput.current?.click()}
            >
              {avatarBusy ? <LoaderCircle className="spin" /> : <Camera />}
            </button>
            <input
              ref={avatarInput}
              type="file"
              accept="image/*"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setAvatarBusy(true);
                try {
                  const avatar = await readAvatar(file);
                  onProfile(await api.updateProfile({ name: profile.name, bio: profile.bio, gender: profile.gender, avatar }));
                  setAvatarError("");
                } catch (cause) {
                  setAvatarError(errorText(cause));
                } finally {
                  setAvatarBusy(false);
                }
              }}
            />
          </div>
          {avatarError && <p className="form-error">{avatarError}</p>}
          <h2>{profile.name}</h2>
          <p>@{profile.handle}</p>
          <blockquote>{profile.bio || "主人还没有写个人简介喵"}</blockquote>
          <div className={`membership-card ${profile.vipUntil ? "vip" : "standard"}`}>
            <span className="membership-badge">
              {profile.vipUntil ? <Crown /> : <CircleUserRound />}
            </span>
            <span className="membership-main">
              <strong>{profile.vipUntil ? "VIP 会员" : "普通用户"}</strong>
              {profile.vipUntil ? (
                <>
                  <i>{vipCardType(profile.vipInfo?.durationSeconds)}</i>
                  <small>
                    兑换时间：
                    {profile.vipInfo
                      ? vipTime(profile.vipInfo.activatedAt)
                      : "—"}
                  </small>
                  <small>
                    到期时间：
                    {profile.vipInfo?.expiresAt
                      ? vipTime(profile.vipInfo.expiresAt)
                      : "永久"}
                  </small>
                </>
              ) : (
                <small>开通 VIP 解锁更多专属权益</small>
              )}
            </span>
          </div>
          {profile.role === "platform-admin" && (
            <section className="admin-identity-card" aria-label="平台管理员身份">
              <span className="admin-identity-icon">
                <ShieldCheck />
              </span>
              <span>
                <strong>平台管理员</strong>
                <small>管理员身份已生效</small>
              </span>
              <i>ADMIN</i>
            </section>
          )}
          {profile.email && (
            <div className="uuid-row">
              <span>
                <small>注册邮箱</small>
                <code>{profile.email}</code>
              </span>
            </div>
          )}
          {profile.uuid && (
            <div className="uuid-row">
              <span>
                <small>用户 UUID</small>
                <code>{profile.uuid}</code>
              </span>
              <IconButton
                label={copied ? "已复制 UUID" : "复制 UUID"}
                onClick={() => void copyUuid()}
              >
                {copied ? <Check /> : <Copy />}
              </IconButton>
            </div>
          )}
        </section>
        <section className="menu-list">
          <button onClick={() => openSheet("edit-profile")}>
            <span className="square-icon blue"><PenLine /></span>
            <span><strong>编辑资料</strong><small>头像、昵称、简介、性别</small></span>
            <ChevronRight />
          </button>
          <button onClick={() => openSheet("vip")}>
            <span className="square-icon gold"><Crown /></span>
            <span><strong>VIP 会员</strong><small>{profile.vipUntil ? "已激活 · 管理会员权益" : "使用卡密开通 VIP"}</small></span>
            <ChevronRight />
          </button>
          <button onClick={onStatuses}>
            <span className="square-icon green"><Sparkles /></span>
            <span><strong>我的动态</strong><small>查看和发布动态</small></span>
            <ChevronRight />
          </button>
          <button onClick={onOpenSettings}>
            <span className="square-icon blue"><Settings /></span>
            <span><strong>设置</strong><small>通用、隐私、安全、身份</small></span>
            <ChevronRight />
          </button>
        </section>
      </div>
    </>
  );
}

function BottomNav({ tab, setTab, announcementUnread = 0, messageUnread = 0 }: { tab: Tab; setTab: (tab: Tab) => void; announcementUnread?: number; messageUnread?: number }) {
  return (
    <nav className="bottom-nav">
      <button
        className={tab === "messages" ? "active" : ""}
        onClick={() => setTab("messages")}
      >
        <MessageCircle />
        <span>消息</span>
        {messageUnread > 0 && <i className="nav-badge">{messageUnread > 99 ? "99+" : messageUnread}</i>}
      </button>
      <button
        className={tab === "contacts" ? "active" : ""}
        onClick={() => setTab("contacts")}
      >
        <ContactRound />
        <span>联系人</span>
      </button>
      <button
        className={tab === "announcements" ? "active" : ""}
        onClick={() => setTab("announcements")}
      >
        <Bell />
        <span>公告</span>
        {announcementUnread > 0 && (
          <i className="nav-badge">{announcementUnread > 99 ? "99+" : announcementUnread}</i>
        )}
      </button>
      <button
        className={tab === "profile" ? "active" : ""}
        onClick={() => setTab("profile")}
      >
        <CircleUserRound />
        <span>我的</span>
      </button>
    </nav>
  );
}

function Modal({
  title,
  children,
  onClose,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  actions?: React.ReactNode;
}) {
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 200);
  };
  return (
    <div
      className={`modal-backdrop ${closing ? "closing" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className={`modal-sheet ${closing ? "closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <div className="dialog-head-actions">
            {actions}
            <IconButton label="关闭" onClick={close}>
              <X />
            </IconButton>
          </div>
        </header>
        {children}
      </section>
    </div>
  );
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger = false,
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-content confirm-content">
        <Info />
        <p>{message}</p>
        {children}
        <div className="button-row">
          <button type="button" className="outline-button" onClick={onClose} disabled={confirming}>
            取消
          </button>
          <button
            type="button"
            className={danger ? "danger-button" : "primary-button"}
            disabled={confirming}
            onClick={() => {
              setConfirming(true);
              onConfirm();
            }}
          >
            {confirming ? <LoaderCircle className="spin" /> : danger ? <Trash2 /> : <Check />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AccountBannedModal({ notice, onClose }: { notice: AccountBanNotice; onClose: () => void }) {
  const remaining = notice.bannedUntil ? Math.max(0, notice.bannedUntil - Date.now()) : null;
  const duration = remaining === null
    ? "永久封禁"
    : remaining >= 86_400_000
      ? `${Math.ceil(remaining / 86_400_000)} 天`
      : remaining >= 3_600_000
        ? `${Math.ceil(remaining / 3_600_000)} 小时`
        : `${Math.max(1, Math.ceil(remaining / 60_000))} 分钟`;
  return <Modal title="账号已被封禁" onClose={onClose}>
    <div className="modal-content confirm-content ban-notice">
      <Ban />
      <p>该账号当前无法继续使用蓝喵速递。</p>
      <dl>
        <div><dt>封禁时长</dt><dd>{duration}</dd></div>
        {notice.bannedUntil && <div><dt>解除时间</dt><dd>{messageTime(new Date(notice.bannedUntil).toISOString())}</dd></div>}
        <div><dt>封禁理由</dt><dd>{notice.reason || "管理操作"}</dd></div>
      </dl>
      <button type="button" className="primary-button" onClick={onClose}>我知道了</button>
    </div>
  </Modal>;
}

function GroupModal({
  contacts,
  onClose,
  onCreate,
}: {
  contacts: Contact[];
  onClose: () => void;
  onCreate: (name: string, memberIds: string[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="创建群聊" onClose={onClose}>
      <div className="modal-content">
        <label>
          群聊名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="给群聊起个名字"
          />
        </label>
        <h3>
          选择成员 <span>{selected.length} 人</span>
        </h3>
        <div className="select-contacts">
          {contacts.map((contact) => (
            <button
              key={contact.id}
              onClick={() =>
                setSelected((items) =>
                  items.includes(contact.id)
                    ? items.filter((id) => id !== contact.id)
                    : [...items, contact.id],
                )
              }
            >
              <Avatar name={contact.name} size="small" />
              <span>{contact.name}</span>
              <i className={selected.includes(contact.id) ? "checked" : ""}>
                {selected.includes(contact.id) && <Check />}
              </i>
            </button>
          ))}
        </div>
        {error && <p className="form-error">{error}</p>}
        <button
          className="primary-button"
          disabled={busy || !name.trim() || selected.length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              await onCreate(name.trim(), selected);
            } catch (cause) {
              setError(errorText(cause));
              setBusy(false);
            }
          }}
        >
          创建群聊
        </button>
      </div>
    </Modal>
  );
}

function AddContactModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (handle: string, message: string) => Promise<void>;
}) {
  const [handle, setHandle] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="添加联系人" onClose={onClose}>
      <div className="modal-content">
        <label>
          邮箱、QQ 号或 UUID
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value.replace(/^@/, ""))}
            placeholder="输入对方邮箱、QQ号或 UUID"
          />
        </label>
        <label>申请附言<textarea rows={3} maxLength={120} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="介绍一下自己，最多 120 字" /></label>
        {error && <p className="form-error">{error}</p>}
        <button
          className="primary-button"
          disabled={!handle.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onAdd(handle.trim(), message.trim());
            } catch (cause) {
              setError(errorText(cause));
              setBusy(false);
            }
          }}
        >
          <UserPlus />
          发送好友申请
        </button>
      </div>
    </Modal>
  );
}

function ContactSettingsPage({
  contact,
  conversationId,
  onBack,
  onSaved,
  onPreferences,
  onRemove,
  appearance,
  onAppearance,
}: {
  contact: Contact;
  conversationId?: string;
  onBack: () => void;
  onSaved: (remark: string) => void;
  onPreferences: (preferences: { pinned?: boolean; blocked?: boolean }) => Promise<void>;
  onRemove: () => void;
  appearance: ConversationAppearance;
  onAppearance: (value: ConversationAppearance) => void;
}) {
  const [subPage, setSubPage] = useState<string | null>(null);
  const [disappearing, setDisappearing] = useState<number | undefined>(undefined);
  const [muted, setMuted] = useState(false);
  const [media, setMedia] = useState<Array<{ id: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: number }>>([]);
  const [commonGroups, setCommonGroups] = useState<Array<{ id: string; name: string; avatar?: string; memberCount: number }>>([]);
  const [error, setError] = useState("");
  const [customSeconds, setCustomSeconds] = useState("");
  const [selectedSeconds, setSelectedSeconds] = useState<number | undefined>(undefined);
  const [customSelected, setCustomSelected] = useState(false);
  const [chatColor, setChatColor] = useState(appearance.color);
  const [wallpaper, setWallpaper] = useState<string | null>(appearance.wallpaper ?? null);
  const [darkWallpaper, setDarkWallpaper] = useState(appearance.dimWallpaper);
  const wallpaperInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handleBack = () => { if (subPage) setSubPage(null); else onBack(); };
    window.addEventListener(SETTINGS_BACK_EVENT, handleBack);
    return () => window.removeEventListener(SETTINGS_BACK_EVENT, handleBack);
  }, [subPage, onBack]);
  const cid = conversationId ?? `d-${contact.id}`;
  const disappearingLabel = (s?: number) => {
    if (!s || s <= 0) return "关";
    if (s < 60) return `${s}秒`;
    if (s < 3600) return `${s / 60}分钟`;
    if (s < 86400) return `${s / 3600}小时`;
    return `${s / 86400}天`;
  };
  const loadMedia = async () => {
    try { const res = await api.getConversationMedia(cid); setMedia(res.media); } catch (cause) { setError(errorText(cause)); }
  };
  const loadCommonGroups = async () => {
    try { const res = await api.getCommonGroups(contact.id); setCommonGroups(res.groups); } catch (cause) { setError(errorText(cause)); }
  };
  return (
    <div className="settings-page anim-fade-up">
      <Header title="" back={onBack} actions={<IconButton label="编辑备注" onClick={() => setSubPage("remark")}><PenLine /></IconButton>} />
      <div className="settings-page-body">
        <div className="signal-profile-card">
          <Avatar name={contact.name} image={contact.avatar} size="large" />
          <h2>{contact.remark || contact.name}</h2>
          <small style={{ color: "var(--gray-500)" }}>{contact.name}</small>
        </div>
        <div className="signal-action-row">
          <button className="signal-action-btn" onClick={() => setSubPage("notify")}><Bell /><span>{muted ? "取消静音" : "静音"}</span></button>
        </div>
        <div className="settings-list">
          <div className="settings-list-item" onClick={() => setSubPage("disappearing")}><span>限时消息</span><small>{disappearingLabel(disappearing)}</small><ChevronRight /></div>
          <div className="settings-list-item" onClick={() => setSubPage("chatColor")}><span>聊天颜色与墙纸</span><ChevronRight /></div>
          <div className="settings-list-item" onClick={() => setSubPage("notify")}><span>声音与通知</span><small>{muted ? "静音" : "通知"}</small><ChevronRight /></div>
        </div>
        <div className="settings-list" style={{ marginTop: 16 }}>
          <div className="settings-list-item" onClick={() => { setSubPage("media"); loadMedia(); }}><span>共享媒体</span><ChevronRight /></div>
          <div className="settings-list-item" onClick={() => { setSubPage("commonGroups"); loadCommonGroups(); }}><span>共同群组</span><ChevronRight /></div>
        </div>
        <div className="settings-list" style={{ marginTop: 16 }}>
          <div className="settings-list-item danger-text" onClick={() => void onPreferences({ blocked: !contact.blocked })}><span>{contact.blocked ? "解除拉黑" : "拉黑"}</span></div>
          <div className="settings-list-item danger-text" onClick={onRemove}><span>删除好友</span></div>
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
      {subPage === "disappearing" && (
        <div className="settings-page anim-fade-up">
          <Header title="限时消息" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--gray-500)" }}>如果启用，该聊天中收发的新消息将在查看之后消失。</p>
            {[{ v: 0, l: "关" }, { v: 2419200, l: "4 周" }, { v: 604800, l: "1 周" }, { v: 86400, l: "1 天" }, { v: 28800, l: "8 小时" }, { v: 3600, l: "1 小时" }, { v: 300, l: "5分钟" }, { v: 30, l: "30秒" }].map(({ v, l }) => (
              <label key={v} className="radio-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer" }}>
                <input type="radio" name="dm-disappearing" checked={!customSelected && (selectedSeconds ?? 0) === v} onChange={() => { setSelectedSeconds(v); setCustomSelected(false); }} style={{ width: 20, height: 20, accentColor: "var(--color-primary)" }} />
                <span style={{ fontSize: 15 }}>{l}</span>
              </label>
            ))}
            <label className="radio-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer" }}>
              <input type="radio" name="dm-disappearing" checked={customSelected} onChange={() => setCustomSelected(true)} style={{ width: 20, height: 20, accentColor: "var(--color-primary)" }} />
              <span style={{ fontSize: 15 }}>自定义时间</span>
            </label>
            <div style={{ padding: "0 16px", display: "flex", gap: 8, alignItems: "center" }}>
              <input type="number" min={1} placeholder="秒数" value={customSeconds} onChange={(e) => setCustomSeconds(e.target.value)} style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--gray-300)", fontSize: 14 }} />
              <span style={{ color: "var(--gray-500)", fontSize: 13 }}>秒</span>
            </div>
            <div style={{ padding: 16 }}>
              <button className="primary-button" style={{ width: "100%" }} onClick={async () => {
                try {
                  const seconds = customSelected ? Number(customSeconds) : selectedSeconds ?? 0;
                  if (!Number.isInteger(seconds) || seconds < 0) throw new Error("请输入有效的限时秒数");
                  await api.setConversationDisappearing(cid, seconds);
                  setDisappearing(seconds);
                  setSubPage(null);
                } catch (cause) { setError(errorText(cause)); }
              }}>保存</button>
            </div>
          </div>
        </div>
      )}
      {subPage === "remark" && <div className="settings-page anim-fade-up"><Header title="编辑备注" back={() => setSubPage(null)} /><div className="settings-page-body"><label>备注<textarea rows={5} maxLength={60} defaultValue={contact.remark ?? ""} onChange={(event) => { (event.currentTarget.form?.elements.namedItem("remark") as HTMLTextAreaElement | null); }} name="remark" /></label><button className="primary-button" onClick={async (event) => { const value = ((event.currentTarget.parentElement?.querySelector("textarea") as HTMLTextAreaElement)?.value ?? "").trim(); try { await api.updateContactRemark(contact.id, value); onSaved(value); } catch (cause) { setError(errorText(cause)); } }}>保存备注</button>{error && <p className="form-error">{error}</p>}</div></div>}
      {subPage === "chatColor" && (
        <div className="settings-page anim-fade-up">
          <Header title="聊天颜色与墙纸" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            <div style={{ padding: 16, textAlign: "center" }}>
              <div style={{ width: "100%", maxWidth: 280, margin: "0 auto", borderRadius: 12, overflow: "hidden", border: "1px solid var(--gray-700)", background: "var(--gray-900)", height: 320 }}>
                <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--gray-700)" }}>
                  <Avatar name={contact.name} image={contact.avatar} size="small" />
                  <span style={{ color: "var(--gray-300)", fontSize: 13 }}>{contact.name}</span>
                </div>
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ background: "var(--gray-700)", borderRadius: 8, padding: "8px 12px", maxWidth: "70%", fontSize: 12, color: "var(--gray-400)" }}>对方消息</div>
                  <div style={{ background: chatColor, borderRadius: 8, padding: "8px 12px", maxWidth: "70%", marginLeft: "auto", fontSize: 12, color: "#fff" }}>我的消息</div>
                </div>
              </div>
            </div>
            <div className="settings-list">
              <div className="settings-list-item color-picker-row"><span>聊天颜色</span><ChatColorPicker value={chatColor} onChange={(value) => { setChatColor(value); onAppearance({ ...appearance, color: value }); }} /></div>
              <div className="settings-list-item" onClick={() => { setChatColor("#ec4899"); onAppearance({ ...appearance, color: "#ec4899" }); }}><span>重置聊天颜色</span></div>
            </div>
            <div className="settings-list" style={{ marginTop: 16 }}>
               <button className="settings-list-item" onClick={() => wallpaperInput.current?.click()}><span>设置墙纸</span><ChevronRight /></button>
               <input ref={wallpaperInput} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; const reader = new FileReader(); reader.onload = () => { const next = String(reader.result); setWallpaper(next); onAppearance({ ...appearance, wallpaper: next }); }; reader.readAsDataURL(file); }} />
               <div className="settings-list-item"><span>深色模式暗淡墙纸</span><Toggle label="深色模式暗淡墙纸" checked={darkWallpaper} onChange={(value) => { setDarkWallpaper(value); onAppearance({ ...appearance, dimWallpaper: value }); }} /></div>
               <div className="settings-list-item" onClick={() => { setWallpaper(null); onAppearance({ ...appearance, wallpaper: undefined }); }}><span>重置墙纸</span></div>
            </div>
          </div>
        </div>
      )}
      {subPage === "notify" && (
        <div className="settings-page anim-fade-up">
          <Header title="声音与通知" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            <div className="settings-list">
              <div className="settings-list-item" onClick={async () => {
                const next = !muted;
                await api.setConversationMute(cid, next ? Date.now() + 365 * 24 * 60 * 60_000 : null);
                setMuted(next);
              }}>
                <Bell style={{ width: 20, height: 20 }} />
                <span>静音通知</span>
                <small>{muted ? "已静音" : "未静音"}</small>
              </div>
              <div className="settings-list-item" onClick={() => onAppearance({ ...appearance, mentionNotifications: !appearance.mentionNotifications })}>
                <AtSign style={{ width: 20, height: 20 }} />
                <span>提及我</span>
                <small>{appearance.mentionNotifications ? "总是通知" : "遵循静音"}</small>
              </div>
              <div className="settings-list-item" onClick={() => onAppearance({ ...appearance, customNotifications: !appearance.customNotifications })}>
                <Volume2 style={{ width: 20, height: 20 }} />
                <span>自定义通知</span>
                <small>{appearance.customNotifications ? "开" : "关"}</small>
              </div>
            </div>
          </div>
        </div>
      )}
      {subPage === "media" && (
        <div className="settings-page anim-fade-up">
          <Header title="共享媒体" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            {media.length === 0 && <p style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>暂无共享媒体</p>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, padding: 16 }}>
              {media.map((item) => (
                <div key={item.id} style={{ aspectRatio: "1", background: "var(--gray-100)", borderRadius: 6, display: "grid", placeItems: "center", fontSize: 11, color: "var(--gray-500)", overflow: "hidden" }}>
                  {item.mimeType.startsWith("image/") ? <img src={`/api/attachments/${item.id}`} alt={item.originalName} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span>{item.originalName}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {subPage === "commonGroups" && (
        <div className="settings-page anim-fade-up">
          <Header title="共同群组" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            {commonGroups.length === 0 && <p style={{ color: "var(--gray-500)", textAlign: "center", padding: 24 }}>暂无共同群组</p>}
            <div className="settings-list">
              {commonGroups.map((g) => (
                <div className="settings-list-item" key={g.id}>
                  <Avatar name={g.name} image={g.avatar} size="small" />
                  <span>{g.name}</span>
                  <small>{g.memberCount} 人</small>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RequestsModal({ contacts, currentUserId, onClose, onContactsChanged }: {
  contacts: Contact[];
  currentUserId: string;
  onClose: () => void;
  onContactsChanged: (contacts: Contact[]) => void;
}) {
  const [section, setSection] = useState<"friends" | "groups">("friends");
  const [groupRequests, setGroupRequests] = useState<JoinRequest[]>([]);
  const [myGroupRequests, setMyGroupRequests] = useState<JoinRequest[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [error, setError] = useState("");
  const incoming = contacts.filter((contact) => contact.status === "pending" && contact.requestedBy !== currentUserId);
  const outgoing = contacts.filter((contact) => contact.status === "pending" && contact.requestedBy === currentUserId);
  useEffect(() => {
    Promise.all([api.listAllJoinRequests(), api.listMyJoinRequests().catch(() => [])])
      .then(([incomingRequests, ownRequests]) => {
        setGroupRequests(incomingRequests);
        setMyGroupRequests(ownRequests);
      })
      .catch((cause) => setError(errorText(cause)))
      .finally(() => setLoadingGroups(false));
    api.listContacts().then(onContactsChanged).catch(() => {});
  }, []);
  const reviewFriend = async (contactId: string, accept: boolean) => {
    try {
      await api.reviewContactRequest(contactId, accept);
      onContactsChanged(await api.listContacts());
    } catch (cause) { setError(errorText(cause)); }
  };
  const reviewGroup = async (request: JoinRequest, decision: "approve" | "reject") => {
    try {
      const reason = undefined;
      await api.reviewJoinRequest(request.groupId, request.id, decision, reason);
      setGroupRequests((all) => all.filter((item) => item.id !== request.id));
    } catch (cause) { setError(errorText(cause)); }
  };
  return (
    <Modal title="申请" onClose={onClose}>
      <div className="modal-content">
        <div className="segmented request-tabs">
          <button className={section === "friends" ? "active" : ""} onClick={() => setSection("friends")}>好友申请</button>
          <button className={section === "groups" ? "active" : ""} onClick={() => setSection("groups")}>群聊申请</button>
        </div>
        {section === "friends" ? <>
          <h3>收到的申请 · {incoming.length}</h3>
          {incoming.length === 0 && <EmptyState>暂无新的好友申请</EmptyState>}
          {incoming.map((contact) => <div className="request-row" key={contact.id}>
            <Avatar name={contact.name} image={contact.avatar} size="small" /><span><strong>{contact.name}</strong><small>{contact.requestMessage || "请求添加你为好友"}</small></span>
            <button onClick={() => void reviewFriend(contact.id, false)}>拒绝</button><button className="approve" onClick={() => void reviewFriend(contact.id, true)}>同意</button>
          </div>)}
          <h3>已发送 · {outgoing.length}</h3>
          {outgoing.length === 0 && <EmptyState>暂无等待处理的好友申请</EmptyState>}
          {outgoing.map((contact) => <div className="member-row" key={contact.id}><Avatar name={contact.name} image={contact.avatar} size="small" /><span><strong>{contact.name}</strong><small>{contact.requestMessage || "好友申请已发送"}</small></span></div>)}
        </> : <>
          <h3>待审核入群申请 · {groupRequests.length}</h3>
          {loadingGroups && <p className="transfer-state">正在读取申请...</p>}
          {!loadingGroups && groupRequests.length === 0 && <EmptyState>暂无需要你审核的入群申请</EmptyState>}
          {groupRequests.map((request) => request.user && <div className="request-row" key={`${request.groupId}-${request.id}`}>
            <Avatar name={request.user.name} image={request.user.avatar} size="small" /><span><strong>{request.user.name}</strong><small>{request.groupName} · 群号 {request.groupNumber ?? request.groupId}{request.answer ? ` · ${request.answer}` : ""}</small></span>
            <button onClick={() => void reviewGroup(request, "reject")}>拒绝</button><button className="approve" onClick={() => void reviewGroup(request, "approve")}>批准</button>
          </div>)}
          <h3>我的入群申请 · {myGroupRequests.length}</h3>
          {myGroupRequests.length === 0 && <EmptyState>暂无已提交的入群申请</EmptyState>}
          {myGroupRequests.map((request) => <div className="member-row" key={`mine-${request.id}`}>
            <Avatar name={request.groupName ?? "群聊"} size="small" />
            <span><strong>{request.groupName}</strong><small>群号 {request.groupNumber ?? request.groupId} · {request.status === "approved" ? "已同意" : request.status === "rejected" ? `已拒绝：${request.rejectionReason}` : "等待审核"}</small></span>
          </div>)}
        </>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}

function JoinGroupModal({ onClose }: { onClose: () => void }) {
  const [groupId, setGroupId] = useState("");
  const [info, setInfo] = useState<GroupJoinInfo | null>(null);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [answer, setAnswer] = useState("");
  const [state, setState] = useState<"joined" | "pending" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lookup = async () => {
    setBusy(true);
    setError("");
    try {
      const [joinInfo, current] = await Promise.all([
        api.getGroupJoinInfo(groupId),
        api.me(),
      ]);
      setInfo(joinInfo);
      setPlatformAdmin(current.role === "platform-admin");
      setState(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="加入群聊" onClose={onClose}>
      <div className="modal-content">
        <label>
          群号
          <span className="inline-field">
            <input
              value={groupId}
              onChange={(e) => {
                setGroupId(e.target.value.trim());
                setInfo(null);
              }}
              placeholder="输入群号"
            />
            <button
              type="button"
              className="outline-button"
              disabled={!groupId || busy}
              onClick={() => void lookup()}
            >
              查询规则
            </button>
          </span>
        </label>
        {info && (
          <div className="join-info">
            <strong>{info.groupName}</strong>
            <small>
              {info.joinMode === "open"
                ? "开放加入"
                : info.joinMode === "approval"
                  ? "需要管理员审批"
                  : info.joinMode === "question"
                    ? "需要回答问题并审批"
                    : "已关闭加入"}
            </small>
            {info.joinQuestion && <p>入群问题：{info.joinQuestion}</p>}
          </div>
        )}
        {info?.joinMode === "question" && (
          <label>
            入群回答
            <textarea
              rows={3}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="请回答上方的入群问题"
            />
          </label>
        )}
        {state && (
          <p className="transfer-state">
            {state === "joined"
              ? "主人已公开加入群聊，请返回消息列表查看喵"
              : "入群申请已提交，正在等待管理员审批喵"}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <button
          className="primary-button"
          disabled={
            !info ||
            (info.joinMode === "closed" && !platformAdmin) ||
            busy ||
            Boolean(state) ||
            (info.joinMode === "question" && !answer.trim())
          }
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              if (platformAdmin) {
                await api.forceJoinGroup(groupId);
                setState("joined");
              } else
                setState(
                  (await api.joinGroup(groupId, answer.trim() || undefined))
                    .state,
                );
            } catch (cause) {
              setError(errorText(cause));
              setBusy(false);
            }
          }}
        >
          <Users />
          {platformAdmin ? "公开加入并取得群治理权" : "提交入群申请"}
        </button>
      </div>
    </Modal>
  );
}

function GroupSettingsPage({
  conversation,
  contacts,
  onBack,
  onSaved,
  onUpdated,
  onMembersChanged,
  onLeave,
  onDissolve,
  ownId,
  appearance,
  onAppearance,
}: {
  conversation: Conversation;
  contacts: Contact[];
  onBack: () => void;
  onSaved: (value: Conversation) => void;
  onUpdated: (value: Conversation) => void;
  onMembersChanged: (members: Conversation["members"]) => void;
  onLeave: () => void;
  onDissolve: () => void;
  ownId: string;
  appearance: ConversationAppearance;
  onAppearance: (value: ConversationAppearance) => void;
}) {
  const [settings, setSettings] = useState<GroupSettings>(
    { ...(conversation.groupSettings ?? { joinMode: "open" }), avatar: conversation.avatar ?? conversation.groupSettings?.avatar, description: conversation.description },
  );
  const [name, setName] = useState(conversation.name);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [members, setMembers] = useState(conversation.members);
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [muteTargetId, setMuteTargetId] = useState<string | null>(null);
  const [muteMinutes, setMuteMinutes] = useState("10");
  const [rejectTarget, setRejectTarget] = useState<JoinRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [subPage, setSubPage] = useState<string | null>(null);
  const [customSeconds, setCustomSeconds] = useState("");
  const [selectedSeconds, setSelectedSeconds] = useState(conversation.disappearingSeconds ?? 0);
  const [customSelected, setCustomSelected] = useState(false);
  const [chatColor, setChatColor] = useState(appearance.color);
  const [wallpaper, setWallpaper] = useState<string | null>(appearance.wallpaper ?? null);
  const [darkWallpaper, setDarkWallpaper] = useState(appearance.dimWallpaper);
  const avatarInput = useRef<HTMLInputElement>(null);
  const wallpaperInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handleBack = () => { if (subPage) setSubPage(null); else onBack(); };
    window.addEventListener(SETTINGS_BACK_EVENT, handleBack);
    return () => window.removeEventListener(SETTINGS_BACK_EVENT, handleBack);
  }, [subPage, onBack]);
  const inviteCandidates = contacts
    .filter((contact) => contact.status === "accepted" && !contact.blocked && !members.some((member) => member.id === contact.id))
    .sort((a, b) => (a.remark || a.name).localeCompare(b.remark || b.name, "zh-CN", { sensitivity: "base" }));
  useEffect(() => {
    if (conversation.canManage)
      api
        .listJoinRequests(conversation.id)
        .then(setRequests)
        .catch((cause) => setError(errorText(cause)));
  }, [conversation]);
  const review = async (id: string, decision: "approve" | "reject") => {
    try {
      await api.reviewJoinRequest(conversation.id, id, decision);
      setRequests((all) => all.filter((item) => item.id !== id));
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const saveSettings = async () => {
    setSaving(true);
    setError("");
    try {
      const next = await api.updateGroupSettings(conversation.id, { ...settings, name, description: settings.description ?? undefined });
      onSaved(next);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
  const owner = members.find((member) => member.groupRole === "owner");
  const admins = members.filter((member) => member.groupRole === "administrator").sort((a, b) => alphabetic(a.name, b.name));
  const regulars = members.filter((member) => member.groupRole === "member").sort((a, b) => alphabetic(a.name, b.name));
  const editingMember = members.find((item) => item.id === editingMemberId);
  const canManage = Boolean(conversation.canManage);
  const isOwner = conversation.viewerGroupRole === "owner";
  const disappearingLabel = (s?: number) => {
    if (!s || s <= 0) return "关";
    if (s < 60) return `${s}秒`;
    if (s < 3600) return `${s / 60}分钟`;
    if (s < 86400) return `${s / 3600}小时`;
    return `${s / 86400}天`;
  };
  const renderMemberRow = (member: GroupMember) => (
    <button
      type="button"
      className={`member-avatar-tile ${editingMemberId === member.id ? "active" : ""}`}
      key={member.id}
      onClick={() => setEditingMemberId((id) => (id === member.id ? null : member.id))}
      aria-label={`${member.name}${member.memberTitle ? `，${member.memberTitle}` : ""}`}
      title={member.name}
    >
      <Avatar name={member.name} image={member.avatar} size="small" />
      <small>{member.id === ownId ? "我" : member.name}</small>
      {member.memberLevel != null && member.memberLevel > 0 && <em>Lv{member.memberLevel}</em>}
    </button>
  );
  return (
    <div className="settings-page anim-fade-up">
      <Header title="" back={onBack} actions={canManage ? <IconButton label="编辑" onClick={() => setSubPage("edit")}><PenLine /></IconButton> : undefined} />
      <div className="settings-page-body group-settings-body">
        <div className="signal-profile-card">
          <div className="group-avatar-editor avatar-wrap">
            <Avatar name={conversation.name} image={settings.avatar ?? conversation.avatar} size="large" />
            {canManage && <button type="button" aria-label="更换群头像" disabled={avatarBusy} onClick={() => avatarInput.current?.click()}>{avatarBusy ? <LoaderCircle className="spin" /> : <Camera />}</button>}
            <input ref={avatarInput} type="file" accept="image/*" hidden onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; setAvatarBusy(true); try { const avatar = await readAvatar(file); setSettings({ ...settings, avatar }); onUpdated(await api.updateGroupAvatar(conversation.id, avatar)); } catch (cause) { setError(errorText(cause)); } finally { setAvatarBusy(false); } }} />
          </div>
          <h2>{conversation.name}</h2>
          <small style={{ color: "var(--gray-500)" }}>{conversation.description || "添加群组描述..."}</small>
        </div>
        <div className="signal-action-row">
          <button className="signal-action-btn" onClick={() => setSubPage("disappearing")}><Sparkles /><span>动态</span></button>
          <button className="signal-action-btn" onClick={() => void onSaved({ ...conversation, muted: !conversation.muted } as Conversation)}><Bell /><span>{conversation.muted ? "取消静音" : "静音"}</span></button>
        </div>
        <div className="settings-list">
          <div className="settings-list-item" onClick={() => setSubPage("disappearing")}><span>限时消息</span><small>{disappearingLabel(conversation.disappearingSeconds)}</small><ChevronRight /></div>
          <div className="settings-list-item" onClick={() => setSubPage("chatColor")}><span>聊天颜色与墙纸</span><ChevronRight /></div>
          <div className="settings-list-item" onClick={() => setSubPage("notify")}><span>声音与通知</span><small>{conversation.muted ? "静音" : "通知"}</small><ChevronRight /></div>
        </div>
        <h3 style={{ padding: "16px 16px 8px", fontSize: 13, color: "var(--gray-500)" }}>{members.length} 个成员</h3>
        {canManage && <div className="settings-list"><div className="settings-list-item" onClick={() => setInviteOpen(!inviteOpen)}><span>添加成员</span><ChevronRight /></div></div>}
        <div className="compact-panel member-directory">
          {owner && renderMemberRow(owner)}
          {admins.map(renderMemberRow)}
          {regulars.map(renderMemberRow)}
        </div>
        {canManage && <div className="settings-list">
          <div className="settings-list-item" onClick={() => setSubPage("title")}><span>成员标签</span><ChevronRight /></div>
          <div className="settings-list-item" onClick={() => setSubPage("requests")}><span>请求与邀请</span><small>{requests.length > 0 ? requests.length : ""}</small><ChevronRight /></div>
        </div>}
        {inviteOpen && canManage && <div className="compact-panel"><h3>邀请好友</h3>{inviteCandidates.length === 0 && <p className="empty-inline">没有可邀请的好友</p>}<div className="invite-friends compact-list">{inviteCandidates.map((contact) => <div className="member-row" key={contact.id}><Avatar name={contact.name} image={contact.avatar} size="small" /><span><strong>{contact.remark || contact.name}</strong></span><button className="outline-button" disabled={invitingId === contact.id} onClick={async () => { setInvitingId(contact.id); try { await api.addGroupMember(conversation.id, contact.id); setMembers((all) => { const next = [...all, { ...contact, groupRole: "member" as const, forced: false, memberLevel: 1 }]; onMembersChanged(next); return next; }); } catch (cause) { setError(errorText(cause)); } finally { setInvitingId(null); } }}>邀请</button></div>)}</div></div>}
        {canManage && editingMemberId && editingMember && editingMember.groupRole !== "owner" && (
          <div className="compact-panel member-editor">
            <div className="member-row"><Avatar name={editingMember.name} image={editingMember.avatar} size="small" /><span><strong>{editingMember.name}</strong><small>成员管理</small></span><IconButton label="关闭" onClick={() => setEditingMemberId(null)}><X /></IconButton></div>
            <div className="member-governance">
              {isOwner && <button className="outline-button" onClick={async () => { try { const next: "member" | "moderator" = editingMember.groupRole === "administrator" ? "member" : "moderator"; await api.setGroupMemberRole(conversation.id, editingMember.id, next); setMembers((all) => all.map((item) => item.id === editingMember.id ? { ...item, groupRole: next === "moderator" ? "administrator" : "member" } : item)); setEditingMemberId(null); } catch (cause) { setError(errorText(cause)); } }}>{editingMember.groupRole === "administrator" ? "撤销管理员" : "设为管理员"}</button>}
              {editingMember.moderation?.mutedUntil && new Date(editingMember.moderation.mutedUntil).getTime() > Date.now() ? (
                <button className="outline-button" onClick={async () => { try { await api.unmuteGroupMember(conversation.id, editingMember.id); setMembers((all) => all.map((item) => item.id === editingMember.id ? { ...item, moderation: { ...item.moderation, mutedUntil: undefined } } : item)); } catch (cause) { setError(errorText(cause)); } }}>解除禁言</button>
              ) : <button className="outline-button" onClick={() => setMuteTargetId(editingMember.id)}>禁言</button>}
              {isOwner && <button className="danger-button" onClick={async () => { try { await api.removeGroupMember(conversation.id, editingMember.id); setMembers((all) => { const next = all.filter((item) => item.id !== editingMember.id); onMembersChanged(next); return next; }); setEditingMemberId(null); } catch (cause) { setError(errorText(cause)); } }}>移出群聊</button>}
            </div>
            <div className="member-edit-fields"><input aria-label="头衔" maxLength={20} defaultValue={editingMember.memberTitle ?? ""} placeholder="头衔" data-member-title={editingMember.id} /><input aria-label="等级" type="number" min={1} max={100} defaultValue={editingMember.memberLevel ?? 1} data-member-level={editingMember.id} /><button className="outline-button" onClick={async () => { try { const title = (document.querySelector(`[data-member-title="${editingMember.id}"]`) as HTMLInputElement)?.value ?? ""; const level = Number((document.querySelector(`[data-member-level="${editingMember.id}"]`) as HTMLInputElement)?.value ?? 1); await api.updateGroupMemberProfile(conversation.id, editingMember.id, title, level); setMembers((all) => all.map((item) => item.id === editingMember.id ? { ...item, memberTitle: title, memberLevel: level } : item)); } catch (cause) { setError(errorText(cause)); } }}>保存</button></div>
          </div>
        )}
        <div className="settings-list" style={{ marginTop: 16 }}>
          <div className="settings-list-item danger-text" onClick={onLeave}><span>离开群组</span></div>
          {isOwner && <div className="settings-list-item danger-text" onClick={onDissolve}><span>解散群组</span></div>}
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
      {subPage === "edit" && (
        <div className="settings-page anim-fade-up">
          <Header title="编辑群资料" back={() => setSubPage(null)} />
          <div className="settings-page-body"><div className="modal-content settings-content">
            <label>群名称<input maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>群描述<textarea rows={4} maxLength={300} value={settings.description ?? ""} onChange={(event) => setSettings({ ...settings, description: event.target.value })} /></label>
            <SelectField label="入群方式" value={settings.joinMode} options={[{ value: "open", label: "开放加入" }, { value: "approval", label: "管理员审批" }, { value: "question", label: "问题验证" }, { value: "closed", label: "关闭加入" }]} onChange={(value) => setSettings({ ...settings, joinMode: value as GroupSettings["joinMode"] })} />
            {settings.joinMode === "question" && <><label>入群问题<input maxLength={300} value={settings.joinQuestion ?? ""} onChange={(event) => setSettings({ ...settings, joinQuestion: event.target.value })} /></label><div className="settings-list-item"><span>自动审核答案</span><Toggle label="自动审核答案" checked={Boolean(settings.autoReview)} onChange={(value) => setSettings({ ...settings, autoReview: value })} /></div>{settings.autoReview && <label>标准答案<input maxLength={300} value={settings.joinAnswer ?? ""} onChange={(event) => setSettings({ ...settings, joinAnswer: event.target.value })} /></label>}</>}
            <button className="primary-button" disabled={saving || !name.trim()} onClick={() => void saveSettings()}>{saving ? <LoaderCircle className="spin" /> : <Check />}保存群资料</button>
            {error && <p className="form-error">{error}</p>}
          </div></div>
        </div>
      )}
      {subPage === "disappearing" && (
        <div className="settings-page anim-fade-up">
          <Header title="限时消息" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--gray-500)" }}>如果启用，该聊天中收发的新消息将在查看之后消失。</p>
            {[{ v: 0, l: "关" }, { v: 2419200, l: "4 周" }, { v: 604800, l: "1 周" }, { v: 86400, l: "1 天" }, { v: 28800, l: "8 小时" }, { v: 3600, l: "1 小时" }, { v: 300, l: "5分钟" }, { v: 30, l: "30秒" }].map(({ v, l }) => (
              <label key={v} className="radio-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer" }}>
                <input type="radio" name="disappearing" checked={!customSelected && selectedSeconds === v} onChange={() => { setSelectedSeconds(v); setCustomSelected(false); }} style={{ width: 20, height: 20, accentColor: "var(--color-primary)" }} />
                <span style={{ fontSize: 15 }}>{l}</span>
              </label>
            ))}
            <label className="radio-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer" }}>
              <input type="radio" name="disappearing" checked={customSelected} onChange={() => setCustomSelected(true)} style={{ width: 20, height: 20, accentColor: "var(--color-primary)" }} />
              <span style={{ fontSize: 15 }}>自定义时间</span>
            </label>
            <div style={{ padding: "0 16px", display: "flex", gap: 8, alignItems: "center" }}>
              <input type="number" min={1} placeholder="秒数" value={customSeconds} onChange={(e) => setCustomSeconds(e.target.value)} style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--gray-300)", fontSize: 14 }} />
              <span style={{ color: "var(--gray-500)", fontSize: 13 }}>秒</span>
            </div>
            <div style={{ padding: 16 }}>
              <button className="primary-button" style={{ width: "100%" }} onClick={async () => {
                try {
                  const seconds = customSelected ? Number(customSeconds) : selectedSeconds;
                  if (!Number.isInteger(seconds) || seconds < 0) throw new Error("请输入有效的限时秒数");
                  await api.setConversationDisappearing(conversation.id, seconds);
                  onSaved({ ...conversation, disappearingSeconds: seconds } as Conversation);
                  setSubPage(null);
                } catch (cause) { setError(errorText(cause)); }
              }}>保存</button>
            </div>
          </div>
        </div>
      )}
      {subPage === "chatColor" && (
        <div className="settings-page anim-fade-up">
          <Header title="聊天颜色与墙纸" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            <div style={{ padding: 16, textAlign: "center" }}>
              <div style={{ width: "100%", maxWidth: 280, margin: "0 auto", borderRadius: 12, overflow: "hidden", border: "1px solid var(--gray-700)", background: "var(--gray-900)", height: 320 }}>
                <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--gray-700)" }}>
                  <Avatar name={conversation.name} image={conversation.avatar} size="small" />
                  <span style={{ color: "var(--gray-300)", fontSize: 13 }}>{conversation.name}</span>
                </div>
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ background: "var(--gray-700)", borderRadius: 8, padding: "8px 12px", maxWidth: "70%", fontSize: 12, color: "var(--gray-400)" }}>对方消息</div>
                  <div style={{ background: chatColor, borderRadius: 8, padding: "8px 12px", maxWidth: "70%", marginLeft: "auto", fontSize: 12, color: "#fff" }}>我的消息</div>
                </div>
              </div>
            </div>
            <div className="settings-list">
              <div className="settings-list-item color-picker-row"><span>聊天颜色</span><ChatColorPicker value={chatColor} onChange={(value) => { setChatColor(value); onAppearance({ ...appearance, color: value }); }} /></div>
              <div className="settings-list-item" onClick={() => { setChatColor("#ec4899"); onAppearance({ ...appearance, color: "#ec4899" }); }}><span>重置聊天颜色</span></div>
            </div>
            <div className="settings-list" style={{ marginTop: 16 }}>
              <button className="settings-list-item" onClick={() => wallpaperInput.current?.click()}><span>设置墙纸</span><ChevronRight /></button>
              <input ref={wallpaperInput} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; const reader = new FileReader(); reader.onload = () => { const next = String(reader.result); setWallpaper(next); onAppearance({ ...appearance, wallpaper: next }); }; reader.readAsDataURL(file); }} />
              <div className="settings-list-item"><span>深色模式暗淡墙纸</span><Toggle label="深色模式暗淡墙纸" checked={darkWallpaper} onChange={(value) => { setDarkWallpaper(value); onAppearance({ ...appearance, dimWallpaper: value }); }} /></div>
              <div className="settings-list-item" onClick={() => { setWallpaper(null); onAppearance({ ...appearance, wallpaper: undefined }); }}><span>重置墙纸</span></div>
            </div>
          </div>
        </div>
      )}
      {subPage === "notify" && (
        <div className="settings-page anim-fade-up">
          <Header title="声音与通知" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            <div className="settings-list">
              <div className="settings-list-item" onClick={async () => {
                const muted = !conversation.muted;
                await api.setConversationMute(conversation.id, muted ? Date.now() + 365 * 24 * 60 * 60_000 : null);
                onSaved({ ...conversation, muted } as Conversation);
              }}>
                <Bell style={{ width: 20, height: 20 }} />
                <span>静音通知</span>
                <small>{conversation.muted ? "已静音" : "未静音"}</small>
              </div>
               <div className="settings-list-item" onClick={() => onAppearance({ ...appearance, mentionNotifications: !appearance.mentionNotifications })}>
                <AtSign style={{ width: 20, height: 20 }} />
                <span>提及我</span>
                <small>{appearance.mentionNotifications ? "总是通知" : "遵循静音"}</small>
              </div>
              <div className="settings-list-item" onClick={() => onAppearance({ ...appearance, customNotifications: !appearance.customNotifications })}>
                <Volume2 style={{ width: 20, height: 20 }} />
                <span>自定义通知</span>
                <small>{appearance.customNotifications ? "开" : "关"}</small>
              </div>
            </div>
          </div>
        </div>
      )}
      {subPage === "title" && (
        <div className="settings-page anim-fade-up">
          <Header title="成员标签" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            <p style={{ margin: "0 0 12px", padding: "0 16px", fontSize: 13, color: "var(--gray-500)" }}>点击成员编辑头衔和等级</p>
            <div className="compact-panel member-directory">
              {owner && renderMemberRow(owner)}
              {admins.map(renderMemberRow)}
              {regulars.map(renderMemberRow)}
            </div>
          </div>
        </div>
      )}
      {subPage === "requests" && (
        <div className="settings-page anim-fade-up">
          <Header title="请求与邀请" back={() => setSubPage(null)} />
          <div className="settings-page-body">
            {(
              <div style={{ padding: "0 16px" }}>
                <h3 style={{ fontSize: 13, color: "var(--gray-500)", marginBottom: 8 }}>待处理成员请求</h3>
                {requests.length === 0 && <p style={{ color: "var(--gray-500)", fontSize: 13 }}>没有成员请求。</p>}
                {requests.map((request) => request.user && (
                  <div className="member-row" key={request.id}>
                    <Avatar name={request.user.name} image={request.user.avatar} size="small" />
                    <span style={{ flex: 1 }}>
                      <strong>{request.user.name}</strong>
                      <small>{request.answer ? `回答：${request.answer}` : "未填写入群回答"}</small>
                    </span>
                    <button className="outline-button" onClick={() => setRejectTarget(request)}>拒绝</button>
                    <button className="primary-button" onClick={() => void review(request.id, "approve")}>批准</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {muteTargetId && (() => {
        const target = members.find((item) => item.id === muteTargetId);
        if (!target) return null;
        return <Modal title="禁言成员" onClose={() => setMuteTargetId(null)}>
          <div className="modal-content">
            <p style={{ margin: "0 0 10px" }}>将 <strong>{target.name}</strong> 禁言多久？</p>
            <div className="mute-duration-row">
              {[5, 10, 30, 60, 1440].map((minutes) => (
                <button type="button" key={minutes} className={`outline-button ${Number(muteMinutes) === minutes ? "active" : ""}`} onClick={() => setMuteMinutes(String(minutes))}>
                  {minutes >= 1440 ? "1 天" : `${minutes} 分钟`}
                </button>
              ))}
            </div>
            <label>自定义分钟数<input type="number" min={1} max={43200} value={muteMinutes} onChange={(e) => setMuteMinutes(e.target.value)} /></label>
            <div className="button-row">
              <button type="button" className="outline-button" onClick={() => setMuteTargetId(null)}>取消</button>
              <button type="button" className="danger-button" disabled={!Number(muteMinutes) || Number(muteMinutes) <= 0} onClick={async () => {
                setError("");
                try {
                  const minutes = Number(muteMinutes);
                  await api.muteGroupMember(conversation.id, target.id, Date.now() + minutes * 60_000);
                  setMembers((all) => all.map((item) => item.id === target.id ? { ...item, moderation: { ...item.moderation, mutedUntil: new Date(Date.now() + minutes * 60_000).toISOString() } } : item));
                  setMuteTargetId(null);
                  setEditingMemberId(null);
                } catch (cause) { setError(errorText(cause)); }
              }}>
                <BellOff />
                确认禁言
              </button>
            </div>
          </div>
        </Modal>;
      })()}
      {rejectTarget && (
        <Modal title="拒绝入群申请" onClose={() => setRejectTarget(null)}>
          <div className="modal-content">
            <label>拒绝理由<textarea rows={2} maxLength={300} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="申请人可见" /></label>
            <div className="button-row">
              <button type="button" className="outline-button" onClick={() => setRejectTarget(null)}>取消</button>
              <button type="button" className="danger-button" disabled={!rejectReason.trim()} onClick={() => {
                void api.reviewJoinRequest(conversation.id, rejectTarget.id, "reject", rejectReason.trim())
                  .then(() => { setRequests((all) => all.filter((item) => item.id !== rejectTarget.id)); setRejectTarget(null); setRejectReason(""); })
                  .catch((cause) => setError(errorText(cause)));
              }}>确认拒绝</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

async function readAvatar(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 15_000_000) throw new Error("头像原图不能超过 15 MB");
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const next = new window.Image();
    next.onload = () => { URL.revokeObjectURL(url); resolve(next); };
    next.onerror = () => { URL.revokeObjectURL(url); reject(new Error("头像读取失败")); };
    next.src = url;
  });
  const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.82, 0.68, 0.54, 0.4]) {
    const result = canvas.toDataURL("image/webp", quality);
    if (result.length <= 96_000) return result;
  }
  throw new Error("头像图片过大，请选择尺寸较小的照片");
}

function ProfileModal({
  profile,
  onClose,
  onSave,
}: {
  profile: UserProfile;
  onClose: () => void;
  onSave: (profile: UserProfile) => void;
}) {
  const [draft, setDraft] = useState(profile);
  const avatarInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      onSave(
        await api.updateProfile({
          name: draft.name.trim(),
          bio: draft.bio,
          gender: draft.gender,
          avatar: draft.avatar,
        }),
      );
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="编辑资料"
      onClose={onClose}
      actions={
        <IconButton
          label={busy ? "保存中" : "保存资料"}
          onClick={() => void save()}
        >
          {busy ? <LoaderCircle className="spin" /> : <Check />}
        </IconButton>
      }
    >
      <div className="modal-content">
        <div className="profile-avatar-editor">
          <div className="avatar-wrap">
            <Avatar name={draft.name} image={draft.avatar} size="large" />
            <button type="button" aria-label="从相册更换头像" onClick={() => avatarInput.current?.click()}><Camera /></button>
          </div>
          <input
            ref={avatarInput}
            type="file"
            accept="image/*"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try { setDraft({ ...draft, avatar: await readAvatar(file) }); }
              catch (cause) { setError(errorText(cause)); }
            }}
          />
        </div>
        <label>
          昵称
          <input
            value={draft.name}
            maxLength={24}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          个人简介
          <textarea
            rows={3}
            maxLength={120}
            value={draft.bio}
            onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
          />
        </label>
        <fieldset className="gender-field">
          <legend>性别</legend>
          <div className="gender-picker" role="listbox" aria-label="性别">
            {([
              ["private", "不公开"],
              ["female", "女"],
              ["male", "男"],
              ["nonbinary", "非二元"],
            ] as Array<[Gender, string]>).map(([value, label]) => (
              <button
                type="button"
                role="option"
                aria-selected={draft.gender === value}
                className={draft.gender === value ? "active" : ""}
                key={value}
                onClick={() => setDraft({ ...draft, gender: value })}
              >
                <span>{label}</span>
                {draft.gender === value && <Check />}
              </button>
            ))}
          </div>
        </fieldset>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}

function SecuritySettings() {
  const [selfDestruct, setSelfDestruct] = useState("");
  const [autoDelete, setAutoDelete] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deleteStep, setDeleteStep] = useState<"initial" | "typed" | "final" | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [pinEnabled, setPinEnabled] = useState(false);
  const [pinNew, setPinNew] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  useEffect(() => { void getPinHash().then((hash) => setPinEnabled(Boolean(hash))).catch(() => {}); }, []);
  useEffect(() => {
    void api
      .getSecuritySettings()
      .then(({ settings }) => {
        setSelfDestruct(
          settings.selfDestructDays ? String(settings.selfDestructDays) : "",
        );
        setAutoDelete(
          settings.messageAutoDeleteSeconds
            ? String(settings.messageAutoDeleteSeconds)
            : "",
        );
      })
      .catch(() => setMessage("主人，安全设置暂时无法读取喵"));
  }, []);
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.updateSecuritySettings({
        selfDestructDays: selfDestruct ? Number(selfDestruct) : null,
        messageAutoDeleteSeconds: autoDelete ? Number(autoDelete) : null,
      });
      setMessage("安全设置已保存喵");
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const deleteAccount = async () => {
    try {
      await api.deleteAccount();
      await clearSession();
      window.location.reload();
    } catch (cause) {
      setMessage(errorText(cause));
    }
  };
  return (
    <>
      <section className="security-settings">
        <h3>高级安全</h3>
        <p className="setting-note">
          主人可以设置长期不登录自动销毁账号，以及本机已解密聊天记录的自动清理时间。服务器不会读取端到端加密正文喵
        </p>
      <SelectField
          label="长期不登录自动销毁"
          value={selfDestruct}
          options={[
            { value: "", label: "关闭" },
            { value: "30", label: "30 天" },
            { value: "90", label: "90 天" },
            { value: "180", label: "180 天" },
            { value: "365", label: "365 天" },
          ]}
          onChange={setSelfDestruct}
        />
      <SelectField
        label="本机聊天记录自动删除"
        value={autoDelete}
        options={[
          { value: "", label: "关闭" },
          { value: "86400", label: "1 天" },
          { value: "604800", label: "7 天" },
          { value: "2592000", label: "30 天" },
        ]}
        onChange={setAutoDelete}
      />
      <button
        className="outline-button"
        disabled={busy}
        onClick={() => void save()}
      >
        <ShieldCheck />
        保存安全设置
      </button>
      {message && <p className="form-error">{message}</p>}
        <div className="pin-settings">
          <h3>应用锁</h3>
          <p className="setting-note">设置 4-6 位数字 PIN 码，打开应用时需输入才能使用</p>
          {pinEnabled ? (
            <>
              <button className="setting-link" onClick={() => void (async () => { await clearPin(); setPinEnabled(false); setPinNew(""); setPinConfirm(""); setMessage("应用锁已关闭喵"); })()}>
                <span><LockKeyhole /><span><strong>关闭应用锁</strong><small>下次打开应用不再需要 PIN 码</small></span></span><ChevronRight />
              </button>
            </>
          ) : (
            <div className="pin-form">
              <label>设置 PIN 码<input inputMode="numeric" maxLength={6} value={pinNew} onChange={(e) => setPinNew(e.target.value.replace(/\D/g, ""))} placeholder="4-6 位数字" /></label>
              <label>确认 PIN 码<input inputMode="numeric" maxLength={6} value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ""))} placeholder="再次输入" /></label>
              <button className="outline-button" disabled={pinBusy || pinNew.length < 4 || pinNew !== pinConfirm} onClick={async () => {
                setPinBusy(true);
                setMessage("");
                try {
                  await setPin(pinNew);
                  setPinEnabled(true);
                  setPinNew("");
                  setPinConfirm("");
                  setMessage("应用锁已开启喵");
                } catch (cause) { setMessage(errorText(cause)); }
                finally { setPinBusy(false); }
              }}>开启应用锁</button>
            </div>
          )}
        </div>
        <button className="danger-button" onClick={() => setDeleteStep("initial")}>
          <Trash2 />
          注销账号
        </button>
      </section>
      {deleteStep === "initial" && (
        <ConfirmModal
          title="确认注销账号"
          message="注销账号会删除账号资料、联系人和服务器上的密文队列，确定继续吗？"
          confirmLabel="继续注销"
          danger
          onClose={() => setDeleteStep(null)}
          onConfirm={() => setDeleteStep("typed")}
        />
      )}
      {deleteStep === "typed" && (
        <ConfirmModal
          title="输入注销确认文字"
          message="请输入“我确认注销账号”，确认你了解此操作无法恢复。"
          confirmLabel="继续"
          danger
          onClose={() => setDeleteStep(null)}
          onConfirm={() => {
            if (deleteText !== "我确认注销账号") {
              setMessage("确认文字不正确，账号没有注销喵");
              return;
            }
            setDeleteStep("final");
          }}
        >
          <input
            autoFocus
            value={deleteText}
            onChange={(event) => setDeleteText(event.target.value)}
            placeholder="我确认注销账号"
          />
        </ConfirmModal>
      )}
      {deleteStep === "final" && (
        <ConfirmModal
          title="最后一次确认"
          message="账号注销后无法恢复，所有服务器资料会被删除。确定删除吗？"
          confirmLabel="永久注销"
          danger
          onClose={() => setDeleteStep(null)}
          onConfirm={() => {
            setDeleteStep(null);
            void deleteAccount();
          }}
        />
      )}
    </>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async () => {
    if (newPassword.length < 10) return setMessage("新密码至少需要 10 位");
    if (newPassword !== confirm) return setMessage("两次输入的新密码不一致喵");
    setBusy(true);
    setMessage("");
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setMessage("密码已更新喵");
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="security-settings">
      <h3>修改密码</h3>
      <p className="setting-note">
        主人可以随时更换密码，服务器只保存加密后的哈希，不会保存明文喵
      </p>
      <label>
        当前密码
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="输入当前密码"
        />
      </label>
      <label>
        新密码
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="至少 10 位"
        />
      </label>
      <label>
        确认新密码
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="再次输入新密码"
        />
      </label>
      <button
        className="outline-button"
        disabled={
          busy ||
          !currentPassword ||
          newPassword.length < 10 ||
          newPassword !== confirm
        }
        onClick={() => void submit()}
      >
        <KeyRound />
        更新密码
      </button>
      {message && <p className="form-error">{message}</p>}
    </section>
  );
}

type ReleaseInfo = {
  id: number;
  versionName: string;
  versionCode: number;
  fileSize: number;
  sha256: string;
  notes: string;
  forceUpdate: boolean;
  publishedAt: string;
  downloadUrl: string;
};

function formatReleaseSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function UpdateModal({
  release,
  onClose,
}: {
  release: ReleaseInfo;
  onClose: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const canClose = !release.forceUpdate;
  return (
    <Modal title="需要更新版本" onClose={canClose ? onClose : () => undefined}>
      <div className="modal-content update-content">
        <Info />
        <p>
          主人，发现新版本 <strong>v{release.versionName}</strong>
          （{formatReleaseSize(release.fileSize)}）
          {release.forceUpdate ? "，旧版本已停止服务，必须下载最新安装包才能继续使用喵" : "，可以现在更新，也可以稍后再说喵"}
        </p>
        {release.notes && (
          <div className="update-notes">
            <strong>更新说明</strong>
            <pre>{release.notes}</pre>
          </div>
        )}
        <div className="button-row">
          {canClose && (
            <button className="outline-button" onClick={onClose}>
              稍后再说
            </button>
          )}
          <button
            className="primary-button"
            disabled={downloading}
            onClick={async () => {
              setDownloading(true);
              try {
                const url = api.downloadReleaseUrl(release);
                if (Capacitor.isNativePlatform()) await Browser.open({ url });
                else window.location.assign(url);
              } finally {
                setDownloading(false);
              }
            }}
          >
            在系统浏览器中下载
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SettingsPage({
  contacts,
  preferences,
  onPreferences,
  conversations,
  appearance,
  onAppearance,
  onProfile,
  onBack,
  onClear,
  onCheckUpdate,
  onLogout,
  cleared,
  clearing,
}: {
  contacts: Contact[];
  preferences: AppPreferences;
  onPreferences: (patch: Partial<AppPreferences>) => void;
  conversations: Conversation[];
  appearance: AppearanceSettings & { backgroundUrl?: string };
  onAppearance: (value: AppearanceSettings) => Promise<void>;
  onProfile: (value: UserProfile) => void;
  onBack: () => void;
  onClear: () => void;
  onCheckUpdate: () => void;
  onLogout: () => void;
  cleared: boolean;
  clearing: boolean;
}) {
  const [sub, setSub] = useState<string | null>(null);
  useEffect(() => {
    const handleBack = () => { if (sub) setSub(null); else onBack(); };
    window.addEventListener(SETTINGS_BACK_EVENT, handleBack);
    return () => window.removeEventListener(SETTINGS_BACK_EVENT, handleBack);
  }, [sub, onBack]);
  if (sub === "appearance") return <AppearancePage appearance={appearance} onAppearance={onAppearance} onBack={() => setSub(null)} />;
  if (sub === "chat") return <ChatSettingsPage preferences={preferences} onPreferences={onPreferences} conversations={conversations} onBack={() => setSub(null)} />;
  if (sub === "stories") return <StoriesSettingsPage preferences={preferences} onPreferences={onPreferences} onBack={() => setSub(null)} />;
  if (sub === "notifications") return <NotificationSettingsPage preferences={preferences} onPreferences={onPreferences} onBack={() => setSub(null)} />;
  if (sub === "privacy") return <PrivacySettingsPage contacts={contacts} preferences={preferences} onPreferences={onPreferences} onProfile={onProfile} onBack={() => setSub(null)} />;
  if (sub === "backup") return <BackupPage conversations={conversations} onBack={() => setSub(null)} />;
  if (sub === "data") return <DataStoragePage onClear={onClear} onCheckUpdate={onCheckUpdate} cleared={cleared} clearing={clearing} onBack={() => setSub(null)} />;
  if (sub === "security") return <SecuritySettingsPage onBack={() => setSub(null)} />;
  return (
    <div className="settings-page anim-fade-up">
      <Header title="设置" back={onBack} />
      <div className="settings-page-body">
        <div className="settings-list">
          <button className="settings-list-item" onClick={() => setSub("appearance")}><span className="settings-icon"><PaintBucket /></span><span>外观</span><ChevronRight /></button>
          <button className="settings-list-item" onClick={() => setSub("chat")}><span className="settings-icon"><MessageCircle /></span><span>聊天</span><ChevronRight /></button>
          <button className="settings-list-item" onClick={() => setSub("stories")}><span className="settings-icon"><Sparkles /></span><span>动态</span><ChevronRight /></button>
          <button className="settings-list-item" onClick={() => setSub("notifications")}><span className="settings-icon"><Bell /></span><span>通知</span><ChevronRight /></button>
          <button className="settings-list-item" onClick={() => setSub("privacy")}><span className="settings-icon"><Lock /></span><span>隐私</span><ChevronRight /></button>
          <button className="settings-list-item" onClick={() => setSub("backup")}><span className="settings-icon"><Clock /></span><span>备份</span><ChevronRight /></button>
          <button className="settings-list-item" onClick={() => setSub("data")}><span className="settings-icon"><Database /></span><span>数据和存储</span><ChevronRight /></button>
          <button className="settings-list-item" onClick={() => setSub("security")}><span className="settings-icon"><ShieldCheck /></span><span>安全</span><ChevronRight /></button>
        </div>
        <button className="logout-link" onClick={onLogout}>
          <LogOut />
          退出登录
        </button>
      </div>
    </div>
  );
}

function AppearancePage({ appearance, onAppearance, onBack }: { appearance: AppearanceSettings & { backgroundUrl?: string }; onAppearance: (v: AppearanceSettings) => Promise<void>; onBack: () => void }) {
  const backgroundInput = useRef<HTMLInputElement>(null);
  const { schemes, schemeId, changeScheme } = useBackground();
  return (
    <div className="settings-page anim-fade-up">
      <Header title="外观" back={onBack} />
      <div className="settings-page-body">
        <div className="modal-content settings-content">
          <div className="settings-list-item" onClick={() => backgroundInput.current?.click()}><span>聊天颜色与墙纸</span><small>{appearance.background ? "已自定义" : "默认"}</small></div>
          <input ref={backgroundInput} hidden type="file" accept="image/*" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; await onAppearance({ theme: appearance.theme, background: file, blurEnabled: appearance.blurEnabled, blurStrength: appearance.blurStrength }); }} />
          {appearance.background && <>
            <div className="settings-list-item"><span>背景模糊</span><Toggle label="背景模糊" checked={appearance.blurEnabled} onChange={(blurEnabled) => void onAppearance({ ...appearance, blurEnabled })} /></div>
            <label className="range-setting">模糊程度 <span>{appearance.blurStrength}px</span><input type="range" min="0" max="24" step="1" value={appearance.blurStrength} disabled={!appearance.blurEnabled} onChange={(event) => void onAppearance({ ...appearance, blurStrength: Number(event.target.value) })} /></label>
          </>}
          <fieldset className="theme-setting"><legend>主题</legend><div className="segmented theme-picker">{([['system','系统默认'],['light','浅色'],['dark','深色']] as const).map(([value, label]) => <button type="button" key={value} className={appearance.theme === value ? "active" : ""} onClick={() => void onAppearance({ theme: value, background: appearance.background, blurEnabled: appearance.blurEnabled, blurStrength: appearance.blurStrength })}>{label}</button>)}</div></fieldset>
          <fieldset className="theme-setting"><legend>配色方案</legend><div className="scheme-picker">{schemes.map((scheme) => <button type="button" key={scheme.id} className={scheme.id === schemeId ? "active" : ""} onClick={() => changeScheme(scheme.id)}><i style={{ background: scheme.background }} /><span><strong>{scheme.name}</strong><small>{scheme.description}</small></span></button>)}</div></fieldset>
        </div>
      </div>
    </div>
  );
}

function ChatSettingsPage({ preferences, onPreferences, conversations, onBack }: { preferences: AppPreferences; onPreferences: (patch: Partial<AppPreferences>) => void; conversations: Conversation[]; onBack: () => void }) {
  const exportChats = async () => {
    const records = await Promise.all(conversations.map(async (conversation) => ({ conversationId: conversation.id, messages: await loadHistory(conversation.id) })));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), conversations: records }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `lanmiao-chat-export-${Date.now()}.json`; anchor.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="settings-page anim-fade-up">
      <Header title="聊天" back={onBack} />
      <div className="settings-page-body">
        <div className="modal-content settings-content">
          <h3 style={{ padding: "16px 16px 8px", fontSize: 13, color: "var(--gray-500)" }}>导出聊天记录</h3>
          <button className="settings-list-item" onClick={() => void exportChats()}><span>导出聊天记录</span><small>下载当前会话的本地 JSON 副本</small><Download /></button>
          <h3 style={{ padding: "16px 16px 8px", fontSize: 13, color: "var(--gray-500)" }}>键盘</h3>
          <div className="settings-list-item"><span>按输入键发送</span><Toggle label="" checked={preferences.enterToSend} onChange={(value) => onPreferences({ enterToSend: value })} /></div>
        </div>
      </div>
    </div>
  );
}

function NotificationSettingsPage({ preferences, onPreferences, onBack }: { preferences: AppPreferences; onPreferences: (patch: Partial<AppPreferences>) => void; onBack: () => void }) {
  return (
    <div className="settings-page anim-fade-up">
      <Header title="通知" back={onBack} />
      <div className="settings-page-body">
        <div className="modal-content settings-content">
          <div className="settings-list-item"><span>消息通知</span><Toggle label="" checked={preferences.messageNotifications} onChange={(value) => onPreferences({ messageNotifications: value })} /></div>
          <div className="settings-list-item"><span>群聊通知</span><Toggle label="" checked={preferences.groupNotifications} onChange={(value) => onPreferences({ groupNotifications: value })} /></div>
          <div className="settings-list-item"><span>来电通知</span><Toggle label="" checked={preferences.callNotifications} onChange={(value) => onPreferences({ callNotifications: value })} /></div>
          <h3 style={{ padding: "16px 16px 8px", fontSize: 13, color: "var(--gray-500)" }}>应用内通知</h3>
          <div className="settings-list-item"><span>通知声音</span><Toggle label="" checked={preferences.notificationSound} onChange={(value) => onPreferences({ notificationSound: value })} /></div>
          <div className="settings-list-item"><span>振动</span><Toggle label="" checked={preferences.vibration} onChange={(value) => onPreferences({ vibration: value })} /></div>
        </div>
      </div>
    </div>
  );
}

function PrivacySettingsPage({ contacts, preferences, onPreferences, onProfile, onBack }: { contacts: Contact[]; preferences: AppPreferences; onPreferences: (patch: Partial<AppPreferences>) => void; onProfile: (v: UserProfile) => void; onBack: () => void }) {
  const blockedCount = contacts.filter((c) => c.blocked).length;
  return (
    <div className="settings-page anim-fade-up">
      <Header title="隐私" back={onBack} />
      <div className="settings-page-body">
        <div className="modal-content settings-content">
          <div className="settings-list-item"><span>已屏蔽</span><small>{blockedCount} 个联系人或群组</small><ChevronRight /></div>
          <h3 style={{ padding: "16px 16px 8px", fontSize: 13, color: "var(--gray-500)" }}>消息传输</h3>
          <div className="settings-list-item"><span>已读回执</span><Toggle label="" checked={preferences.readReceipts} onChange={(value) => onPreferences({ readReceipts: value })} /></div>
          <div className="settings-list-item"><span>"正在输入"提示</span><Toggle label="" checked={preferences.typingIndicators} onChange={(value) => onPreferences({ typingIndicators: value })} /></div>
          <h3 style={{ padding: "16px 16px 8px", fontSize: 13, color: "var(--gray-500)" }}>高级</h3>
          <QqBindingSection />
          <ChangePasswordForm />
          {blockedCount > 0 && <section className="blocked-list"><h3>已拉黑的好友</h3>{contacts.filter((c) => c.blocked).map((c) => <div className="member-row" key={c.id}><Avatar name={c.name} image={c.avatar} /><span><strong>{c.remark || c.name}</strong><small>@{c.handle}</small></span><button className="outline-button" onClick={async () => { await api.updateContactPreferences(c.id, { blocked: false }); location.reload(); }}>解除拉黑</button></div>)}</section>}
        </div>
      </div>
    </div>
  );
}

function DataStoragePage({ onClear, onCheckUpdate, cleared, clearing, onBack }: { onClear: () => void; onCheckUpdate: () => void; cleared: boolean; clearing: boolean; onBack: () => void }) {
  return (
    <div className="settings-page anim-fade-up">
      <Header title="数据和存储" back={onBack} />
      <div className="settings-page-body">
        <div className="modal-content settings-content">
          <div className="settings-list-item" onClick={onClear}><span>管理存储</span><small>{clearing ? "正在清理..." : cleared ? "已清理" : "点击清理缓存"}</small><ChevronRight /></div>
          <span className="version" role="button" tabIndex={0} onClick={onCheckUpdate} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCheckUpdate(); } }}>蓝喵速递 {APP_VERSION_NAME} · 检查更新</span>
        </div>
      </div>
    </div>
  );
}

function SecuritySettingsPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="settings-page anim-fade-up">
      <Header title="安全" back={onBack} />
      <div className="settings-page-body">
        <div className="modal-content settings-content">
          <SecuritySettings />
          <div className="setting-note"><Info /><p>身份私钥不会在清理缓存时删除。卸载应用会移除本机密钥，请先确认其他设备可用。</p></div>
        </div>
      </div>
    </div>
  );
}

function BackupPage({ conversations, onBack }: { conversations: Conversation[]; onBack: () => void }) {
  const backup = async () => {
    const data = { type: "local-plain-backup", createdAt: new Date().toISOString(), conversations: await Promise.all(conversations.map(async (conversation) => ({ conversationId: conversation.id, messages: await loadHistory(conversation.id) }))) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `lanmiao-local-backup-${Date.now()}.json`; anchor.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="settings-page anim-fade-up">
      <Header title="备份" back={onBack} />
      <div className="settings-page-body">
        <div className="modal-content settings-content">
          <p style={{ padding: "16px", fontSize: 13, color: "var(--gray-500)" }}>备份消息记录可以确保您在更换手机或重装蓝喵速递时不会丢失数据。</p>
          <div className="settings-list-item"><span>本地明文备份</span><small>仅下载到当前设备，不上传云端</small><Download /></div>
          <div style={{ padding: "0 16px 16px" }}><button className="outline-button" onClick={() => void backup()}><Download />下载本地备份</button></div>
        </div>
      </div>
    </div>
  );
}

function StoriesSettingsPage({ preferences, onPreferences, onBack }: { preferences: AppPreferences; onPreferences: (patch: Partial<AppPreferences>) => void; onBack: () => void }) {
  return (
    <div className="settings-page anim-fade-up">
      <Header title="动态" back={onBack} />
      <div className="settings-page-body">
        <div className="modal-content settings-content">
          <p style={{ padding: "16px", fontSize: 13, color: "var(--gray-500)" }}>动态更新将会在 24 小时后自动消失。请选择谁可以查看您的动态，或创建对特定访客或群组可见的新动态。</p>
          <div className="settings-list-item"><span>浏览回执</span><Toggle label="" checked={preferences.storyViewReceipts} onChange={(value) => onPreferences({ storyViewReceipts: value })} /></div>
        </div>
      </div>
    </div>
  );
}

function QqBindingSection() {
  const [boundNumber, setBoundNumber] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api.getQqBinding()
      .then((state) => setBoundNumber(state.bound ? state.qqNumber : null))
      .catch((cause) => setError(errorText(cause)));
  }, []);
  return (
    <section className="qq-binding-section">
      <div className="setting-row qq-binding-heading">
        <span>
          <BadgeCheck />
          <span><strong>已绑定 QQ</strong><small>注册验证时绑定，当前不可重复绑定</small></span>
        </span>
        <strong className="qq-bound-value">{boundNumber ?? "正在读取..."}</strong>
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

function QqBindingGate({ onBound }: { onBound: (profile: UserProfile) => void }) {
  const [qqNumber, setQqNumber] = useState("");
  const [token, setToken] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState("");
  const create = async () => {
    if (!/^\d{5,12}$/.test(qqNumber)) {
      setError("请输入 5-12 位自己的 QQ 号");
      return;
    }
    try {
      const next = await api.createQqBindingRequest(qqNumber);
      setToken(next.token);
      setRemaining(next.ttlSeconds);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  useEffect(() => {
    if (!token) return;
    const timer = window.setInterval(async () => {
      try {
        const state = await api.getQqBinding();
        if (state.bound) {
          onBound(await api.me());
          return;
        }
        setRemaining(state.request?.remainingSeconds ?? 0);
        if (!state.request || state.request.remainingSeconds <= 0) {
          setToken("");
          setRemaining(0);
        }
      } catch (cause) {
        setError(errorText(cause));
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [token]);
  return (
    <main className="gate-page">
      <section className="gate-document qq-binding-gate">
        <span className="eyebrow">账号安全验证</span>
        <h1>绑定 QQ 后继续</h1>
        <p>请先填写自己的 QQ 号，获取登录密钥后到对应验证群发送命令完成绑定喵。</p>
        {!token && (
          <label>
            QQ 号
            <input inputMode="numeric" maxLength={12} value={qqNumber} onChange={(event) => setQqNumber(event.target.value.replace(/\D/g, ""))} placeholder="输入自己的 QQ 号" />
          </label>
        )}
        {token && <div className="qq-token-box">
          <code>/login {token}</code>
          <IconButton label="复制绑定命令" onClick={() => void copyText(`/login ${token}`)}><Copy /></IconButton>
        </div>}
        <p className="setting-note">{token ? `密钥剩余 ${remaining} 秒，绑定成功后会自动进入软件。` : "绑定后才能继续使用软件。"}</p>
        {error && <p className="form-error">{error}</p>}
        <button className="outline-button" onClick={() => void create()}><KeyRound />{token ? "重新生成登录密钥" : "获取登录密钥"}</button>
      </section>
    </main>
  );
}

function VipModal({
  onClose,
  onRedeemed,
}: {
  onClose: () => void;
  onRedeemed: (until: string) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const normalizeVipInput = (value: string) => value.match(/(?:LTSD|LTMY)-VIP-[A-Za-z0-9_-]{24}/)?.[0] ?? value.trim().toUpperCase();
  const validVipCode =
    /^(?:LTSD|LTMY)-VIP-[A-Za-z0-9_-]{24}$/.test(normalizeVipInput(code));
  return (
    <Modal title="兑换 VIP" onClose={onClose}>
      <div className="modal-content vip-content">
        <Crown className="vip-crown" />
        <h3>输入兑换码</h3>
        <p>主人，请输入 LTSD-VIP 开头的会员兑换码喵</p>
        <label>
          兑换码
          <input
            value={code}
            maxLength={64}
            onChange={(e) => setCode(normalizeVipInput(e.target.value))}
            placeholder="LTSD-VIP-..."
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button
          className="primary-button"
          disabled={busy || !validVipCode}
          onClick={async () => {
            setBusy(true);
            try {
                  onRedeemed((await api.redeemVip(normalizeVipInput(code))).vipUntil);
            } catch (cause) {
              setError(errorText(cause));
              setBusy(false);
            }
          }}
        >
          <BadgeCheck />
          立即兑换
        </button>
      </div>
    </Modal>
  );
}

function AttachmentModal({
  onClose,
  onSend,
  conversationId,
}: {
  onClose: () => void;
  onSend: (meta: AttachmentMeta) => Promise<void>;
  conversationId: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState("image/*");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const choose = (type: "image" | "video") => {
    setAccept(`${type}/*`);
    setError("");
    setTimeout(() => input.current?.click());
  };
  const selected = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setProgress(0);
    setError("");
    try {
      validateAttachment(file);
      const meta = await api.uploadAttachment(file, conversationId, setProgress);
      const cached = await cacheServerAttachment(meta, file);
      if (cached.localUrl) URL.revokeObjectURL(cached.localUrl);
      await onSend(meta);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <Modal title="发送图片" onClose={onClose}>
      <div className="modal-content attachment-picker">
        <button disabled={busy} onClick={() => choose("image")}>
          <span className="square-icon green">
            <FileImage />
          </span>
          <span>
            <strong>图片</strong>
            <small>JPG、PNG、WebP、GIF，最大 200 MB</small>
          </span>
          <ChevronRight />
        </button>
        <button disabled={busy} onClick={() => choose("video")}>
          <span className="square-icon coral">
            <Video />
          </span>
          <span>
            <strong>视频</strong>
            <small>MP4、WebM，最大 500 MB</small>
          </span>
          <ChevronRight />
        </button>
        <input
          ref={input}
          hidden
          type="file"
          accept={accept}
          onChange={(e) => void selected(e.target.files?.[0])}
        />
        {busy && <p className="transfer-state">正在上传到服务器 · {progress}%</p>}
        {error && <p className="transfer-state">{error}</p>}
        <p className="picker-note">
          <Paperclip /> 图片和视频通过服务器中转发送，不经过端到端加密，发送后对方可直接查看喵
        </p>
      </div>
    </Modal>
  );
}

function formatBytes(bytes: number) {
  return bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

type VipOverage = {
  over: boolean;
  vip: boolean;
  ownedGroupLimit: number;
  memberLimit: number;
  ownedGroups: Array<{ id: number; name: string; memberCount: number }>;
};

function OverageModal({
  overage,
  onRefresh,
  onDeleted,
}: {
  overage: VipOverage;
  onRefresh: () => void;
  onDeleted: (groupId: string) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmGroupId, setConfirmGroupId] = useState<number | null>(null);
  const overGroups = overage.ownedGroups.filter(
    (group) =>
      group.memberCount > overage.memberLimit ||
      overage.ownedGroups.length > overage.ownedGroupLimit,
  );
  const remove = async (id: number) => {
    setBusyId(String(id));
    setError("");
    try {
      await onDeleted(String(id));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusyId(null);
    }
  };
  return (
    <>
      <Modal title="VIP 权益已到期" onClose={() => undefined}>
        <div className="modal-content">
        <Crown className="vip-crown" />
        <p>
          主人，VIP
          已经到期且没有续费，当前内容超出了普通权益。请先删除超出的内容，否则无法继续使用喵
        </p>
        <p className="setting-note">
          普通权益：最多创建 {overage.ownedGroupLimit} 个群聊，每个群最多{" "}
          {overage.memberLimit}{" "}
          位成员。超出的群聊可以解散，成员过多的群可以在群组治理里移除成员。
        </p>
        <div className="overage-groups">
          {overGroups.length === 0 ? (
            <p className="success-copy">检测到已不再超限，可以继续使用喵</p>
          ) : (
            overGroups.map((group) => (
              <div className="detail-row" key={group.id}>
                <div className="mini-main">
                  <strong>{group.name}</strong>
                  <span>
                    {group.memberCount} 位成员
                    {overage.ownedGroups.length > overage.ownedGroupLimit &&
                      " · 超出群聊数量上限"}
                  </span>
                </div>
                <button
                  type="button"
                  className="danger-button"
                  disabled={busyId === String(group.id)}
                  onClick={() => setConfirmGroupId(group.id)}
                >
                  解散群组
                </button>
              </div>
            ))
          )}
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="outline-button" onClick={onRefresh}>
          <Check />
          刷新检测
        </button>
        </div>
      </Modal>
      {confirmGroupId !== null && (
        <ConfirmModal
          title="确认解散群组"
          message="群内密文和成员关系都会被删除，确定解散这个群聊吗？"
          confirmLabel="解散群组"
          danger
          onClose={() => setConfirmGroupId(null)}
          onConfirm={() => {
            const id = confirmGroupId;
            setConfirmGroupId(null);
            void remove(id);
          }}
        />
      )}
    </>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [disclaimer, setDisclaimer] = useState<Disclaimer | null>(null);
  const [booting, setBooting] = useState(true);
  const [splashElapsed, setSplashElapsed] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("messages");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [statuses, setStatuses] = useState<StatusUpdate[]>([]);
  const [announcementDetail, setAnnouncementDetail] = useState<Announcement | null>(null);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [settingsPage, setSettingsPage] = useState<null | "group" | "contact" | "settings">(null);
  const [removeContactId, setRemoveContactId] = useState<string | null>(null);
  const [groupAction, setGroupAction] = useState<"leave" | "dissolve" | null>(null);
  const [appearance, setAppearance] = useState<AppearanceSettings>({ theme: "light", blurEnabled: false, blurStrength: 8 });
  const [preferences, setPreferences] = useState<AppPreferences>(defaultPreferences);
  const [backgroundUrl, setBackgroundUrl] = useState("");
  const [pinLocked, setPinLocked] = useState(false);
  const [pinError, setPinError] = useState("");
  const [callState, setCallState] = useState<CallState>({ status: "idle" });
  const [callElapsed, setCallElapsed] = useState(0);
  const [callLog, setCallLog] = useState<{ callId: string; peerId: string; duration: number; result: CallResult; message: string } | null>(null);
  const recordedCallsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!profile?.id) return;
    void loadPreferences(profile.id).then(setPreferences).catch(() => setPreferences(defaultPreferences));
  }, [profile?.id]);
  const updatePreferences = (patch: Partial<AppPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      void savePreferences(next, profile?.id).catch(() => setLoadError("偏好设置已应用，但本机保存失败"));
      return next;
    });
  };
  useEffect(() => {
    if (callState.status !== "active") { setCallElapsed(0); return; }
    const update = () => setCallElapsed(Math.max(0, Math.floor((Date.now() - callState.startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [callState]);
  useEffect(() => {
    if (callState.status !== "ended" || recordedCallsRef.current.has(callState.callId)) return;
    recordedCallsRef.current.add(callState.callId);
    setCallLog({ callId: callState.callId, peerId: `d-${callState.peerId}`, duration: callState.duration, result: callState.result, message: callState.message });
    const message: ChatMessage = { id: `call-${callState.callId}`, conversationId: `d-${callState.peerId}`, senderId: profile?.id ?? "", senderName: profile?.name ?? "", body: `__call__:${callState.result}:${callState.duration}:${callState.message}`, sentAt: new Date().toISOString(), status: "delivered" };
    void appendHistory(message.conversationId, message);
    window.setTimeout(() => setCallState({ status: "idle" }), 1400);
  }, [callState, profile?.id, profile?.name]);
  const [incomingCaller, setIncomingCaller] = useState<string | null>(null);
  const callManagerRef = useRef<VoiceCallManager | null>(null);
  const pendingOfferRef = useRef<{ from: string; signal: unknown } | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void LocalNotifications.createChannel({
      id: "chat-messages",
      name: "聊天消息",
      description: "个人和群聊新消息提醒",
      importance: 5,
      visibility: 1,
     vibration: preferences.vibration,
    }).catch(() => {});
    const action = LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => {
      const conversationId = notification.extra?.conversationId;
      if (typeof conversationId !== "string") return;
      setTab("messages");
      setSheet(null);
      setSettingsPage(null);
      void openConversation(conversationId);
    });
    return () => { void action.then((handle) => handle.remove()); };
  }, [preferences.vibration]);
  useEffect(() => {
    let currentUrl = "";
    void loadAppearance().then((value) => {
      setAppearance(value);
      if (value.background) { currentUrl = URL.createObjectURL(value.background); setBackgroundUrl(currentUrl); }
    }).catch(() => {});
    return () => { if (currentUrl) URL.revokeObjectURL(currentUrl); };
  }, []);
  const updateAppearance = async (value: AppearanceSettings) => {
    setAppearance(value);
    setBackgroundUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return value.background ? URL.createObjectURL(value.background) : "";
    });
    try { await saveAppearance(value); }
    catch { setLoadError("外观已应用，但本机保存失败"); }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => setSplashElapsed(true), 1600);
    return () => window.clearTimeout(timer);
  }, []);

  const confirmRemoveContact = async () => {
    const id = removeContactId;
    setRemoveContactId(null);
    if (!id) return;
    try {
      await api.removeContact(id);
      setContacts(await api.listContacts());
      setConversations((all) => all.filter((item) => item.id !== `d-${id}`));
      setActiveId((current) => (current === `d-${id}` ? null : current));
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  };
  const performGroupAction = async () => {
    const action = groupAction;
    const groupId = active?.id;
    setGroupAction(null);
    if (!action || !groupId) return;
    try {
      if (action === "leave") await api.leaveGroup(groupId);
      else await api.deleteGroup(groupId);
      setConversations((all) => all.filter((item) => item.id !== groupId));
      setMessages((all) => {
        const { [groupId]: _removed, ...rest } = all;
        return rest;
      });
      void removeHistory(groupId);
      setActiveId(null);
      setSheet(null);
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  };

  const markAnnouncementRead = async (id: string) => {
    await api.markAnnouncementRead(id).catch(() => {});
    setAnnouncements((all) =>
      all.map((item) =>
        item.id === id ? { ...item, readAt: new Date().toISOString() } : item,
      ),
    );
  };
  const readAllAnnouncements = async () => {
    await api.markAllAnnouncementsRead().catch(() => {});
    const now = new Date().toISOString();
    setAnnouncements((all) => all.map((item) => ({ ...item, readAt: now })));
  };
  const openAnnouncement = (item: Announcement) => {
    setAnnouncementDetail(item);
    if (!item.readAt) void markAnnouncementRead(item.id);
  };
  const confirmNotice = announcements.find(
    (item) => item.confirmRequired && !item.readAt,
  );
  const announcementUnread = announcements.filter((item) => !item.readAt).length;
  const messageUnread = conversations.reduce((count, item) => count + (item.unread ?? 0), 0);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<string, Record<string, ReturnType<typeof setTimeout>>>>({});
  const [cacheCleared, setCacheCleared] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheComplete, setCacheComplete] = useState(false);
  const [cacheError, setCacheError] = useState("");
  const cacheClearingRef = useRef(false);
  const [overage, setOverage] = useState<VipOverage | null>(null);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [updatePrompted, setUpdatePrompted] = useState(false);
  const [latestNotice, setLatestNotice] = useState(false);
  const [accountBan, setAccountBan] = useState<AccountBanNotice | null>(null);

  const checkUpdate = async () => {
    const latest = await api.checkLatestRelease();
    if (!latest) { setRelease(null); return null; }
    if (latest.versionCode > APP_VERSION_CODE) {
      setRelease(latest);
      return latest;
    }
    return null;
  };
  const confirmClearCache = async () => {
    if (cacheClearingRef.current) return;
    cacheClearingRef.current = true;
    setCacheClearing(true);
    setCacheError("");
    setSheet(null);
    try {
      await clearAttachmentCache();
      setCacheCleared(true);
      setCacheComplete(true);
    } catch (cause) {
      setLoadError(errorText(cause));
    } finally {
      cacheClearingRef.current = false;
      setCacheClearing(false);
    }
  };
  useEffect(() => {
    const update = () => { void checkUpdate().then((latest) => { if (latest) setSheet("update"); }).catch(() => {}); };
    api.setUpdateRequiredHandler(update);
    socket.setUpdateRequiredHandler(update);
    const timer = window.setInterval(update, 60_000);
    return () => { api.setUpdateRequiredHandler(); socket.setUpdateRequiredHandler(); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const banned = (notice: AccountBanNotice) => setAccountBan(notice);
    api.setAccountBannedHandler(banned);
    socket.setAccountBannedHandler(banned);
    return () => { api.setAccountBannedHandler(); socket.setAccountBannedHandler(); };
  }, []);

  const performLogout = async () => {
    socket.close();
    api.setToken();
    await clearSession();
    setSession(null);
    setProfile(null);
    setDisclaimer(null);
    setConversations([]);
    setContacts([]);
    setMessages({});
  };
  const refreshStatuses = async () => {
    try { setStatuses((await api.listStatusFeed()).statuses); } catch { /* 动态加载失败时静默 */ }
  };
  const logout = async () => setLogoutConfirm(true);
  const applyProfile = (next: UserProfile) => {
    setProfile(next);
    if (!session) return;
    const updated = { ...session, user: next };
    setSession(updated);
    void saveSession(updated).catch((cause) => setLoadError(errorText(cause)));
  };
  const establishSession = async (next: Session) => {
    api.setToken(next.accessToken);
    await saveSession(next);
    setSession(next);
    setProfile(next.user);
    const current = await api.getDisclaimer();
    setDisclaimer(current);
  };

  useEffect(() => {
    void (async () => {
      try {
        const latest = await api.checkLatestRelease();
        if (latest?.forceUpdate && latest.versionCode > APP_VERSION_CODE) {
          setRelease(latest);
          setBooting(false);
          return;
        }
        const stored = await loadSession();
        if (stored) {
          api.setToken(stored.accessToken);
          const user = await api.me();
          const next = { ...stored, user };
          await saveSession(next);
          setSession(next);
          setProfile(user);
          setDisclaimer(await api.getDisclaimer());
          if (await getPinHash()) setPinLocked(true);
        }
      } catch (cause) {
        try { await performLogout(); } catch { /* Continue to the retry screen. */ }
        setLoadError(errorText(cause));
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const listener = CapacitorApp.addListener("backButton", () => {
      if (release && release.versionCode > APP_VERSION_CODE) return;
      if (logoutConfirm) return setLogoutConfirm(false);
      if (groupAction) return setGroupAction(null);
      if (removeContactId) return setRemoveContactId(null);
      if (announcementDetail) return setAnnouncementDetail(null);
      if (latestNotice) return setLatestNotice(false);
      if (cacheComplete) return setCacheComplete(false);
      if (sheet) return setSheet(null);
      if (settingsPage) {
        window.dispatchEvent(new Event(SETTINGS_BACK_EVENT));
        return;
      }
      if (activeId) return setActiveId(null);
      if (tab !== "messages") return setTab("messages");
      return;
    });
    return () => { void listener.then((handle) => handle.remove()); };
  }, [release, logoutConfirm, groupAction, removeContactId, announcementDetail, latestNotice, cacheComplete, sheet, settingsPage, activeId, tab]);

  useEffect(() => {
    if (!session || !profile || !disclaimer?.accepted) return;
    let cancelled = false;
    Promise.all([
      api.listConversations(),
      api.listContacts(),
      api.listAnnouncements(),
    ])
        .then(async ([nextConversations, nextContacts, nextAnnouncements]) => {
          if (!cancelled) {
            const unread = await loadUnread(profile.id);
            const hydrated = await Promise.all(nextConversations.map(async (item) => {
              const history = await loadHistory(item.id).catch(() => []);
              const latest = history.filter((message) => !message.recalled).at(-1);
              return {
                ...item,
                unread: unread[item.id] ?? 0,
                ...(latest ? {
                  preview: latest.attachment ? (latest.attachment.mime.startsWith("image/") ? "[图片]" : latest.attachment.mime.startsWith("audio/") ? "[语音]" : "[视频]") : latest.body,
                  updatedAt: latest.sentAt,
                } : {}),
              };
            }));
            setConversations(hydrated);
          setContacts(nextContacts);
          setAnnouncements(nextAnnouncements.announcements);
          void refreshStatuses();
        }
      })
      .catch((cause) => setLoadError(errorText(cause)));
    api
      .getVipOverage()
      .then(setOverage)
      .catch(() => setOverage(null));
    socket.connect(session.accessToken);
    const unsubscribe = socket.subscribe((event) => {
      void handleSocketEvent(event);
    });
    void (async () => {
      try {
        const latest = await checkUpdate();
        if (latest && !updatePrompted) {
          setUpdatePrompted(true);
          setSheet("update");
        }
      } catch (cause) {
        if (!cancelled) setLoadError(errorText(cause));
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      socket.close();
    };
  }, [session?.accessToken, disclaimer?.accepted, profile?.id]);

  const decryptRecord = async (record: {
    id: string;
    conversationId: string;
    senderId: string;
    senderName: string;
    senderRole?: "user" | "platform-admin";
    senderVip?: boolean;
    envelope: Parameters<typeof decryptEnvelope>[0];
    sentAt: string;
    governance?: boolean;
  }): Promise<ChatMessage> => {
    try {
      const value = JSON.parse(await decryptEnvelope(record.envelope)) as {
        body: string;
        attachment?: AttachmentMeta;
        quote?: ChatMessage["quote"];
      };
      return { ...record, body: value.body, attachment: value.attachment, quote: value.quote, status: "delivered" };
    } catch {
      return { ...record, body: "此设备无法解密这条消息喵", status: "failed" };
    }
  };
  const handleSocketEvent = async (event: SocketEvent) => {
    if (event.type === "message.created") {
      const message = await decryptRecord(event);
      if (message.attachment) {
        try {
          const cached = await loadCachedAttachment(message.attachment.id);
          if (cached?.localUrl) URL.revokeObjectURL(cached.localUrl);
          if (!cached) {
            const stored = await cacheServerAttachment(message.attachment, await api.downloadAttachment(message.attachment.id));
            if (stored.localUrl) URL.revokeObjectURL(stored.localUrl);
          }
        } catch {
          // Keep the encrypted message; the media bubble retries when opened.
        }
      }
      await appendHistory(event.conversationId, message);
      setMessages((all) => ({
        ...all,
        [event.conversationId]: [
          ...(all[event.conversationId] ?? []).filter(
            (item) => item.id !== message.id,
          ),
          message,
        ],
      }));
      setConversations((all) => {
        const next = all.map((item) => item.id === event.conversationId ? {
          ...item,
          preview: message.attachment ? (message.attachment.mime.startsWith("image/") ? "[图片]" : "[视频]") : message.body,
          updatedAt: message.sentAt,
          unread: event.conversationId === activeIdRef.current ? 0 : (item.unread ?? 0) + 1,
        } : item);
        if (profile) void saveUnread(profile.id, Object.fromEntries(next.filter((item) => item.unread > 0).map((item) => [item.id, item.unread])));
        return next;
      });
      if (Capacitor.isNativePlatform() && event.conversationId !== activeIdRef.current) {
        const permission = await LocalNotifications.checkPermissions().catch(() => ({ display: "denied" as const }));
        const conversation = conversationsRef.current.find((item) => item.id === event.conversationId);
        const allowed = event.conversationId.startsWith("g-") ? preferences.groupNotifications : preferences.messageNotifications;
        if (permission.display === "granted" && allowed && !conversation?.muted) {
          const body = message.attachment
            ? message.attachment.mime.startsWith("image/") ? "[图片]" : "[视频]"
            : message.status === "failed" ? "收到一条新消息" : message.body.slice(0, 80);
          await LocalNotifications.schedule({ notifications: [{
            id: Math.floor(Math.random() * 2_000_000_000) + 1,
            title: conversation?.name ?? (event.conversationId.startsWith("g-") ? "群聊新消息" : "新消息"),
            body,
             channelId: "chat-messages",
             ...(preferences.notificationSound ? {} : { silent: true }),
            schedule: { at: new Date(Date.now() + 100) },
            extra: { conversationId: event.conversationId },
          }] }).catch(() => {});
        }
      }
      socket.acknowledge(event.id);
    }
    if (event.type === "moderation-tombstone") {
      const id = `g-${event.groupId}`;
      await tombstoneHistory(id, event.messageId);
      setMessages((all) => ({
        ...all,
        [id]: (all[id] ?? []).map((item) =>
          item.id === event.messageId
            ? { ...item, body: "此消息已由群组治理移除", governance: true }
            : item,
        ),
      }));
    }
    if (event.type === "message-recalled") {
      await recallHistory(event.conversationId, event.messageId);
      setMessages((all) => ({
        ...all,
        [event.conversationId]: (all[event.conversationId] ?? []).map((item) => item.id === event.messageId ? { ...item, body: "", attachment: undefined, quote: undefined, recalled: true } : item),
      }));
    }
    if (event.type === "message-edited") {
      try {
        const value = JSON.parse(await decryptEnvelope(event.envelope)) as { body: string; attachment?: AttachmentMeta; quote?: ChatMessage["quote"] };
        const updated: ChatMessage = { id: event.messageId, conversationId: event.conversationId, senderId: event.senderId, senderName: `#${event.senderId}`, body: value.body, attachment: value.attachment, quote: value.quote, status: "delivered", edited: true, sentAt: event.editedAt };
        await appendHistory(event.conversationId, updated);
        setMessages((all) => ({
          ...all,
          [event.conversationId]: (all[event.conversationId] ?? []).map((item) => item.id === event.messageId ? { ...item, body: value.body, attachment: value.attachment, quote: value.quote, edited: true } : item),
        }));
      } catch { /* 无法解密时保留原消息 */ }
    }
    if (event.type === "message-read") {
      setMessages((all) => ({
        ...all,
        [event.conversationId]: (all[event.conversationId] ?? []).map((item) => item.id === event.messageId ? { ...item, status: "delivered", readBy: [...new Set([...(item.readBy ?? []), event.readerId])] } : item),
      }));
    }
    if (event.type === "message-reactions") {
      setMessages((all) => ({
        ...all,
        [event.conversationId]: (all[event.conversationId] ?? []).map((item) => item.id === event.messageId ? { ...item, reactions: event.reactions } : item),
      }));
    }
    if (event.type === "message-disappeared") {
      await recallHistory(event.conversationId, event.messageId);
      setMessages((all) => ({
        ...all,
        [event.conversationId]: (all[event.conversationId] ?? []).map((item) => item.id === event.messageId ? { ...item, body: "", recalled: true, disappearing: true } : item),
      }));
    }
    if (event.type === "typing") {
      setTypingUsers((all) => {
        const conversationTypers = { ...(all[event.conversationId] ?? {}) };
        if (conversationTypers[event.from]) clearTimeout(conversationTypers[event.from]);
        const timer = setTimeout(() => {
          setTypingUsers((current) => {
            const next = { ...current };
            const typer = { ...(next[event.conversationId] ?? {}) };
            delete typer[event.from];
            if (Object.keys(typer).length === 0) delete next[event.conversationId];
            else next[event.conversationId] = typer;
            return next;
          });
        }, 2500);
        const updated = { ...conversationTypers, [event.from]: timer };
        if (Object.keys(updated).length === 0) delete all[event.conversationId];
        else all = { ...all, [event.conversationId]: updated };
        return { ...all };
      });
    }
    if (event.type === "call-signal") {
      const manager = callManagerRef.current ?? new VoiceCallManager();
      callManagerRef.current = manager;
      manager.setHandler({
        sendSignal: (peerId, signal) => { socket.sendSignal(peerId, signal); },
        onStateChange: (state) => {
          setCallState(state);
          if (state.status === "idle") setIncomingCaller(null);
        },
      });
      const signal = event.signal as { kind?: string; callId?: string };
      if (signal.kind === "offer") {
        if (!signal.callId) return;
        manager.prepareIncoming(event.from, signal.callId);
        setIncomingCaller(event.from);
        setCallState({ status: "ringing", peerId: event.from, callId: signal.callId });
        pendingOfferRef.current = { from: event.from, signal };
      } else {
        void manager.handleSignal(event.from, signal);
      }
    }
    if (event.type === "avatar-updated") {
      setContacts((all) => all.map((c) => c.id === event.userId ? { ...c, avatar: event.avatar } : c));
      setConversations((all) => all.map((conv) => {
        if (conv.group) {
          const members = conv.members.map((m) => m.id === event.userId ? { ...m, avatar: event.avatar } : m);
          return { ...conv, members };
        }
        return conv.members[0]?.id === event.userId ? { ...conv, avatar: event.avatar } : conv;
      }));
    }
    if (event.type === "contact-request") {
      try { setContacts(await api.listContacts()); } catch { /* 网络波动时下次打开申请弹窗仍会刷新 */ }
    }
  };
  const openConversation = async (id: string) => {
    setActiveId(id);
    setConversations((all) => {
      const next = all.map((item) => item.id === id ? { ...item, unread: 0 } : item);
      if (profile) void saveUnread(profile.id, Object.fromEntries(next.filter((item) => item.unread > 0).map((item) => [item.id, item.unread])));
      return next;
    });
    if (messages[id]) return;
    setMessagesLoading(true);
    try {
      const local = await loadHistory(id);
      setMessages((all) => ({ ...all, [id]: local }));
    } catch (cause) {
      setLoadError(errorText(cause));
    } finally {
      setMessagesLoading(false);
    }
  };
  const send = async (body: string, attachment?: AttachmentMeta, quote?: ChatMessage["quote"]) => {
    const active = conversations.find((item) => item.id === activeId);
    if (!active || !profile) return;
    const recipientMap = new Map(
      active.members
        .filter((item) => item.id !== profile.id)
        .map((item) => [item.id, item.publicKey]),
    );
    const recipients = [...recipientMap].map(([id, key]) => ({ id, key }));
    if (recipients.length === 0 || recipients.some((item) => !item.key))
      throw new Error("缺少接收方公钥，消息没有发送喵");
    const clientId = crypto.randomUUID();
    const plaintext = JSON.stringify({ body, attachment, quote });
    const envelopes = Object.fromEntries(
      await Promise.all(
        recipients.map(async ({ id, key }) => [
          id,
          await encryptEnvelope(plaintext, key),
        ]),
      ),
    );
    const pending: ChatMessage = {
      id: clientId,
      conversationId: active.id,
      senderId: profile.id,
      senderName: profile.name,
      senderRole: profile.role,
      body,
      attachment,
      quote,
      sentAt: new Date().toISOString(),
      status: "sending",
    };
    setMessages((all) => ({
      ...all,
      [active.id]: [...(all[active.id] ?? []), pending],
    }));
    try {
      const accepted = await socket.sendMessage(active, {
        clientId,
        recipientIds: recipients.map((item) => item.id),
        envelopes,
      });
      const sent = {
        ...pending,
        id: accepted.id,
        sentAt: accepted.acceptedAt,
        status: "sent" as const,
      };
      await appendHistory(active.id, sent);
      setConversations((all) => all.map((item) => item.id === active.id ? {
        ...item,
        preview: attachment ? (attachment.mime.startsWith("image/") ? "[图片]" : attachment.mime.startsWith("audio/") ? "[语音]" : "[视频]") : body,
        updatedAt: sent.sentAt,
      } : item));
      setMessages((all) => ({
        ...all,
        [active.id]: (all[active.id] ?? []).map((item) =>
          item.id === clientId ? sent : item,
        ),
      }));
    } catch (cause) {
      setMessages((all) => ({
        ...all,
        [active.id]: (all[active.id] ?? []).map((item) =>
          item.id === clientId ? { ...item, status: "failed" } : item,
        ),
      }));
      throw cause;
    }
  };
  const active = conversations.find((item) => item.id === activeId);
  const editMessage = async (message: ChatMessage, body: string) => {
    const conv = conversations.find((item) => item.id === message.conversationId);
    if (!conv || !profile) return;
    const recipients = conv.members
      .filter((item) => item.id !== profile.id)
      .filter((item) => item.publicKey);
    if (recipients.length === 0) return;
    const plaintext = JSON.stringify({ body, attachment: message.attachment, quote: message.quote });
    const envelopes = Object.fromEntries(
      await Promise.all(
        recipients.map(async ({ id, publicKey }) => [id, await encryptEnvelope(plaintext, publicKey)]),
      ),
    );
    await api.editMessage(message.id, envelopes);
    setMessages((all) => ({
      ...all,
      [message.conversationId]: (all[message.conversationId] ?? []).map((item) => item.id === message.id ? { ...item, body, edited: true } : item),
    }));
    void appendHistory(message.conversationId, { ...message, body, edited: true });
  };
  const reactToMessage = async (message: ChatMessage, emoji: string) => {
    const result = await api.setMessageReaction(message.id, emoji);
    setMessages((all) => ({
      ...all,
      [message.conversationId]: (all[message.conversationId] ?? []).map((item) => item.id === message.id ? { ...item, reactions: result.reactions } : item),
    }));
  };
  const typingName = (conversationId: string) => {
    const typerIds = Object.keys(typingUsers[conversationId] ?? {});
    const conv = conversations.find((item) => item.id === conversationId);
    if (!conv) return [];
    const nameOf = (id: string) => conv.members.find((member) => member.id === id)?.name ?? `#${id}`;
    return typerIds.map(nameOf);
  };
  const notifyTyping = () => { if (activeIdRef.current) socket.sendTyping(activeIdRef.current); };
  const refreshOverage = async () => {
    try {
      setOverage(await api.getVipOverage());
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  };
  const deleteOwnedGroup = async (groupId: string) => {
    await api.deleteGroup(groupId);
    const id = `g-${groupId}`;
    setConversations((all) => all.filter((item) => item.id !== id));
    setMessages((all) => {
      const { [id]: _removed, ...rest } = all;
      return rest;
    });
    void removeHistory(id);
    if (activeId === id) setActiveId(null);
    await refreshOverage();
  };

  if (booting || !splashElapsed) return <AppSplash />;
  if (release?.forceUpdate && release.versionCode > APP_VERSION_CODE)
    return <UpdateModal release={release} onClose={() => undefined} />;
  if (accountBan)
    return <AccountBannedModal notice={accountBan} onClose={() => { setAccountBan(null); void performLogout(); }} />;
  if (!session || !profile)
    return (
      <>
        {loadError && <div className="global-error">{loadError}</div>}
        <AuthScreen
          onAuthenticated={async (next) => {
            await establishSession(next);
            setBooting(false);
          }}
        />
      </>
    );
  if (!profile.qqNumber)
    return <QqBindingGate onBound={applyProfile} />;
  if (!disclaimer)
    return (
      <div className="splash">
        <LoaderCircle className="spin" />
        <span>正在获取使用声明喵</span>
      </div>
    );
  if (!disclaimer.accepted)
    return (
      <DisclaimerGate
        disclaimer={disclaimer}
        onAccept={async () => {
          await api.acceptDisclaimer(disclaimer.version);
          setDisclaimer({ ...disclaimer, accepted: true });
          applyProfile({
            ...profile,
            disclaimerAcceptedVersion: disclaimer.version,
          });
        }}
      />
    );

  return (
    <div className="app-shell" data-theme={appearance.theme}>
      {pinLocked && (
        <div className="pin-lock-screen">
          <div className="splash-icon"><img src="/app-icon.png" alt="蓝喵速递" /></div>
          <strong>蓝喵速递</strong>
          <form onSubmit={async (event) => { event.preventDefault(); const value = (event.currentTarget.elements.namedItem("pin") as HTMLInputElement).value; if (await verifyPin(value)) { setPinLocked(false); setPinError(""); } else setPinError("PIN 码错误，请重试"); }}>
            <input name="pin" type="password" inputMode="numeric" maxLength={6} placeholder="请输入应用 PIN 码" autoFocus />
            <button type="submit" className="primary-button">解锁</button>
          </form>
          {pinError && <p className="form-error">{pinError}</p>}
          <button className="setting-link" onClick={() => void performLogout()}>退出登录</button>
        </div>
      )}
      <main className={`phone-surface ${backgroundUrl ? "has-custom-background" : ""}`}>
        {backgroundUrl && <div className="app-background" style={{ backgroundImage: `url(${backgroundUrl})`, filter: appearance.blurEnabled ? `blur(${appearance.blurStrength}px)` : "none" }} />}
        {loadError && (
          <button className="global-error" onClick={() => setLoadError("")}>
            {loadError}
          </button>
        )}
        <StatusBanner profile={profile} />
        {active ? (
          <AppErrorBoundary>
            <SlideTransition mode={settingsPage === "group" ? "group" : settingsPage === "contact" && editContact ? "contact" : `chat-${active.id}`}>
            {settingsPage === "group" ? (
              <GroupSettingsPage
                conversation={active}
                contacts={contacts}
                ownId={profile.id}
                appearance={conversationAppearance(preferences, active.id)}
                onAppearance={(value) => updatePreferences({ conversations: { ...preferences.conversations, [active.id]: value } })}
                onBack={() => setSettingsPage(null)}
                onSaved={(next) => {
                  setConversations((all) =>
                    all.map((item) => (item.id === next.id ? next : item)),
                  );
                  setSettingsPage(null);
                }}
                onUpdated={(next) => {
                  setConversations((all) => all.map((item) => (item.id === next.id ? next : item)));
                }}
                onMembersChanged={(members) => {
                  setConversations((all) =>
                    all.map((item) =>
                      item.id === active.id ? { ...item, members } : item,
                    ),
                  );
                }}
                onLeave={() => setGroupAction("leave")}
                onDissolve={() => setGroupAction("dissolve")}
              />
            ) : settingsPage === "contact" && editContact ? (
              <ContactSettingsPage
                contact={editContact}
               conversationId={`d-${editContact.id}`}
                appearance={conversationAppearance(preferences, `d-${editContact.id}`)}
                onAppearance={(value) => updatePreferences({ conversations: { ...preferences.conversations, [`d-${editContact.id}`]: value } })}
                onBack={() => setSettingsPage(null)}
                onSaved={(remark) => {
                  setContacts((all) =>
                    all.map((item) =>
                      item.id === editContact.id ? { ...item, remark } : item,
                    ),
                  );
                  setSettingsPage(null);
                }}
                onPreferences={async (preferences) => {
                  const next = await api.updateContactPreferences(editContact.id, preferences);
                  setContacts((all) => all.map((item) => item.id === editContact.id ? { ...item, ...next } : item));
                  setConversations((all) => all.map((item) => item.id === `d-${editContact.id}` ? { ...item, ...next } : item));
                  setEditContact((current) => current ? { ...current, ...next } : current);
                }}
                onRemove={() => setRemoveContactId(editContact.id)}
              />
            ) : (
            <ChatScreen
            profile={profile}
            conversation={active}
            messages={messages[active.id] ?? []}
            loading={messagesLoading}
            onBack={() => setActiveId(null)}
            onSend={(text, quote) => send(text, undefined, quote)}
            onSendVoice={async (file) => {
              const meta = await api.uploadAttachment(file, active.id);
              const cached = await cacheServerAttachment(meta, file);
              if (cached.localUrl) URL.revokeObjectURL(cached.localUrl);
              await send("", meta);
            }}
            onRecall={async (message) => {
              await api.recallMessage(message.id);
              await recallHistory(active.id, message.id);
              setMessages((all) => ({ ...all, [active.id]: (all[active.id] ?? []).map((item) => item.id === message.id ? { ...item, body: "", attachment: undefined, quote: undefined, recalled: true } : item) }));
            }}
            onEdit={editMessage}
            onReact={reactToMessage}
             onTyping={notifyTyping}
             typingNames={preferences.typingIndicators ? typingName(active.id) : []}
             preferences={preferences}
             conversationPreferences={conversationAppearance(preferences, active.id)}
            onMute={async (id, until) => {
              await api.setConversationMute(id, until);
              setConversations((all) => all.map((item) => item.id === id ? { ...item, muted: until !== null } : item));
            }}
            onDisappear={async (id, seconds) => {
              await api.setConversationDisappearing(id, seconds);
              setConversations((all) => all.map((item) => item.id === id ? { ...item, disappearingSeconds: seconds } : item));
            }}
            onCall={async (peerId) => {
              if (!peerId) return;
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach((t) => t.stop());
              } catch { setCallState({ status: "error", message: "需要麦克风权限才能发起语音通话，请在系统设置中允许蓝喵速递使用麦克风" }); return; }
              const manager = callManagerRef.current ?? new VoiceCallManager();
              callManagerRef.current = manager;
              manager.setHandler({
                sendSignal: (id, signal) => { socket.sendSignal(id, signal); },
                onStateChange: setCallState,
              });
              void manager.startOutgoing(peerId);
            }}
            onAttachments={() => setSheet("attachments")}
            onSettings={() => {
              if (active.group) setSettingsPage("group");
              else {
                const contact = contacts.find((item) => item.id === active.members?.[0]?.id);
                if (contact) { setEditContact(contact); setSettingsPage("contact"); }
              }
            }}
            displayName={
              active.group
                ? undefined
                : contacts.find((item) => item.id === active.members?.[0]?.id)
                    ?.remark || active.name
            }
            callLog={callLog}
          />
            )}
            </SlideTransition>
          </AppErrorBoundary>
        ) : (
          <>
          <SlideTransition mode={settingsPage === "settings" ? "settings" : tab}>
            {settingsPage === "settings" ? (
             <SettingsPage
               contacts={contacts}
               conversations={conversations}
               preferences={preferences}
               onPreferences={updatePreferences}
              appearance={{ ...appearance, backgroundUrl }}
              onAppearance={updateAppearance}
            onProfile={applyProfile}
            onBack={() => setSettingsPage(null)}
            cleared={cacheCleared}
            clearing={cacheClearing}
            onClear={() => {
              if (cacheClearingRef.current) return;
              setCacheError("");
              setSheet("cache-confirm");
            }}
            onCheckUpdate={() => {
              void checkUpdate()
                .then((latest) => {
                  if (latest) setSheet("update");
                  else {
                    setSettingsPage(null);
                    setLatestNotice(true);
                  }
                })
                .catch((cause) => setLoadError(errorText(cause)));
            }}
            onLogout={() => setLogoutConfirm(true)}
          />
        ) : (
            <>
            {tab === "messages" && (
              <MessagesScreen
                conversations={conversations}
                open={(id) => void openConversation(id)}
                onGroup={() => setSheet("new-group")}
              />
            )}
            {tab === "contacts" && (
              <ContactsScreen
                 contacts={contacts}
                 groups={conversations}
                onGroup={() => setSheet("new-group")}
                onJoin={() => setSheet("join-group")}
                onAdd={() => setSheet("add-contact")}
                onRequests={() => setSheet("requests")}
                 onOpen={async (contactId) => {
                  const conversation =
                    await api.startDirectConversation(contactId);
                  setConversations((all) => [
                    conversation,
                    ...all.filter((item) => item.id !== conversation.id),
                  ]);
                   await openConversation(conversation.id);
                 }}
                 onOpenGroup={openConversation}
                 onCall={(peerId) => {
                   if (!peerId) return;
                   const manager = callManagerRef.current ?? new VoiceCallManager();
                   callManagerRef.current = manager;
                   manager.setHandler({
                     sendSignal: (id, signal) => { socket.sendSignal(id, signal); },
                     onStateChange: setCallState,
                   });
                   void manager.startOutgoing(peerId);
                 }}
               />
            )}
            {tab === "statuses" && (
              <StatusesScreen
                myName={profile.name}
                myAvatar={profile.avatar}
                statuses={statuses}
                refresh={async () => {
                  try { setStatuses((await api.listStatusFeed()).statuses); } catch (cause) { setLoadError(errorText(cause)); }
                }}
                publish={async (input) => {
                  await api.publishStatus(input);
                  await refreshStatuses();
                }}
                view={(statusId) => { void api.markStatusViewed(statusId).catch(() => {}); setStatuses((all) => all.map((item) => item.id === statusId ? { ...item, viewed: true } : item)); }}
                remove={(statusId) => { void api.deleteStatus(statusId).catch(() => {}); setStatuses((all) => all.filter((item) => item.id !== statusId)); }}
                openMedia={async (imageId) => {
                  const cached = await cacheServerAttachment({ id: imageId, name: "动态图片", mime: "image/jpeg", size: 0 }, await api.downloadAttachment(imageId));
                  return cached.localUrl ?? "";
                }}
                onBack={() => setTab("profile")}
              />
            )}
            {tab === "announcements" && (
              <AnnouncementsScreen
                announcements={announcements}
                onOpen={openAnnouncement}
                onReadAll={() => void readAllAnnouncements()}
              />
            )}
            {tab === "profile" && (
              <ProfileScreen
                profile={profile}
                openSheet={setSheet}
                onOpenSettings={() => setSettingsPage("settings")}
                onProfile={applyProfile}
                onStatuses={() => setTab("statuses")}
              />
            )}
            </>
        )}
          </SlideTransition>
          {settingsPage !== "settings" && (
            <BottomNav tab={tab} setTab={setTab} announcementUnread={announcementUnread} messageUnread={messageUnread} />
          )}
          </>
        )}
      </main>
      {callState.status !== "idle" && callState.status !== "error" && callState.status !== "ended" && (
        <div className="call-overlay">
          <div className="call-card">
            <Avatar name={contacts.find((item) => item.id === callState.peerId)?.name ?? active?.members.find((item) => item.id === callState.peerId)?.name ?? `#${callState.peerId}`} image={contacts.find((item) => item.id === callState.peerId)?.avatar ?? active?.members.find((item) => item.id === callState.peerId)?.avatar} size="large" />
            <strong>{contacts.find((item) => item.id === callState.peerId)?.name ?? active?.members.find((item) => item.id === callState.peerId)?.name ?? `#${callState.peerId}`}</strong>
             <small>{callState.status === "ringing" ? "来电..." : callState.status === "outgoing" ? "呼叫中..." : `通话中 ${Math.floor(callElapsed / 60).toString().padStart(2, "0")}:${(callElapsed % 60).toString().padStart(2, "0")}`}</small>
            {callState.status === "active" && callManagerRef.current?.remote && (
              <audio ref={(node) => { if (node && callManagerRef.current?.remote) { node.srcObject = callManagerRef.current.remote; node.play().catch(() => {}); } }} autoPlay />
            )}
            <div className="call-actions">
              {(callState.status === "ringing") && (
                 <button className="call-button accept" onClick={async () => { const offer = pendingOfferRef.current; setIncomingCaller(null); if (offer) { const manager = callManagerRef.current ?? new VoiceCallManager(); callManagerRef.current = manager; manager.setHandler({ sendSignal: (id, signal) => socket.sendSignal(id, signal), onStateChange: setCallState }); void manager.handleSignal(offer.from, offer.signal as { kind?: string; callId?: string }); pendingOfferRef.current = null; } }}><Phone /></button>
               )}
               <button className="call-button hangup" onClick={() => { if (callState.status === "ringing") callManagerRef.current?.reject(); else callManagerRef.current?.hangup(); setIncomingCaller(null); pendingOfferRef.current = null; }}><PhoneOff /></button>
            </div>
          </div>
        </div>
      )}
      {(callState.status === "error" || callState.status === "ended") && (
        <div className="call-overlay" onClick={() => setCallState({ status: "idle" })}>
          <div className="call-card">
            <strong style={{ color: "var(--coral-dark)" }}>{callState.status === "ended" ? callState.message : "通话失败"}</strong>
            <small>{callState.message}</small>
            <div className="call-actions">
              <button className="call-button hangup" onClick={() => setCallState({ status: "idle" })}><PhoneOff /></button>
            </div>
          </div>
        </div>
      )}
      {sheet === "new-group" && (
        <GroupModal
          contacts={contacts.filter((contact) => contact.status === "accepted" && !contact.blocked)}
          onClose={() => setSheet(null)}
          onCreate={async (name, memberIds) => {
            const group = await api.createGroup({ name, memberIds });
            setConversations((all) => [group, ...all]);
            setMessages((all) => ({ ...all, [group.id]: [] }));
            setSheet(null);
            setActiveId(group.id);
          }}
        />
      )}
      {sheet === "join-group" && (
        <JoinGroupModal onClose={() => setSheet(null)} />
      )}
      {sheet === "add-contact" && (
        <AddContactModal
          onClose={() => setSheet(null)}
          onAdd={async (handle, message) => {
            await api.addContact(handle, message);
            setContacts(await api.listContacts());
            setSheet(null);
          }}
        />
      )}
      {sheet === "requests" && (
        <RequestsModal
          contacts={contacts}
          currentUserId={profile.id}
          onClose={() => setSheet(null)}
          onContactsChanged={setContacts}
        />
      )}
      {sheet === "edit-profile" && (
        <ProfileModal
          profile={profile}
          onClose={() => setSheet(null)}
          onSave={(next) => {
            applyProfile(next);
            setSheet(null);
          }}
        />
      )}
      {latestNotice && (
        <Modal title="检查更新" onClose={() => setLatestNotice(false)}>
          <div className="modal-content confirm-content">
            <Check />
            <p>主人，当前已经是最新版本喵。</p>
            <div className="button-row">
              <button
                className="primary-button"
                onClick={() => setLatestNotice(false)}
              >
                知道了
              </button>
            </div>
          </div>
        </Modal>
      )}
      {sheet === "update" && release && (
        <UpdateModal
          release={release}
          onClose={() => {
            setSheet(null);
            setRelease(null);
          }}
        />
      )}
      {sheet === "cache-confirm" && (
        <Modal title="清理本地缓存" onClose={() => !cacheClearing && setSheet(null)}>
          <div className="modal-content confirm-content">
            {cacheClearing ? <LoaderCircle className="spin" /> : <Trash2 />}
            <p>
              主人，已下载的附件副本将从本机删除，服务器消息和身份密钥会保留喵。
            </p>
            {cacheError && <p className="form-error">{cacheError}</p>}
            <div className="button-row">
              <button
                type="button"
                className="outline-button"
                disabled={cacheClearing}
                onClick={() => setSheet(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={cacheClearing}
                onClick={() => void confirmClearCache()}
              >
                {cacheClearing ? "正在清理" : "确认清理"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {cacheComplete && (
        <Modal title="清理完成" onClose={() => setCacheComplete(false)}>
          <div className="modal-content confirm-content">
            <Check />
            <p>主人，本地缓存已清理完成喵。</p>
            <div className="button-row">
              <button className="primary-button" onClick={() => setCacheComplete(false)}>
                知道了
              </button>
            </div>
          </div>
        </Modal>
      )}
      {sheet === "vip" && (
        <VipModal
          onClose={() => setSheet(null)}
          onRedeemed={(vipUntil) => {
            applyProfile({ ...profile, vipUntil });
            setSheet(null);
          }}
        />
      )}
      {sheet === "attachments" && active && (
        <AttachmentModal
          conversationId={active.id}
          onClose={() => setSheet(null)}
          onSend={async (meta) => {
            setSheet(null);
            try {
              await send("", meta);
            } catch (cause) {
              setLoadError(errorText(cause));
            }
          }}
        />
      )}
      {announcementDetail && (
        <Modal title="公告详情" onClose={() => setAnnouncementDetail(null)}>
          <div className="modal-content announcement-detail">
            <header>
              <BellRing />
              <span>
                <strong>{announcementDetail.title}</strong>
                <small>
                  {messageTime(announcementDetail.publishedAt)} ·{" "}
                  {announcementDetail.authorName} · 平台管理员
                </small>
              </span>
            </header>
            <p>{announcementDetail.body}</p>
            <button
              className="primary-button"
              onClick={() => setAnnouncementDetail(null)}
            >
              我知道了
            </button>
          </div>
        </Modal>
      )}
      {confirmNotice && !announcementDetail && (
        <Modal title="平台公告" onClose={() => undefined}>
          <div className="modal-content announcement-detail">
            <header>
              <BellRing />
              <span>
                <strong>{confirmNotice.title}</strong>
                <small>
                  {messageTime(confirmNotice.publishedAt)} ·{" "}
                  {confirmNotice.authorName}
                </small>
              </span>
            </header>
            <p>{confirmNotice.body}</p>
            <button
              className="primary-button"
              onClick={() => void markAnnouncementRead(confirmNotice.id)}
            >
              我已知晓
            </button>
          </div>
        </Modal>
      )}
      {overage?.over && (
        <OverageModal
          overage={overage}
          onRefresh={() => void refreshOverage()}
          onDeleted={deleteOwnedGroup}
        />
      )}
      {removeContactId && (
        <ConfirmModal
          title="删除好友"
          message="删除后将同时移除双方的聊天会话，确定删除该好友吗？"
          confirmLabel="删除好友"
          danger
          onClose={() => setRemoveContactId(null)}
          onConfirm={() => void confirmRemoveContact()}
        />
      )}
      {groupAction && active && (
        <ConfirmModal
          title={groupAction === "leave" ? "退出群聊" : "解散群聊"}
          message={
            groupAction === "leave"
              ? "退出后不再接收该群消息，确定退出吗？"
              : "解散后所有成员的群消息记录都会被删除，确定解散吗？"
          }
          confirmLabel={groupAction === "leave" ? "退出群聊" : "解散群聊"}
          danger
          onClose={() => setGroupAction(null)}
          onConfirm={() => void performGroupAction()}
        />
      )}
      {logoutConfirm && (
        <ConfirmModal
          title="退出当前账号"
          message="本机私钥会保留，之后可以再次登录。确定退出当前账号吗？"
          confirmLabel="退出登录"
          onClose={() => setLogoutConfirm(false)}
          onConfirm={() => {
            setLogoutConfirm(false);
            void performLogout();
          }}
        />
      )}
    </div>
  );
}
