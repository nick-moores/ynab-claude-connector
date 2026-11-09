# Example Claude Rules note

This is a sample for a fictional household, the Rivera family. Your real rules live in the note on the **🤖 Claude → Claude Rules** category in your own YNAB budget. Claude creates that category the first time you save a rule. You can also paste a note like this one into it and edit it to fit.

Category names must match your budget's categories exactly, emoji included.

```
Standing instructions for Claude. Edit freely: one item per line.

RULES (payee contains → category):
TRADER JOE → 🛒 Groceries
COSTCO → 🛒 Groceries | warehouse runs; split out household goods if over $300
SHELL → ⛽ Gas
Netflix → 📺 Subscriptions
Spotify → 📺 Subscriptions
CITY UTILITIES → 💡 Utilities | water and trash
Venmo [inflow] → Inflow: Ready to Assign | reimbursements from friends
ACME CORP PAYROLL [inflow] → Inflow: Ready to Assign

PROTECTED (never take money from):
🛟 Emergency Fund | only the user moves this
🎓 College Savings

GUIDELINES:
- "Joint 401K" and "Brokerage" are tracking accounts: their transactions need no category, just approval.
- Moving money from High-Yield Savings to Checking is a transfer, not income.
- Cover overspending from Ready to Assign by default.
- 🎁 Giving holds money we've promised to others. Always confirm with me before moving money into or out of it.
- Ask before approving anything over $500 that no rule covers.
```

## What each section does

| Section | Format | Effect |
|---|---|---|
| **RULES** | `payee text → category`, optional `[inflow]` / `[outflow]`, optional `\| note` | Transactions whose payee contains the text get that `suggested_category` when Claude reviews unapproved or uncategorized items. Matching ignores case and punctuation, and the first match wins. |
| **PROTECTED** | `category`, optional `\| note` | Hard stop, enforced by the connector: no `move_money` out of it, and no lowering its assignment. |
| **GUIDELINES** | `- free text` | Context Claude follows: account roles, how to cover overspending, which categories to ask about first. |

## Tips

- **Protected or confirm-first?** Protected is a hard lock, so Claude can't move money out even if you ask. For "always ask me first," use a guideline instead, like the 🎁 Giving line above.
- **Keep match text specific.** Matching is a substring match, so "HIC" would also match "Chick-fil-A".
- **Let Claude write them.** Saying "Trader Joe's is always Groceries" in chat saves the rule for you (`add_rule`). The same goes for guidelines (`add_guideline`) and protected categories (`set_protected_category`).
