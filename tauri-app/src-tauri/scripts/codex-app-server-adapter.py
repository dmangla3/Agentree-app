#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def _resolve_sdk_src() -> Path:
    script_path = Path(__file__).resolve()
    sdk_src = script_path.parent.parent / "python-sdk"
    if (sdk_src / "codex_app_server" / "__init__.py").exists():
        return sdk_src
    raise ModuleNotFoundError(
        "Bundled Codex app-server SDK was not found at "
        f"{sdk_src}. Ensure `python-sdk/codex_app_server` is included as a Tauri resource."
    )


SDK_SRC = _resolve_sdk_src()
if str(SDK_SRC) not in sys.path:
    sys.path.insert(0, str(SDK_SRC))

from codex_app_server import AppServerClient, AppServerConfig, TextInput, Thread  # noqa: E402

FINAL_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["final_response", "commit_subject", "ai_label"],
    "properties": {
        "final_response": {
            "type": "string",
            "description": "User-visible final assistant response. Keep the normal summary, verification, and caveats here.",
        },
        "commit_subject": {
            "anyOf": [{"type": "string"}, {"type": "null"}],
            "description": (
                "Concise imperative git commit subject for the changes made, "
                "4-10 words, no trailing period. Use null if no files changed."
            ),
        },
        "ai_label": {
            "anyOf": [{"type": "string"}, {"type": "null"}],
            "description": (
                "Concise 5-10 word graph label for this assistant message. "
                "Describe the outcome, not the full response. No trailing period."
            ),
        },
    },
}


def _approval_handler(method: str, params: dict[str, Any] | None) -> dict[str, Any]:
    if method == "item/commandExecution/requestApproval":
        return {"decision": "accept"}
    if method == "item/fileChange/requestApproval":
        return {"decision": "accept"}
    if method == "mcpServer/elicitation/request":
        request_mode = params.get("mode") if isinstance(params, dict) else None
        if request_mode == "url":
            return {"action": "accept", "content": None}
        return {"action": "accept", "content": {}}
    return {}


class AgentreeCodex:
    def __init__(self, config: AppServerConfig) -> None:
        self._client = AppServerClient(config=config, approval_handler=_approval_handler)
        self._client.start()
        self._client.initialize()

    def __enter__(self) -> "AgentreeCodex":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def thread_start(self, **kwargs: Any) -> Thread:
        started = self._client.thread_start(kwargs)
        return Thread(self._client, started.thread.id)

    def thread_resume(self, thread_id: str, **kwargs: Any) -> Thread:
        resumed = self._client.thread_resume(thread_id, kwargs)
        return Thread(self._client, resumed.thread.id)

    def thread_fork(self, thread_id: str, **kwargs: Any) -> Thread:
        forked = self._client.thread_fork(thread_id, kwargs)
        return Thread(self._client, forked.thread.id)


def _emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, default=_json_default), flush=True)


def _json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, mode="json")
    if hasattr(value, "value"):
        return value.value
    return str(value)


def _resolve_codex_bin() -> str:
    env_path = os.environ.get("CODEX_BIN")
    if env_path:
        return env_path
    located = shutil.which("codex")
    if located:
        return located
    fallback = "/opt/homebrew/bin/codex"
    if Path(fallback).exists():
        return fallback
    raise FileNotFoundError("Could not find `codex` binary in PATH. Set CODEX_BIN.")


def _resolve_codex_home() -> str:
    env_path = os.environ.get("CODEX_HOME")
    if env_path and env_path.strip():
        return env_path.strip()
    return str(Path.home() / ".codex")


def _has_env_value(name: str) -> bool:
    return bool((os.environ.get(name) or "").strip())


def _redact_sensitive_text(value: str) -> str:
    redacted = value
    redacted = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "sk-REDACTED", redacted)
    redacted = re.sub(
        r"(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}",
        r"\1 REDACTED",
        redacted,
    )
    redacted = re.sub(
        r"(?i)(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)(['\"\s:=]+)[^'\"\s,}]+",
        r"\1\2REDACTED",
        redacted,
    )
    return redacted


def _text_excerpt(value: str, limit: int = 500) -> str:
    compact = " ".join(value.strip().split())
    return _redact_sensitive_text(compact[:limit])


def _normalize_commit_subject(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"[\n\r\t]+", " ", value)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    normalized = normalized.strip("\"'`- .")
    if not normalized:
        return None
    return normalized[:72].strip() or None


def _normalize_ai_label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"```[\s\S]*?```", " ", value)
    normalized = re.sub(r"`+", "", normalized)
    normalized = re.sub(r"[\n\r\t]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    normalized = normalized.strip("\"'`- .")
    if not normalized:
        return None
    return normalized[:80].strip() or None


def _normalize_final_response(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _structured_final_output_from_text(value: Any) -> dict[str, str | None] | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    final_response = _normalize_final_response(parsed.get("final_response"))
    commit_subject = _normalize_commit_subject(parsed.get("commit_subject"))
    ai_label = _normalize_ai_label(parsed.get("ai_label"))
    if final_response is None and commit_subject is None and ai_label is None:
        return None
    return {
        "final_response": final_response,
        "commit_subject": commit_subject,
        "ai_label": ai_label,
    }


def _merge_structured_final_output(
    current: dict[str, str | None] | None,
    next_value: dict[str, str | None] | None,
) -> dict[str, str | None] | None:
    if next_value is None:
        return current
    return {
        "final_response": next_value.get("final_response") or (current or {}).get("final_response"),
        "commit_subject": next_value.get("commit_subject") or (current or {}).get("commit_subject"),
        "ai_label": next_value.get("ai_label") or (current or {}).get("ai_label"),
    }


def _decode_json_string_prefix(value: str) -> str:
    decoded: list[str] = []
    index = 0
    while index < len(value):
        ch = value[index]
        if ch != "\\":
            decoded.append(ch)
            index += 1
            continue
        if index + 1 >= len(value):
            break
        escaped = value[index + 1]
        if escaped == "u":
            hex_value = value[index + 2:index + 6]
            if len(hex_value) < 4 or not re.fullmatch(r"[0-9a-fA-F]{4}", hex_value):
                break
            decoded.append(chr(int(hex_value, 16)))
            index += 6
            continue
        replacements = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            "b": "\b",
            "f": "\f",
            "n": "\n",
            "r": "\r",
            "t": "\t",
        }
        if escaped not in replacements:
            break
        decoded.append(replacements[escaped])
        index += 2
    return "".join(decoded)


