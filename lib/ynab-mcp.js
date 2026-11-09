// YNAB MCP server core — shared by the local stdio entry (../bin/stdio.js)
// and the hosted HTTP entry (../api/mcp/[secret].js).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE = "https://api.ynab.com/v1";
const RULES_GROUP = "🤖 Claude";
const RULES_CATEGORY = "Claude Rules";

const INSTRUCTIONS = `Tools for the user's YNAB budget. Amounts are dollars (negative = outflow/spending).
Account, category, and payee arguments accept names (partial matches OK).

The user keeps standing instructions in their budget (a "${RULES_CATEGORY}" category note):
payee→category rules, protected categories, and general guidelines.
- Call get_rules before reviewing/categorizing transactions or moving money, and follow it.
- get_transactions with a status filter adds suggested_category from those rules.
- When the user states a lasting preference ("X is always Y", "never touch Z"), save it with
  add_rule / add_guideline / set_protected_category so it applies in every future conversation.
- Protected categories can never be used as a source of money; the server enforces this.
- Confirm with the user before deleting transactions or applying large changes.`;

export function buildServer({ token, budget: defaultBudget = "last-used" }) {
  if (!token) throw new Error("YNAB token missing");

  // ---------- API helpers ----------

  async function ynab(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = json.error || {};
      throw new Error(`YNAB ${res.status} ${e.name || ""}: ${e.detail || text}`);
    }
    return json.data;
  }

  const toMilli = (d) => Math.round(d * 1000);
  const fromMilli = (m) => (m == null ? null : Math.round(m) / 1000);
  const today = () => new Date().toISOString().slice(0, 10);
  const b = (id) => encodeURIComponent(id || defaultBudget);
  const norm = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  const getAccounts = (budget) =>
    cached(`acc:${budget}`, async () =>
      (await ynab("GET", `/budgets/${b(budget)}/accounts`)).accounts.filter((a) => !a.deleted));
  const getCategoryGroups = (budget) =>
    cached(`cat:${budget}`, async () =>
      (await ynab("GET", `/budgets/${b(budget)}/categories`)).category_groups.filter((g) => !g.deleted));
  const getPayees = (budget) =>
    cached(`pay:${budget}`, async () =>
      (await ynab("GET", `/budgets/${b(budget)}/payees`)).payees.filter((p) => !p.deleted));

  function resolve(items, query, kind, nameOf = (x) => x.name) {
    if (!query) return null;
    const byId = items.find((x) => x.id === query);
    if (byId) return byId;
    const q = norm(query);
    const exact = items.filter((x) => norm(nameOf(x)) === q);
    if (exact.length === 1) return exact[0];
    const partial = items.filter((x) => norm(nameOf(x)).includes(q));
    if (partial.length === 1) return partial[0];
    const candidates = (exact.length ? exact : partial).slice(0, 10).map(nameOf);
    throw new Error(
      candidates.length
        ? `Ambiguous ${kind} "${query}". Matches: ${candidates.join(" | ")}`
        : `No ${kind} matching "${query}".`
    );
  }

  const resolveAccount = async (budget, q) => resolve(await getAccounts(budget), q, "account");
  async function allCategories(budget) {
    return (await getCategoryGroups(budget)).flatMap((g) =>
      g.categories.filter((c) => !c.deleted).map((c) => ({ ...c, group: g.name, group_id: g.id }))
    );
  }
  async function resolveCategory(budget, q) {
    const cats = (await allCategories(budget)).filter((c) => c.name !== RULES_CATEGORY);
    return resolve(cats, q, "category", (c) => (q.includes(":") ? `${c.group}: ${c.name}` : c.name));
  }
  const resolvePayee = async (budget, q) => resolve(await getPayees(budget), q, "payee");

  // ---------- rules (stored in a YNAB category note) ----------

  function parseRules(note) {
    const out = { rules: [], protected: [], guidelines: [] };
    let section = null;
    for (const raw of (note || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const header = line.match(/^(RULES|PROTECTED|GUIDELINES)\b/i);
      if (header) { section = header[1].toUpperCase(); continue; }
      const body = line.replace(/^[-•*]\s*/, "");
      if (section === "RULES") {
        const m = body.match(/^(.+?)\s*(?:\[(inflow|outflow)\])?\s*(?:→|->|=>)\s*(.+?)(?:\s*\|\s*(.*))?$/i);
        if (m) out.rules.push({ match: m[1].trim(), direction: m[2]?.toLowerCase(), category: m[3].trim(), note: m[4]?.trim() || undefined });
      } else if (section === "PROTECTED") {
        const [category, note] = body.split("|").map((s) => s.trim());
        out.protected.push({ category, note: note || undefined });
      } else if (section === "GUIDELINES") {
        out.guidelines.push(body);
      }
    }
    return out;
  }

  function formatRules(r) {
    const lines = [
      "Standing instructions for Claude. Edit freely: one item per line.",
      "",
      "RULES (payee contains → category):",
      ...r.rules.map((x) => `${x.match}${x.direction ? ` [${x.direction}]` : ""} → ${x.category}${x.note ? ` | ${x.note}` : ""}`),
      "",
      "PROTECTED (never take money from):",
      ...r.protected.map((x) => `${x.category}${x.note ? ` | ${x.note}` : ""}`),
      "",
      "GUIDELINES:",
      ...r.guidelines.map((g) => `- ${g}`),
    ];
    return lines.join("\n");
  }

  async function findRulesCategory(budget) {
    const cats = await allCategories(budget);
    return cats.find((c) => c.name === RULES_CATEGORY) || null;
  }

  async function loadRules(budget) {
    return cached(`rules:${budget}`, async () => {
      const cat = await findRulesCategory(budget);
      if (!cat) return { exists: false, ...parseRules("") };
      const fresh = (await ynab("GET", `/budgets/${b(budget)}/categories/${cat.id}`)).category;
      return { exists: true, category_id: cat.id, ...parseRules(fresh.note) };
    }, 30 * 1000);
  }

  async function saveRules(budget, rules) {
    let cat = await findRulesCategory(budget);
    const note = formatRules(rules);
    if (!cat) {
      const groups = await getCategoryGroups(budget);
      let group = groups.find((g) => g.name === RULES_GROUP);
      if (!group) {
        group = (await ynab("POST", `/budgets/${b(budget)}/category_groups`, { category_group: { name: RULES_GROUP } })).category_group;
      }
      await ynab("POST", `/budgets/${b(budget)}/categories`, {
        category: { name: RULES_CATEGORY, category_group_id: group.id, note },
      });
    } else {
      await ynab("PATCH", `/budgets/${b(budget)}/categories/${cat.id}`, { category: { note } });
    }
    invalidate(`cat:${budget}`);
    invalidate(`rules:${budget}`);
    return loadRules(budget);
  }

  function suggestFor(t, rules) {
    const payee = norm(t.payee_name);
    for (const r of rules.rules) {
      if (!payee.includes(norm(r.match))) continue;
      if (r.direction === "inflow" && t.amount <= 0) continue;
      if (r.direction === "outflow" && t.amount >= 0) continue;
      return r;
    }
    return null;
  }

  async function assertNotProtected(budget, categoryId, action) {
    const rules = await loadRules(budget);
    for (const p of rules.protected) {
      let pc;
      try { pc = await resolveCategory(budget, p.category); } catch { continue; }
      if (pc.id === categoryId) {
        throw new Error(
          `Refused: "${pc.name}" is a protected category (${p.note || "user rule"}). ` +
          `Money can't be taken from it via Claude to ${action}. Use Ready to Assign or another category instead.`
        );
      }
    }
  }

  // ---------- formatting ----------

  function fmtTxn(t) {
    const r = {
      id: t.id, date: t.date, amount: fromMilli(t.amount), payee: t.payee_name,
      category: t.category_name, account: t.account_name, memo: t.memo || undefined,
      cleared: t.cleared, approved: t.approved, flag: t.flag_color || undefined,
    };
    if (t.transfer_account_id) r.transfer = true;
    if (t.subtransactions?.length)
      r.splits = t.subtransactions.filter((s) => !s.deleted).map((s) => ({
        amount: fromMilli(s.amount), category: s.category_name, payee: s.payee_name, memo: s.memo || undefined,
      }));
    return r;
  }

  function fmtCategory(c) {
    const r = { name: c.name, assigned: fromMilli(c.budgeted), activity: fromMilli(c.activity), available: fromMilli(c.balance) };
    if (c.goal_type) {
      r.goal = {
        type: c.goal_type, target: fromMilli(c.goal_target), target_month: c.goal_target_month || undefined,
        percent_complete: c.goal_percentage_complete, underfunded: fromMilli(c.goal_under_funded) || undefined,
      };
    }
    if (c.hidden) r.hidden = true;
    return r;
  }

  async function buildTxn(budget, a) {
    const t = {};
    if (a.account) t.account_id = (await resolveAccount(budget, a.account)).id;
    if (a.date) t.date = a.date;
    if (a.amount != null) t.amount = toMilli(a.amount);
    if (a.payee) {
      try { t.payee_id = (await resolvePayee(budget, a.payee)).id; } catch { t.payee_name = a.payee; }
    }
    if (a.category) t.category_id = (await resolveCategory(budget, a.category)).id;
    if (a.memo != null) t.memo = a.memo;
    if (a.cleared) t.cleared = a.cleared;
    if (a.approved != null) t.approved = a.approved;
    if (a.flag !== undefined) t.flag_color = a.flag === "none" ? null : a.flag;
    if (a.splits) {
      t.subtransactions = await Promise.all(a.splits.map(async (s) => ({
        amount: toMilli(s.amount),
        category_id: s.category ? (await resolveCategory(budget, s.category)).id : undefined,
        memo: s.memo,
      })));
      t.category_id = null;
    }
    return t;
  }

  // ---------- server & tools ----------

  const server = new McpServer({ name: "ynab", version: "2.0.0" }, { instructions: INSTRUCTIONS });

  function tool(name, description, schema, handler) {
    server.registerTool(name, { description, inputSchema: schema }, async (args) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await handler(args), null, 1) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    });
  }

  const budgetArg = z.string().optional().describe("Budget id. Omit to use the default (last-used budget).");
  const flagEnum = z.enum(["red", "orange", "yellow", "green", "blue", "purple", "none"]);

  tool("list_budgets", "List the user's YNAB budgets (plans) with ids.", {}, async () => {
    const d = await ynab("GET", "/budgets");
    return d.budgets.map((x) => ({ id: x.id, name: x.name, last_modified: x.last_modified_on, currency: x.currency_format?.iso_code }));
  });

  tool("list_accounts", "List accounts with current balances. on_budget=false means a tracking account (no categories needed).",
    { budget: budgetArg, include_closed: z.boolean().optional() },
    async ({ budget, include_closed }) => {
      invalidate(`acc:${budget}`);
      return (await getAccounts(budget)).filter((a) => include_closed || !a.closed).map((a) => ({
        name: a.name, type: a.type, on_budget: a.on_budget, balance: fromMilli(a.balance),
        cleared: fromMilli(a.cleared_balance), uncleared: fromMilli(a.uncleared_balance),
        closed: a.closed || undefined, id: a.id,
      }));
    });

  tool("get_month",
    "Budget overview for a month: Ready to Assign, income, totals, age of money, and every category's assigned/activity/available/goal, grouped.",
    {
      budget: budgetArg,
      month: z.string().optional().describe('YYYY-MM-01 or "current" (default).'),
      include_hidden: z.boolean().optional(),
      only_overspent: z.boolean().optional().describe("Only categories with negative available."),
    },
    async ({ budget, month = "current", include_hidden, only_overspent }) => {
      const [m, groups] = await Promise.all([
        ynab("GET", `/budgets/${b(budget)}/months/${month}`).then((d) => d.month),
        getCategoryGroups(budget),
      ]);
      const byId = new Map(m.categories.map((c) => [c.id, c]));
      return {
        month: m.month, ready_to_assign: fromMilli(m.to_be_budgeted), income: fromMilli(m.income),
        assigned: fromMilli(m.budgeted), activity: fromMilli(m.activity), age_of_money: m.age_of_money,
        groups: groups
          .filter((g) => (include_hidden || !g.hidden) && !["Internal Master Category", RULES_GROUP].includes(g.name))
          .map((g) => ({
            group: g.name,
            categories: g.categories.map((c) => byId.get(c.id))
              .filter((c) => c && !c.deleted && (include_hidden || !c.hidden))
              .filter((c) => !only_overspent || c.balance < 0)
              .map(fmtCategory),
          }))
          .filter((g) => g.categories.length),
      };
    });

  tool("list_categories", "List category groups and categories (names + ids).",
    { budget: budgetArg, include_hidden: z.boolean().optional() },
    async ({ budget, include_hidden }) =>
      (await getCategoryGroups(budget))
        .filter((g) => (include_hidden || !g.hidden) && g.name !== RULES_GROUP)
        .map((g) => ({
          group: g.name,
          categories: g.categories.filter((c) => !c.deleted && (include_hidden || !c.hidden)).map((c) => ({ name: c.name, id: c.id })),
        })));

  tool("list_payees", "List payees, optionally filtered by search text.",
    { budget: budgetArg, search: z.string().optional() },
    async ({ budget, search }) => {
      let p = await getPayees(budget);
      if (search) p = p.filter((x) => norm(x.name).includes(norm(search)));
      return p.map((x) => ({ name: x.name, id: x.id, transfer: x.transfer_account_id ? true : undefined }));
    });

  tool("get_transactions",
    "Search transactions by date range, account, category, payee, status, text, amount. Newest first. With a status filter, each result includes suggested_category from the user's saved rules when one matches.",
    {
      budget: budgetArg,
      since_date: z.string().optional().describe("YYYY-MM-DD. Defaults to 30 days ago (or all time when status is set)."),
      until_date: z.string().optional(),
      account: z.string().optional(),
      category: z.string().optional(),
      payee: z.string().optional(),
      status: z.enum(["unapproved", "uncategorized"]).optional(),
      search: z.string().optional().describe("Matches payee, memo, or category."),
      min_amount: z.number().optional().describe("Absolute value, dollars."),
      max_amount: z.number().optional().describe("Absolute value, dollars."),
      limit: z.number().int().optional().describe("Default 100."),
    },
    async (a) => {
      const budget = a.budget;
      const since = a.since_date || (a.status ? "2000-01-01" : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
      let path = `/budgets/${b(budget)}/transactions`;
      const acct = a.account && (await resolveAccount(budget, a.account));
      const cat = a.category && (await resolveCategory(budget, a.category));
      const pay = a.payee && (await resolvePayee(budget, a.payee));
      if (acct) path = `/budgets/${b(budget)}/accounts/${acct.id}/transactions`;
      else if (cat) path = `/budgets/${b(budget)}/categories/${cat.id}/transactions`;
      else if (pay) path = `/budgets/${b(budget)}/payees/${pay.id}/transactions`;
      const qs = new URLSearchParams({ since_date: since });
      if (a.status) qs.set("type", a.status);
      let txns = (await ynab("GET", `${path}?${qs}`)).transactions.filter((t) => !t.deleted);

      if (cat && acct) txns = txns.filter((t) => t.category_id === cat.id || t.subtransactions?.some((s) => s.category_id === cat.id));
      if (pay && (acct || cat)) txns = txns.filter((t) => t.payee_id === pay.id);
      if (a.until_date) txns = txns.filter((t) => t.date <= a.until_date);
      if (a.search) {
        const s = norm(a.search);
        txns = txns.filter((t) => [t.payee_name, t.memo, t.category_name].some((f) => f && norm(f).includes(s)));
      }
      if (a.min_amount != null) txns = txns.filter((t) => Math.abs(t.amount) >= toMilli(a.min_amount));
      if (a.max_amount != null) txns = txns.filter((t) => Math.abs(t.amount) <= toMilli(a.max_amount));
      txns.sort((x, y) => (x.date < y.date ? 1 : -1));

      const limit = a.limit ?? 100;
      const rules = a.status ? await loadRules(budget) : null;
      return {
        count: txns.length,
        net_total: fromMilli(txns.reduce((s, t) => s + t.amount, 0)),
        truncated: txns.length > limit || undefined,
        guidelines: rules?.guidelines.length ? rules.guidelines : undefined,
        transactions: txns.slice(0, limit).map((t) => {
          const r = fmtTxn(t);
          const hit = rules && suggestFor(t, rules);
          if (hit && hit.category !== t.category_name) {
            r.suggested_category = hit.category;
            r.rule = `${hit.match}${hit.note ? ` (${hit.note})` : ""}`;
          }
          return r;
        }),
      };
    });

  const txnFields = {
    date: z.string().optional().describe("YYYY-MM-DD"),
    amount: z.number().optional().describe("Dollars. Negative = outflow, positive = inflow."),
    payee: z.string().optional().describe('Payee name. Use "Transfer : <account name>" to make it a transfer.'),
    category: z.string().optional().describe('Category name, or "Group: Category". "Inflow: Ready to Assign" for income.'),
    memo: z.string().optional(),
    cleared: z.enum(["cleared", "uncleared", "reconciled"]).optional(),
    approved: z.boolean().optional(),
    flag: flagEnum.optional(),
    splits: z.array(z.object({ amount: z.number(), category: z.string().optional(), memo: z.string().optional() }))
      .optional().describe("Sub-transactions; amounts must sum to the total."),
  };

  tool("create_transaction", "Create a transaction. Amount in dollars, negative for spending.",
    { budget: budgetArg, account: z.string(), ...txnFields, amount: z.number() },
    async (a) => {
      const t = await buildTxn(a.budget, { date: today(), approved: true, cleared: "uncleared", ...a });
      const d = await ynab("POST", `/budgets/${b(a.budget)}/transactions`, { transaction: t });
      invalidate(`pay:${a.budget}`);
      return { created: fmtTxn(d.transaction) };
    });

  tool("update_transactions",
    "Update one or more transactions by id (recategorize, approve, memo, payee, amount, date, flag). Only provided fields change.",
    { budget: budgetArg, updates: z.array(z.object({ id: z.string(), account: z.string().optional(), ...txnFields })).min(1) },
    async ({ budget, updates }) => {
      const transactions = await Promise.all(updates.map(async (u) => ({ id: u.id, ...(await buildTxn(budget, u)) })));
      const d = await ynab("PATCH", `/budgets/${b(budget)}/transactions`, { transactions });
      invalidate(`pay:${budget}`);
      return { updated: d.transactions.map(fmtTxn) };
    });

  tool("approve_transactions",
    "Approve transactions by id, or all_unapproved=true (optionally with except_ids) to approve everything awaiting approval.",
    { budget: budgetArg, ids: z.array(z.string()).optional(), all_unapproved: z.boolean().optional(), except_ids: z.array(z.string()).optional() },
    async ({ budget, ids, all_unapproved, except_ids = [] }) => {
      if (!ids?.length && !all_unapproved) throw new Error("Provide ids or all_unapproved=true.");
      if (all_unapproved) {
        const d = await ynab("GET", `/budgets/${b(budget)}/transactions?type=unapproved`);
        ids = d.transactions.filter((t) => !t.deleted).map((t) => t.id);
      }
      ids = ids.filter((id) => !except_ids.includes(id));
      if (!ids.length) return { approved: 0 };
      const d = await ynab("PATCH", `/budgets/${b(budget)}/transactions`, { transactions: ids.map((id) => ({ id, approved: true })) });
      return { approved: d.transactions.length };
    });

  tool("delete_transaction", "Delete a transaction by id. Confirm with the user first.",
    { budget: budgetArg, id: z.string() },
    async ({ budget, id }) => ({ deleted: fmtTxn((await ynab("DELETE", `/budgets/${b(budget)}/transactions/${id}`)).transaction) }));

  tool("assign_to_category",
    "SET the assigned amount for a category in a month (not additive). Lowering a protected category is refused.",
    { budget: budgetArg, category: z.string(), amount: z.number(), month: z.string().optional().describe('YYYY-MM-01 or "current".') },
    async ({ budget, category, amount, month = "current" }) => {
      const cat = await resolveCategory(budget, category);
      const cur = (await ynab("GET", `/budgets/${b(budget)}/months/${month}/categories/${cat.id}`)).category;
      if (toMilli(amount) < cur.budgeted) await assertNotProtected(budget, cat.id, "lower its assigned amount");
      const d = await ynab("PATCH", `/budgets/${b(budget)}/months/${month}/categories/${cat.id}`, { category: { budgeted: toMilli(amount) } });
      return { updated: fmtCategory(d.category), month };
    });

  tool("move_money",
    'Move money between categories in a month. from="Ready to Assign" assigns new money to `to`. Protected categories can never be the source.',
    { budget: budgetArg, from: z.string(), to: z.string(), amount: z.number().positive(), month: z.string().optional() },
    async ({ budget, from, to, amount, month = "current" }) => {
      const fromRTA = /ready to assign/i.test(from);
      const tc = await resolveCategory(budget, to);
      const get = (id) => ynab("GET", `/budgets/${b(budget)}/months/${month}/categories/${id}`).then((d) => d.category);
      const patch = (id, budgeted) =>
        ynab("PATCH", `/budgets/${b(budget)}/months/${month}/categories/${id}`, { category: { budgeted } }).then((d) => d.category);
      let nf;
      if (!fromRTA) {
        const fc = await resolveCategory(budget, from);
        await assertNotProtected(budget, fc.id, "move money");
        const f = await get(fc.id);
        nf = fmtCategory(await patch(fc.id, f.budgeted - toMilli(amount)));
      }
      const t = await get(tc.id);
      const nt = await patch(tc.id, t.budgeted + toMilli(amount));
      return { from: nf || "Ready to Assign", to: fmtCategory(nt), month };
    });

  tool("list_scheduled_transactions", "List upcoming scheduled/recurring transactions.", { budget: budgetArg },
    async ({ budget }) =>
      (await ynab("GET", `/budgets/${b(budget)}/scheduled_transactions`)).scheduled_transactions
        .filter((s) => !s.deleted).sort((x, y) => (x.date_next < y.date_next ? -1 : 1))
        .map((s) => ({
          id: s.id, next: s.date_next, frequency: s.frequency, amount: fromMilli(s.amount),
          payee: s.payee_name, category: s.category_name, account: s.account_name, memo: s.memo || undefined,
        })));

  tool("spending_summary",
    "Aggregate spending by category, payee, category_group, or month over a date range. Excludes transfers and income.",
    {
      budget: budgetArg,
      since_date: z.string(),
      until_date: z.string().optional(),
      group_by: z.enum(["category", "payee", "category_group", "month"]).optional(),
      top: z.number().int().optional(),
    },
    async ({ budget, since_date, until_date, group_by = "category", top = 25 }) => {
      const [d, groups] = await Promise.all([
        ynab("GET", `/budgets/${b(budget)}/transactions?since_date=${since_date}`),
        getCategoryGroups(budget),
      ]);
      const groupOf = new Map(groups.flatMap((g) => g.categories.map((c) => [c.id, g.name])));
      const rows = [];
      for (const t of d.transactions) {
        if (t.deleted || t.transfer_account_id) continue;
        if (until_date && t.date > until_date) continue;
        const subs = t.subtransactions?.filter((s) => !s.deleted) || [];
        const parts = subs.length
          ? subs.filter((s) => !s.transfer_account_id).map((s) => ({ ...s, date: t.date, payee_name: s.payee_name || t.payee_name }))
          : [t];
        for (const p of parts) if (groupOf.get(p.category_id) !== "Internal Master Category") rows.push(p);
      }
      const keyOf = {
        category: (r) => r.category_name || "(uncategorized)",
        payee: (r) => r.payee_name || "(no payee)",
        category_group: (r) => groupOf.get(r.category_id) || "(uncategorized)",
        month: (r) => r.date.slice(0, 7),
      }[group_by];
      const agg = new Map();
      for (const r of rows) {
        const e = agg.get(keyOf(r)) || { spent: 0, count: 0 };
        e.spent -= r.amount; e.count++;
        agg.set(keyOf(r), e);
      }
      const list = [...agg.entries()]
        .map(([k, v]) => ({ [group_by]: k, spent: fromMilli(v.spent), count: v.count }))
        .sort((x, y) => (group_by === "month" ? (x.month < y.month ? -1 : 1) : y.spent - x.spent));
      return {
        range: [since_date, until_date || today()],
        total_spent: fromMilli(rows.reduce((s, r) => s - r.amount, 0)),
        rows: group_by === "month" ? list : list.slice(0, top),
      };
    });

  // ---------- rules tools ----------

  tool("get_rules",
    "Get the user's standing instructions: payee→category rules, protected categories, and guidelines. Call before reviewing transactions or moving money.",
    { budget: budgetArg },
    async ({ budget }) => {
      const r = await loadRules(budget);
      return r.exists ? r : { ...r, hint: "No rules saved yet. They are created automatically on the first add_rule / add_guideline." };
    });

  tool("add_rule",
    'Save a lasting payee→category rule (e.g. "Trader Joe\'s is always Groceries"). match is text contained in the payee name. Replaces an existing rule with the same match/direction.',
    {
      budget: budgetArg,
      match: z.string().describe('Text the payee contains, e.g. "TRADER JOE" or "Netflix".'),
      category: z.string().describe("Category name (validated against the budget)."),
      direction: z.enum(["inflow", "outflow"]).optional().describe("Only apply to money in or money out."),
      note: z.string().optional(),
    },
    async ({ budget, match, category, direction, note }) => {
      const cat = category === "Inflow: Ready to Assign" ? { name: category } : await resolveCategory(budget, category);
      const r = await loadRules(budget);
      const rules = r.rules.filter((x) => !(norm(x.match) === norm(match) && x.direction === direction));
      rules.push({ match, direction, category: cat.name, note });
      const saved = await saveRules(budget, { ...r, rules });
      return { saved: { match, direction, category: cat.name, note }, total_rules: saved.rules.length };
    });

  tool("remove_rule", "Remove a payee rule by its match text.",
    { budget: budgetArg, match: z.string() },
    async ({ budget, match }) => {
      const r = await loadRules(budget);
      const rules = r.rules.filter((x) => norm(x.match) !== norm(match));
      if (rules.length === r.rules.length) throw new Error(`No rule matching "${match}".`);
      await saveRules(budget, { ...r, rules });
      return { removed: match };
    });

  tool("add_guideline", "Save a lasting free-form instruction (e.g. budgeting conventions, context about accounts).",
    { budget: budgetArg, text: z.string() },
    async ({ budget, text }) => {
      const r = await loadRules(budget);
      await saveRules(budget, { ...r, guidelines: [...r.guidelines, text] });
      return { added: text };
    });

  tool("remove_guideline", "Remove a guideline (matched by contained text).",
    { budget: budgetArg, text: z.string() },
    async ({ budget, text }) => {
      const r = await loadRules(budget);
      const guidelines = r.guidelines.filter((g) => !norm(g).includes(norm(text)));
      if (guidelines.length === r.guidelines.length) throw new Error(`No guideline containing "${text}".`);
      await saveRules(budget, { ...r, guidelines });
      return { removed: r.guidelines.length - guidelines.length };
    });

  tool("set_protected_category",
    "Mark a category as protected (money can never be moved out of it or its assignment lowered via Claude), or unprotect it.",
    { budget: budgetArg, category: z.string(), protected: z.boolean(), note: z.string().optional() },
    async ({ budget, category, protected: isProtected, note }) => {
      const cat = await resolveCategory(budget, category);
      const r = await loadRules(budget);
      const rest = r.protected.filter((p) => {
        try { return norm(p.category) !== norm(cat.name); } catch { return true; }
      });
      const list = isProtected ? [...rest, { category: cat.name, note }] : rest;
      await saveRules(budget, { ...r, protected: list });
      return { category: cat.name, protected: isProtected };
    });

  return server;
}

// Module-level cache (persists across requests in a warm serverless instance).
const cache = new Map();
async function cached(key, fn, ttlMs = 5 * 60 * 1000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
function invalidate(prefix) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}
