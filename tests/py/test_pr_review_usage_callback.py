import asyncio
import importlib.util
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
from types import ModuleType, SimpleNamespace

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "scripts/ci/review-usage-python"
SECRET = "private-prompt-and-api-key"


def _fake_litellm(monkeypatch):
    package = ModuleType("litellm")
    package.callbacks = [object()]
    integration = ModuleType("litellm.integrations")
    logger = ModuleType("litellm.integrations.custom_logger")
    logger.CustomLogger = type("CustomLogger", (), {})
    monkeypatch.setitem(sys.modules, "litellm", package)
    monkeypatch.setitem(sys.modules, "litellm.integrations", integration)
    monkeypatch.setitem(sys.modules, "litellm.integrations.custom_logger", logger)
    return package


def _load_callback(monkeypatch):
    package = _fake_litellm(monkeypatch)
    source = SOURCE / "private_usage_callback.py"
    assert source.is_file(), "The private usage callback must be implemented"
    spec = importlib.util.spec_from_file_location("private_usage_callback", source)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "private_usage_callback", module)
    spec.loader.exec_module(module)
    return module, package


def _records(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _status(path):
    return json.loads(Path(str(path) + ".status.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("as_object", [False, True])
def test_success_retains_only_normalized_usage_and_response_identity(monkeypatch, tmp_path, capsys, as_object):
    module, _ = _load_callback(monkeypatch)
    path = tmp_path / "usage.jsonl"
    callback = module.register(path)
    usage = {
        "prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140,
        "prompt_tokens_details": {"cached_tokens": 60},
        "completion_tokens_details": {"reasoning_tokens": 30},
        "cache_creation_input_tokens": 10, "secret": SECRET,
    }
    response = {
        "id": "chatcmpl-observed", "model": "gpt-5.4-2026-03-05",
        "service_tier": "priority", "usage": usage,
        "choices": [{"message": {"content": SECRET}}],
    }
    if as_object:
        response = SimpleNamespace(**{**response, "usage": SimpleNamespace(**usage)})
    kwargs = {"model": "gpt-5.4", "litellm_call_id": "call-1", "response_cost": 0.012,
              "messages": [{"content": SECRET}], "api_key": SECRET}
    callback.log_success_event(kwargs, response, None, None)
    assert _records(path) == [{
        "schemaVersion": 1, "reviewer": "pr-agent", "responseId": "chatcmpl-observed",
        "callId": "call-1", "status": "success", "model": "gpt-5.4-2026-03-05",
        "modelAttribution": "response", "serviceTier": "priority",
        "usage": {"inputTokens": 100, "cachedInputTokens": 60, "cacheWriteInputTokens": 10,
                  "outputTokens": 40, "reasoningOutputTokens": 30, "totalTokens": 140},
        "providerEstimatedCostUsd": 0.012,
    }]
    assert SECRET not in path.read_text(encoding="utf-8")
    assert capsys.readouterr() == ("", "")


def test_sync_async_notifications_deduplicate_but_distinct_responses_remain(monkeypatch, tmp_path):
    module, _ = _load_callback(monkeypatch)
    path = tmp_path / "usage.jsonl"
    callback = module.register(path)
    kwargs = {"model": "openai/model-a", "litellm_call_id": "call-1"}
    response = {"id": "response-1", "usage": {"prompt_tokens": 4}}
    callback.log_success_event(kwargs, response, None, None)
    asyncio.run(callback.async_log_success_event(kwargs, response, None, None))
    callback.log_success_event({**kwargs, "litellm_call_id": "duplicate-notifier"}, response, None, None)
    callback.log_success_event({**kwargs, "model": "openai/model-b"}, {**response, "id": "response-2"}, None, None)
    records = _records(path)
    assert [(item["responseId"], item["model"]) for item in records] == [
        ("response-1", "openai/model-a"), ("response-2", "openai/model-b")]
    assert all(item["modelAttribution"] == "requested" for item in records)


def test_failed_attempt_and_successful_fallback_keep_unknown_usage(monkeypatch, tmp_path, capsys):
    module, _ = _load_callback(monkeypatch)
    path = tmp_path / "usage.jsonl"
    callback = module.register(path)
    kwargs = {"model": "model-a", "litellm_call_id": "failed-1", "response_cost": 0,
              "exception": RuntimeError(SECRET)}
    callback.log_failure_event(kwargs, None, None, None)
    asyncio.run(callback.async_log_failure_event(kwargs, None, None, None))
    callback.log_success_event({"model": "model-b", "litellm_call_id": "fallback-1"}, {"id": "response-2"}, None, None)
    records = _records(path)
    assert [(item["status"], item["model"], item["usage"], item["providerEstimatedCostUsd"]) for item in records] == [
        ("failure", "model-a", None, None), ("success", "model-b", None, None)]
    assert SECRET not in path.read_text(encoding="utf-8")
    assert capsys.readouterr() == ("", "")


@pytest.mark.parametrize("invalid", [-1, True, 1.5, "12", float("inf"), float("nan")])
def test_invalid_counters_and_cost_are_unknown_not_zero(monkeypatch, tmp_path, invalid):
    module, _ = _load_callback(monkeypatch)
    path = tmp_path / "usage.jsonl"
    callback = module.register(path)
    cost = -1.5 if invalid == 1.5 else invalid
    callback.log_success_event({"response_cost": cost}, {"usage": {"prompt_tokens": invalid}}, None, None)
    record = _records(path)[0]
    assert record["usage"] is None
    assert record["providerEstimatedCostUsd"] is None


def test_partial_and_zero_usage_preserve_known_categories_without_deriving_missing(monkeypatch, tmp_path):
    module, _ = _load_callback(monkeypatch)
    path = tmp_path / "usage.jsonl"
    callback = module.register(path)
    callback.log_success_event({}, {"usage": {"input_tokens": 20, "output_tokens": 0,
        "cache_read_input_tokens": 8}}, None, None)
    assert _records(path)[0]["usage"] == {
        "inputTokens": 20, "cachedInputTokens": 8, "cacheWriteInputTokens": None,
        "outputTokens": 0, "reasoningOutputTokens": None, "totalTokens": None}


def test_capture_failure_records_scalar_status_without_breaking_review(monkeypatch, tmp_path, capsys):
    module, _ = _load_callback(monkeypatch)
    path = tmp_path / "usage.jsonl"
    callback = module.register(path)
    path.mkdir()
    callback.log_success_event({}, {"usage": {"prompt_tokens": 1}}, None, None)
    assert _status(path) == {"schemaVersion": 1, "state": "capture-failed"}
    assert capsys.readouterr() == ("", "")


def test_registration_preserves_other_callbacks_and_is_idempotent(monkeypatch, tmp_path):
    module, package = _load_callback(monkeypatch)
    original = package.callbacks[0]
    path = tmp_path / "usage.jsonl"
    first = module.register(path)
    second = module.register(path)
    assert first is second
    assert package.callbacks == [original, first]
    assert _status(path) == {"schemaVersion": 1, "state": "registered"}
    assert not path.exists()


@pytest.mark.parametrize("enabled", [False, True])
def test_python_startup_registers_only_when_scoped_env_is_present(tmp_path, enabled):
    assert (SOURCE / "sitecustomize.py").is_file(), "The scoped Python startup registration must be implemented"
    package = tmp_path / "fake" / "litellm"
    (package / "integrations").mkdir(parents=True)
    (package / "__init__.py").write_text("callbacks = []\n", encoding="utf-8")
    (package / "integrations" / "__init__.py").write_text("", encoding="utf-8")
    (package / "integrations" / "custom_logger.py").write_text("class CustomLogger: pass\n", encoding="utf-8")
    path = tmp_path / "usage.jsonl"
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(SOURCE), str(package.parent)]),
           "PYTHONDONTWRITEBYTECODE": "1"}
    env.pop("ALBUM_HAVEN_REVIEW_USAGE_FILE", None)
    if enabled:
        env["ALBUM_HAVEN_REVIEW_USAGE_FILE"] = str(path)
    code = "import sys; assert ('litellm' in sys.modules) is " + str(enabled)
    if enabled:
        code += "; import litellm; litellm.callbacks[0].log_success_event({}, {'usage': {'prompt_tokens': 7}}, None, None)"
    result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=15)
    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")
    if enabled:
        assert _records(path)[0]["usage"]["inputTokens"] == 7
        assert _status(path)["state"] == "registered"
    else:
        assert not path.exists()
        assert not Path(str(path) + ".status.json").exists()


def test_startup_registration_failure_is_private_and_does_not_abort_python(monkeypatch, tmp_path, capsys):
    source = SOURCE / "sitecustomize.py"
    assert source.is_file(), "The scoped Python startup registration must be implemented"
    path = tmp_path / "usage.jsonl"
    monkeypatch.setenv("ALBUM_HAVEN_REVIEW_USAGE_FILE", str(path))
    monkeypatch.setitem(sys.modules, "private_usage_callback", None)
    runpy.run_path(str(source))
    assert _status(path) == {"schemaVersion": 1, "state": "registration-failed"}
    assert capsys.readouterr() == ("", "")
