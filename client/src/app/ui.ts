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

/**
 * The signature element. The outer ring is the share of the financial year that has passed; the inner ring
 * is the share of the allocation spent. The gap between them is the whole story, read at a glance.
 */
@Component({
  selector: 'app-rings',
  template: `
    <svg class="rings" [attr.width]="size()" [attr.height]="size()" [attr.viewBox]="'0 0 ' + size() + ' ' + size()" role="img" [attr.aria-label]="label()">
      <g [attr.transform]="'rotate(-90 ' + c() + ' ' + c() + ')'" fill="none" stroke-linecap="round" [attr.stroke-width]="stroke()">
        <circle [attr.cx]="c()" [attr.cy]="c()" [attr.r]="outerR()" stroke="var(--track)" />
        @if (!single()) {
          <circle [attr.cx]="c()" [attr.cy]="c()" [attr.r]="innerR()" stroke="var(--track)" />
        }
        <circle class="ring-draw" [attr.cx]="c()" [attr.cy]="c()" [attr.r]="outerR()" stroke="var(--time)"
          [attr.stroke-dasharray]="len(outerR())" [attr.stroke-dashoffset]="offset(outerR(), elapsed())" [style.--len]="len(outerR()) + 'px'" />
        @if (!single()) {
          <circle class="ring-draw" [attr.cx]="c()" [attr.cy]="c()" [attr.r]="innerR()" [attr.stroke]="spendColour()"
            [attr.stroke-dasharray]="len(innerR())" [attr.stroke-dashoffset]="offset(innerR(), utilization())" [style.--len]="len(innerR()) + 'px'" />
        }
      </g>
      @if (centre()) {
        <text [attr.x]="c()" [attr.y]="c() - 2" text-anchor="middle" class="display" [attr.font-size]="size() / 6.4" font-weight="600" fill="var(--ink)">{{ centre() }}</text>
        <text [attr.x]="c()" [attr.y]="c() + size() / 9" text-anchor="middle" [attr.font-size]="size() / 14" fill="var(--secondary)" font-family="var(--sans)">{{ centreSub() }}</text>
      }
    </svg>
  `,
})
export class PaceRings {
  elapsed = input.required<number>();
  utilization = input(0);
  status = input<string>('on');
  size = input(168);
  /** Time only, for when there is no spending to compare. */
  single = input(false);
  centre = input('');
  centreSub = input('');

  protected c = computed(() => this.size() / 2);
  protected stroke = computed(() => Math.round(this.size() / 11));
  protected outerR = computed(() => this.c() - this.stroke() / 2 - 1);
  protected innerR = computed(() => this.outerR() - this.stroke() - 4);
  protected len = (r: number) => 2 * Math.PI * r;
  protected offset = (r: number, pct: number) => this.len(r) * (1 - Math.min(Math.max(pct, 0), 100) / 100);
  protected spendColour = computed(() => (({ behind: 'var(--behind)', ahead: 'var(--ahead)', over: 'var(--over)' }) as Record<string, string>)[this.status()] ?? 'var(--spent)');
  protected label = computed(() =>
    this.single() ? `${pct(this.elapsed())} of the financial year has passed.` : `${pct(this.elapsed())} of the year passed, ${pct(this.utilization())} of the allocation spent. ${STATUS_WORDS[this.status()] ?? ''}.`,
  );
}

const ICONS: Record<string, string> = {
  overview: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  alerts: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  expenditure: 'M7 3.5h10a1 1 0 0 1 1 1V21l-3-2-3 2-3-2-3 2V4.5a1 1 0 0 1 1-1zM9 8h6M9 11.5h6M9 15h3',
  budgets: 'M3.5 9.5 12 4l8.5 5.5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3.5 20.5h17',
  reports: 'M7 3.5h7l4 4v13H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1zM14 3.5v4h4M9 13h6M9 16.5h6',
  admin: 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6',
  audit: 'M12 7v5l3 2M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z',
};

@Component({
  selector: 'app-icon',
  template: `<svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path()" /></svg>`,
})
export class Icon {
  name = input.required<string>();
  size = input(20);
  protected path = computed(() => ICONS[this.name()] ?? '');
}

/** A pillared building: reads as a public institution without borrowing any official emblem. */
@Component({
  selector: 'app-mark',
  template: `<span class="brand-mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5 12 4.5l8.5 5M6 11v6.5M10 11v6.5M14 11v6.5M18 11v6.5M4 20h16" /></svg></span>`,
})
export class BrandMark {}