def _json_string_field_prefix(buffer: str, field_name: str) -> str | None:
    match = re.search(rf'"{re.escape(field_name)}"\s*:\s*"', buffer)
    if not match:
        return None
    start = match.end()
    index = start
    escaped = False
    while index < len(buffer):
        ch = buffer[index]
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            return _decode_json_string_prefix(buffer[start:index])
        index += 1
    return _decode_json_string_prefix(buffer[start:])


def _suffix_after_prefix(previous: str, current: str) -> str:
    if current.startswith(previous):
        return current[len(previous):]
    return current


def _path_exists(path: str | Path) -> bool:
    try:
        return Path(path).exists()
    except OSError:
        return False


def _run_codex_probe(codex_bin: str, args: list[str], codex_home: str, timeout: int = 10) -> dict[str, Any]:
    try:
        result = subprocess.run(
            [codex_bin, *args],
            env={**os.environ, "CODEX_HOME": codex_home},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception as error:
        return {
            "ok": False,
            "error_type": error.__class__.__name__,
        }
    return {
        "ok": result.returncode == 0,
        "exit_code": result.returncode,
        "output_excerpt": _text_excerpt(result.stdout),
    }


def _codex_environment_detail(codex_bin: str, codex_home: str) -> dict[str, Any]:
    codex_home_path = Path(codex_home)
    return {
        "codex_bin": codex_bin,
        "codex_home": codex_home,
        "codex_bin_exists": _path_exists(codex_bin),
        "codex_home_exists": _path_exists(codex_home_path),
        "codex_auth_json_exists": _path_exists(codex_home_path / "auth.json"),
        "codex_config_exists": _path_exists(codex_home_path / "config.toml"),
        "codex_state_db_exists": _path_exists(codex_home_path / "state_5.sqlite"),
        "codex_logs_db_exists": _path_exists(codex_home_path / "logs_2.sqlite"),
        "codex_version": _run_codex_probe(codex_bin, ["--version"], codex_home, timeout=5),
        "env_HOME": os.environ.get("HOME"),
        "env_USER": os.environ.get("USER"),
        "env_SHELL": os.environ.get("SHELL"),
        "path_entries": os.environ.get("PATH", "").split(os.pathsep)[:12],
        "has_OPENAI_API_KEY": _has_env_value("OPENAI_API_KEY"),
        "has_CODEX_API_KEY": _has_env_value("CODEX_API_KEY"),
    }


def _sanitize_account(account: Any) -> dict[str, Any] | None:
    if not isinstance(account, dict):
        return None
    account_type = account.get("type")
    sanitized: dict[str, Any] = {"type": account_type}
    if account_type == "chatgpt":
        sanitized["planType"] = account.get("planType")
    return sanitized


def _read_account(codex: Codex) -> dict[str, Any]:
    response = codex._client._request_raw("account/read", {})  # type: ignore[attr-defined]
    if not isinstance(response, dict):
        raise RuntimeError("Codex account/read response was not a JSON object.")
    return response


def _codex_login_status_ok(codex_bin: str, codex_home: str) -> bool:
    probe = _run_codex_probe(codex_bin, ["login", "status"], codex_home)
    if not probe.get("ok") and "exit_code" not in probe:
        _emit_trace(
            "codex_login_status_probe_failed",
            {
                "error_type": probe.get("error_type"),
            },
        )
        return False

    output_excerpt = str(probe.get("output_excerpt") or "")
    logged_in = bool(probe.get("ok")) and "Logged in" in output_excerpt
    _emit_trace(
        "codex_login_status_probe",
        {
            "exit_code": probe.get("exit_code"),
            "logged_in": logged_in,
            "output_excerpt": output_excerpt,
        },
    )
    return logged_in


def _ensure_codex_auth(codex: Codex, codex_bin: str, codex_home: str) -> None:
    response = _read_account(codex)
    account = response.get("account")
    requires_openai_auth = response.get("requiresOpenaiAuth")
    if requires_openai_auth is None:
        requires_openai_auth = True

    _emit_trace(
        "codex_account_read",
        {
            "requiresOpenaiAuth": bool(requires_openai_auth),
            "account": _sanitize_account(account),
        },
    )

    if requires_openai_auth and not account:
        if _codex_login_status_ok(codex_bin, codex_home):
            _emit_trace(
                "codex_account_read_empty_but_cli_logged_in",
                {
                    "codex_bin": codex_bin,
                    "codex_home": codex_home,
                },
            )
            return

        raise RuntimeError(
            "Codex authentication is missing in Agentree's app-server environment. "
            f"CODEX_HOME is {codex_home}, and {codex_home}/auth.json is "
            f"{'present' if _path_exists(Path(codex_home) / 'auth.json') else 'missing'}. "
            "Agentree may be unable to read Codex's macOS keychain credential from its app sandbox. "
            f"Run `CODEX_HOME={codex_home} codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth` "
            "in a terminal to create file-backed Codex auth, then retry from Agentree."
        )


def _auth_config_overrides(codex_home: str) -> list[str]:
    auth_json_path = Path(codex_home) / "auth.json"
    if _path_exists(auth_json_path):
        return ['cli_auth_credentials_store="file"']
    return []


def _classify_provider_error(message: str) -> dict[str, Any]:
    code = "provider_error"
    if "usageLimitExceeded" in message or "usage limit" in message.lower():
        code = "usage_limit_exceeded"
    elif "Unauthorized" in message or "authentication" in message.lower():
        code = "auth_error"
    elif "rate limit" in message.lower():
        code = "rate_limited"

    user_message = message
    match = re.search(r'message="([^"]+)"', message)
    if match:
        user_message = match.group(1)

    return {
        "provider_error_code": code,
        "provider_error_message": user_message,
    }


def _recommended_file_auth_command(codex_home: str) -> str:
    return f"CODEX_HOME={codex_home} codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth"


def _emit_readiness_check() -> int:
    codex_home = _resolve_codex_home()
    recommended_command = _recommended_file_auth_command(codex_home)
    base: dict[str, Any] = {
        "status": "unknown_error",
        "codexHome": codex_home,
        "hasAuthJson": _path_exists(Path(codex_home) / "auth.json"),
        "hasOpenaiApiKey": _has_env_value("OPENAI_API_KEY"),
        "hasCodexApiKey": _has_env_value("CODEX_API_KEY"),
        "recommendedCommand": recommended_command,
        "message": "Codex readiness could not be determined.",
    }

    try:
        codex_bin = _resolve_codex_bin()
    except FileNotFoundError as error:
        print(
            json.dumps(
                {
                    **base,
                    "status": "cli_missing",
                    "message": str(error),
                }
            ),
            flush=True,
        )
        return 0

    version_probe = _run_codex_probe(codex_bin, ["--version"], codex_home, timeout=5)
    base.update(
        {
            "codexBin": codex_bin,
            "codexBinExists": _path_exists(codex_bin),
            "codexVersion": version_probe.get("output_excerpt") if version_probe.get("ok") else None,
            "versionError": version_probe.get("output_excerpt") or version_probe.get("error_type"),
        }
    )
    if not version_probe.get("ok"):
        print(
            json.dumps(
                {
                    **base,
                    "status": "cli_not_executable",
                    "message": "Codex CLI was found but could not be executed.",
                }
            ),
            flush=True,
        )
        return 0

    config = AppServerConfig(
        codex_bin=codex_bin,
        cwd=os.getcwd(),
        env={"CODEX_HOME": codex_home},
        config_overrides=tuple(_auth_config_overrides(codex_home)),
        client_name="agentree_codex_readiness",
        client_title="Agentree Codex Readiness",
    )
    try:
        with AgentreeCodex(config=config) as codex:
            response = _read_account(codex)
    except Exception as error:  # noqa: BLE001
        login_probe = _run_codex_probe(codex_bin, ["login", "status"], codex_home)
        print(
            json.dumps(
                {
                    **base,
                    "status": "unknown_error",
                    "loginStatus": login_probe,
                    "message": f"Codex app-server readiness check failed: {error.__class__.__name__}.",
                }
            ),
            flush=True,
        )
        return 0

    account = response.get("account")
    sanitized_account = _sanitize_account(account)
    if sanitized_account:
        auth_mode = sanitized_account.get("type")
        print(
            json.dumps(
                {
                    **base,
                    "status": "ready",
                    "authMode": auth_mode,
                    "planType": sanitized_account.get("planType"),
                    "account": sanitized_account,
                    "message": "Codex is ready for Agentree.",
                    "recommendedCommand": None,
                }
            ),
            flush=True,
        )
        return 0

    login_probe = _run_codex_probe(codex_bin, ["login", "status"], codex_home)
    status = "auth_missing" if base["hasAuthJson"] else "keychain_unavailable"
    message = (
        "Codex file-backed auth exists, but Agentree could not use it. Re-run the file-backed Codex login command."
        if base["hasAuthJson"]
        else "Codex is not available to Agentree. Terminal keychain login can fail from the desktop app, so use file-backed Codex login."
    )
    print(
        json.dumps(
            {
                **base,
                "status": status,
                "loginStatus": login_probe,
                "message": message,
            }
        ),
        flush=True,
    )
    return 0


def _extract_item(item: Any) -> Any:
    return getattr(item, "root", item)


def _extract_assistant_text(payload: Any) -> str:
    item = _extract_item(getattr(payload, "item", None))
    if item is None:
        return ""
    text = getattr(item, "text", None)
    return text if isinstance(text, str) else ""


def _safe_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _map_usage(token_usage: Any) -> dict[str, Any]:
    last = getattr(token_usage, "last", None)
    total = getattr(token_usage, "total", None)
    return {
        "input_tokens": getattr(last, "input_tokens", None),
        "output_tokens": getattr(last, "output_tokens", None),
        "reasoning_output_tokens": getattr(last, "reasoning_output_tokens", None),
        "cached_input_tokens": getattr(last, "cached_input_tokens", None),
        "total_tokens": getattr(last, "total_tokens", None),
        "cumulative_input_tokens": getattr(total, "input_tokens", None),
        "cumulative_output_tokens": getattr(total, "output_tokens", None),
        "cumulative_reasoning_output_tokens": getattr(total, "reasoning_output_tokens", None),
        "cumulative_cached_input_tokens": getattr(total, "cached_input_tokens", None),
        "cumulative_total_tokens": getattr(total, "total_tokens", None),
        "model_context_window": getattr(token_usage, "model_context_window", None),
    }


def _map_rate_limit_window(window: Any) -> dict[str, Any] | None:
    if window is None:
        return None
    return {
        "resetsAt": getattr(window, "resets_at", None),
        "usedPercent": getattr(window, "used_percent", None),
        "windowDurationMins": getattr(window, "window_duration_mins", None),
    }


def _map_rate_limits(rate_limits: Any) -> dict[str, Any] | None:
    if rate_limits is None:
        return None

    credits = getattr(rate_limits, "credits", None)
    return {
        "kind": "codex",
        "credits": {
            "balance": getattr(credits, "balance", None),
            "hasCredits": getattr(credits, "has_credits", None),
            "unlimited": getattr(credits, "unlimited", None),
        }
        if credits is not None
        else None,
        "limitId": getattr(rate_limits, "limit_id", None),
        "limitName": getattr(rate_limits, "limit_name", None),
        "planType": getattr(getattr(rate_limits, "plan_type", None), "value", getattr(rate_limits, "plan_type", None)),
        "primary": _map_rate_limit_window(getattr(rate_limits, "primary", None)),
        "secondary": _map_rate_limit_window(getattr(rate_limits, "secondary", None)),
    }


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Agentree production adapter for codex app-server streaming.",
        add_help=False,
    )
    parser.add_argument("--model", default="gpt-5.4")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--reasoning-effort", default=None)
    parser.add_argument("--permission-mode", default=None)
    parser.add_argument("--provider-thread-id", default=None)
    parser.add_argument("--provider-turn-id", default=None)
    parser.add_argument("--provider-thread-strategy", default=None)
    parser.add_argument("--source-provider-thread-id", default=None)
    parser.add_argument("--source-provider-lineage-id", default=None)
    parser.add_argument("--target-provider-user-turn-count", default=None)
    parser.add_argument("--target-node-id", default=None)
    parser.add_argument("--node-id", default=None)
    parser.add_argument("--raw-events", action="store_true")
    parser.add_argument("--readiness-check", action="store_true")
    parser.add_argument("prompt", nargs="?")
    args, unknown = parser.parse_known_args(argv)

    if args.prompt is None:
        # Keep compatibility with existing spawn args where prompt is final token.
        if unknown:
            args.prompt = unknown[-1]
            unknown = unknown[:-1]
        else:
            args.prompt = ""
    args.unknown = unknown
    return args


