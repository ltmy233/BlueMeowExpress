import asyncio
import json
import re
import ssl
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register


@register(
    "lanmiao_qq_verify",
    "蓝喵速递",
    "蓝喵速递 QQ 绑定验证与群管理命令",
    "1.1.3",
)
class LanmiaoQqVerify(Star):
    def __init__(self, context: Context, config):
        super().__init__(context)
        self.config = config or {}
        self._heartbeat_task = None

    def _value(self, key, default):
        value = self.config.get(key, default) if hasattr(self.config, "get") else default
        return default if value is None else value

    def _service_url(self):
        return str(self._value("service_url", "")).rstrip("/")

    def _plugin_token(self):
        return str(self._value("plugin_token", ""))

    def _groups(self):
        return {
            str(value).strip()
            for value in self._value("whitelist_groups", [])
            if str(value).strip()
        }

    def _blacklist(self):
        return {
            str(value).strip()
            for value in self._value("blacklist_groups", [])
            if str(value).strip()
        }

    def _list_enabled(self):
        return bool(self._groups())

    def _list_mode(self):
        return str(self._value("group_list_mode", "whitelist")).strip().lower()

    def _admins(self):
        return {
            str(value).strip()
            for value in self._value("admin_qq_ids", [])
            if str(value).strip()
        }

    @staticmethod
    def _numeric_id(value):
        matches = re.findall(r"\d{5,12}", str(value or ""))
        return matches[-1] if matches else str(value or "").strip()

    def _allowed_group(self, event: AstrMessageEvent):
        group_id = self._numeric_id(event.get_group_id())
        if not group_id:
            return False
        if not self._list_enabled():
            return True
        if self._list_mode() == "blacklist":
            return group_id not in self._blacklist()
        return group_id in self._groups()

    def _is_admin(self, event: AstrMessageEvent):
        return self._numeric_id(event.get_sender_id()) in self._admins()

    async def _request(self, path, payload=None):
        service_url = self._service_url()
        if not service_url or not self._plugin_token():
            return 0, {"error": "QQ verification plugin is not configured"}

        def send():
            data = json.dumps(payload).encode("utf-8") if payload is not None else None
            context = ssl._create_unverified_context()
            request = Request(
                service_url + path,
                data=data,
                headers={
                    "Content-Type": "application/json",
                    "X-Lanmiao-Plugin-Token": self._plugin_token(),
                },
                method="POST",
            )
            try:
                with urlopen(request, timeout=10, context=context) as response:
                    raw = response.read().decode("utf-8")
                    return response.status, json.loads(raw or "{}")
            except HTTPError as error:
                raw = error.read().decode("utf-8", errors="replace")
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError:
                    body = {"error": raw or "server request failed"}
                return error.code, body

        try:
            return await asyncio.to_thread(send)
        except (URLError, TimeoutError, OSError) as error:
            logger.warning("Lanmiao QQ verification request failed: %s", error)
            return 0, {"error": "Lanmiao service is temporarily unavailable"}

    async def initialize(self):
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _heartbeat_loop(self):
        while True:
            await self._request(
                "/api/qq/bot/heartbeat",
                {
                    "botId": str(self._value("bot_id", "astrbot-main")),
                    "botName": "Lanmiao QQ Bot",
                    "status": "online",
                    "groupCount": len(self._groups()),
                    "metadata": {
                        "plugin": "lanmiao_qq_verify",
                        "groupListEnabled": self._list_enabled(),
                        "groupListMode": self._list_mode(),
                        "whitelistGroups": sorted(self._groups()),
                        "blacklistGroups": sorted(self._blacklist()),
                        "adminQqIds": sorted(self._admins()),
                    },
                },
            )
            await asyncio.sleep(max(10, int(self._value("heartbeat_seconds", 30))))

    async def terminate(self):
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass

    @filter.command("login")
    async def login(self, event: AstrMessageEvent):
        if not self._allowed_group(event):
            return
        message = str(getattr(event, "message_str", "") or "").strip()
        match = re.search(r"(?<!\d)(\d{7})(?!\d)", message)
        if not match:
            yield event.plain_result("用法：/login <7位验证码>")
            return

        status, body = await self._request(
            "/api/qq/bind",
            {
                "token": match.group(1),
                "qqNumber": self._numeric_id(event.get_sender_id()),
                "groupId": self._numeric_id(event.get_group_id()),
            },
        )
        if status == 200 and body.get("bound"):
            yield event.plain_result("QQ 绑定成功，登录成功")
        else:
            yield event.plain_result(body.get("error", "QQ 绑定失败"))

    async def _admin_request(self, event, path, payload=None):
        if not self._allowed_group(event):
            return {"error": "当前群未配置为蓝喵速递管理群"}
        if not self._is_admin(event):
            return {"error": "当前 QQ 未配置为蓝喵速递管理员"}
        data = {
            "adminQq": self._numeric_id(event.get_sender_id()),
            "groupId": self._numeric_id(event.get_group_id()),
        }
        if payload:
            data.update(payload)
        status, body = await self._request(path, data)
        return body if status == 200 else {"error": body.get("error", "命令执行失败")}

    async def _command_args(self, event):
        text = str(getattr(event, "message_str", "") or "").strip()
        return text.split()[1:]

    @filter.command("st")
    async def status(self, event: AstrMessageEvent):
        """服务器状态"""
        result = await self._admin_request(event, "/api/qq/admin/status")
        if result is not None:
            yield event.plain_result(result.get("message", result.get("error", "服务器状态暂时不可用")))

    @filter.command("find")
    async def search_user(self, event: AstrMessageEvent):
        """查询玩家：邮箱、VIP、QQ 绑定"""
        args = await self._command_args(event)
        result = await self._admin_request(
            event, "/api/qq/admin/user-search", {"query": " ".join(args)}
        )
        if result is not None:
            users = result.get("users", [])
            lines = [
                f"{user.get('displayName')} | {user.get('uuid')} | 邮箱 {user.get('email')} | QQ {user.get('qqNumber') or '未绑定'} | VIP {user.get('vipExpiresAt') or '无'}"
                for user in users
            ]
            yield event.plain_result("\n".join(lines) or result.get("error", "没有找到玩家"))

    async def _user_action(self, event, path):
        args = await self._command_args(event)
        result = await self._admin_request(event, path, {"query": " ".join(args)})
        if result is not None:
            yield event.plain_result(result.get("message", result.get("error", "完成")))

    @filter.command("ban")
    async def ban(self, event: AstrMessageEvent):
        """封禁玩家"""
        async for message in self._user_action(event, "/api/qq/admin/ban"):
            yield message

    @filter.command("unban")
    async def unban(self, event: AstrMessageEvent):
        """解禁玩家"""
        async for message in self._user_action(event, "/api/qq/admin/unban"):
            yield message

    @filter.command("unvip")
    async def revoke_vip(self, event: AstrMessageEvent):
        """撤销玩家 VIP"""
        async for message in self._user_action(event, "/api/qq/admin/revoke-vip"):
            yield message

    @staticmethod
    def _parse_duration(text):
        text = (text or "").strip().lower()
        if not text:
            return None, "请填写时长，例如：永久、1天、7天、1月、1年、30天"
        word_map = {
            "永久": "permanent", "永": "permanent", "permanent": "permanent",
            "时": 3600, "小时": 3600, "h": 3600, "hour": 3600,
            "天": 86400, "d": 86400, "day": 86400,
            "周": 604800, "星期": 604800, "w": 604800, "week": 604800,
            "月": 2592000, "m": 2592000, "month": 2592000,
            "季": 7776000, "quarter": 7776000,
            "年": 31536000, "y": 31536000, "year": 31536000,
        }
        if text in word_map:
            value = word_map[text]
            if isinstance(value, str):
                return {"duration": value}, None
            return {"durationSeconds": value}, None
        match = re.fullmatch(r"(\d+)\s*(秒|分钟|分|小时|时|天|日|周|星期|月|季|年)?", text)
        if match:
            number = int(match.group(1))
            unit = match.group(2) or "天"
            unit_map = {
                "秒": 1, "分钟": 60, "分": 60, "小时": 3600, "时": 3600,
                "天": 86400, "日": 86400, "周": 604800, "星期": 604800,
                "月": 2592000, "季": 7776000, "年": 31536000,
            }
            seconds = number * unit_map[unit]
            if seconds >= 3153600000:
                return {"duration": "permanent"}, None
            return {"durationSeconds": seconds}, None
        return None, "时长格式不正确，例如：永久、1天、7天、1月、1年"

    @filter.command("vip")
    async def issue_vip(self, event: AstrMessageEvent):
        """给玩家发放 VIP：/vip <玩家> <时长>"""
        args = await self._command_args(event)
        if not args:
            yield event.plain_result("用法：/vip <玩家> <时长>，例如：/vip 小明 7天 或 /vip 小明 永久")
            return
        payload, error = self._parse_duration(args[-1])
        if error:
            yield event.plain_result(error)
            return
        result = await self._admin_request(
            event, "/api/qq/admin/issue-vip", {**payload, "query": " ".join(args[:-1])}
        )
        if result is not None:
            yield event.plain_result(result.get("message", result.get("error", "发放成功")))

    @filter.command("help")
    async def help(self, event: AstrMessageEvent):
        """查看全部命令"""
        if not self._allowed_group(event):
            return
        yield event.plain_result(
            "蓝喵速递 QQ 管理命令：\n"
            "/st —— 服务器状态\n"
            "/find <玩家> —— 查询玩家（邮箱/VIP/QQ）\n"
            "/ban <玩家> —— 封禁玩家\n"
            "/unban <玩家> —— 解禁玩家\n"
            "/vip <玩家> <时长> —— 给玩家发放 VIP（如 永久、7天、1月、1年）\n"
            "/unvip <玩家> —— 撤销玩家 VIP\n"
            "/login <验证码> —— 绑定 QQ 并登录"
        )
