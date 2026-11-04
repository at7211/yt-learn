# Anthropic Messages API fact sheet (raw HTTP, JSON-Schema output)
Date compiled: 2026-11-04.

SK = /private/tmp/claude-501/bundled-skills/2.1.316/da0498237dcad9acdeeb199e4ee4cf0a/claude-api
(NOTE: the skill actually extracted to version 2.1.316 / hash da0498...; the path in the task text, 2.1.312/bb4772..., was not used.)
Docs fetched live 2026-11-04: P=https://platform.claude.com/docs/en/...
Local copy of pricing page fetch: /Users/jaychou/.claude/projects/-Users-jaychou-side-project/cde8b891-b96a-466f-af6a-c3caf2795364/tool-results/toolu_01VgG457UNBUaRctTHVA4HoG.txt

## 1. Endpoint + headers
- POST https://api.anthropic.com/v1/messages  (SK/curl/examples.md:16)
- Headers: `Content-Type: application/json`, `x-api-key: <key>`, `anthropic-version: 2026-10-21` (SK/curl/examples.md:17-19; table at :101-108 says anthropic-version "Required (API version)").
- Version choice: the skill's current value is `2026-10-21`. The live structured-outputs doc's curl still uses `2023-06-01` (P/build-with-claude/structured-outputs.md). Both accepted. Differences (SK/shared/api-version-migration.md:99): on 2026-10-21 ANY `temperature`/`top_p`/`top_k` => 400 on every model; also 400 for a `document` block in an assistant message and for `text` blocks with non-empty `citations` in a user message (:129, :135). Raw-HTTP switch = just the header (:46). Not verified: whether 2023-06-01 will remain supported long-term.
- Beta header for structured JSON output: NONE needed for `output_config.format` (P/build-with-claude/structured-outputs.md: "beta headers are no longer required for output_config.format"; SK/shared/tool-use-concepts.md:539). Only the deprecated `output_format` param needs `structured-outputs-2025-11-13` (same live page; SK/shared/tool-use-concepts.md:539, SK/curl/examples.md:108 says anthropic-beta only for beta features).
- OAuth alternative (not needed for API key): `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` (skill SKILL.md "Authentication" section; SK/shared/error-codes.md:60-63).
- Response header `request-id` on every response (P/api/errors.md "Request ID").

## 2. Structured output (JSON Schema)
Primary path: `output_config.format` = {"type":"json_schema","schema":{...}}. Supported models include claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5 (SK/shared/tool-use-concepts.md:537 "Supported models" line, checked at 524+13).
- Body: top-level `output_config: {"format": {"type": "json_schema", "schema": <JSON Schema>}}` (SK/python/claude-api/tool-use.md, "Raw Schema" example in section starting line 480; SK/shared/model-migration.md:133-141).
- Parsed JSON location: the response's text content block: `content[i].type=="text"`, `.text` is a JSON string -> `json.loads` (SK/python/claude-api/tool-use.md "output_config.format guarantees the first block is text with valid JSON"; live page: "in the response's text content block"). With thinking on (always, on Opus/Sonnet 5.5) first block may be `thinking`; select first block with type=="text" rather than content[0].
- Schema restrictions (P/build-with-claude/structured-outputs.md, fetched; also SK/shared/tool-use-concepts.md:541-558):
  - Supported: object/array/string/integer/number/boolean/null; enum (primitives only); const; anyOf; allOf (not with $ref); $ref/$def/definitions (internal only); default; required; string formats date-time,time,date,duration,email,hostname,uri,ipv4,ipv6,uuid; array minItems only 0 or 1; `additionalProperties` MUST be `false` on objects.
  - Unsupported (=> 400): recursive schemas, external $ref, minimum/maximum/multipleOf, minLength/maxLength, array constraints beyond minItems 0/1, additionalProperties != false, complex enums. Regex `pattern`: partial (no backrefs, lookaround, \b, large {n,m}).
  - The SDKs strip unsupported constraints and validate client-side (SK tool-use-concepts.md:558); a raw-HTTP client must do that itself (assumption: no server-side stripping).
