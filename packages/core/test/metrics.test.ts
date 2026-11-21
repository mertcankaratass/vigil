/**
 * Balance sheet ratios with the KATMR reference numbers from docs/VIGIL.md §7 (million TL, June 2026 purchasing power).
 */
import { describe, expect, test } from "bun:test";
import {
  calculateBalanceSheetRatios,
  cashRatio,
  currentRatio,
  liabilitiesToAssets,
  monetaryAndFinanceExpense,
  monetaryAndFinanceExpenseByPeriod,
  netDebt,
  netDebtToEquity,
  notReported,
  ok,
  pyRound,
  quickRatio,
  type Result,
} from "../src/index.ts";
import { fact, filing } from "./helpers.ts";

const katmr2026 = {
  cash: 120.8,
  current_assets: 12903.6,
  total_assets: 14795.4,
  inventories: 8989.1,
  borrowings: 2313.8,
  current_liabilities: 3897.1,
  equity: 10499.9,
  total_liabilities: 14795.4 - 10499.9, // 4295.5
};
// 31.12.2025, the prior year-end comparative.
const katmr2025 = {
  cash: 450.9,
  current_assets: 14263.3,
  total_assets: 16069.1,
  inventories: 9191.0,
  borrowings: 2460.5,
  current_liabilities: 5174.7,
  equity: 10181.0,
  total_liabilities: 16069.1 - 10181.0, // 5888.1
};

/** The value of an ok result; anything else fails the test with the result in the message. */
function val(r: Result<number | bigint>): number {
  if (r.status !== "ok")
    throw new Error(`expected a value, got ${JSON.stringify(r, (_k, x) => (typeof x === "bigint" ? String(x) : x))}`);
  return Number(r.value);
}
const r2 = (r: Result<number | bigint>) => pyRound(val(r), 2);

describe("KATMR ratios", () => {
  test("current ratio", () => {
    expect(r2(currentRatio(katmr2026.current_assets, katmr2026.current_liabilities))).toBe(3.31);
    expect(r2(currentRatio(katmr2025.current_assets, katmr2025.current_liabilities))).toBe(2.76);
  });

  test("quick ratio", () => {
    expect(r2(quickRatio(katmr2026.current_assets, katmr2026.inventories, katmr2026.current_liabilities))).toBe(1.0);
    expect(r2(quickRatio(katmr2025.current_assets, katmr2025.inventories, katmr2025.current_liabilities))).toBe(0.98);
  });

  test("cash ratio", () => {
    expect(r2(cashRatio(katmr2026.cash, katmr2026.current_liabilities))).toBe(0.03);
    expect(r2(cashRatio(katmr2025.cash, katmr2025.current_liabilities))).toBe(0.09);
  });

  test("net debt and net debt to equity", () => {
    const nd2026 = netDebt(katmr2026.borrowings, katmr2026.cash);
    expect(pyRound(val(nd2026), 1)).toBe(2193.0);
    expect(r2(netDebtToEquity(nd2026, katmr2026.equity))).toBe(0.21);
    const nd2025 = netDebt(katmr2025.borrowings, katmr2025.cash);
    expect(pyRound(val(nd2025), 1)).toBe(2009.6);
    expect(r2(netDebtToEquity(nd2025, katmr2025.equity))).toBe(0.2);
  });

  test("liabilities to assets", () => {
    expect(r2(liabilitiesToAssets(katmr2026.total_liabilities, katmr2026.total_assets))).toBe(0.29);
    expect(r2(liabilitiesToAssets(katmr2025.total_liabilities, katmr2025.total_assets))).toBe(0.37);
  });

  test("integers in TL (bigint) work too", () => {
    expect(val(currentRatio(1290360n, 389710n))).toBeCloseTo(3.311, 3);
    // Amounts stay exact: 231,380 - 12,080 = 219,300 as a bigint.
    expect(netDebt(231380n, 12080n)).toEqual(ok(219300n));
  });
});

