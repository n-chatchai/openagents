"""Dedicated client for message classification and completion handoffs.

Two kinds of endpoint, by MESSAGE_ROUTER_API:
  chat       an OpenAI-compatible chat model answering the router prompt (default)
  decisions  a decisions model (OpenRouter's /api/alpha/decisions, e.g. TypeSafe
             Jev) asked one choice question; it answers human messages only, since
             completion handoffs need a JSON reply a choice cannot give.
"""
from functools import lru_cache

DECISIONS_TIMEOUT_SECONDS = 15


@lru_cache(maxsize=1)
def get_client(base_url, api_key):
    from openai import OpenAI

    if not base_url or not api_key:
        raise ValueError("Message router requires its own endpoint and API key")
    return OpenAI(base_url=base_url, api_key=api_key, timeout=15, max_retries=0)


def uses_decisions() -> bool:
    from app.config import config
    return config.MESSAGE_ROUTER_API == "decisions"


def decide(base_url, api_key, model, state, criteria, instructions, timeout=DECISIONS_TIMEOUT_SECONDS) -> str:
    """Ask a decisions model to pick one key of ``criteria``; returns that key.

    Raises on any failure or on an answer that is not one of the keys, so the
    caller falls back to the general router.
    """
    import httpx

    if not base_url or not api_key or not model:
        raise ValueError("Message router requires its own endpoint, model and API key")
    response = httpx.post(
        f"{base_url.rstrip('/')}/decisions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": model, "state": state,
              "questions": {"recipient": {"type": "choice", "instructions": instructions, "criteria": criteria}}},
        timeout=timeout,
    )
    response.raise_for_status()
    answer = (response.json().get("answers") or {}).get("recipient") or {}
    # A refusal or a missing answer is "not answered", never a verdict.
    if answer.get("type") != "choice" or answer.get("choice") not in criteria:
        raise ValueError("Decisions model returned no usable choice")
    return answer["choice"]
