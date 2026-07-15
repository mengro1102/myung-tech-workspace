#!/usr/bin/env python3
"""
명테크 24시간 에이전틱 사이클 러너
사이클: 분석 → 작전 검토 → 실행

task_queue + agent_dispatcher 기반 (LangGraph 미필요)
"""

from __future__ import annotations

import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "shared_memory"))
sys.path.insert(0, str(ROOT / "bridge"))

import task_queue
import message_broker

# ── 사이클 프롬프트 ───────────────────────────────────────────

ANALYSIS_PROMPT = """\
[자동 분석] 명테크 AI 에이전틱 시스템 일일 분석을 수행합니다.

다음 항목을 한국어로 간결하게 분석하세요:
1. 현재 진행 중인 주요 과제와 현황
2. 오늘 집중해야 할 핵심 목표 3가지
3. 각 부서(연구/금융/콘텐츠)의 오늘 역할

분석 결과를 구조화된 형태로 제시하세요."""

STRATEGY_PROMPT_TPL = """\
[작전 검토] 아래 분석을 바탕으로 실행 계획을 검토하세요.

=== 분석 결과 ===
{analysis}
=================

검토 항목:
1. 위 목표 달성을 위한 실행 순서
2. 각 부서별 구체적 지시사항
3. 예상 리스크와 대응 방안

검토 결과를 명확히 제시하세요."""

EXEC_PROMPT_TPL = """\
[자동 실행 사이클 - {dept_label}] 오늘의 부서 작업을 수행하세요.

=== 오늘의 전략 ===
{strategy}
==================

위 전략에서 {dept_label} 관련 항목을 파악하고,
담당 부서로서 구체적인 산출물을 작성하세요."""

DEPT_LABELS = {
    "research_dept": "학술연구부",
    "finance_dept":  "금융투자부",
    "content_dept":  "콘텐츠생산부",
}


# ── CycleRunner ───────────────────────────────────────────────

