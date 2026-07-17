"""
Benchmark LLM models for each pipeline stage.

Tests Qwen3-14B (OpenRouter) vs Gemini 2.5 Flash (direct API) on:
1. Query generation — multilingual (EN, DE, FR cities)
2. AI filter — article selection from candidates
3. Summary — bullet-point news summary

Usage:
    cd backend
    PYTHONUNBUFFERED=1 python3 scripts/benchmark_models.py
"""
import asyncio
import json
import logging
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("benchmark_models")

import httpx
from app.config import settings

# ---- Models to test ----
MODELS = {
    "gemini-2.5-flash": {
        "provider": "gemini",
        "model_id": "gemini-2.5-flash",
    },
    "gemini-2.5-flash-lite": {
        "provider": "gemini",
        "model_id": "gemini-2.5-flash-lite",
    },
    "gemini-2.5-flash-lite (OpenRouter Vertex ZDR)": {
        "provider": "openrouter",
        "model_id": "google/gemini-2.5-flash-lite",
    },
}


def extract_json(text: str) -> str:
    """Extract JSON from text that may have thinking/reasoning prefix."""
    # Qwen3 models may prepend <think>...</think> reasoning
    if "</think>" in text:
        text = text.split("</think>")[-1]
    # Find first { or [
    for i, c in enumerate(text):
        if c in "{[":
            # Find matching closing bracket
            return text[i:]
    return text

# ---- API helpers ----

async def call_openrouter(client, model_id, messages, max_tokens=500, temperature=0.5, json_mode=True):
    payload = {
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "provider": {
            "only": ["google-vertex"],
            "zdr": True,
            "data_collection": "deny",
            "require_parameters": True,
        },
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    t0 = time.time()
    response = await client.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "HTTP-Referer": "https://www.scoutpost.ai",
            "X-Title": "coJournalist",
            "X-OpenRouter-Cache": "false",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=45.0,
    )
    elapsed = time.time() - t0
    if not response.is_success:
        return {"error": f"HTTP {response.status_code}: {response.text[:200]}", "elapsed": elapsed}
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return {"content": content, "elapsed": elapsed, "usage": usage}


