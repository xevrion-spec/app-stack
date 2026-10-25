"""Guarded Daytona client: hard limits on concurrency, daily creates, timeouts, network and lifetime.
Never pass secrets into a sandbox: env_vars is always empty and only the input file is uploaded."""
from __future__ import annotations
import json, re, time, datetime, pathlib, contextlib
from dataclasses import dataclass, field

HERE = pathlib.Path(__file__).resolve().parent
AUTOPILOT = HERE.parents[1]
LABEL_APP = "xevrion-autopilot"

class BudgetExceeded(RuntimeError): ...
class ConcurrencyExceeded(RuntimeError): ...

@dataclass
class SandboxConfig:
    max_concurrent: int = 1
    max_creates_per_day: int = 20
    exec_timeout_s: int = 60
    auto_stop_minutes: int = 5
    auto_delete_minutes: int = 0
    ephemeral: bool = True
    network_block_all: bool = True
    language: str = "python"
    janitor_max_age_minutes: int = 15
    usage_file: str = "local/out/sandbox_usage.json"
    @classmethod
    def load(cls, path: pathlib.Path | None = None) -> "SandboxConfig":
        d = json.loads((path or HERE / "sandbox.config.json").read_text())
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})

class Usage:
    """Per-day create counter + running totals (local JSON file)."""
    def __init__(self, path: pathlib.Path): self.path = path
    def _read(self):
        try: return json.loads(self.path.read_text())
        except Exception: return {"days": {}, "total_creates": 0, "total_seconds": 0.0, "last": None}
    def today(self): return self._read()["days"].get(datetime.date.today().isoformat(), 0)
    def record(self, seconds: float, tenant: str):
        d = self._read(); k = datetime.date.today().isoformat()
        d["days"][k] = d["days"].get(k, 0) + 1; d["total_creates"] += 1; d["total_seconds"] = round(d["total_seconds"] + seconds, 1)
        d["last"] = {"at": datetime.datetime.now().isoformat(timespec="seconds"), "tenant": tenant, "seconds": round(seconds, 1)}
        self.path.parent.mkdir(parents=True, exist_ok=True); self.path.write_text(json.dumps(d, indent=2))
    def summary(self): d = self._read(); d["today"] = self.today(); return d

def safe_label(s: str) -> str: return re.sub(r"[^a-z0-9-]", "-", s.lower())[:40] or "unknown"

class GuardedDaytona:
    def __init__(self, cfg: SandboxConfig | None = None, client=None, usage: Usage | None = None):
        self.cfg = cfg or SandboxConfig.load()
        self._client = client
        self.usage = usage or Usage(AUTOPILOT / self.cfg.usage_file)
    @property
    def client(self):
        if self._client is None:
            from daytona import Daytona  # reads DAYTONA_API_KEY / DAYTONA_API_URL from env
            self._client = Daytona()
        return self._client
    def ours(self):
        return [s for s in self.client.list() if (getattr(s, "labels", None) or {}).get("app") == LABEL_APP]
    def _params(self, tenant: str, purpose: str):
        from daytona import CreateSandboxFromSnapshotParams
        return CreateSandboxFromSnapshotParams(
            language=self.cfg.language, env_vars={}, public=False,
            labels={"app": LABEL_APP, "tenant": safe_label(tenant), "purpose": safe_label(purpose)},
            auto_stop_interval=self.cfg.auto_stop_minutes, auto_delete_interval=self.cfg.auto_delete_minutes,
            ephemeral=self.cfg.ephemeral, network_block_all=self.cfg.network_block_all)
    def check_limits(self):
        if self.usage.today() >= self.cfg.max_creates_per_day:
            raise BudgetExceeded(f"daily sandbox cap reached ({self.cfg.max_creates_per_day})")
        if len(self.ours()) >= self.cfg.max_concurrent:
            raise ConcurrencyExceeded(f"max concurrent sandboxes ({self.cfg.max_concurrent}) already running")
    @contextlib.contextmanager
    def sandbox(self, tenant: str, purpose: str, params=None):
        """Create -> yield -> ALWAYS delete. Counts against the daily budget."""
        self.check_limits()
        t = time.time(); sb = self.client.create(params or self._params(tenant, purpose))
        try: yield sb
        finally:
            try: self.client.delete(sb)
            finally: self.usage.record(time.time() - t, tenant)
    def exec(self, sb, cmd: str) -> str:
        r = sb.process.exec(cmd, timeout=self.cfg.exec_timeout_s)
        if getattr(r, "exit_code", 0): raise RuntimeError(f"sandbox exec failed ({r.exit_code}): {str(getattr(r,'result',''))[:300]}")
        return r.result
    def upload(self, sb, data: bytes, remote: str): sb.fs.upload_file(data, remote)
    def download(self, sb, remote: str) -> bytes: return sb.fs.download_file(remote)
    def janitor(self, max_age_minutes: int | None = None, dry_run: bool = False):
        """Delete our sandboxes older than max_age (default from config). Returns list of (id, age_min, action)."""
        age_lim = max_age_minutes if max_age_minutes is not None else self.cfg.janitor_max_age_minutes
        now = datetime.datetime.now(datetime.timezone.utc); out = []
        for s in self.ours():
            c = getattr(s, "created_at", None)
            try: created = datetime.datetime.fromisoformat(str(c).replace("Z", "+00:00"))
            except Exception: created = now - datetime.timedelta(days=1)  # unknown age -> treat as stale
            age = (now - created).total_seconds() / 60
            if age >= age_lim:
                if not dry_run: self.client.delete(s)
                out.append((s.id, round(age, 1), "deleted" if not dry_run else "would delete"))
        return out