def _emit_trace(name: str, detail: dict[str, Any] | None = None) -> None:
    event: dict[str, Any] = {
        "type": "trace",
        "name": name,
        "source": "codex_app_server_adapter",
        "ts": int(time.time() * 1000),
    }
    if detail:
        event["detail"] = detail
    _emit(event)


def _thread_user_turn_count(thread: Any) -> int | None:
    try:
        read_response = thread.read(include_turns=True)
        read_thread = getattr(read_response, "thread", None)
        turns = getattr(read_thread, "turns", None)
        if not isinstance(turns, list):
            return None
        count = 0
        for turn in turns:
            items = getattr(turn, "items", None)
            if not isinstance(items, list):
                continue
            is_user_turn = False
            for item in items:
                root = _extract_item(item)
                item_type = getattr(root, "type", None)
                if item_type == "userMessage":
                    is_user_turn = True
                    break
            if is_user_turn:
                count += 1
        return count
    except Exception:
        return None


def _enum_value(value: Any) -> Any:
    return getattr(value, "value", value)


def _tool_output_from_item(item: Any, output_deltas_by_item_id: dict[str, str]) -> Any:
    item_id = getattr(item, "id", None)
    delta_output = output_deltas_by_item_id.get(item_id or "")
    aggregated_output = getattr(item, "aggregated_output", None)
    if isinstance(aggregated_output, str) and aggregated_output:
        return aggregated_output
    if isinstance(delta_output, str) and delta_output:
        return delta_output
    return aggregated_output


