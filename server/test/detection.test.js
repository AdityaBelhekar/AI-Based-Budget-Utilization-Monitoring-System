import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_THRESHOLDS, evaluate, mergeThresholds } from '../src/detection.js';
import { croreToPaise } from '../src/money.js';

const FY = '2024-25';
const ALLOC = 1_000_000;
let n = 0;
const tx = (date, amountPaise, over = {}) => ({ id: `t${++n}`, kind: 'expense', amountPaise, date, category: 'Equipment', reversed: false, ...over });
const run = (over) => evaluate({ financialYear: FY, allocatedPaise: ALLOC, asOf: '2024-12-31', transactions: [], ...over });
const types = (findings) => findings.map((f) => `${f.type}:${f.periodKey}`).sort();
const find = (findings, type) => findings.find((f) => f.type === type);

describe('the PRD worked example, 31 December 2024', () => {
  const cases = [
    ['NBS', '45000.00', '40990.68', 'ahead'],
    ['Petroleum', '11925.01', '6879.23', 'behind'],
    ['Food', '205250.01', '163716.30', null],
    ['Urea', '118999.80', '95407.98', null],
  ];
  for (const [name, budget, actual, direction] of cases) {
    test(`${name}: ${direction ? `pace rule fires, ${direction}` : 'pace rule stays quiet'}`, () => {
      const findings = evaluate({
        financialYear: FY,
        allocatedPaise: croreToPaise(budget),
        asOf: '2024-12-31',
        transactions: [tx('2024-12-31', croreToPaise(actual), { kind: 'monthly_summary', category: 'Subsidy' })],
      });
      const pace = find(findings, 'pace_deviation');
      assert.equal(pace?.periodKey ?? null, direction);
      assert.equal(find(findings, 'under_utilization'), undefined, 'the 40%-at-70% rule stays quiet on all four');
    });
  }

  test('Petroleum shows the published gap', () => {
    const [pace] = evaluate({
      financialYear: FY,
      allocatedPaise: croreToPaise('11925.01'),
      asOf: '2024-12-31',
      transactions: [tx('2024-12-31', croreToPaise('6879.23'), { kind: 'monthly_summary' })],
    }).filter((f) => f.type === 'pace_deviation');
    assert.equal(pace.evidence.gapPts, -17.65);
    assert.equal(pace.evidence.elapsedPct, 75.34);
    assert.match(pace.message, /17\.65 points behind pace/);
  });
});

