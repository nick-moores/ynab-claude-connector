# AGENTS.md

MCP server that lets Claude read and edit a YNAB budget. One core, two entry points:

| Path | Role |
|---|---|
| `lib/ynab-mcp.js` | All tools, YNAB API client, rules engine. `buildServer({ token, budget })` returns an `McpServer`. |
| `bin/stdio.js` | Local entry (stdio) for Claude Code / Claude Desktop. |
| `api/mcp/[secret].js` | Hosted entry: Vercel function, stateless Streamable HTTP, JSON responses. |

Plain ESM JavaScript, no build step. Deps: `@modelcontextprotocol/sdk`, `zod`.

## Gotchas

- **Do not add `server.js`, `index.js`, `app.js`, or `src/server.js`** (or a `main` field pointing at one).
  Vercel auto-detects those as a whole-app entry point and routes every request there, so every request fails with a 500 "No export" error.
  That's why the files are named `bin/` and `lib/`. `vercel.json` sets `"framework": null`
  so Vercel deploys `api/` as functions. Without it, the build fails with "No entrypoint found".
- **Amounts:** tools take and return dollars; YNAB uses milliunits (`toMilli` / `fromMilli`). Outflows are negative.
- **Names, not IDs:** tools accept account/category/payee names. `resolve()` tries exact id, then exact name, then a unique partial match, and errors with candidates if the match is ambiguous.
  Categories can be given as `"Group: Category"` to disambiguate.
- **YNAB rate limit is 200 requests/hour** per token. Accounts, categories and payees are cached for 5 minutes, and rules for 30 seconds.
  The cache lives at module level, so it persists within a warm serverless instance. Invalidate it after any write that changes those lists.
- YNAB renamed "budgets" to "plans" in the API (`/plans/...`). `/budgets/...` still works and is what the code uses.
  The OpenAPI spec is at `https://api.ynab.com/papi/open_api_spec.yaml`.
- Transactions in tracking accounts (`on_budget: false`) report category "Uncategorized". That's normal: they don't take categories.

## Rules (user's standing instructions)

The rules are stored **in the YNAB budget itself**, as the note on the category `Claude Rules` in group `🤖 Claude`.
They are not in this repo or a database, so local and hosted servers share them, and the user can edit them in the YNAB app.
The category is created on the first `add_rule` / `add_guideline` / `set_protected_category`. Note format (parsed by `parseRules`, written by `formatRules`):

```
RULES (payee contains → category):
TRADER JOE → 🛒 Groceries | optional note
Venmo [inflow] → Inflow: Ready to Assign | qualifier is [inflow] or [outflow]

PROTECTED (never take money from):
🛟 Emergency Fund | note

GUIDELINES:
- free text
```

See `examples/claude-rules.md` for a fuller sample.

- `→`, `->` and `=>` are all accepted. Matching is a substring match on the normalized payee name (lowercase, punctuation collapsed).
  Avoid short match strings: "HIC" would also match "Chick-fil-A".
- `get_transactions` with a `status` filter adds `suggested_category` from these rules.
- **Protected categories are enforced in code:** `move_money` from one, or `assign_to_category` lowering one, throws. Never weaken this check.
  For a softer "ask first" category, users add a guideline instead of protecting it.
- The rules category is hidden from `list_categories`, `get_month` and category resolution.

## Secrets & deploy

- Each user deploys their own copy (see README). Vercel env vars (production, sensitive): `YNAB_TOKEN`, `MCP_SECRET` (at least 32 chars), and optionally `YNAB_BUDGET_ID`.
- The connector URL is `https://<deployment>/api/mcp/<MCP_SECRET>`. A wrong secret returns 404, and non-POST requests return 405.
- **Never commit or print the secret, the YNAB token, or a real connector URL.** `.env*` is gitignored except `.env.example`.
- Local Claude Code registration (user scope): `claude mcp add --scope user ynab -e YNAB_TOKEN=... -- node <repo>/bin/stdio.js`.

## Testing

There's no test suite yet. To smoke-test, connect an SDK client:
`StdioClientTransport` running `node bin/stdio.js` locally, or `StreamableHTTPClientTransport` against the hosted URL.
Then call `listTools`, `get_rules` and `get_month`, and, if a category is listed under PROTECTED, check that `move_money` from it is refused.
Smoke tests run against a **real budget**, so stick to read-only calls apart from that refusal check.

## Skills and examples

- `skills/ynab-check/SKILL.md`: the "YNAB check" skill. Clears the approval queue, then reports Ready to Assign, overspending and month-to-date spend.
  It must stay generic: anything specific to one person's budget belongs in their Claude Rules note, not in the skill.
- `examples/claude-rules.md`: a sample rules note for a fictional household.
