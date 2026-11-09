---
name: ynab-check
description: Run a YNAB check-in with the YNAB connector — clear the approval queue, then show Ready to Assign, overspending and month-to-date spend. Use when the user says "YNAB check" or asks how their budget looks.
---

# YNAB check-in

Use the YNAB connector (default budget unless the user names another). Goal: the user sees the state of their budget at a glance and their YNAB approval queue is cleared, with as few questions as possible.

Everything specific to this user's budget (payee rules, tracking accounts, categories to protect or ask about) comes from their **Claude Rules** note via `get_rules`. Don't assume anything that isn't there.

## Steps

1. **Rules first.** Call `get_rules` and follow every rule, protected category and guideline it returns.
   If no rules exist yet, carry on, and at the end offer to save any patterns you noticed as rules.
2. **Clear the queue.** Call `get_transactions` with `status: "unapproved"`.
   - Approve without asking (categorize first if needed):
     - transactions with a `suggested_category` from a saved rule;
     - transactions in tracking (off-budget) accounts, which take no category;
     - transfers between the user's own accounts;
     - anything a guideline says to treat as routine.
   - Everything else: list it with a proposed category. Ask in one batch, then apply the answers with `update_transactions` and approve.
   - If the user says a payee should always go somewhere, save it with `add_rule`.
3. **Ready to Assign and overspending.** Call `get_month` (current) and `get_month` with `only_overspent: true`.
4. **Spend vs. budget.** Call `spending_summary` from the 1st of the month to today with `group_by: "category_group"`, and compare it with the assigned amounts from `get_month`.

## Guardrails

- Never move money or change assignments without proposing the moves and getting a yes first. Use `move_money` (or `assign_to_category`) only after that.
- Protected categories can never be a source of money; the connector refuses those moves.
- If a guideline says to confirm before moving money into or out of a category, ask every time, even when covering overspending.
- If the guidelines say how to cover overspending (for example "from Ready to Assign"), propose moves that way. Otherwise, propose covering from Ready to Assign first.
- Uncategorized transfers and tracking-account activity are not to-dos; never report them as problems.

## Output (short, phone-friendly)

- Headline: "All clear" or "Needs you: N items"
- Ready to Assign: $X (flag if negative)
- Overspent: category and amount, or "none"
- Spending vs. budget by group, month to date: only notable groups, one line each
- Approved automatically: count
- Needs your call: date, payee, amount, account, suggested category
- If anything is overspent: a proposed set of moves, waiting for a yes
