import { Component, computed, input, output } from '@angular/core';
import { MonthState } from './api';
import { financialYears, monthLong, monthShort, pct, signedPts, STATUS_WORDS } from './format';

/**
 * Spending against time. Grey up to what was spent; the gap between spending and the
 * time-elapsed mark carries the colour, and only once it passes the department's limit.
 */
@Component({
  selector: 'app-pace',
  template: `
    <div class="pace" [class.large]="large()" role="img" [attr.aria-label]="label()">
      @for (seg of segments(); track seg.kind) {
        <div [class]="'pace-seg ' + seg.kind" [style.clip-path]="seg.clip"></div>
      }
      <div class="pace-mark" [style.left.%]="elapsed()"></div>
    </div>
  `,
})
export class PaceBar {
  utilization = input.required<number>();
  elapsed = input.required<number>();
  status = input.required<string>();
  large = input(false);

  protected segments = computed(() => {
    const u = Math.min(this.utilization(), 100);
    const e = this.elapsed();
    // The notch keeps adjacent segments apart even where their colours are close in lightness.
    const clip = (from: number, to: number, notch = false) => `inset(0 ${100 - to}% 0 calc(${from}% + ${notch ? 'var(--notch)' : '0px'}))`;
    switch (this.status()) {
      case 'behind':
        return [
          { kind: 'spent', clip: clip(0, u) },
          { kind: 'behind', clip: clip(u, e, u > 0) },
        ];
      case 'ahead':
        return [
          { kind: 'spent', clip: clip(0, e) },
          { kind: 'ahead', clip: clip(e, u, true) },
        ];
      case 'over':
        return [
          { kind: 'spent', clip: clip(0, e) },
          { kind: 'over', clip: clip(e, 100, true) },
        ];
      default:
        return [{ kind: 'spent', clip: clip(0, u) }];
    }
  });

  protected label = computed(
    () =>
      `${pct(this.utilization())} used, ${pct(this.elapsed())} of the year passed. ${STATUS_WORDS[this.status()] ?? ''}, ${signedPts(this.utilization() - this.elapsed())} points.`,
  );
}

@Component({
  selector: 'app-status',
  template: `<span [class]="'status ' + value()">{{ text() }}</span>`,
})
export class StatusWord {
  value = input.required<string>();
  protected text = computed(() => STATUS_WORDS[this.value()] ?? this.value()[0].toUpperCase() + this.value().slice(1));
}

/** The 12 months of the financial year, April first. Months not yet reached cannot be chosen. */
@Component({
  selector: 'app-months',
  template: `
    <div class="months" role="group" aria-label="Month to view">
      @for (m of months(); track m.month) {
        <button
          type="button"
          [disabled]="!m.available"
          [attr.aria-pressed]="m.month === selected()"
          [attr.aria-label]="monthLong(m.month) + (m.available ? '' : ', not yet reached')"
          (click)="pick.emit(m.month)"
        >
          {{ monthShort(m.month) }}
        </button>
      }
    </div>
  `,
})
export class MonthStrip {
  months = input.required<MonthState[]>();
  selected = input.required<string>();
  pick = output<string>();
  protected monthShort = monthShort;
  protected monthLong = monthLong;
}

@Component({
  selector: 'app-year',
  template: `
    <div class="field-inline">
      <label for="fy">Financial year</label>
      <select id="fy" (change)="pick.emit($any($event.target).value)">
        @for (fy of years; track fy) {
          <option [value]="fy" [selected]="fy === value()">{{ fy }}</option>
        }
      </select>
    </div>
  `,
})
export class YearPicker {
  value = input.required<string>();
  pick = output<string>();
  protected years = financialYears();
}