class CycleRunner:
    def __init__(self):
        self.running    = False
        self._thread: threading.Thread | None = None
        self.cycle_count = 0
        self.last_cycle: str | None = None
        self.status     = "stopped"   # stopped | analyzing | strategizing | executing | idle | error
        self.logs: list[str] = []

    # ── 로그 ──────────────────────────────────────────────────
    def _log(self, msg: str):
        ts    = datetime.now().strftime("%H:%M:%S")
        entry = f"[{ts}] {msg}"
        self.logs.append(entry)
        if len(self.logs) > 200:
            self.logs = self.logs[-200:]
        print(entry, flush=True)

    # ── 에이전트간 대화 emit (Phase 3.1 — 피드 시각화) ────────
    def _emit(self, sender: str, target: str, msg: str):
        """message_broker로 sender→target 메시지 발행 (SSE 피드에 실시간 표시)."""
        try:
            message_broker.publish_event(sender=sender, target=target, payload=msg)
        except Exception:
            pass

    # ── 태스크 큐 헬퍼 ───────────────────────────────────────
    def _enqueue(self, dept: str, instruction: str, priority: int = 9) -> str:
        task = task_queue.enqueue(
            sender="cycle_runner",
            target_dept=dept,
            instruction=instruction,
            priority=priority,
        )
        return task["task_id"]

    def _wait(self, task_id: str, timeout: int = 360) -> str:
        """태스크 완료까지 대기 → result 반환 (타임아웃 시 빈 문자열)."""
        elapsed = 0
        while elapsed < timeout:
            t = task_queue.get_task(task_id)
            if t and t["status"] == "done":
                return t.get("result") or ""
            if t and t["status"] == "failed":
                self._log(f"  ⚠️ 태스크 실패: {task_id}")
                return t.get("result") or ""
            time.sleep(4)
            elapsed += 4
        self._log(f"  ⏱ 타임아웃: {task_id}")
        return ""

    # ── 단계별 실행 ───────────────────────────────────────────
    def _phase_analysis(self) -> str:
        self._log("━━ [1/3] 분석 단계 시작")
        self.status = "analyzing"
        self._emit("orchestration_dept", "research_dept",
                   "오늘의 시장 동향·기회·리스크를 분석해 주세요.")
        tid    = self._enqueue("orchestration_dept", ANALYSIS_PROMPT, priority=10)
        result = self._wait(tid)
        self._log(f"  ✅ 분석 완료 ({len(result)}자)")
        snippet = (result[:90] + "…") if result else "분석 결과 정리 완료."
        self._emit("research_dept", "orchestration_dept", f"분석 완료 — {snippet}")
        return result

    def _phase_strategy(self, analysis: str) -> str:
        self._log("━━ [2/3] 작전 검토 단계")
        self.status = "strategizing"
        self._emit("orchestration_dept", "finance_dept",
                   "분석을 바탕으로 우선순위·자원 배분 작전을 검토합니다.")
        prompt = STRATEGY_PROMPT_TPL.format(analysis=analysis[:800])
        tid    = self._enqueue("orchestration_dept", prompt, priority=10)
        result = self._wait(tid)
        self._log(f"  ✅ 작전 검토 완료 ({len(result)}자)")
        snippet = (result[:90] + "…") if result else "작전안 도출 완료."
        self._emit("finance_dept", "orchestration_dept", f"작전 검토 완료 — {snippet}")
        return result

    def _phase_execution(self, strategy: str):
        self._log("━━ [3/3] 실행 단계")
        self.status = "executing"
        for dept, label in DEPT_LABELS.items():
            prompt = EXEC_PROMPT_TPL.format(
                dept_label=label,
                strategy=strategy[:600],
            )
            tid = self._enqueue(dept, prompt, priority=8)
            self._log(f"  → {label} 태스크 배분 ({tid})")
            self._emit("orchestration_dept", dept, f"{label}: 작전에 따라 실행 태스크를 진행해 주세요.")
        # 실행 태스크는 디스패처가 처리하므로 대기하지 않음
        self._emit("orchestration_dept", "studio_ui", "전 부서에 실행 태스크 배분 완료. 진행 상황을 추적합니다.")
        self._log("  ✅ 모든 부서에 실행 태스크 배분 완료")

    # ── 사이클 1회 ────────────────────────────────────────────
    def _one_cycle(self):
        self.cycle_count += 1
        self.last_cycle  = datetime.now(timezone.utc).isoformat()
        self._log(f"🔄 사이클 #{self.cycle_count} 시작 ({self.last_cycle[:19]})")

        try:
            analysis = self._phase_analysis()
            strategy = self._phase_strategy(analysis)
            self._phase_execution(strategy)

            message_broker.publish_event(
                sender="cycle_runner",
                target="studio_ui",
                payload=json_summary(self.cycle_count, analysis, strategy),
            )
            self._log(f"✅ 사이클 #{self.cycle_count} 완료")
        except Exception as exc:
            self._log(f"❌ 사이클 오류: {exc}")
            self.status = "error"
            return

        self.status = "idle"

    # ── 루프 스레드 ───────────────────────────────────────────
    def _loop(self, interval: int):
        while self.running:
            self._one_cycle()
            if not self.running:
                break
            self._log(f"⏱ 다음 사이클까지 {interval}초 대기…")
            # 인터럽트 가능하게 짧게 분할
            for _ in range(interval):
                if not self.running:
                    break
                time.sleep(1)

    # ── 공개 API ──────────────────────────────────────────────
    def start(self, interval: int = 3600) -> bool:
        if self.running:
            return False
        self.running = True
        self._thread = threading.Thread(
            target=self._loop, args=(interval,), daemon=True
        )
        self._thread.start()
        self._log(f"🚀 24시간 에이전틱 사이클 시작 (간격: {interval}초)")
        return True

    def stop(self):
        self.running = False
        self.status  = "stopped"
        self._log("⏹ 사이클 중지됨")

    def run_once(self):
        """UI에서 즉시 사이클 1회 실행 (비동기)."""
        if self.status in ("analyzing", "strategizing", "executing"):
            return False
        t = threading.Thread(target=self._one_cycle, daemon=True)
        t.start()
        return True

    def get_status(self) -> dict:
        return {
            "running":     self.running,
            "status":      self.status,
            "cycle_count": self.cycle_count,
            "last_cycle":  self.last_cycle,
            "logs":        self.logs[-30:],
        }


# ── 싱글턴 ───────────────────────────────────────────────────
runner = CycleRunner()


def json_summary(cycle: int, analysis: str, strategy: str) -> str:
    import json
    return json.dumps({
        "type":     "cycle_complete",
        "cycle":    cycle,
        "analysis": analysis[:200],
        "strategy": strategy[:200],
    }, ensure_ascii=False)