describe("not computable (#65): never 0, NaN or a fallback", () => {
  test("a missing input names the input", () => {
    expect(currentRatio(null, 100)).toEqual({
      status: "not_computable",
      reason: {
        code: "missing_input",
        message: "Hesaplanamaz: Dönen varlıklar raporda yok veya hesaplanamadı.",
        needs: ["current_assets"],
      },
    });
    expect(currentRatio(100, undefined)).toMatchObject({ reason: { needs: ["current_liabilities"] } });
    expect(cashRatio(null, 50)).toMatchObject({ reason: { needs: ["cash"] } });
    expect(netDebt(null, 50)).toMatchObject({ reason: { needs: ["financial_debt"] } });
    expect(liabilitiesToAssets(100, null)).toMatchObject({ reason: { needs: ["total_assets"] } });
  });

  test("every missing input is named, in order", () => {
    expect(quickRatio(null, null, 50)).toEqual({
      status: "not_computable",
      reason: {
        code: "missing_input",
        message: "Hesaplanamaz: Dönen varlıklar, Stoklar raporda yok veya hesaplanamadı.",
        needs: ["current_assets", "inventories"],
      },
    });
  });

  test("a cell the company left empty is not computable too", () => {
    expect(currentRatio(notReported(), 100)).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["current_assets"] },
    });
  });

  test("a not computable input passes its own needs on", () => {
    // Net debt is missing because borrowings are; net debt / equity then needs financial_debt, not net_debt.
    expect(netDebtToEquity(netDebt(null, 50), 100)).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["financial_debt"] },
    });
    expect(netDebtToEquity(netDebt(null, null), null)).toMatchObject({
      reason: { needs: ["financial_debt", "cash", "equity"] },
    });
  });

  test("an ok result is used as its value", () => {
    expect(val(netDebtToEquity(ok(50), ok(100)))).toBe(0.5);
  });

  test("a zero denominator is not computable and names the denominator", () => {
    expect(currentRatio(100, 0)).toEqual({
      status: "not_computable",
      reason: { code: "zero_denominator", message: "Hesaplanamaz: Kısa vadeli yükümlülükler sıfır.", needs: [] },
    });
    expect(currentRatio(100n, 0n)).toMatchObject({ reason: { code: "zero_denominator" } });
    expect(quickRatio(100, 20, 0)).toMatchObject({ reason: { code: "zero_denominator" } });
    expect(cashRatio(10, 0)).toMatchObject({ reason: { code: "zero_denominator" } });
    expect(netDebtToEquity(50, 0)).toMatchObject({
      reason: { code: "zero_denominator", message: "Hesaplanamaz: Özkaynaklar sıfır." },
    });
    expect(liabilitiesToAssets(50, 0)).toMatchObject({ reason: { code: "zero_denominator" } });
  });

  test("a zero numerator is a value, not a missing input", () => {
    expect(val(cashRatio(0, 50))).toBe(0);
    expect(netDebt(0n, 0n)).toEqual(ok(0n));
  });

  test("no ratio is NaN or Infinity, whatever the inputs", () => {
    const inputs = [null, undefined, 0, 0n, notReported<number>()];
    for (const a of inputs) {
      for (const b of inputs) {
        for (const r of [currentRatio(a, b), cashRatio(a, b), liabilitiesToAssets(a, b), quickRatio(a, b, a)]) {
          if (r.status === "ok") expect(Number.isFinite(r.value)).toBe(true);
          else expect(r.status).toBe("not_computable");
        }
      }
    }
  });

  test("calculateBalanceSheetRatios with no inputs gives a reason for every ratio", () => {
    const all = calculateBalanceSheetRatios();
    for (const r of [all.current_ratio, all.quick_ratio, all.cash_ratio, all.net_debt, all.net_debt_to_equity]) {
      expect(r.status).toBe("not_computable");
    }
    expect(all.liabilities_to_assets).toMatchObject({ reason: { needs: ["total_liabilities", "total_assets"] } });
    expect(all.liabilities_derived).toBe(false);
  });
});