describe('rules', () => {
  test('under-utilization fires below 40% only once 70% of the year has gone', () => {
    const spend = [tx('2024-04-10', 300_000), tx('2024-12-10', 10)];
    assert.ok(find(run({ transactions: spend, asOf: '2024-12-31' }), 'under_utilization'));
    assert.equal(find(run({ transactions: spend, asOf: '2024-11-30' }), 'under_utilization'), undefined);
    assert.equal(find(run({ transactions: [...spend, tx('2024-12-11', 100_000)], asOf: '2024-12-31' }), 'under_utilization'), undefined);
  });

  test('pace waits until the first quarter is over', () => {
    assert.equal(find(run({ asOf: '2024-06-29' }), 'pace_deviation'), undefined);
    assert.equal(find(run({ asOf: '2024-07-15' }), 'pace_deviation').periodKey, 'behind');
  });

  test('overspending warns at 90% and is critical past 100%, which replaces the pace finding', () => {
    const warn = find(run({ transactions: [tx('2024-12-01', 920_000)] }), 'overspending');
    assert.equal(warn.severity, 'medium');
    const over = run({ transactions: [tx('2024-12-01', 1_050_000)] });
    assert.equal(find(over, 'overspending').severity, 'critical');
    assert.equal(find(over, 'pace_deviation'), undefined);
  });

  test('dormant funds: 45 idle days with over a quarter left', () => {
    const findings = run({ transactions: [tx('2024-10-01', 400_000)], asOf: '2024-11-20' });
    const dormant = find(findings, 'dormant');
    assert.equal(dormant.evidence.idleDays, 50);
    assert.equal(dormant.periodKey, 'since-2024-10-01');
    assert.equal(find(run({ transactions: [tx('2024-10-20', 400_000)], asOf: '2024-11-20' }), 'dormant'), undefined);
    assert.equal(find(run({ transactions: [tx('2024-10-01', 800_000)], asOf: '2024-11-20' }), 'dormant'), undefined);
  });

  test('year-end rush: over 33% in January to March, or over 15% in March', () => {
    const q4 = run({ asOf: '2025-03-31', transactions: [tx('2024-05-01', 500_000), tx('2025-01-15', 340_000)] });
    assert.deepEqual(types(q4.filter((f) => f.type === 'year_end_rush')), ['year_end_rush:q4']);
    const march = run({ asOf: '2025-03-31', transactions: [tx('2024-05-01', 600_000), tx('2025-03-20', 160_000)] });
    assert.deepEqual(types(march.filter((f) => f.type === 'year_end_rush')), ['year_end_rush:march']);
    assert.equal(run({ asOf: '2024-12-31', transactions: [tx('2024-12-01', 900_000)] }).filter((f) => f.type === 'year_end_rush').length, 0);
  });

  test('possible duplicate: same amount and category within 7 days, unless reversed', () => {
    const a = tx('2024-11-01', 4_200);
    const b = tx('2024-11-06', 4_200);
    const dup = find(run({ transactions: [a, b, tx('2024-11-07', 4_200, { category: 'Travel' })] }), 'possible_duplicate');
    assert.deepEqual(dup.evidence.transactionIds, [a.id, b.id]);
    assert.equal(find(run({ transactions: [a, tx('2024-11-20', 4_200)] }), 'possible_duplicate'), undefined);
    assert.equal(find(run({ transactions: [a, { ...b, reversed: true }] }), 'possible_duplicate'), undefined);
  });

  test('spike: a month far above its own history', () => {
    const history = ['2023-10', '2023-11', '2023-12', '2024-01', '2024-02', '2024-03'].map((month, i) => ({ month, amountPaise: 1000 + i * 50 }));
    const steady = [tx('2024-04-30', 1100, { kind: 'monthly_summary' }), tx('2024-05-31', 1150, { kind: 'monthly_summary' })];
    const spike = find(run({ allocatedPaise: 100_000_000, history, transactions: [...steady, tx('2024-06-30', 9000, { kind: 'monthly_summary' })] }), 'spike');
    assert.equal(spike.periodKey, 'month-2024-06');
    assert.ok(spike.evidence.z > 3.5);
    assert.equal(find(run({ allocatedPaise: 100_000_000, history, transactions: steady }), 'spike'), undefined);
  });

  test('a March spike is left to the year-end rush rule', () => {
    const history = ['2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12'].map((month, i) => ({ month, amountPaise: 1000 + i * 50 }));
    const march = [tx('2025-03-31', 9000, { kind: 'monthly_summary' })];
    assert.equal(find(run({ allocatedPaise: 1e9, asOf: '2025-03-31', history, transactions: march }), 'spike'), undefined);
  });

  test('spike needs 6 months of history and a spread to compare against', () => {
    const short = [{ month: '2024-03', amountPaise: 100 }];
    assert.equal(find(run({ allocatedPaise: 1e12, history: short, transactions: [tx('2024-04-30', 1e6, { kind: 'monthly_summary' })] }), 'spike'), undefined);
    const flat = ['2023-10', '2023-11', '2023-12', '2024-01', '2024-02', '2024-03'].map((month) => ({ month, amountPaise: 100 }));
    assert.equal(find(run({ allocatedPaise: 1e12, history: flat, transactions: [tx('2024-04-30', 1e6, { kind: 'monthly_summary' })] }), 'spike'), undefined);
  });

  test('a single expense over 10% of the allocation is a spike; a published monthly total is not', () => {
    assert.equal(find(run({ transactions: [tx('2024-08-01', 150_000)] }), 'spike').periodKey.startsWith('txn-'), true);
    assert.equal(find(run({ transactions: [tx('2024-08-01', 150_000, { kind: 'monthly_summary' })] }), 'spike'), undefined);
  });

  test('every finding states its rule, figures and threshold', () => {
    for (const f of run({ transactions: [tx('2024-12-01', 950_000), tx('2024-12-02', 950_000 / 10)] })) {
      assert.ok(f.message.length > 20);
      assert.equal(f.evidence.asOf, '2024-12-31');
    }
  });
});

test('department overrides layer on top of the global thresholds', () => {
  const merged = mergeThresholds({ pace: { maxGapPts: 20 } }, { pace: { startElapsedPct: 30 } });
  assert.deepEqual(merged.pace, { startElapsedPct: 30, maxGapPts: 20 });
  assert.deepEqual(merged.dormant, DEFAULT_THRESHOLDS.dormant);
  assert.equal(DEFAULT_THRESHOLDS.pace.maxGapPts, 15, 'defaults are never mutated');
});
