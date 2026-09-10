"""Private, content-free usage capture through LiteLLM's supported callbacks."""

import json
import math
import os
from pathlib import Path
import re
import threading

import litellm
from litellm.integrations.custom_logger import CustomLogger


def _field(value, name):
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def _counter(value):
    return value if type(value) is int and 0 <= value <= 2**53 - 1 else None


def _first_counter(*values):
    return next((value for item in values if (value := _counter(item)) is not None), None)


def _identifier(value, *, model=False):
    pattern = r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}" if model else r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}"
    return value if isinstance(value, str) and re.fullmatch(pattern, value) else None


def _usage(value):
    if value is None:
        return None
    input_details = _field(value, "prompt_tokens_details") or _field(value, "input_tokens_details")
    output_details = _field(value, "completion_tokens_details") or _field(value, "output_tokens_details")
    result = {
        "inputTokens": _first_counter(_field(value, "prompt_tokens"), _field(value, "input_tokens")),
        "cachedInputTokens": _first_counter(_field(input_details, "cached_tokens"), _field(value, "cache_read_input_tokens")),
        "cacheWriteInputTokens": _counter(_field(value, "cache_creation_input_tokens")),
        "outputTokens": _first_counter(_field(value, "completion_tokens"), _field(value, "output_tokens")),
        "reasoningOutputTokens": _counter(_field(output_details, "reasoning_tokens")),
        "totalTokens": _counter(_field(value, "total_tokens")),
    }
    return result if any(item is not None for item in result.values()) else None


def _cost(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def _write_status(path, state):
    try:
        Path(str(path) + ".status.json").write_text(
            json.dumps({"schemaVersion": 1, "state": state}), encoding="utf-8"
        )
    except OSError:
        # An absent marker also means unavailable capture. Never affect the review.
        pass


class PrivateUsageCallback(CustomLogger):
    def __init__(self, path):
        super().__init__()
        self.path = Path(path)
        self._lock = threading.Lock()
        self._seen = set()

    def _capture(self, kwargs, response, status):
        try:
            response_id = _identifier(_field(response, "id"))
            call_id = _identifier(_field(kwargs, "litellm_call_id"))
            response_model = _identifier(_field(response, "model"), model=True)
            requested_model = _identifier(_field(kwargs, "model"), model=True)
            tier = _field(response, "service_tier")
            usage = _usage(_field(response, "usage"))
            record = {
                "schemaVersion": 1,
                "reviewer": "pr-agent",
                "responseId": response_id,
                "callId": call_id,
                "status": status,
                "model": response_model or requested_model,
                "modelAttribution": "response" if response_model else "requested",
                "serviceTier": tier if tier in ("auto", "default", "flex", "priority", "scale", "standard", "batch") else None,
                "usage": usage,
                # LiteLLM may seed failed calls with a synthetic zero cost.
                "providerEstimatedCostUsd": None if status == "failure" and usage is None else _cost(_field(kwargs, "response_cost")),
            }
            # One response can notify both sync and async hooks. Without an identity,
            # preserve the observation rather than merging potentially distinct calls.
            identity = ("response", response_id) if response_id else (("call", call_id, status) if call_id else None)
            line = json.dumps(record, allow_nan=False, separators=(",", ":")) + "\n"
            with self._lock:
                if identity is not None and identity in self._seen:
                    return
                descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(descriptor, "a", encoding="utf-8") as output:
                    output.write(line)
                if identity is not None:
                    self._seen.add(identity)
        except Exception:
            _write_status(self.path, "capture-failed")

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._capture(kwargs, response_obj, "success")

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._capture(kwargs, response_obj, "failure")

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._capture(kwargs, response_obj, "success")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._capture(kwargs, response_obj, "failure")


def register(path):
    path = Path(path)
    for callback in litellm.callbacks:
        if isinstance(callback, PrivateUsageCallback) and callback.path == path:
            return callback
    callback = PrivateUsageCallback(path)
    litellm.callbacks.append(callback)
    _write_status(path, "registered")
    return callback