test("calculateBalanceSheetRatios derives liabilities only when they are missing", () => {
  const derived = calculateBalanceSheetRatios({
    current_assets: katmr2026.current_assets,
    current_liabilities: katmr2026.current_liabilities,
    inventories: katmr2026.inventories,
    cash_and_equivalents: katmr2026.cash,
    borrowings: katmr2026.borrowings,
    equity: katmr2026.equity,
    total_assets: katmr2026.total_assets,
  });
  expect(r2(derived.current_ratio)).toBe(3.31);
  expect(r2(derived.quick_ratio)).toBe(1.0);
  expect(r2(derived.cash_ratio)).toBe(0.03);
  expect(pyRound(val(derived.net_debt), 1)).toBe(2193.0);
  expect(r2(derived.net_debt_to_equity)).toBe(0.21);
  expect(r2(derived.liabilities_to_assets)).toBe(0.29);
  expect(derived.liabilities_derived).toBe(true);

  const explicit = calculateBalanceSheetRatios({
    current_assets: katmr2026.current_assets,
    current_liabilities: katmr2026.current_liabilities,
    total_assets: katmr2026.total_assets,
    total_liabilities: katmr2026.total_liabilities,
  });
  expect(r2(explicit.liabilities_to_assets)).toBe(0.29);
  expect(explicit.liabilities_derived).toBe(false);
});

describe("pyRound matches Python's round()", () => {
  test.each([
    [2.5, 0, 2],
    [3.5, 0, 4],
    [-2.5, 0, -2],
    [0.125, 2, 0.12],
    [0.375, 2, 0.38],
    [2.675, 2, 2.67], // 2.675 is 2.67499999... in binary
    [1.005, 2, 1.0],
    [-0.4, 0, -0],
    [0.215429998603807, 6, 0.21543],
  ])("round(%p, %p) = %p", (x, n, expected) => {
    expect(pyRound(x, n)).toBe(expected);
  });
});

