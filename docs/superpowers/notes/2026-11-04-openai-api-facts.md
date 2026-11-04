# OpenAI API fact sheet (fetched 2026-11-03/04)

Docs moved: platform.openai.com/docs/* 301-redirects to developers.openai.com/api/docs/*; the API reference pages on platform.openai.com return 403 to WebFetch. Sources below are the developers.openai.com `.md` versions fetched with curl (local copies in this scratchpad dir: resp-create.md, structured-outputs.md, reasoning.md, error-codes.md, pricing.md, latest.md, astra.md, mig.md). "L" = line number in that local copy.

Source URLs (S = base https://developers.openai.com/api):
- REF  = S/reference/resources/responses/methods/create(.md)  (resp-create.md)
- SO   = S/docs/guides/structured-outputs.md
- REAS = S/docs/guides/reasoning.md
- ERR  = S/docs/guides/error-codes.md
- PRICE= S/docs/pricing.md
- MODELS = S/reference/resources/models/methods/list (fetched via WebFetch, summarized; not .md)
- LATEST = S/docs/guides/latest-model.md ; ASTRA = S/docs/models/gpt-6-astra.md ; MIG = S/docs/guides/migrate-to-responses.md

## 1. Endpoint, headers, Responses vs Chat Completions
- `POST https://api.openai.com/v1/responses` (REF "post /responses"; curl at REF L16674-16679 and SO L670).
- Headers in docs' curl: `Authorization: Bearer $OPENAI_API_KEY`, `Content-Type: application/json` (REF L16676-16678; SO L671-672). No other header documented as required.
- Chat Completions: MIG L7 verbatim: "While Chat Completions remains supported, Responses is recommended for all new projects." So Responses is correct for new code.

## 2. Structured output (Responses API)
Request shape (SO curl L670-715, REF L10093-10125):
`text.format = { "type":"json_schema", "name":<str, a-zA-Z0-9_- max 64>, "schema":<JSON Schema object>, "strict":<bool, default false>, "description":<optional str> }`
- `name`, `schema`, `type` are listed required; `description`, `strict` optional (REF L10093-10125).
- Where JSON text is: `output[]` item with `type:"message"` -> `content[]` item `type:"output_text"` -> `.text` (REF example L16700-16714). `output_text` top-level is SDK-ONLY convenience, NOT in raw HTTP JSON (REF L16201-16205: "SDK-only convenience property ... Supported in the Python and JavaScript SDKs"). A urllib client must walk `output[].content[]` and join `output_text` texts; also skip `reasoning` items in `output`.
- Refusal shape: content item `{"type":"refusal","refusal":"<explanation>"}` in the same `content[]` (REF L498-504; SO L3199-3205). Check for it before parsing.
- Non-strict mode: exists. `strict` defaults to false (REF L10117-10123); with strict false, schema adherence is not guaranteed. Older `{"type":"json_object"}` JSON mode also exists, "Not recommended" (REF L5290-5312); it needs the word "JSON" in the context or API errors (SO L4381). Always validate output yourself.
- Strict-mode (`strict:true`) requirements (SO):
  - `additionalProperties: false` required on every object (SO L4120-4125 "must always be set in objects").
  - All fields must be in `required`; optional is emulated with type union with null, e.g. `"type":["string","null"]` (SO L4059).
  - Root must be an object, not `anyOf` (SO L4003-4005).
  - Limits: up to 5000 object properties total, 10 nesting levels (SO L4092); total string length of property/definition/enum/const names <=120,000 chars; <=1000 enum values total (SO ~L4096-4106).
  - Supported types: string, number, boolean, integer, object, array, enum, anyOf (SO L3875-3885). `$defs`/definitions and recursive `$ref:"#"` supported (SO L4220, L4265).
  - Supported keywords: string `pattern`, `format` (date-time,time,date,duration,email,hostname,ipv4,ipv6,uuid); number `multipleOf,maximum,exclusiveMaximum,minimum,exclusiveMinimum`; array `minItems,maxItems` (SO L3890-3915).
  - Not supported: `allOf, not, dependentRequired, dependentSchemas, if, then, else` (SO ~L4140 "Composition"). Docs say an unsupported schema with strict:true "will receive an error" (SO L4154). minLength/maxLength were not found in the supported list (only listed as unsupported for fine-tuned models, SO ~L4146) -- UNVERIFIED for base models; treat as unsupported/avoid.
  - Output key order follows schema key order (SO "Key ordering").
  - First request with a new schema has extra latency (WebFetch summary of SO; not re-verified in .md).
- Complete curl, copied from SO L670-715:
```bash
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-astra",
    "input": [
      {
        "role": "system",
        "content": "You are a helpful math tutor. Guide the user through the solution step by step."
      },
      {
        "role": "user",
        "content": "how can I solve 8x + 7 = -23"
      }
    ],
    "text": {
      "format": {
        "type": "json_schema",
        "name": "math_reasoning",
        "schema": {
          "type": "object",
          "properties": {
            "steps": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "explanation": { "type": "string" },
                  "output": { "type": "string" }
                },
                "required": ["explanation", "output"],
                "additionalProperties": false
              }
            },
            "final_answer": { "type": "string" }
          },
          "required": ["steps", "final_answer"],
          "additionalProperties": false
        },
        "strict": true
      }
    }
  }'
```

## 3. Instructions, input, max_output_tokens, temperature
- `instructions: optional string|null` -- "A system (or developer) message inserted into the model's context" (REF L4744-4746).
- `input: optional string or array of input items` (REF L99); a plain string is a user message; array form `{"role":"system"|"user","content":"..."}` used in SO curl.
- `max_output_tokens: optional integer|null`, minimum 16, includes visible AND reasoning tokens (REF L4752-4756). Reasoning guide: reserve >=25,000 tokens for reasoning+output when starting (REAS, "Incomplete status handling" section).
- `temperature`: Responses param, number 0-2, default 1 (REF L5267-5272). BUT LATEST L223: "When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`" (stated for the GPT-6 models). => Do NOT send temperature to reasoning models with effort != none. (REAS did not mention temperature.)
- Also: `store` default true (REF L5239); `reasoning.summary`/`verbosity` (`text.verbosity` low|medium|high, REF ~L5320) exist.

## 4. Reasoning effort and models
- `reasoning: { effort }`; REF L5128-5160: "Currently supported values are none, minimal, low, medium, high, xhigh, and max. ... Not all reasoning models support every value." Default medium.
- Per-model (REAS; ASTRA L12; LATEST L219-221): gpt-6-astra supports low, medium, high, xhigh, max (no `none`, no `minimal`; REAS says `none` returns HTTP 400). gpt-6.1-sol: no `none`/`minimal`, default medium. GPT-6.1 Terra, GPT-6 Sol, GPT-6 Luna support `none`. gpt-5.6 family and gpt-5.5 default medium.
- Model ids named by docs: gpt-6-astra (REAS: recommended starting point; "most capable"; 1,050,000 context, 128,000 max output, ASTRA L14-22), gpt-6.1-sol, gpt-6.1-terra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol/-terra/-luna, gpt-5.5, gpt-5.4 (+mini/nano), gpt-5.2, gpt-5.1, gpt-5, gpt-5-mini, gpt-5-nano, o3, o3-pro (PRICE), o4-mini (REAS, summaries example). gpt-6-astra supports structured_outputs (ASTRA L66-70). REAS: gpt-5.6-terra = lower cost, gpt-5.6-luna = lowest cost/latency.
- NOTE: user memory says gpt-6.1-sol is unsupported on THIS account; docs list it, so availability is account-specific. Verify with GET /v1/models (item 7).

## 5. Response status / usage / incompletes
- `status`: one of completed, failed, in_progress, cancelled, queued, incomplete (REF L16460-16475).
- `incomplete_details: {reason}|null`; reason in `max_output_tokens`, `max_messages`, `content_filter`, `steered` (REF L6591-6610).
- Incomplete from max_output_tokens may occur before any visible output (reasoning ate the budget) (REAS).
- `error` on the response object (when status failed): `{code, message}`; codes include server_error, rate_limit_exceeded, invalid_prompt, +18 more (REF L6491-6497).
- `usage` (REF L16630-16672, example L16745-16755): `input_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens`. All names confirmed exactly. Output tokens include reasoning tokens (REF L4752 wording) -- bill output_tokens at output rate.
- Refusal: see item 2.

## 6. Errors
Table from ERR L10-24 (https://developers.openai.com/api/docs/guides/error-codes.md):
- 401 Invalid Authentication / Incorrect API key provided / not a member of an org / IP not authorized.
- 403 country, region, territory not supported.
- 429: "Rate limit reached for requests"; `slow_down` (type rate_limit_error); `credit_balance_exhausted`; `organization_spend_limit_exceeded`; `project_spend_limit_exceeded`; `organization_usage_limit_exceeded`.
- 500 server error. 503 `server_is_overloaded` (type service_unavailable_error).
- 400 invalid `service_tier`.
- `insufficient_quota`: NOT listed as a code at ERR. The page says to inspect `error.code` for billing causes since `error.type` may still be `insufficient_quota`; "Retrying billing, spend, or quota errors won't restore API access." => Do not retry 429s whose code is one of the credit/spend/usage-limit codes or insufficient_quota; retry only rate_limit-type 429, 500, 503.
- Error JSON body: ERR does not show a full example; it references `error.type`, `error.code`, `error.param`. `error.message` is not spelled out on ERR in the fetched text -- shape `{"error":{"message","type","param","code"}}` is NOT confirmed by a doc quote here (gap).
- `Retry-After`: "If a Retry-After header is present, wait at least as long as it specifies" (ERR L148, L168); if absent use exponential backoff with jitter.

## 7. GET /v1/models
- `GET https://api.openai.com/v1/models` with `Authorization: Bearer $OPENAI_API_KEY` (MODELS; WebFetch summary). Response `{"object":"list","data":[{id, created (unix s), object:"model", owned_by, shutdown_date (string|null)}]}`. Plain API key works per docs' curl example. (Not run live: no key used.)

## 8. Prices, USD per 1M tokens, Standard tier, short context (<=272K input) -- PRICE L35-64 (https://developers.openai.com/api/docs/pricing.md), fetched 2026-11-04 local time; page shows no publication date
| model | input | cached input | output |
|---|---|---|---|
| gpt-6-astra | 10.00 | 1.00 | 50.00 |
| gpt-6.1-sol | 2.00 | 0.10 | 10.00 |
| gpt-6.1-terra | 1.00 | 0.05 | 5.00 |
| gpt-6-sol | 2.00 | 0.20 | 10.00 |
| gpt-6-luna | 0.10 | 0.01 | 0.50 |
| gpt-5.6-sol | 4.00 | 0.40 | 20.00 |
| gpt-5.6-terra | 2.00 | 0.20 | 12.00 |
| gpt-5.6-luna | 0.20 | 0.02 | 1.20 |
| gpt-5.5 | 5.00 | 0.50 | 30.00 |
| gpt-5.5-pro | 30.00 | not listed | 180.00 |
| gpt-5.4 | 2.50 | 0.25 | 15.00 |
| gpt-5.4-pro | 30.00 | not listed | 180.00 |
| gpt-5.4-mini | 0.75 | 0.075 | 4.50 |
| gpt-5.4-nano | 0.20 | 0.02 | 1.25 |
| gpt-5.2 | 1.75 | 0.175 | 14.00 |
| gpt-5.1 | 1.25 | 0.125 | 10.00 |
| gpt-5 | 1.25 | 0.125 | 10.00 |
| gpt-5-mini | 0.25 | 0.025 | 2.00 |
| gpt-5-nano | 0.05 | 0.005 | 0.40 |
| o3 | 2.00 | 0.50 | 8.00 |
| o3-pro | 20.00 | not listed | 80.00 |
| o4-mini | not listed on the Standard table fetched (grep of pricing.md found no row) | | |
Notes: gpt-6-astra also has cache-write price $12.50/1M (ASTRA pricing; PRICE L35). Prompts >272K input: 2x input/cache, 1.5x output for whole request (ASTRA). Batch/Flex = 50% of Standard; Fast mode 2x (ASTRA). Pricing page lists other tables (batch/flex/priority) at pricing.md L81+; not used.

## Gaps / unverified
- API reference pages on platform.openai.com 403'd; used developers.openai.com equivalents.
- Exact error JSON body (`error.message`) not shown on error-codes page.
- minLength/maxLength under strict on non-fine-tuned models not explicitly stated.
- Pricing/model availability for this account not checked (no API key used).
- WebFetch is summarized by a small model; all quoted line numbers come from curl'd .md files, except MODELS (WebFetch only).
