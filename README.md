# YNAB Claude Connector

An MCP server that lets Claude read and work with your [YNAB](https://www.ynab.com) budget: review and approve transactions, see Ready to Assign and overspending, move money between categories, and summarize spending.

Your standing instructions (payee rules, categories Claude should never take money from, budgeting conventions) live **inside your own YNAB budget** as a category note. You can edit them in the YNAB app, and nothing about your finances is stored in this repo or anywhere else.

Everyone deploys **their own copy** with their own YNAB token, so no one else's server ever sees your data.

## What Claude can do

| Area | Tools |
|---|---|
| Overview | `list_budgets`, `list_accounts`, `list_categories`, `list_payees`, `get_month`, `spending_summary` |
| Transactions | `get_transactions`, `create_transaction`, `update_transactions`, `approve_transactions`, `delete_transaction`, `list_scheduled_transactions` |
| Budgeting | `assign_to_category`, `move_money` |
| Your rules | `get_rules`, `add_rule`, `remove_rule`, `set_protected_category`, `add_guideline`, `remove_guideline` |

Amounts are in dollars (negative = money out). Accounts, categories and payees can be named; partial names work when they're unambiguous.

## Setup (about 15 minutes)

### 1. Get a YNAB token

In YNAB, go to **Settings → Developer Settings** (<https://app.ynab.com/settings/developer>) and create a Personal Access Token. Treat it like a password: it has full access to your budget.

### 2. Make a connector secret

Generate a long random string. Your connector URL will include it, so anyone without it gets a 404.

```bash
openssl rand -hex 32
```

### 3. Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnick-moores%2Fynab-claude-connector&project-name=ynab-claude-connector&repository-name=ynab-claude-connector&env=YNAB_TOKEN,MCP_SECRET&envDescription=YNAB_TOKEN%20is%20your%20YNAB%20Personal%20Access%20Token.%20MCP_SECRET%20is%20a%20random%20string%20of%20at%20least%2032%20characters%20(openssl%20rand%20-hex%2032).&envLink=https%3A%2F%2Fgithub.com%2Fnick-moores%2Fynab-claude-connector%23setup-about-15-minutes)

The button copies this repo into your GitHub account and asks for:

| Variable | Value |
|---|---|
| `YNAB_TOKEN` | Your token from step 1 |
| `MCP_SECRET` | Your secret from step 2 (at least 32 characters) |
| `YNAB_BUDGET_ID` | *Optional.* Add later in Vercel if you have several budgets; otherwise your last-used budget is the default. |

### 4. Add the connector in Claude

Your connector URL is:

```
https://<your-project>.vercel.app/api/mcp/<MCP_SECRET>
```

In Claude, open **Settings → Connectors**, add a custom connector, and paste the URL. Keep this URL private: it is the key to your budget.

### 5. Set up your rules

Tell Claude things like *"Trader Joe's is always Groceries"* or *"never take money from Emergency Fund"*. The first one you save creates a category **🤖 Claude → Claude Rules** in your budget, and your rules are stored in its note. You can edit that note directly in YNAB too. (The connector hides this category from budget overviews.) See [`examples/claude-rules.md`](examples/claude-rules.md) for the note format and a sample household.

### 6. Optional: add the check-in skill

[`skills/ynab-check`](skills/ynab-check/SKILL.md) turns "YNAB check" into a one-pass review: clear the approval queue, then report Ready to Assign, overspending and month-to-date spending. Zip the `ynab-check` folder and upload it in Claude under **Customize → Skills**.

## Run locally instead (Claude Code or Claude Desktop)

```bash
npm install
claude mcp add --scope user ynab -e YNAB_TOKEN=your-token -- node /path/to/ynab-claude-connector/bin/stdio.js
```

## How your rules work

The rules note has three sections:

- **Rules:** `payee text → category`. When Claude lists unapproved or uncategorized transactions, each one gets a `suggested_category` from the first matching rule.
- **Protected:** categories that can never be a source of money. This is enforced in code, so Claude can't move money out of them or lower their assignment even if asked.
- **Guidelines:** free-form context, like which accounts are tracking-only or how you prefer to cover overspending.

Claude reads them with `get_rules` before reviewing transactions or moving money.

## Privacy and safety

- Your token and secret live only in your Vercel environment variables. `.env*` files are gitignored; see [`.env.example`](.env.example).
- The server is stateless. It caches account, category and payee lists in memory for a few minutes to stay under YNAB's 200 requests/hour limit, and stores nothing else.
- Claude is told to confirm before deleting transactions or making large changes. Protected categories are a hard stop.

## License

MIT