- Caveats: first use of a new schema has a one-time compile cost, cached 24h (tool-use-concepts.md:562). Incompatible with citations (400) and prefill (:565). `refusal`/`max_tokens` stop reasons can yield output not matching schema (live page; :563-564). A schema property asking for "reasoning/steps" can trigger `reasoning_extraction` refusal (live page).
- Fallback (tool-use): define a tool with `input_schema` and `strict: true` (+ additionalProperties:false, required) (SKILL.md "Strict tool use"; SK/curl/examples.md:109-121 shows the tool shape). Result appears in a `tool_use` block's `.input`. BUT forced `tool_choice` {type:any|tool} returns 400 on claude-opus-5-5 and claude-sonnet-5-5 (SK/shared/error-codes.md:127; P/api/errors.md "Forced tool use not supported"), so only `auto` works and the call is not guaranteed. Prefer output_config.format.
- Complete minimal curl (copied from live doc P/build-with-claude/structured-outputs.md, fetched 2026-11-04; header version as in doc):
```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-5-5",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "Extract the key information from this email: John Smith (john@example.com) is interested in our Enterprise plan and wants to schedule a demo for next Tuesday at 2pm."
      }
    ],
    "output_config": {
      "format": {
        "type": "json_schema",
        "schema": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "email": {"type": "string"},
            "plan_interest": {"type": "string"},
            "demo_requested": {"type": "boolean"}
          },
          "required": ["name", "email", "plan_interest", "demo_requested"],
          "additionalProperties": false
        }
      }
    }
  }'
```
  (Skill's equivalent with version 2026-10-21 and a raw schema: SK/python/claude-api/tool-use.md Raw Schema section; headers SK/curl/examples.md:16-20.)

## 3. System prompt, user message, max_tokens, temperature
- `system`: top-level string, or list of {type:"text",text,cache_control?} blocks (SK/python/claude-api/README.md "System Prompts"; SK/curl/examples.md:23-25).
- `messages`: [{"role":"user","content":"..."}]; first must be user; must end with user turn (prefill 400s on 4.6+ models) (README "Multi-Turn Rules"; P/api/errors.md "Prefill not supported").
- `max_tokens` required (SK/shared/error-codes.md:49). Skill guidance: don't lowball; ~16000 default non-streaming; streaming needed only for very large (>~16K) values (SK SKILL.md "Common Pitfalls"; model-migration.md:359-361). Thinking counts toward max_tokens (SK/shared/model-migration.md Haiku 5.5 section, line ~2276 "Thinking counts toward max_tokens"). RECOMMENDATION (mine, not from docs): 2-4 KB JSON ~ 1-1.5K output tokens; with always-on adaptive thinking use 8000-16000 to leave room; check stop_reason=="max_tokens". Hard cap 128K output for these models (SK/shared/models.md:64,69,72).
- `temperature`: do NOT send. 400 on every model under anthropic-version 2026-10-21 (api-version-migration.md:99); under 2023-06-01 still 400 on claude-opus-5-5 (SK/shared/error-codes.md:123-124 area, line "Model-specific 400s on Claude Opus 5.5 / ... temperature, top_p, top_k are removed"), non-default 400 on Sonnet 5.5 (SKILL.md thinking table) and Haiku 5.5 (error-codes.md:126 area).

## 4. Thinking / effort (Claude 5.5 family)
Source: SKILL.md "Thinking & Effort" table; SK/shared/error-codes.md model-specific 400 list; P/api/errors.md "Thinking cannot be disabled".
- Effort: `output_config: {"effort": "low"|"medium"|"high"|"xhigh"|"max"}` (inside output_config, not top-level; GA, no beta header). Can be combined with `output_config.format` in the same object (assumption: both keys are sibling fields of output_config; each is documented separately, the combo is not shown in one example).
- claude-opus-5-5: thinking always on. Omit `thinking` or send {"type":"adaptive"}. {"type":"disabled"} and {"type":"enabled","budget_tokens":N} => 400 at every effort. Effort default `medium`. Levels low/medium/high/xhigh/max. Forced tool_choice any/tool 400.
- claude-sonnet-5-5: omit or {"type":"adaptive"}. {"type":"disabled"} => 400; use {"type":"between_tools"} (only on Sonnet 5.5; effort high or below; no other thinking field; 400 on other models). budget_tokens 400. Effort default `high`; levels low..max. Non-default temperature 400.
- claude-haiku-5-5: omit or adaptive; {"type":"disabled"} accepted at effort low/medium/high only (400 at xhigh/max); budget_tokens 400; non-default temperature/top_p 400, any top_k 400; effort default `medium`; levels low..max (SKILL.md table row "Claude Haiku 5.5"; error-codes.md Haiku bullet; P/api/errors.md).
- Display: `thinking.display` default "omitted" (empty thinking text) on all three; "summarized" optional (SKILL.md "Thinking display"). Thinking blocks, if present, are separate content blocks - ignore them when extracting JSON.
- Effort/refusal support is also queryable via GET /v1/models `capabilities.effort`, `capabilities.thinking.types` (P/api/models/list.md).
- Suggested for a cheap JSON task: omit `thinking`; set `output_config.effort` "low" (SK/python/claude-api/README.md Cost section shows haiku-5-5 with {"effort":"low"}).

## 5. Usage + stop_reason
- usage fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (SK/shared/prompt-caching.md:183-188; SK/python/claude-api/README.md "Verifying Cache Hits"). Also `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` (prompt-caching.md:208). Haiku 5.5 note: prompt length for the >100K price tier counts cache reads+writes (pricing page). Not verified: whether the fields can be null/missing when no caching (treat with .get(...,0)).
- stop_reason values: end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal (SK/python/claude-api/README.md:422-431). On `refusal`: `stop_details` {type, category, explanation} non-null only then (SKILL.md "Stop details"). Check `max_tokens` (truncated JSON) and `refusal` (output may not match schema) before json.loads (structured-outputs live page).
- Refusal fallbacks (`fallbacks` param) are beta and NOT supported on Haiku 5.5 (400) (error-codes.md Haiku bullet); optional on others; not needed.

## 6. Errors
- Table (P/api/errors.md, fetched): 400 invalid_request_error; 401 authentication_error; 402 billing_error; 403 permission_error; 404 not_found_error; 409 conflict_error; 413 request_too_large; 429 rate_limit_error; 500 api_error; 504 timeout_error; 529 overloaded_error. (Skill SK/shared/error-codes.md:7-17 omits 409/504.)
- Body: {"type":"error","error":{"type":"...","message":"..."},"request_id":"req_..."} (P/api/errors.md "Error shapes"; SK/shared/error-codes.md:34-43).
- retry-after: header present on 429 (SK/shared/error-codes.md:153); exception: a tier spend-cap 429 has NO retry-after and keeps failing (P/api/errors.md 429 entry). SDK honors retry-after "when present". Not found in docs: an explicit statement that 529 carries retry-after -> treat as optional. Retryable: 429, 5xx incl. 529 (error-codes.md:7-17; skill SKILL.md "max_retries ... retries 408/409/429/5xx").
- 404 also for model not available to org (error-codes.md:13). Mid-stream errors only with stream:true (n/a non-streaming). Max request size Messages API 128 MB (P/api/errors.md).
- Unknown/invalid `anthropic-beta` value => 400 (error-codes.md:30).

## 7. GET /v1/models
- URL: GET https://api.anthropic.com/v1/models ; single: /v1/models/{id} (SK/shared/models.md:35).
- Headers: x-api-key (SK/shared/models.md:36), anthropic-version (live doc: optional; skill example sends 2026-10-21, models.md:37). Live doc example uses `Authorization: Bearer`; x-api-key per skill example. Optional `anthropic-workspace-id`.
- Query: `limit` (default 20, 1-1000), `after_id`, `before_id`, `lifecycle` (array of active/deprecated/retired, max 3; default = active+deprecated) (P/api/models/list.md).
- Response: {"data":[ModelInfo],"first_id","last_id","has_more"}; ModelInfo fields: type("model"), id, display_name, created_at (RFC 3339), deprecated_at, lifecycle, line, max_input_tokens, max_tokens, retires_at, capabilities{...}. Newest first. Paginate: while has_more, pass after_id=last_id (live doc "last_id ... can be used as the after_id").
- There is no `context_window` field (SKILL.md "Models API").

## 8. List prices USD per MTok (source: P/about-claude/pricing.md, fetched 2026-11-04; local copy lines 15-41; page itself shows no explicit date)
| model | input | output | cache write 5m | cache write 1h | cache read |
|---|---|---|---|---|---|
| claude-opus-5-5 | 4 | 20 | 5 | 8 | 0.20 (pricing:21,41) |
| claude-sonnet-5-5 | 2 | 10 | 2.50 | 4 | 0.10 (pricing:29,41 footnote: 0.05x) |
| claude-haiku-5-5, prompt <=100K tokens | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 (pricing:34) |
| claude-haiku-5-5, prompt >100K tokens | 0.50 | 2.50 | 0.625 | 1 | 0.05 (pricing:35) |
- DISCREPANCY: skill cache says Sonnet 5.5 cache reads $0.20 (SK/shared/model-migration.md:2087 area "cache reads $0.20"), live pricing page says $0.10 (0.05x of $2). Use the live page (0.10). Skill input/output prices agree (SKILL.md "Current Models (cached: 2026-10-06)": opus 4/20, sonnet 2/10, haiku 0.10/0.50, >100K 0.50/2.50 per model-migration Haiku section).
- Batch is 50%: Opus 5.5 2/10, Sonnet 5.5 1/5, Haiku 5.5 0.05/0.25 (<=100K) (pricing:194,202,207). inference_geo "us" adds 1.1x (pricing:160).

## Gaps / not verified
- Nothing was executed against the live API (no key used); all behaviors are from docs.
- Combining output_config.format + output_config.effort in one request not shown in a single doc example.
- Exact per-model `effort` support for the structured-output combination not tested.
- Pricing page has no visible "as of" date; dated by fetch (2026-11-04); skill model table is dated 2026-10-06.
- Line numbers for the "(area)" references are approximate to within a few lines (grep-located); other line numbers exact.