def _map_mcp_tool_name(item: Any) -> str:
    server = getattr(item, "server", None)
    tool = getattr(item, "tool", None)
    if isinstance(server, str) and server and isinstance(tool, str) and tool:
        return f"{server}.{tool}"
    if isinstance(tool, str) and tool:
        return tool
    return "mcpToolCall"


def _map_tool_event(item: Any, *, completed: bool) -> dict[str, Any] | None:
    return _map_tool_event_with_output(item, completed=completed, output_deltas_by_item_id={})


def _map_tool_event_with_output(
    item: Any,
    *,
    completed: bool,
    output_deltas_by_item_id: dict[str, str],
) -> dict[str, Any] | None:
    item_type = getattr(item, "type", None)
    item_id = getattr(item, "id", None)
    item_payload = _json_default(item)

    if item_type == "commandExecution":
        if completed:
            return {
                "type": "tool_result",
                "toolName": "commandExecution",
                "toolUseId": item_id,
                "toolOutput": _tool_output_from_item(item, output_deltas_by_item_id),
                "status": _enum_value(getattr(item, "status", None)),
                "durationMs": getattr(item, "duration_ms", None),
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item_payload,
            }
        return {
            "type": "tool_use",
            "name": "commandExecution",
            "id": item_id,
            "input": {
                "command": getattr(item, "command", None),
                "cwd": getattr(item, "cwd", None),
            },
            "commandActions": getattr(item, "command_actions", None),
            "item_type": item_type,
            "provider_item_id": item_id,
            "provider_item": item_payload,
        }

    if item_type == "mcpToolCall":
        tool_name = _map_mcp_tool_name(item)
        if completed:
            error = getattr(item, "error", None)
            return {
                "type": "tool_result",
                "toolName": tool_name,
                "toolUseId": item_id,
                "toolOutput": getattr(item, "result", None),
                "is_error": error is not None or _enum_value(getattr(item, "status", None)) == "failed",
                "durationMs": getattr(item, "duration_ms", None),
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item_payload,
            }
        return {
            "type": "tool_use",
            "name": tool_name,
            "id": item_id,
            "input": getattr(item, "arguments", None),
            "item_type": item_type,
            "provider_item_id": item_id,
            "provider_item": item_payload,
        }

    if item_type == "fileChange":
        if completed:
            return {
                "type": "tool_result",
                "toolName": "fileChange",
                "toolUseId": item_id,
                "toolOutput": {
                    "status": _enum_value(getattr(item, "status", None)),
                    "output": output_deltas_by_item_id.get(item_id or ""),
                },
                "is_error": _enum_value(getattr(item, "status", None)) == "failed",
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item_payload,
            }
        return {
            "type": "tool_use",
            "name": "fileChange",
            "id": item_id,
            "input": {"changes": getattr(item, "changes", None)},
            "item_type": item_type,
            "provider_item_id": item_id,
            "provider_item": item_payload,
        }

    if item_type == "dynamicToolCall":
        tool_name = getattr(item, "tool", None) or "dynamicToolCall"
        if completed:
            return {
                "type": "tool_result",
                "toolName": tool_name,
                "toolUseId": item_id,
                "toolOutput": getattr(item, "content_items", None),
                "is_error": getattr(item, "success", None) is False,
                "durationMs": getattr(item, "duration_ms", None),
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item_payload,
            }
        return {
            "type": "tool_use",
            "name": tool_name,
            "id": item_id,
            "input": getattr(item, "arguments", None),
            "item_type": item_type,
            "provider_item_id": item_id,
            "provider_item": item_payload,
        }

    if item_type == "webSearch":
        if completed:
            return {
                "type": "tool_result",
                "toolName": "webSearch",
                "toolUseId": item_id,
                "toolOutput": getattr(item, "action", None),
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item_payload,
            }
        return {
            "type": "tool_use",
            "name": "webSearch",
            "id": item_id,
            "input": {"query": getattr(item, "query", None)},
            "item_type": item_type,
            "provider_item_id": item_id,
            "provider_item": item_payload,
        }

    if item_type == "imageGeneration":
        if completed:
            return {
                "type": "tool_result",
                "toolName": "imageGeneration",
                "toolUseId": item_id,
                "toolOutput": {
                    "status": getattr(item, "status", None),
                    "revisedPrompt": getattr(item, "revised_prompt", None),
                    "result": getattr(item, "result", None),
                },
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item_payload,
            }
        return {
            "type": "tool_use",
            "name": "imageGeneration",
            "id": item_id,
            "input": {},
            "item_type": item_type,
            "provider_item_id": item_id,
            "provider_item": item_payload,
        }

    if item_type == "collabAgentToolCall":
        tool_name = getattr(item, "tool", None) or "collabAgentToolCall"
        if completed:
            return {
                "type": "tool_result",
                "toolName": tool_name,
                "toolUseId": item_id,
                "toolOutput": {
                    "status": _enum_value(getattr(item, "status", None)),
                    "receiverThreadIds": getattr(item, "receiver_thread_ids", None),
                    "agentsStates": getattr(item, "agents_states", None),
                },
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item_payload,
            }
        return {
            "type": "tool_use",
            "name": tool_name,
            "id": item_id,
            "input": {
                "prompt": getattr(item, "prompt", None),
                "model": getattr(item, "model", None),
                "reasoningEffort": getattr(item, "reasoning_effort", None),
            },
            "item_type": item_type,
            "provider_item_id": item_id,
            "provider_item": item_payload,
        }

    return None


