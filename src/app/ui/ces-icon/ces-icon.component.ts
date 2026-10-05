import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { CES_ICONS } from './ces-icons';

/**
 * `<ces-icon name="lock" />` - one Lucide icon from the shared set.
 *
 * Sized by the surrounding font-size (1em) and coloured by `color`
 * (currentColor), so it drops in wherever a legacy glyph used to
 * sit: the existing `font-size` / `color` rules keep working on the host.
 * Decorative by default (aria-hidden); put an aria-label on the control that
 * wraps it, as before.
 */
@Component({
  selector: 'ces-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    [innerHTML]="markup()"
  ></svg>`,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1em;
        height: 1em;
        flex: none;
        line-height: 1;
        vertical-align: middle;
      }
      svg {
        width: 100%;
        height: 100%;
        display: block;
      }
    `
  ],
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()'
  }
})
export class CesIconComponent {
  private readonly sanitizer = inject(DomSanitizer);

  /** Lucide icon name, e.g. `circle-alert` - must exist in ces-icons.ts. */
  readonly name = input.required<string>();

  /** Optional pixel size; omit to follow the surrounding font-size (1em). */
  readonly size = input<number | null>(null);

  protected readonly markup = computed<SafeHtml>(() => {
    const inner = CES_ICONS[this.name()];
    if (inner === undefined) {
      console.warn(`[ces-icon] unknown icon "${this.name()}" - add it to ces-icons.ts`);
      return '';
    }
    // Static markup from our own registry (lucide-static), never user input.
    return this.sanitizer.bypassSecurityTrustHtml(inner);
  });
}
