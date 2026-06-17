"""LangGraph 노드 함수 — 사원, 팀장, 라우터 (에이전트 SOUL + 모델 라우팅 지원)"""

from __future__ import annotations

import json
import logging
from typing import Literal

from orchestrator.graphs.state import AgentState
from orchestrator.lifecycle.agent_loader import get_agent, get_agent_system_prompt
from orchestrator.llm_gateway import get_llm_gateway, LLMGatewayError
from orchestrator.redis_layer.pubsub import publish_agent_state_change

logger = logging.getLogger(__name__)


def _resolve_model(agent_id: str) -> str | None:
    """에이전트 프로필의 preferred_model → vLLM 라우팅에 사용."""
    profile = get_agent(agent_id)
    if profile:
        return profile.get("preferred_model") or profile.get("assigned_brain")
    return None


async def worker_node(state: AgentState) -> dict:
    """사원 에이전트 노드 — base_prompt(SOUL) + preferred_model 라우팅."""
    agent_id = state["current_agent"]
    dept_id = state["department_id"]

    await publish_agent_state_change(agent_id, "thinking", "작업 수행 중")

    gateway = await get_llm_gateway()

    # 에이전트 SOUL 우선 사용, 없으면 기본 프롬프트
    system_prompt = get_agent_system_prompt(agent_id)
    if not system_prompt or system_prompt == f"너는 에이전트 {agent_id}다.":
        system_prompt = (
            f"너는 {dept_id} 소속 사원 에이전트({agent_id})다. "
            "주어진 태스크를 성실하게 수행하고 결과물을 명확하게 제시해라. "
            "결과물은 구체적이고 실행 가능해야 한다."
        )

    messages = _format_messages_for_llm(state["messages"])
    preferred_model = _resolve_model(agent_id)

    try:
        response = await gateway.chat_completion(
            agent_id=agent_id,
            system_prompt=system_prompt,
            messages=messages,
            model=preferred_model,
            temperature=0.7,
            max_tokens=2048,
        )

        await publish_agent_state_change(agent_id, "responding", "응답 생성 완료")

        return {
            "messages": [{"role": "assistant", "content": response.content}],
            "task_status": "review",
            "artifacts": {
                **state.get("artifacts", {}),
                "worker_output": response.content,
                "worker_latency_ms": response.latency_ms,
                "worker_tokens": response.usage,
                "worker_model": response.model,
            },
        }

    except LLMGatewayError as e:
        logger.error(f"Worker node LLM 호출 실패: {e}")
        await publish_agent_state_change(agent_id, "error", str(e))
        return {
            "task_status": "error",
            "error_detail": str(e),
        }


async def manager_node(state: AgentState) -> dict:
    """팀장 에이전트 노드 — base_prompt(SOUL) + preferred_model 라우팅."""
    dept_id = state["department_id"]
    manager_id = f"{dept_id[:3]}_pm_01"

    await publish_agent_state_change(manager_id, "thinking", "검수 중")

    gateway = await get_llm_gateway()

    system_prompt = get_agent_system_prompt(manager_id)
    if not system_prompt or system_prompt == f"너는 에이전트 {manager_id}다.":
        system_prompt = (
            f"너는 {dept_id} 소속 팀장(PM) 에이전트({manager_id})다. "
            "사원이 제출한 결과물을 검수하는 역할이다. "
            "결과물의 품질과 정확성을 평가한 뒤, 반드시 다음 JSON 형식으로만 응답해라:\n"
            '{"decision": "APPROVED" 또는 "REJECTED", "feedback": "구체적 피드백"}\n'
            "품질이 충분하면 APPROVED, 보완이 필요하면 REJECTED + 개선 지침을 제공해라."
        )

    messages = _format_messages_for_llm(state["messages"])
    preferred_model = _resolve_model(manager_id)

    try:
        response = await gateway.chat_completion(
            agent_id=manager_id,
            system_prompt=system_prompt,
            messages=messages,
            model=preferred_model,
            temperature=0.3,
            max_tokens=512,
        )

        await publish_agent_state_change(manager_id, "responding", "검수 완료")

        return {
            "messages": [{"role": "assistant", "content": response.content}],
            "artifacts": {
                **state.get("artifacts", {}),
                "manager_review": response.content,
                "manager_latency_ms": response.latency_ms,
            },
        }

    except LLMGatewayError as e:
        logger.error(f"Manager node LLM 호출 실패: {e}")
        await publish_agent_state_change(manager_id, "error", str(e))
        return {
            "task_status": "error",
            "error_detail": str(e),
        }


def route_decision(state: AgentState) -> Literal["approved", "rejected", "error"]:
    """조건부 분기 라우터."""
    if state.get("task_status") == "error":
        return "error"
    if state["iteration_count"] >= state["max_iterations"]:
        return "error"

    manager_review = state.get("artifacts", {}).get("manager_review", "")
    try:
        parsed = json.loads(manager_review)
        decision = parsed.get("decision", "").upper()
    except (json.JSONDecodeError, AttributeError):
        upper_review = manager_review.upper()
        if "APPROVED" in upper_review:
            decision = "APPROVED"
        elif "REJECTED" in upper_review:
            decision = "REJECTED"
        else:
            decision = "APPROVED"

    if decision == "APPROVED":
        return "approved"
    elif decision == "REJECTED":
        return "rejected"
    return "approved"


async def increment_iteration(state: AgentState) -> dict:
    """반복 카운터 증가 — 팀장 피드백을 user 메시지로 주입."""
    new_count = state["iteration_count"] + 1
    feedback = state.get("artifacts", {}).get("manager_review", "")
    feedback_msg = (
        f"[팀장 피드백 - 반복 {new_count}회차] {feedback}\n"
        "위 피드백을 반영하여 결과물을 개선해주세요."
    )
    return {
        "messages": [{"role": "user", "content": feedback_msg}],
        "iteration_count": new_count,
        "task_status": "in_progress",
    }


def _format_messages_for_llm(messages: list) -> list[dict]:
    """LangGraph messages를 vLLM API 형식으로 변환."""
    formatted = []
    for msg in messages:
        if hasattr(msg, "content") and hasattr(msg, "type"):
            role = "user" if msg.type == "human" else "assistant"
            formatted.append({"role": role, "content": msg.content})
        elif isinstance(msg, dict):
            formatted.append(msg)
    return formatted