def main() -> int:
    args = _parse_args(sys.argv[1:])
    if args.readiness_check:
        return _emit_readiness_check()

    prompt = args.prompt or ""
    start_ts = time.time()
    first_provider_event_emitted = False
    first_delta_emitted = False
    first_delta_ts_ms: int | None = None
    delta_count = 0
    active_thread_id: str | None = None
    active_turn_id: str | None = None
    last_usage: dict[str, Any] | None = None
    raw_methods: set[str] = set()
    fallback_reason: str | None = None
    initial_strategy_selected: str | None = None
    fallback_strategy_selected: str | None = None
    failed_fork_discarded = False
    source_provider_thread_id: str | None = None
    forked_provider_thread_id: str | None = None
    provider_lineage_id: str | None = None
    source_provider_user_turn_count: int | None = None
    target_provider_user_turn_count = _safe_int(args.target_provider_user_turn_count)
    computed_trailing_turn_count: int | None = None
    rollback_turn_count: int | None = None
    branch_point_mapping_confidence = "unknown"
    cumulative_text = ""
    structured_text_buffer = ""
    structured_final_output: dict[str, str | None] | None = None
    last_provider_error: dict[str, Any] | None = None
    output_deltas_by_item_id: dict[str, str] = {}

    def _fail_provider_thread_reuse(
        *,
        reason_code: str,
        message: str,
        requested_strategy: str | None,
        source_thread_id: str | None,
        source_turn_id: str | None = None,
        extra_meta: dict[str, Any] | None = None,
    ) -> int:
        now_ms = int(time.time() * 1000)
        meta = {
            "provider": "codex",
            "transport": "app_server",
            "provider_client": "agentree",
            "provider_thread_strategy": "failed",
            "provider_initial_strategy_selected": requested_strategy,
            "provider_fallback_strategy_selected": None,
            "provider_fallback_reason_code": reason_code,
            "provider_source_thread_id": source_thread_id,
            "provider_source_turn_id": source_turn_id,
            "provider_error_code": "provider_thread_reuse_failed",
            "provider_error_message": message,
            "provider_failed_fork_discarded": failed_fork_discarded,
            "provider_forked_thread_id": forked_provider_thread_id,
            "provider_source_user_turn_count": source_provider_user_turn_count,
            "provider_target_user_turn_count": target_provider_user_turn_count,
            "provider_computed_trailing_turn_count": computed_trailing_turn_count,
            "provider_rollback_turn_count": rollback_turn_count,
            "provider_branch_point_mapping_confidence": branch_point_mapping_confidence,
            "provider_branch_target_node_id": args.target_node_id,
        }
        if extra_meta:
            meta.update(extra_meta)
        _emit({"type": "provider_meta", "meta": meta, "timestamp": now_ms})
        _emit({"type": "error", "content": message, "timestamp": now_ms})
        _emit(
            {
                "type": "provider_stop",
                "provider_stop_reason": reason_code,
                "provider_status": "failed",
                "final_content": message,
                "provider_thread_id": active_thread_id,
                "provider_turn_id": active_turn_id,
                "timestamp": now_ms,
            }
        )
        return 1

    _emit_trace("adapter_started", {"node_id": args.node_id, "cwd": args.cwd})

    try:
        codex_bin = _resolve_codex_bin()
        codex_home = _resolve_codex_home()
        _emit_trace(
            "codex_environment",
            _codex_environment_detail(codex_bin, codex_home),
        )
        mcp_url = os.environ.get("AGENTREE_MCP_URL") or os.environ.get("MCP_SERVER_URL")
        config_overrides: list[str] = _auth_config_overrides(codex_home)
        if mcp_url:
            config_overrides.extend(
                [
                    "features.connectors=true",
                    f'mcp_servers.agentree.url="{mcp_url}"',
                ]
            )

        app_server_config = AppServerConfig(
            codex_bin=codex_bin,
            cwd=args.cwd,
            env={"CODEX_HOME": codex_home},
            config_overrides=tuple(config_overrides),
            client_name="agentree_codex_adapter",
            client_title="Agentree Codex Adapter",
        )

        with AgentreeCodex(config=app_server_config) as codex:
            _ensure_codex_auth(codex, codex_bin, codex_home)

            requested_strategy = (args.provider_thread_strategy or "").strip().lower() or "fresh_thread"
            if requested_strategy not in {"resume", "fork", "fork_then_rollback", "fresh_thread"}:
                requested_strategy = "fresh_thread"
            initial_strategy_selected = requested_strategy

            source_thread_id = args.source_provider_thread_id or args.provider_thread_id
            source_provider_thread_id = source_thread_id

            thread_kwargs: dict[str, Any] = {
                "model": args.model,
                "cwd": args.cwd,
            }
            if args.reasoning_effort:
                thread_kwargs["config"] = {"model_reasoning_effort": args.reasoning_effort}

            thread = None
            thread_strategy = "fresh_thread"

            if requested_strategy in {"resume", "fork", "fork_then_rollback"} and not source_thread_id:
                return _fail_provider_thread_reuse(
                    reason_code="provider_source_thread_missing",
                    message=(
                        f"Codex could not {requested_strategy} the provider thread because "
                        "Agentree did not have a source provider thread id for the parent node."
                    ),
                    requested_strategy=requested_strategy,
                    source_thread_id=source_thread_id,
                    source_turn_id=args.provider_turn_id,
                )

            if requested_strategy == "resume" and source_thread_id:
                try:
                    thread = codex.thread_resume(source_thread_id, **thread_kwargs)
                    thread_strategy = "resume"
                except Exception as resume_error:
                    return _fail_provider_thread_reuse(
                        reason_code=f"resume_failed:{resume_error.__class__.__name__}",
                        message=f"Codex could not resume provider thread {source_thread_id}: {resume_error}",
                        requested_strategy=requested_strategy,
                        source_thread_id=source_thread_id,
                        source_turn_id=args.provider_turn_id,
                    )
            elif requested_strategy in {"fork", "fork_then_rollback"} and source_thread_id:
                source_for_count = None
                try:
                    source_for_count = codex.thread_resume(source_thread_id, **thread_kwargs)
                    source_provider_user_turn_count = _thread_user_turn_count(source_for_count)
                except Exception as count_error:
                    source_provider_user_turn_count = None
                    if requested_strategy == "fork_then_rollback":
                        return _fail_provider_thread_reuse(
                            reason_code=f"rollback_source_read_failed:{count_error.__class__.__name__}",
                            message=(
                                f"Codex could not read source provider thread {source_thread_id} "
                                f"to compute the rollback point: {count_error}"
                            ),
                            requested_strategy=requested_strategy,
                            source_thread_id=source_thread_id,
                            source_turn_id=args.provider_turn_id,
                        )

                if requested_strategy == "fork_then_rollback":
                    if (
                        source_provider_user_turn_count is not None and
                        target_provider_user_turn_count is not None and
                        target_provider_user_turn_count >= 0
                    ):
                        computed_trailing_turn_count = source_provider_user_turn_count - target_provider_user_turn_count
                        branch_point_mapping_confidence = "high" if computed_trailing_turn_count >= 0 else "invalid"
                    else:
                        branch_point_mapping_confidence = "low"
                        return _fail_provider_thread_reuse(
                            reason_code="rollback_target_mapping_missing",
                            message=(
                                "Codex could not compute a safe rollback point for this branch. "
                                "The parent node is missing provider user-turn metadata."
                            ),
                            requested_strategy=requested_strategy,
                            source_thread_id=source_thread_id,
                            source_turn_id=args.provider_turn_id,
                        )

                try:
                    forked = codex.thread_fork(source_thread_id, **thread_kwargs)
                    forked_provider_thread_id = forked.id
                    thread = forked
                    thread_strategy = "fork"
                except Exception as fork_error:
                    return _fail_provider_thread_reuse(
                        reason_code=f"fork_failed:{fork_error.__class__.__name__}",
                        message=f"Codex could not fork provider thread {source_thread_id}: {fork_error}",
                        requested_strategy=requested_strategy,
                        source_thread_id=source_thread_id,
                        source_turn_id=args.provider_turn_id,
                    )

                if (
                    requested_strategy == "fork_then_rollback" and
                    thread_strategy == "fork" and
                    computed_trailing_turn_count is not None
                ):
                    if computed_trailing_turn_count >= 1:
                        rollback_turn_count = computed_trailing_turn_count
                        try:
                            # Python SDK currently lacks a high-level helper for rollback.
                            codex._client._request_raw(  # type: ignore[attr-defined]
                                "thread/rollback",
                                {"threadId": thread.id, "numTurns": rollback_turn_count},
                            )
                            thread_strategy = "fork_then_rollback"
                        except Exception as rollback_error:
                            failed_fork_discarded = True
                            return _fail_provider_thread_reuse(
                                reason_code=f"rollback_failed:{rollback_error.__class__.__name__}",
                                message=(
                                    f"Codex forked provider thread {source_thread_id}, but rollback "
                                    f"to the branch point failed: {rollback_error}"
                                ),
                                requested_strategy=requested_strategy,
                                source_thread_id=source_thread_id,
                                source_turn_id=args.provider_turn_id,
                                extra_meta={"provider_forked_thread_id": forked_provider_thread_id},
                            )
                    elif computed_trailing_turn_count == 0:
                        thread_strategy = "fork"
                    else:
                        failed_fork_discarded = True
                        return _fail_provider_thread_reuse(
                            reason_code="rollback_turn_count_negative",
                            message=(
                                "Codex could not safely branch from this provider thread because "
                                "the computed rollback turn count was negative."
                            ),
                            requested_strategy=requested_strategy,
                            source_thread_id=source_thread_id,
                            source_turn_id=args.provider_turn_id,
                            extra_meta={"provider_forked_thread_id": forked_provider_thread_id},
                        )
            else:
                thread = codex.thread_start(**thread_kwargs)

            active_thread_id = thread.id
            provider_lineage_id = (
                args.source_provider_lineage_id
                or source_provider_thread_id
                or active_thread_id
            )
            _emit(
                {
                    "type": "provider_meta",
                    "meta": {
                        "provider": "codex",
                        "transport": "app_server",
                        "provider_client": "agentree",
                        "provider_thread_id": active_thread_id,
                        "provider_source_thread_id": source_thread_id,
                        "provider_lineage_id": provider_lineage_id,
                        "provider_thread_strategy": thread_strategy,
                        "provider_initial_strategy_selected": initial_strategy_selected,
                        "provider_fallback_strategy_selected": fallback_strategy_selected,
                        "provider_fallback_reason_code": fallback_reason,
                        "provider_failed_fork_discarded": failed_fork_discarded,
                        "provider_forked_thread_id": forked_provider_thread_id,
                        "provider_source_user_turn_count": source_provider_user_turn_count,
                        "provider_target_user_turn_count": target_provider_user_turn_count,
                        "provider_computed_trailing_turn_count": computed_trailing_turn_count,
                        "provider_rollback_turn_count": rollback_turn_count,
                        "provider_branch_point_mapping_confidence": branch_point_mapping_confidence,
                        "provider_branch_target_node_id": args.target_node_id,
                        "provider_turn_id": args.provider_turn_id,
                        "provider_model": args.model,
                        "provider_run_mode": args.permission_mode,
                        "provider_thread_resume_enabled": thread_strategy == "resume",
                    },
                }
            )
            _emit({"type": "session", "session_id": active_thread_id, "provider": "codex", "transport": "app_server"})
            _emit_trace("thread_ready", {"provider_thread_id": active_thread_id, "strategy": thread_strategy})

            turn = thread.turn(
                TextInput(prompt),
                model=args.model,
                cwd=args.cwd,
                output_schema=FINAL_RESULT_SCHEMA,
            )
            for event in turn.stream():
                method = event.method
                payload = event.payload
                now_ms = int(time.time() * 1000)
                if method not in raw_methods:
                    raw_methods.add(method)

                if not first_provider_event_emitted:
                    first_provider_event_emitted = True
                    _emit_trace("first_provider_event", {"method": method})

                if method == "turn/started":
                    turn_obj = getattr(payload, "turn", None)
                    active_turn_id = getattr(turn_obj, "id", None) or active_turn_id
                    _emit(
                        {
                            "type": "provider_meta",
                            "meta": {
                                "provider_turn_id": active_turn_id,
                            },
                        }
                    )
                    continue

                if method == "item/agentMessage/delta":
                    delta = getattr(payload, "delta", "")
                    if isinstance(delta, str) and delta:
                        structured_text_buffer += delta
                        delta_count += 1
                        if not first_delta_emitted:
                            first_delta_emitted = True
                            first_delta_ts_ms = now_ms
                            _emit_trace("first_assistant_delta", {"provider_turn_id": getattr(payload, "turn_id", None)})
                        visible_prefix = _json_string_field_prefix(structured_text_buffer, "final_response")
                        if visible_prefix:
                            visible_delta = _suffix_after_prefix(cumulative_text, visible_prefix)
                            if visible_delta:
                                cumulative_text = visible_prefix
                                _emit(
                                    {
                                        "type": "message_delta",
                                        "delta": visible_delta,
                                        "provider_item_id": getattr(payload, "item_id", None),
                                        "provider_thread_id": getattr(payload, "thread_id", None),
                                        "provider_turn_id": getattr(payload, "turn_id", None),
                                        "timestamp": now_ms,
                                    }
                                )
                    continue

                if method == "item/started":
                    item = _extract_item(getattr(payload, "item", None))
                    if item is None:
                        continue
                    mapped_tool = _map_tool_event_with_output(
                        item,
                        completed=False,
                        output_deltas_by_item_id=output_deltas_by_item_id,
                    )
                    if mapped_tool:
                        mapped_tool["timestamp"] = now_ms
                        _emit(mapped_tool)
                    continue

                if method in ("item/commandExecution/outputDelta", "item/fileChange/outputDelta"):
                    delta = getattr(payload, "delta", "")
                    item_id = getattr(payload, "item_id", None)
                    if isinstance(delta, str) and delta and isinstance(item_id, str) and item_id:
                        output_deltas_by_item_id[item_id] = output_deltas_by_item_id.get(item_id, "") + delta
                        _emit(
                            {
                                "type": "tool_output_delta",
                                "toolUseId": item_id,
                                "delta": delta,
                                "provider_item_id": item_id,
                                "provider_thread_id": getattr(payload, "thread_id", None),
                                "provider_turn_id": getattr(payload, "turn_id", None),
                                "timestamp": now_ms,
                            }
                        )
                    continue

                if method == "item/completed":
                    item = _extract_item(getattr(payload, "item", None))
                    item_type = getattr(item, "type", None)
                    item_id = getattr(item, "id", None)
                    if item_type == "agentMessage":
                        text = _extract_assistant_text(payload)
                        if isinstance(text, str) and text:
                            structured_final_output = _merge_structured_final_output(
                                structured_final_output,
                                _structured_final_output_from_text(text),
                            )
                            structured_text_buffer = text if len(text) >= len(structured_text_buffer) else structured_text_buffer
                        visible_text = (
                            structured_final_output.get("final_response")
                            if structured_final_output
                            else None
                        ) or text
                        if isinstance(visible_text, str) and visible_text:
                            cumulative_text = visible_text
                        _emit(
                            {
                                "type": "message_completed",
                                "content": visible_text,
                                "provider_item_id": item_id,
                                "provider_thread_id": getattr(payload, "thread_id", None),
                                "provider_turn_id": getattr(payload, "turn_id", None),
                                "timestamp": now_ms,
                            }
                        )
                        continue

                    if item_type == "reasoning":
                        summary = getattr(item, "summary", None)
                        text = "\n".join(summary) if isinstance(summary, list) else None
                        if text:
                            _emit({"type": "thinking", "content": text, "timestamp": now_ms})
                        continue

                    mapped_tool = _map_tool_event_with_output(
                        item,
                        completed=True,
                        output_deltas_by_item_id=output_deltas_by_item_id,
                    )
                    if mapped_tool:
                        mapped_tool["timestamp"] = now_ms
                        _emit(mapped_tool)
                    continue

                if method in (
                    "item/reasoningSummaryText/delta",
                    "item/reasoningText/delta",
                    "item/reasoning/summaryTextDelta",
                    "item/reasoning/textDelta",
                    "item/plan/delta",
                ):
                    text_delta = getattr(payload, "delta", "")
                    if isinstance(text_delta, str) and text_delta:
                        _emit({"type": "thinking", "content": text_delta, "timestamp": now_ms})
                    continue

                if method == "thread/tokenUsage/updated":
                    usage = _map_usage(getattr(payload, "token_usage", None))
                    last_usage = usage
                    _emit(
                        {
                            "type": "usage",
                            "usage": usage,
                            "provider_thread_id": getattr(payload, "thread_id", None),
                            "provider_turn_id": getattr(payload, "turn_id", None),
                            "timestamp": now_ms,
                        }
                    )
                    continue

                if method == "account/rateLimits/updated":
                    mapped_limits = _map_rate_limits(getattr(payload, "rate_limits", None))
                    if mapped_limits is not None:
                        _emit(
                            {
                                "type": "provider_meta",
                                "meta": {
                                    "provider": "codex",
                                    "provider_limits": mapped_limits,
                                },
                                "timestamp": now_ms,
                            }
                        )
                    continue

                if method == "error":
                    message = getattr(payload, "message", None) or str(payload)
                    last_provider_error = _classify_provider_error(message)
                    _emit(
                        {
                            "type": "provider_meta",
                            "meta": last_provider_error,
                            "timestamp": now_ms,
                        }
                    )
                    _emit({"type": "error", "content": message, "timestamp": now_ms})
                    continue

                if args.raw_events:
                    _emit(
                        {
                            "type": "codex_event",
                            "method": method,
                            "payload": _json_default(payload),
                            "timestamp": now_ms,
                        }
                    )

                if method == "turn/completed":
                    turn_obj = getattr(payload, "turn", None)
                    status_obj = getattr(turn_obj, "status", None)
                    status = getattr(status_obj, "value", str(status_obj))
                    turn_id = getattr(turn_obj, "id", None)
                    if turn_id:
                        active_turn_id = turn_id
                    final_provider_user_turn_count = _thread_user_turn_count(thread)
                    if structured_final_output is None:
                        structured_final_output = _structured_final_output_from_text(structured_text_buffer)
                    visible_final_content = (
                        structured_final_output.get("final_response")
                        if structured_final_output
                        else None
                    ) or cumulative_text
                    commit_subject = (
                        structured_final_output.get("commit_subject")
                        if structured_final_output
                        else None
                    )
                    ai_label = (
                        structured_final_output.get("ai_label")
                        if structured_final_output
                        else None
                    )
                    structured_meta = {}
                    if commit_subject:
                        structured_meta["commit_subject"] = commit_subject
                    if ai_label:
                        structured_meta["ai_label"] = ai_label
                    if structured_meta:
                        _emit(
                            {
                                "type": "provider_meta",
                                "meta": structured_meta,
                                "timestamp": now_ms,
                            }
                        )
                    if status == "completed":
                        _emit_trace("turn_completed", {"status": status, "provider_turn_id": active_turn_id})
                    else:
                        _emit_trace("turn_completed", {"status": status, "provider_turn_id": active_turn_id})
                    _emit(
                        {
                            "type": "provider_meta",
                            "meta": {
                                "provider_notification_methods": sorted(raw_methods),
                                "provider_turn_id": active_turn_id,
                                "provider_stream": {
                                    "first_delta_ts": first_delta_ts_ms,
                                    "delta_count": delta_count,
                                },
                                "provider_error_code": last_provider_error.get("provider_error_code")
                                if last_provider_error
                                else None,
                                "provider_error_message": last_provider_error.get("provider_error_message")
                                if last_provider_error
                                else None,
                                "provider_user_turn_count": final_provider_user_turn_count,
                                "provider_forked_thread_id": forked_provider_thread_id,
                                "provider_source_thread_id": source_provider_thread_id,
                                "provider_thread_strategy": thread_strategy,
                                "provider_lineage_id": provider_lineage_id,
                            },
                        }
                    )
                    _emit(
                        {
                            "type": "provider_stop",
                            "provider_stop_reason": "end_turn" if status == "completed" else "error",
                            "provider_status": status,
                            "final_content": visible_final_content
                            if status == "completed"
                            else (
                                last_provider_error.get("provider_error_message")
                                if last_provider_error
                                else cumulative_text
                            ),
                            "provider_thread_id": active_thread_id,
                            "provider_turn_id": active_turn_id,
                            "usage": last_usage,
                            "timestamp": now_ms,
                        }
                    )
                    return 0 if status == "completed" else 1

    except Exception as error:  # noqa: BLE001
        _emit(
            {
                "type": "error",
                "content": f"Codex app-server adapter failed: {error}",
                "timestamp": int(time.time() * 1000),
            }
        )
        _emit(
            {
                "type": "provider_stop",
                "provider_stop_reason": "error",
                "provider_status": "failed",
                "final_content": cumulative_text,
                "provider_thread_id": active_thread_id,
                "provider_turn_id": active_turn_id,
                "timestamp": int(time.time() * 1000),
            }
        )
        return 1

    _emit(
        {
            "type": "provider_stop",
            "provider_stop_reason": "end_turn",
            "provider_status": "completed",
            "final_content": (
                (structured_final_output or _structured_final_output_from_text(structured_text_buffer) or {}).get("final_response")
                or cumulative_text
            ),
            "provider_thread_id": active_thread_id,
            "provider_turn_id": active_turn_id,
            "timestamp": int(time.time() * 1000),
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