describe("net monetary position and finance expense (#64)", () => {
  test("KATMR worked example from docs/VIGIL.md §7: exposes both side by side", () => {
    // 6A 2026: net monetary position 60.0 mn TL, finance (net) -188.9 mn TL
    const katmr2026 = monetaryAndFinanceExpense(60_000_000n, -188_900_000n);
    expect(katmr2026.net_monetary_position).toEqual(ok(60_000_000n));
    expect(katmr2026.finance_expense).toEqual(ok(-188_900_000n));

    // 6A 2025: net monetary position 145.5 mn TL, finance (net) -168.3 mn TL
    const katmr2025 = monetaryAndFinanceExpense(145_500_000n, -168_300_000n);
    expect(katmr2025.net_monetary_position).toEqual(ok(145_500_000n));
    expect(katmr2025.finance_expense).toEqual(ok(-168_300_000n));
  });

  test("KATMR Q1/Q2 swing mentioned in context: net monetary position swings but is kept with finance expense", () => {
    // Q1 2026: +320.2 mn TL
    const q1 = monetaryAndFinanceExpense(320_200_000n, -95_000_000n);
    expect(q1.net_monetary_position).toEqual(ok(320_200_000n));
    expect(q1.finance_expense).toEqual(ok(-95_000_000n));

    // Q2 2026 (standalone): -260.2 mn TL
    const q2 = monetaryAndFinanceExpense(-260_200_000n, -93_900_000n);
    expect(q2.net_monetary_position).toEqual(ok(-260_200_000n));
    expect(q2.finance_expense).toEqual(ok(-93_900_000n));
  });

  test("missing input gives not computable (#65), never 0 or fallback", () => {
    // Missing net monetary position
    const noMon = monetaryAndFinanceExpense(null, -188_900_000n);
    expect(noMon.net_monetary_position).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["net_monetary_position"] },
    });
    expect(noMon.finance_expense).toEqual(ok(-188_900_000n));

    // Missing finance expense
    const noExp = monetaryAndFinanceExpense(60_000_000n, undefined);
    expect(noExp.net_monetary_position).toEqual(ok(60_000_000n));
    expect(noExp.finance_expense).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["finance_expense"] },
    });

    // Both missing or not reported
    const bothMissing = monetaryAndFinanceExpense(notReported(), notReported());
    expect(bothMissing.net_monetary_position).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["net_monetary_position"] },
    });
    expect(bothMissing.finance_expense).toMatchObject({
      status: "not_computable",
      reason: { code: "missing_input", needs: ["finance_expense"] },
    });

    // Zero is a valid amount, not missing
    const zero = monetaryAndFinanceExpense(0n, 0n);
    expect(zero.net_monetary_position).toEqual(ok(0n));
    expect(zero.finance_expense).toEqual(ok(0n));
  });

  test("accepts input object form as well", () => {
    const res = monetaryAndFinanceExpense({
      net_monetary_position: 60_000_000n,
      finance_expense: -188_900_000n,
    });
    expect(res.net_monetary_position).toEqual(ok(60_000_000n));
    expect(res.finance_expense).toEqual(ok(-188_900_000n));
  });

  test("monetaryAndFinanceExpenseByPeriod extracts both lines for every period in a filing", () => {
    const f = filing({
      template_family: "general",
      role_codes: ["310003"],
      facts: [
        fact({
          role_code: "310003",
          row_id: "general_role_310003-row-52",
          column_class: "col-order-class-4",
          period_type: "YTD_CUMULATIVE",
          period_label: "01.01.2026 - 30.06.2026",
          period_start: "2026-01-01",
          period_end: "2026-06-30",
          normalized_value_tl: 60_000_000n,
        }),
        fact({
          role_code: "310003",
          row_id: "general_role_310003-row-51",
          column_class: "col-order-class-4",
          period_type: "YTD_CUMULATIVE",
          period_label: "01.01.2026 - 30.06.2026",
          period_start: "2026-01-01",
          period_end: "2026-06-30",
          normalized_value_tl: -188_900_000n,
        }),
        fact({
          role_code: "310003",
          row_id: "general_role_310003-row-52",
          column_class: "col-order-class-5",
          period_type: "YTD_CUMULATIVE",
          period_label: "01.01.2025 - 30.06.2025",
          period_start: "2025-01-01",
          period_end: "2025-06-30",
          normalized_value_tl: 145_500_000n,
        }),
        fact({
          role_code: "310003",
          row_id: "general_role_310003-row-51",
          column_class: "col-order-class-5",
          period_type: "YTD_CUMULATIVE",
          period_label: "01.01.2025 - 30.06.2025",
          period_start: "2025-01-01",
          period_end: "2025-06-30",
          normalized_value_tl: -168_300_000n,
        }),
      ],
    });

    const periods = monetaryAndFinanceExpenseByPeriod(f);
    expect(periods).toHaveLength(2);

    const c4 = periods.find((p) => p.column_class === "col-order-class-4");
    expect(c4?.net_monetary_position).toEqual(ok(60_000_000n));
    expect(c4?.finance_expense).toEqual(ok(-188_900_000n));

    const c5 = periods.find((p) => p.column_class === "col-order-class-5");
    expect(c5?.net_monetary_position).toEqual(ok(145_500_000n));
    expect(c5?.finance_expense).toEqual(ok(-168_300_000n));
  });

  test("non-general template returns not applicable for each period", () => {
    const f = filing({
      template_family: "banks",
      role_codes: ["310017"],
      facts: [
        fact({
          role_code: "310017",
          row_id: "banks_role_310017-row-4",
          column_class: "col-order-class-4",
          period_type: "YTD_CUMULATIVE",
          period_label: "01.01.2026 - 30.06.2026",
          period_start: "2026-01-01",
          period_end: "2026-06-30",
          normalized_value_tl: 100_000n,
        }),
      ],
    });
    const periods = monetaryAndFinanceExpenseByPeriod(f);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.net_monetary_position).toMatchObject({
      status: "not_computable",
      reason: { code: "not_applicable" },
    });
  });
});
