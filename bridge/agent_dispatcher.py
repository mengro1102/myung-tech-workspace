#!/usr/bin/env python3
"""
Agent Dispatcher: picks pending tasks from the task queue,
calls the department's assigned_brain via Ollama (local) or OpenRouter,
and writes results back to the task queue + shared memory.

Backend 우선순위:
  1. Ollama (로컬) — OLLAMA_BASE_URL 또는 기본 http://localhost:11434
  2. OpenRouter   — OPENROUTER_API_KEY 환경변수가 있을 때만 사용
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MYUNG_TECH_WORKSPACE = (BASE_DIR / "..").resolve()

sys.path.insert(0, str(MYUNG_TECH_WORKSPACE / "shared_memory"))
import task_queue
import message_broker

# ── 백엔드 설정 ─────────────────────────────────────────
OLLAMA_BASE_URL     = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_CHAT_URL     = f"{OLLAMA_BASE_URL}/v1/chat/completions"
OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_API_KEY  = os.environ.get("OPENROUTER_API_KEY", "")

# Ollama 사용 여부: OPENROUTER_API_KEY 없으면 Ollama 우선
USE_OLLAMA = not bool(OPENROUTER_API_KEY)

# 부서별 Ollama 모델 매핑 (manifest의 assigned_brain이 OpenRouter 형식일 때 대체)
OLLAMA_MODEL_MAP = {
    "orchestration_dept": "qwen2.5-coder:7b",
    "research_dept":      "qwen2.5-coder:7b",
    "finance_dept":       "qwen2.5-coder:7b",
    "dev_dept":           "qwen2.5-coder:7b",
    "content_dept":       "qwen2.5-coder:7b",
}
OLLAMA_DEFAULT_MODEL = "qwen2.5-coder:7b"

POLL_INTERVAL   = 3.0   # seconds between queue polls
REQUEST_TIMEOUT = 300   # seconds


def _load_dept_manifest(dept_id: str) -> dict:
    path = MYUNG_TECH_WORKSPACE / "departments" / dept_id / "department_manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _call_llm(model: str, messages: list[dict]) -> str:
    """Ollama 또는 OpenRouter로 LLM 호출."""
    if USE_OLLAMA:
        return _call_ollama(model, messages)
    else:
        return _call_openrouter(model, messages, OPENROUTER_API_KEY)


def _call_ollama(model: str, messages: list[dict]) -> str:
    body = json.dumps({
        "model": model,
        "messages": messages,
        "stream": False,
    }).encode("utf-8")

    req = urllib.request.Request(
        OLLAMA_CHAT_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as exc:
        body_err = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama HTTP {exc.code}: {body_err}") from exc
    except Exception as exc:
        raise RuntimeError(f"Ollama 연결 실패 ({OLLAMA_BASE_URL}): {exc}") from exc


def _call_openrouter(model: str, messages: list[dict], api_key: str) -> str:
    body = json.dumps({
        "model": model,
        "messages": messages,
    }).encode("utf-8")

    req = urllib.request.Request(
        OPENROUTER_CHAT_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://myung-tech.internal",
            "X-Title": "Myung-Tech Orchestration",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as exc:
        body_err = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter HTTP {exc.code}: {body_err}") from exc


def _dispatch_task(task: dict, api_key: str = "") -> None:
    task_id = task["task_id"]
    dept_id = task["target_dept"]

    manifest = _load_dept_manifest(dept_id)
    dept_name = manifest.get("department_name", dept_id)

    # 모델 선택: Ollama면 로컬 모델맵 사용, OpenRouter면 manifest 값 사용
    if USE_OLLAMA:
        model = OLLAMA_MODEL_MAP.get(dept_id, OLLAMA_DEFAULT_MODEL)
    else:
        model = manifest.get("assigned_brain", "qwen/qwen-2.5-7b-instruct:free")

    task_queue.update_status(task_id, "in_progress")
    backend = "Ollama" if USE_OLLAMA else "OpenRouter"
    print(f"[dispatcher] {task_id} → {dept_name} ({model}) via {backend}")

    system_prompt = (
        f"당신은 명테크의 {dept_name} 소속 AI 에이전트입니다. "
        "주어진 지시를 한국어로 간결하게 수행하세요."
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": task["instruction"]},
    ]

    try:
        result = _call_llm(model, messages)
        task_queue.update_status(task_id, "done", result=result)

        # Publish result as shared memory event
        message_broker.publish_event(
            sender=dept_id,
            target=task["sender"],
            payload=f"[{task_id}] {result[:300]}{'...' if len(result) > 300 else ''}",
        )
        print(f"[dispatcher] {task_id} done.")
    except Exception as exc:
        task_queue.update_status(task_id, "failed", result=str(exc))
        print(f"[dispatcher] {task_id} FAILED: {exc}", file=sys.stderr)


def run_once(api_key: str) -> int:
    """Process all pending tasks once. Returns number of tasks dispatched."""
    pending = task_queue.list_tasks("pending")
    # Sort by priority descending
    pending.sort(key=lambda t: t.get("priority", 5), reverse=True)
    for task in pending:
        _dispatch_task(task, api_key)
    return len(pending)


def run_daemon(api_key: str) -> None:
    print("[dispatcher] Daemon started.")
    while True:
        n = run_once(api_key)
        if n == 0:
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key:
        print("[FATAL] OPENROUTER_API_KEY not set.", file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1] if len(sys.argv) > 1 else "once"
    if mode == "daemon":
        run_daemon(key)
    else:
        dispatched = run_once(key)
        print(f"[dispatcher] {dispatched} task(s) processed.")
