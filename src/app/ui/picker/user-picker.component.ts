import { Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { PickItem, capList, filterItems, stepIndex } from './picker-logic';

/** A long list is cut here so opening the picker is instant; typing narrows it. */
const MAX_VISIBLE = 80;

let nextId = 0;

/**
 * A type-to-search replacement for a plain dropdown of people (or anything
 * long). Click it, start typing, pick with the mouse or Up / Down / Enter.
 *
 * `[value]="email()" (valueChange)="email.set($event)"`. An empty string means
 * nothing is chosen.
 */
@Component({
  selector: 'ces-user-picker',
  standalone: true,
  template: `
    <div class="up" [class.open]="open()">
      <input
        class="inp up-input"
        type="text"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="listId"
        [attr.aria-activedescendant]="open() && active() >= 0 ? listId + '-' + active() : null"
        [attr.aria-label]="ariaLabel() || placeholder()"
        [placeholder]="selectedLabel() || placeholder()"
        [disabled]="disabled()"
        [value]="open() ? query() : selectedLabel()"
        (focus)="openList()"
        (click)="openList()"
        (input)="onType($any($event.target).value)"
        (keydown)="onKey($event)"
        (blur)="closeList()"
      />
      @if (value() && !disabled()) {
        <button type="button" class="up-clear" aria-label="Clear selection" (mousedown)="$event.preventDefault()" (click)="choose('')">✕</button>
      }
      @if (open()) {
        <div class="up-list" role="listbox" [id]="listId">
          @for (item of visible().visible; track item.key; let i = $index) {
            <div
              class="up-opt"
              role="option"
              [id]="listId + '-' + i"
              [class.active]="i === active()"
              [class.chosen]="item.key === value()"
              [attr.aria-selected]="item.key === value()"
              (mousedown)="$event.preventDefault()"
              (click)="choose(item.key)"
              (mouseenter)="active.set(i)"
            >
              <span>{{ item.label }}</span>
              @if (item.sub) {
                <span class="up-sub">{{ item.sub }}</span>
              }
            </div>
          } @empty {
            <div class="up-none">No match{{ query().trim() ? ' for "' + query().trim() + '"' : '' }}.</div>
          }
          @if (visible().hidden > 0) {
            <div class="up-more">{{ visible().hidden }} more. Keep typing to narrow it.</div>
          }
        </div>
      }
    </div>
  `,
})
export class UserPickerComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly options = input.required<readonly PickItem[]>();
  readonly value = input('');
  readonly valueChange = output<string>();
  readonly placeholder = input('Search people…');
  readonly ariaLabel = input('');
  readonly disabled = input(false);

  readonly listId = `up-list-${nextId++}`;
  readonly open = signal(false);
  readonly query = signal('');
  readonly active = signal(0);

  readonly filtered = computed(() => filterItems(this.options(), this.query()));
  readonly visible = computed(() => capList(this.filtered(), MAX_VISIBLE));
  readonly selectedLabel = computed(() => this.options().find((o) => o.key === this.value())?.label ?? '');

  openList(): void {
    if (this.disabled() || this.open()) return;
    this.query.set('');
    // start on the chosen row, so reopening lands where you were
    const at = this.options().findIndex((o) => o.key === this.value());
    this.active.set(at >= 0 && at < MAX_VISIBLE ? at : 0);
    this.open.set(true);
  }

  closeList(): void {
    this.open.set(false);
    this.query.set('');
  }

  onType(text: string): void {
    this.query.set(text);
    this.active.set(0);
    this.open.set(true);
  }

  choose(key: string): void {
    this.valueChange.emit(key);
    this.closeList();
  }

  onKey(event: KeyboardEvent): void {
    const rows = this.visible().visible;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.open()) this.openList();
        else this.active.set(stepIndex(this.active(), 1, rows.length));
        this.scrollActiveIntoView();
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.active.set(stepIndex(this.active(), -1, rows.length));
        this.scrollActiveIntoView();
        break;
      case 'Enter':
        if (this.open() && rows[this.active()]) {
          event.preventDefault();
          this.choose(rows[this.active()].key);
        }
        break;
      case 'Escape':
        if (this.open()) {
          event.preventDefault();
          event.stopPropagation();
          this.closeList();
        }
        break;
      case 'Tab':
        this.closeList();
        break;
    }
  }

  private scrollActiveIntoView(): void {
    queueMicrotask(() => {
      const el = (this.host.nativeElement as HTMLElement).querySelector(`#${this.listId}-${this.active()}`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  }
}
