"""PayPal — 잔액과 거래 내역 조회(읽기 전용).

수익을 확인하는 것이 목적이므로 읽기만 넣는다. 송금·환불처럼 돈을 움직이는
호출은 **일부러 넣지 않았다.** 에이전트가 제안할 수 있는 자리에 그런 것을
두면, 결재 한 번 잘못 눌렀을 때 되돌릴 수 없다. 돈을 보내는 일은 사람이
PayPal 에서 직접 한다.

sandbox 와 live 는 주소가 다르다. `PAYPAL_MODE` 로 고른다 — 기본은 live 가
아니라 sandbox 다. 잘못 설정한 채로 진짜 계정을 긁는 것보다, 설정이 안 돼서
아무것도 안 나오는 편이 낫다.
"""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone

from . import base
from .base import Integration, Probe, env, http, register, require

HOSTS = {
    "sandbox": "https://api-m.sandbox.paypal.com",
    "live": "https://api-m.paypal.com",
}


def mode() -> str:
    m = (env("PAYPAL_MODE") or "sandbox").strip().lower()
    return m if m in HOSTS else "sandbox"


def host() -> str:
    return HOSTS[mode()]


def access_token() -> str:
    """client_credentials 로 토큰을 받는다. 수명은 보통 9시간."""
    cid, secret = require("PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET")
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    got = base.form_post(f"{host()}/v1/oauth2/token",
                         {"grant_type": "client_credentials"},
                         headers={"Authorization": f"Basic {auth}"},
                         label=f"PayPal({mode()})")
    token = got.get("access_token")
    if not token:
        raise base.IntegrationError(
            "PayPal 토큰을 받지 못했습니다. Client ID/Secret 이 맞는지, "
            f"그리고 지금 모드({mode()})의 자격증명인지 확인하세요 — "
            "sandbox 키로 live 를 부를 수 없습니다.")
    return token


def _auth() -> dict:
    return {"Authorization": f"Bearer {access_token()}"}


def balances() -> list[dict]:
    """통화별 잔액.

    이 엔드포인트는 비즈니스 계정 + 'Transaction Search' 권한이 필요하다.
    개인 계정이면 403 이 온다 — 그 사실을 그대로 알린다.
    """
    got = http(f"{host()}/v1/reporting/balances", headers=_auth(),
               label=f"PayPal({mode()})")
    out = []
    for b in got.get("balances") or []:
        tb = b.get("total_balance") or {}
        out.append({"currency": b.get("currency", ""),
                    "total": float(tb.get("value") or 0),
                    "available": float((b.get("available_balance") or {}).get("value") or 0)})
    return out


def transactions(days: int = 30, limit: int = 40) -> list[dict]:
    """최근 거래. PayPal 은 한 번에 31일까지만 조회할 수 있다."""
    days = max(1, min(31, days))
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    got = http(f"{host()}/v1/reporting/transactions", headers=_auth(), params={
        "start_date": start.strftime("%Y-%m-%dT%H:%M:%S-0000"),
        "end_date": end.strftime("%Y-%m-%dT%H:%M:%S-0000"),
        "fields": "transaction_info,payer_info",
        "page_size": max(1, min(500, limit)),
    }, label=f"PayPal({mode()})")
    rows = []
    for d in got.get("transaction_details") or []:
        ti = d.get("transaction_info") or {}
        amt = ti.get("transaction_amount") or {}
        fee = ti.get("fee_amount") or {}
        rows.append({
            "id": ti.get("transaction_id", ""),
            "at": (ti.get("transaction_initiation_date") or "")[:10],
            "status": ti.get("transaction_status", ""),
            "amount": float(amt.get("value") or 0),
            "fee": float(fee.get("value") or 0),
            "currency": amt.get("currency_code", ""),
            "subject": (ti.get("transaction_subject")
                        or ti.get("transaction_note") or "")[:60],
        })
    return rows


def summary(days: int = 30) -> dict:
    """기간 매출 요약. 입금(양수)만 매출로 센다."""
    rows = transactions(days)
    income = [r for r in rows if r["amount"] > 0]
    gross = sum(r["amount"] for r in income)
    fees = sum(abs(r["fee"]) for r in income)
    cur = income[0]["currency"] if income else ""
    return {"days": days, "count": len(income), "gross": round(gross, 2),
            "fees": round(fees, 2), "net": round(gross - fees, 2), "currency": cur}


def probe() -> Probe:
    try:
        access_token()
    except base.NotConfigured as exc:
        return Probe(False, "아직 설정하지 않았습니다", exc.missing)
    # 토큰만으로는 '읽을 권한이 있는가' 를 모른다. 실제로 한 번 읽어 본다.
    try:
        bal = balances()
    except base.IntegrationError as exc:
        msg = str(exc)
        if "403" in msg or "NOT_AUTHORIZED" in msg.upper():
            return Probe(False,
                         f"인증은 됐지만 조회 권한이 없습니다({mode()} 모드). "
                         "PayPal 개발자 앱에서 'Transaction Search' 를 켜고, "
                         "비즈니스 계정인지 확인하세요.")
        return Probe(False, msg)
    if not bal:
        return Probe(True, f"{mode()} 연결됨 — 잔액 정보 없음")
    part = ", ".join(f"{b['currency']} {b['total']:,.2f}" for b in bal[:3])
    return Probe(True, f"{mode()} 연결됨 — 잔액 {part}")


def context(_query: str = "") -> str:
    try:
        s = summary(30)
        bal = balances()
    except base.IntegrationError:
        return ""
    lines = [f"[PayPal — 실제 데이터 ({mode()} 모드)]"]
    if bal:
        lines.append("잔액: " + ", ".join(
            f"{b['currency']} {b['total']:,.2f}(가용 {b['available']:,.2f})" for b in bal))
    if s["count"]:
        lines.append(f"최근 30일 입금 {s['count']}건 — "
                     f"총 {s['currency']} {s['gross']:,.2f}, "
                     f"수수료 {s['fees']:,.2f}, 순수익 {s['net']:,.2f}")
    else:
        lines.append("최근 30일 입금 없음")
    return "\n".join(lines)


register(Integration(
    name="paypal",
    label="PayPal (수익 조회)",
    icon="💰",
    required=["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"],
    optional=["PAYPAL_MODE"],
    probe=probe,
    context=context,
    docs="paypal",
))