async def call_gemini(client, model_id, messages, max_tokens=500, temperature=0.5, json_mode=True):
    """Call Gemini via OpenAI-compatible endpoint."""
    payload = {
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    t0 = time.time()
    response = await client.post(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        headers={
            # This comparison-only benchmark intentionally remains capable of
            # direct-Google probes without making GEMINI_API_KEY runtime config.
            "Authorization": f"Bearer {os.getenv('GEMINI_API_KEY', '')}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=45.0,
    )
    elapsed = time.time() - t0
    if not response.is_success:
        return {"error": f"HTTP {response.status_code}: {response.text[:300]}", "elapsed": elapsed}
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return {"content": content, "elapsed": elapsed, "usage": usage}


async def call_model(client, model_config, messages, max_tokens=500, temperature=0.5, json_mode=True):
    if model_config["provider"] == "openrouter":
        return await call_openrouter(client, model_config["model_id"], messages, max_tokens, temperature, json_mode)
    elif model_config["provider"] == "gemini":
        return await call_gemini(client, model_config["model_id"], messages, max_tokens, temperature, json_mode)


# ---- Test prompts (actual pipeline prompts) ----

QUERY_GEN_TESTS = [
    {
        "label": "Bozeman, US (English)",
        "prompt": """You are a local information researcher. For the city of Bozeman in US:

1. DETERMINE the PRIMARY local language used in this location.

2. GENERATE 7 search queries in that language for LOCAL INFORMATION.

Requirements:
- Include variety: local events, city politics, community news, cultural happenings
- At least 2 queries should target non-news content (blogs, community sites, local forums)
- Include the city name 'Bozeman' in each query
- Use natural phrasing locals would actually search for

3. GENERATE 5 discovery queries to find LOCAL COMMUNITY content (not news articles).
   Target:
   - Community event calendars and local activity listings
   - Job boards and local employment opportunities
   - Neighborhood forums, community groups, civic associations
   - Local business openings, farmers markets, volunteer calls
   - Independent community blogs written BY residents

Return JSON only:
{
  "primary_language": "<2-letter ISO code>",
  "queries": ["query1", "query2", ...],
  "discovery_queries": ["community query1", ...],
  "local_domains": ["domain1", "domain2", ...]
}""",
    },
    {
        "label": "Schaffhausen, CH (German)",
        "prompt": """You are a local information researcher. For the city of Schaffhausen in CH:

1. DETERMINE the PRIMARY local language used in this location.
   Consider regional languages (e.g., Montreal uses French, Barcelona uses Spanish, Zurich uses German).

2. GENERATE 7 search queries in that language for LOCAL INFORMATION.

Requirements:
- Include variety: local events, city politics, community news, cultural happenings
- At least 2 queries should target non-news content (blogs, community sites, local forums)
- Include the city name 'Schaffhausen' in each query
- Use natural phrasing locals would actually search for

3. GENERATE 5 discovery queries to find LOCAL COMMUNITY content (not news articles).

Return JSON only:
{
  "primary_language": "<2-letter ISO code>",
  "queries": ["query1", "query2", ...],
  "discovery_queries": ["community query1", ...],
  "local_domains": ["domain1.ch", "domain2.ch", ...]
}""",
    },
    {
        "label": "Lyon, FR (French)",
        "prompt": """You are a local information researcher. For the city of Lyon in FR:

1. DETERMINE the PRIMARY local language used in this location.

2. GENERATE 7 search queries in that language for LOCAL INFORMATION.

Requirements:
- Include variety: local events, city politics, community news, cultural happenings
- At least 2 queries should target non-news content (blogs, community sites, local forums)
- Include the city name 'Lyon' in each query
- Use natural phrasing locals would actually search for

3. GENERATE 5 discovery queries to find LOCAL COMMUNITY content (not news articles).

Return JSON only:
{
  "primary_language": "<2-letter ISO code>",
  "queries": ["query1", "query2", ...],
  "discovery_queries": ["community query1", ...],
  "local_domains": ["domain1.fr", "domain2.fr", ...]
}""",
    },
]

FILTER_PROMPT = """You are a local news editor selecting the most relevant articles for a journalist covering Bozeman, Montana.

From the numbered articles below, select the 5-6 MOST relevant for a local journalist.

PRIORITIZE:
- Recent local developments, decisions, and events
- Stories with local impact (housing, infrastructure, politics, economy)
- Unique or underreported angles
- Diverse topics (don't select 3 articles about the same story)

AVOID:
- National/global news without local connection
- Listicles, travel guides, tourism content
- Press releases without newsworthy content
- Duplicate coverage of the same event

ARTICLES:
0. Title: Bozeman City Commission approves new housing development
   Source: Bozeman Daily Chronicle | Date: 2026-03-15
   Summary: Commission voted 4-1 to approve 200-unit mixed-use development on North 7th

1. Title: Montana State University announces record enrollment
   Source: MSU News | Date: 2026-03-14
   Summary: Spring enrollment reaches 17,500 students, highest in university history

2. Title: Gallatin Valley water rights dispute heads to court
   Source: Montana Free Press | Date: 2026-03-13
   Summary: Ranchers challenge city's water allocation plan affecting irrigation downstream

3. Title: Best restaurants in Bozeman for 2026
   Source: TripAdvisor | Date: 2026-03-10
   Summary: Top 10 dining spots for visitors to Big Sky Country

4. Title: Bridger Bowl announces early season closure
   Source: Bozeman Magazine | Date: 2026-03-12
   Summary: Below-average snowfall forces ski area to close two weeks early

5. Title: Local nonprofit launches affordable childcare program
   Source: KBZK | Date: 2026-03-14
   Summary: Thrive Community Hub opens subsidized childcare serving 50 families

6. Title: Montana Legislature debates property tax reform
   Source: Associated Press | Date: 2026-03-15
   Summary: Bipartisan bill could cap annual property tax increases at 3%

7. Title: Bozeman High School robotics team wins state championship
   Source: Bozeman Daily Chronicle | Date: 2026-03-13
   Summary: Team heads to national competition in Houston next month

8. Title: New bike lane project begins on Main Street
   Source: City of Bozeman | Date: 2026-03-11
   Summary: $2.3M project adds protected lanes from downtown to MSU campus

9. Title: Climate change impacts on Gallatin River fishing
   Source: Yale Environment 360 | Date: 2026-03-08
   Summary: Rising water temperatures threaten native trout populations

Return a JSON object with a single key "indices" containing an array of the selected article indices.
Example: {"indices": [0, 2, 5, 7, 8]}"""

SUMMARY_PROMPT = """Summarize the key news for Bozeman, Montana.

ARTICLES:
1. Title: Bozeman City Commission approves new housing development
   URL: https://example.com/housing
   Summary: Commission voted 4-1 to approve 200-unit mixed-use development on North 7th

2. Title: Gallatin Valley water rights dispute heads to court
   URL: https://example.com/water
   Summary: Ranchers challenge city's water allocation plan affecting irrigation

3. Title: Local nonprofit launches affordable childcare program
   URL: https://example.com/childcare
   Summary: Thrive Community Hub opens subsidized childcare serving 50 families

4. Title: New bike lane project begins on Main Street
   URL: https://example.com/bikes
   Summary: $2.3M project adds protected lanes from downtown to MSU campus

5. Title: Bozeman High School robotics team wins state championship
   URL: https://example.com/robotics
   Summary: Team heads to national competition in Houston next month

FORMAT:
- Use emoji bullets for each story
- Each bullet: 1 descriptive sentence explaining what happened and why it matters
- Include [source](url) links inline
- 3-5 bullets maximum
- NO introduction or preface - start directly with the first bullet

IMPORTANT: Write the summary in English.
Start directly with the first bullet point. Do not write any introduction."""


# ---- Benchmark runner ----

async def run_benchmark():
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=10.0),
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=0),
        follow_redirects=True,
    )

    results = {}

    try:
        # ======== TASK 1: Query Generation (multilingual) ========
        print("\n" + "=" * 70)
        print("  TASK 1: QUERY GENERATION (multilingual)")
        print("=" * 70)

        for model_name, model_config in MODELS.items():
            results.setdefault(model_name, {})
            print(f"\n  --- {model_name} ---")

            for test in QUERY_GEN_TESTS:
                messages = [
                    {"role": "system", "content": "You are a query generator. Output only the requested JSON format."},
                    {"role": "user", "content": test["prompt"]},
                ]
                r = await call_model(client, model_config, messages, max_tokens=500, temperature=0.5)

                if "error" in r:
                    print(f"    {test['label']:30s} ERROR: {r['error'][:80]}  ({r['elapsed']:.1f}s)")
                    results[model_name][f"querygen_{test['label']}"] = {"error": r["error"], "elapsed": r["elapsed"]}
                else:
                    try:
                        cleaned = extract_json(r["content"] or "")
                        parsed = json.loads(cleaned)
                        lang = parsed.get("primary_language", "?")
                        n_queries = len(parsed.get("queries", []))
                        n_disc = len(parsed.get("discovery_queries", []))
                        sample = parsed.get("queries", [""])[0][:60] if parsed.get("queries") else ""
                        print(f"    {test['label']:30s} {r['elapsed']:5.1f}s  lang={lang}  queries={n_queries}  disc={n_disc}")
                        print(f"      Sample: {sample}")
                        results[model_name][f"querygen_{test['label']}"] = {
                            "elapsed": r["elapsed"], "lang": lang, "queries": n_queries,
                            "discovery": n_disc, "sample": sample,
                        }
                    except (json.JSONDecodeError, ValueError, KeyError, TypeError) as e:
                        print(f"    {test['label']:30s} {r['elapsed']:5.1f}s  JSON PARSE ERROR: {e}")
                        print(f"      Raw: {(r.get('content') or '')[:120]}")
                        results[model_name][f"querygen_{test['label']}"] = {"elapsed": r["elapsed"], "json_error": str(e)}

        # ======== TASK 2: AI Filter ========
        print("\n" + "=" * 70)
        print("  TASK 2: AI FILTER (article selection)")
        print("=" * 70)

        for model_name, model_config in MODELS.items():
            messages = [{"role": "user", "content": FILTER_PROMPT}]
            r = await call_model(client, model_config, messages, max_tokens=200, temperature=0.1)

            if "error" in r:
                print(f"  {model_name:30s} ERROR: {r['error'][:80]}  ({r['elapsed']:.1f}s)")
                results[model_name]["filter"] = {"error": r["error"], "elapsed": r["elapsed"]}
            else:
                try:
                    cleaned = extract_json(r.get("content") or "")
                    parsed = json.loads(cleaned)
                    indices = parsed.get("indices", [])
                    print(f"  {model_name:30s} {r['elapsed']:5.1f}s  selected={indices}")
                    results[model_name]["filter"] = {"elapsed": r["elapsed"], "indices": indices}
                except (json.JSONDecodeError, ValueError, KeyError, TypeError) as e:
                    print(f"  {model_name:30s} {r['elapsed']:5.1f}s  JSON PARSE ERROR")
                    print(f"    Raw: {(r.get('content') or '')[:150]}")
                    results[model_name]["filter"] = {"elapsed": r["elapsed"], "json_error": str(e)}

        # ======== TASK 3: Summary ========
        print("\n" + "=" * 70)
        print("  TASK 3: SUMMARY GENERATION")
        print("=" * 70)

        for model_name, model_config in MODELS.items():
            messages = [{"role": "user", "content": SUMMARY_PROMPT}]
            r = await call_model(client, model_config, messages, max_tokens=500, temperature=0.2, json_mode=False)

            if "error" in r:
                print(f"  {model_name:30s} ERROR: {r['error'][:80]}  ({r['elapsed']:.1f}s)")
                results[model_name]["summary"] = {"error": r["error"], "elapsed": r["elapsed"]}
            else:
                summary = (r.get("content") or "").strip()
                lines = [l for l in summary.split("\n") if l.strip()]
                print(f"  {model_name:30s} {r['elapsed']:5.1f}s  {len(lines)} bullets, {len(summary)} chars")
                for line in lines[:5]:
                    print(f"    {line[:100]}")
                results[model_name]["summary"] = {"elapsed": r["elapsed"], "bullets": len(lines), "chars": len(summary)}

        # ======== SUMMARY TABLE ========
        print("\n" + "=" * 70)
        print("  RESULTS SUMMARY")
        print("=" * 70)
        print(f"\n  {'Model':30s} {'QueryGen(EN)':>12s} {'QueryGen(DE)':>12s} {'QueryGen(FR)':>12s} {'Filter':>8s} {'Summary':>8s} {'Total':>8s}")
        print("  " + "-" * 88)

        for model_name in MODELS:
            r = results.get(model_name, {})
            qg_en = r.get("querygen_Bozeman, US (English)", {}).get("elapsed", 0)
            qg_de = r.get("querygen_Schaffhausen, CH (German)", {}).get("elapsed", 0)
            qg_fr = r.get("querygen_Lyon, FR (French)", {}).get("elapsed", 0)
            filt = r.get("filter", {}).get("elapsed", 0)
            summ = r.get("summary", {}).get("elapsed", 0)
            total = qg_en + filt + summ  # Typical pipeline: 1 querygen + 1 filter + 1 summary

            qg_en_s = f"{qg_en:.1f}s" if qg_en else "ERROR"
            qg_de_s = f"{qg_de:.1f}s" if qg_de else "ERROR"
            qg_fr_s = f"{qg_fr:.1f}s" if qg_fr else "ERROR"
            filt_s = f"{filt:.1f}s" if filt else "ERROR"
            summ_s = f"{summ:.1f}s" if summ else "ERROR"
            total_s = f"{total:.1f}s" if total else "N/A"

            print(f"  {model_name:30s} {qg_en_s:>12s} {qg_de_s:>12s} {qg_fr_s:>12s} {filt_s:>8s} {summ_s:>8s} {total_s:>8s}")

    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(run_benchmark())
