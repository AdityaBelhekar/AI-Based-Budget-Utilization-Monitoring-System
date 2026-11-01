import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

interface Summary {
  financialYear: string;
  dayOfYear: number;
  daysInYear: number;
  elapsedPct: number;
}

@Component({
  selector: 'app-overview',
  template: `
    @if (summary(); as s) {
      <h1>Financial year {{ s.financialYear }}</h1>
      <p>Day {{ s.dayOfYear }} of {{ s.daysInYear }}, so <span class="figure">{{ s.elapsedPct.toFixed(2) }}%</span> of the year has passed.</p>
      <div class="pace" role="img" [attr.aria-label]="s.elapsedPct.toFixed(2) + '% of the financial year has passed'">
        <span class="pace-mark" [style.left.%]="s.elapsedPct"></span>
      </div>
      <p class="muted">No budgets are recorded for {{ s.financialYear }} yet, so there is nothing to compare against the year's progress.</p>
    }
  `,
})
export class Overview {
  protected summary = toSignal(inject(HttpClient).get<Summary>('/api/dashboard/summary'));
}
