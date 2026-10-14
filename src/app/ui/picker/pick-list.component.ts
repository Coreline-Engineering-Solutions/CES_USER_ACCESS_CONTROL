import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  PickItem,
  allShownSelected,
  filterItems,
  selectionSummary,
  setShown,
  toggleKey,
} from './picker-logic';

/**
 * A searchable list you tick items in: the same control for projects, people,
 * anything. Search narrows the list, "Select all" ticks what the search is
 * showing, and ticks you made earlier are never lost by searching.
 *
 * Rows are painted lazily by the browser (`content-visibility`), so a list of
 * a few thousand people stays quick.
 *
 * The parent owns the selection and passes it back in, so it stays the single
 * source of truth: `[selected]="set()" (selectedChange)="set.set($event)"`.
 */
@Component({
  selector: 'ces-pick-list',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="pick">
      <div class="pick-tools">
        <input
          class="inp pick-search"
          type="search"
          autocomplete="off"
          [ngModel]="query()"
          (ngModelChange)="query.set($event)"
          [placeholder]="searchPlaceholder()"
          [attr.aria-label]="searchPlaceholder()"
        />
        <button type="button" class="btn" (click)="selectShown()" [disabled]="disabled() || shown().length === 0 || everyShownTicked()">
          Select all{{ query().trim() ? ' shown' : '' }} ({{ shown().length }})
        </button>
        <button type="button" class="btn" (click)="clearAll()" [disabled]="disabled() || selected().size === 0">Clear</button>
      </div>
      <div class="pick-summary" aria-live="polite">{{ summary() }}</div>
      <div class="pick-list" role="listbox" aria-multiselectable="true" [attr.aria-label]="noun()">
        @for (item of shown(); track item.key) {
          <label class="pick-row" [class.on]="selected().has(item.key)" role="option" [attr.aria-selected]="selected().has(item.key)">
            <input type="checkbox" [checked]="selected().has(item.key)" [disabled]="disabled()" (change)="toggle(item.key)" />
            <span class="pick-label">{{ item.label }}</span>
            @if (item.sub) {
              <span class="pick-sub">{{ item.sub }}</span>
            }
          </label>
        } @empty {
          <div class="pick-empty">
            @if (query().trim()) {
              No {{ noun() }} match "{{ query().trim() }}".
            } @else {
              {{ emptyText() }}
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class PickListComponent {
  readonly items = input.required<readonly PickItem[]>();
  readonly selected = input<ReadonlySet<string>>(new Set<string>());
  readonly selectedChange = output<Set<string>>();
  /** Plural, for the summary and the empty message: "projects", "people". */
  readonly noun = input('items');
  readonly searchPlaceholder = input('Search…');
  readonly emptyText = input('Nothing to show.');
  readonly disabled = input(false);

  readonly query = signal('');
  readonly shown = computed(() => filterItems(this.items(), this.query()));
  readonly everyShownTicked = computed(() => allShownSelected(this.selected(), this.shown()));
  readonly summary = computed(() =>
    selectionSummary(this.selected().size, this.shown().length, this.items().length, this.noun()),
  );

  toggle(key: string): void {
    if (this.disabled()) return;
    this.selectedChange.emit(toggleKey(this.selected(), key));
  }

  selectShown(): void {
    this.selectedChange.emit(setShown(this.selected(), this.shown(), true));
  }

  clearAll(): void {
    this.selectedChange.emit(new Set<string>());
  }
}
