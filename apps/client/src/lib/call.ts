// 语音通话状态机：WebRTC 信令、ICE、通话状态流转、callId 去重
export type CallResult = "completed" | "missed" | "rejected" | "cancelled" | "failed";

export type CallState =
  | { status: "idle" }
  | { status: "outgoing"; peerId: string; callId: string; startedAt: number }
  | { status: "ringing"; peerId: string; callId: string }
  | { status: "active"; peerId: string; callId: string; startedAt: number }
  | { status: "ended"; peerId: string; callId: string; result: CallResult; duration: number; message: string }
  | { status: "error"; message: string };

export interface CallSignalHandler {
  sendSignal: (peerId: string, signal: unknown) => void;
  onStateChange: (state: CallState) => void;
}

type CallSignal = {
  kind?: string;
  callId?: string;
  sdp?: unknown;
  candidate?: unknown;
  reason?: CallResult;
};

export class VoiceCallManager {
  private pc?: RTCPeerConnection;
  private localStream?: MediaStream;
  private remoteStream?: MediaStream;
  private peerId = "";
  private callId = "";
  private activeStartedAt = 0;
  private handler?: CallSignalHandler;
  private candidatesQueue: RTCIceCandidateInit[] = [];
  private callTimer?: ReturnType<typeof setTimeout>;
  private disconnectedCount = 0;
  private finished = false;

  setHandler(handler: CallSignalHandler) {
    this.handler = handler;
  }

  prepareIncoming(peerId: string, callId: string) {
    this.peerId = peerId;
    this.callId = callId;
    this.finished = false;
  }

  get remote(): MediaStream | undefined {
    return this.remoteStream;
  }

  private get peer(): RTCPeerConnection {
    if (this.pc) return this.pc;
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.qq.com:3478" },
        { urls: "stun:stun.miwifi.com:3478" },
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.handler?.sendSignal(this.peerId, { kind: "ice", callId: this.callId, candidate: event.candidate.toJSON() });
    };
    this.pc.ontrack = (event) => {
      this.remoteStream = event.streams[0];
      this.markActive();
    };
    this.pc.onconnectionstatechange = () => {
      if (this.finished) return;
      if (this.pc?.connectionState === "failed") this.finish("failed", true);
      if (this.pc?.connectionState === "disconnected" && this.disconnectedCount++ > 2) this.finish("failed", true);
    };
    return this.pc;
  }

  private markActive() {
    if (this.callTimer) clearTimeout(this.callTimer);
    this.callTimer = undefined;
    if (!this.activeStartedAt) this.activeStartedAt = Date.now();
    this.handler?.onStateChange({ status: "active", peerId: this.peerId, callId: this.callId, startedAt: this.activeStartedAt });
  }

  async startOutgoing(peerId: string): Promise<boolean> {
    try {
      this.peerId = peerId;
      this.callId = crypto.randomUUID();
      this.finished = false;
      this.activeStartedAt = 0;
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localStream.getTracks().forEach((track) => this.peer.addTrack(track, this.localStream!));
      const offer = await this.peer.createOffer();
      await this.peer.setLocalDescription(offer);
      this.handler?.sendSignal(peerId, { kind: "offer", callId: this.callId, sdp: this.peer.localDescription });
      this.handler?.onStateChange({ status: "outgoing", peerId, callId: this.callId, startedAt: Date.now() });
      this.callTimer = setTimeout(() => this.finish("missed", true), 30_000);
      return true;
    } catch (error) {
      this.dispose();
      const message = error instanceof DOMException && error.name === "NotAllowedError" ? "请允许麦克风权限" : "无法建立通话，请检查网络";
      this.handler?.onStateChange({ status: "error", message });
      return false;
    }
  }

  async handleSignal(peerId: string, signal: CallSignal) {
    if (!signal.callId) return;
    if (this.callId && signal.callId !== this.callId) return;
    if (!this.callId) this.prepareIncoming(peerId, signal.callId);
    if (this.finished) return;
    try {
      if (signal.kind === "offer") {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.localStream.getTracks().forEach((track) => this.peer.addTrack(track, this.localStream!));
        await this.peer.setRemoteDescription(signal.sdp as RTCSessionDescriptionInit);
        const answer = await this.peer.createAnswer();
        await this.peer.setLocalDescription(answer);
        this.handler?.sendSignal(peerId, { kind: "answer", callId: this.callId, sdp: this.peer.localDescription });
        this.flushCandidates();
        this.markActive();
      } else if (signal.kind === "answer") {
        await this.peer.setRemoteDescription(signal.sdp as RTCSessionDescriptionInit);
        this.flushCandidates();
      } else if (signal.kind === "ice") {
        const candidate = signal.candidate as RTCIceCandidateInit | undefined;
        if (!candidate) return;
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(candidate);
        else this.candidatesQueue.push(candidate);
      } else if (signal.kind === "hangup") {
        this.finish(signal.reason ?? (this.activeStartedAt ? "completed" : "cancelled"), false);
      }
    } catch {
      this.finish("failed", true);
    }
  }

  hangup() {
    this.finish(this.activeStartedAt ? "completed" : "cancelled", true);
  }

  reject() {
    this.finish("rejected", true);
  }

  private flushCandidates() {
    for (const candidate of this.candidatesQueue) void this.pc?.addIceCandidate(candidate).catch(() => {});
    this.candidatesQueue = [];
  }

  private finish(result: CallResult, notifyPeer: boolean) {
    if (this.finished || !this.peerId || !this.callId) return;
    this.finished = true;
    const peerId = this.peerId;
    const callId = this.callId;
    const duration = this.activeStartedAt ? Math.max(0, Math.floor((Date.now() - this.activeStartedAt) / 1000)) : 0;
    if (notifyPeer) try { this.handler?.sendSignal(peerId, { kind: "hangup", callId, reason: result }); } catch { /* ignore */ }
    this.dispose();
    const message = result === "missed" ? "未接听" : result === "rejected" ? "通话已拒绝" : result === "cancelled" ? "通话已取消" : result === "failed" ? "通话失败" : "通话结束";
    this.handler?.onStateChange({ status: "ended", peerId, callId, result, duration, message });
  }

  private dispose() {
    if (this.callTimer) clearTimeout(this.callTimer);
    this.callTimer = undefined;
    try { this.localStream?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    this.pc = undefined;
    this.localStream = undefined;
    this.remoteStream = undefined;
    this.candidatesQueue = [];
    this.disconnectedCount = 0;
    this.activeStartedAt = 0;
  }
}
