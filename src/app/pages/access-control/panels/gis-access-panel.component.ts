import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GisAccessApiService } from '../../../services/gis-access-api.service';
import { SessionService } from '../../../session/session.service';
import { DbUsersService } from '../../../services/db-users.service';
import { GisProject } from '../../../services/gis-access.types';
import { PickListComponent } from '../../../ui/picker/pick-list.component';
import { UserPickerComponent } from '../../../ui/picker/user-picker.component';
import { PickItem } from '../../../ui/picker/picker-logic';
import {
  PersonOutcome,
  bulkSummary,
  failedEmails,
  personFailureReason,
  runBulkProjectAssign,
} from './bulk-project-assign';

/**
 * Self-contained access panel for GIS project membership — one entry in
 * PROJECT_REGISTRY (see ../project-registry.ts). Unlike Stock (pick a
 * location, see its grants) and Modules (pick a module, see its grants),
 * the GIS API has no "list users for this project" endpoint — only
 * "list this user's projects" — so this panel is user-centric: look up a
 * person, see and edit what they're in. Binary membership, no role tiers.
 */
@Component({
  selector: 'app-gis-access-panel',
  standalone: true,
  imports: [FormsModule, PickListComponent, UserPickerComponent],
  templateUrl: './gis-access-panel.component.html',
})
export class GisAccessPanelComponent implements OnInit {
  private readonly api = inject(GisAccessApiService);
  private readonly session = inject(SessionService);
  readonly dbUsers = inject(DbUsersService); // template reads dbUsers.users() for the email dropdown

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  /** Gated by GIS System Manager only — CES_NG_GIS itself gates this feature
   *  the same way (menu-bar.component.html: `Project Access` requires
   *  isGisSystemManager()). No per-project manager tier exists yet. */
  readonly canManage = computed(() => this.session.isSystemManager());

  readonly allProjects = signal<GisProject[]>([]);

  readonly lookupEmail = signal('');
  readonly activeEmail = signal('');
  readonly userProjects = signal<GisProject[]>([]);
  readonly userProjectsLoading = signal(false);
  readonly userProjectsError = signal<string | null>(null);

  readonly assignableProjects = computed(() => {
    const held = new Set(this.userProjects().map((p) => p.name));
    return this.allProjects().filter((p) => !held.has(p.name));
  });

  readonly showAssignModal = signal(false);
  readonly assignSelection = signal<Set<string>>(new Set());
  readonly assigning = signal(false);
  readonly assignError = signal<string | null>(null);

  readonly removing = signal<string | null>(null);

  // ─── Project directory (upfront browse) ─────────────────────────────────
  // Shown before any user lookup, so the panel isn't a blank prompt.
  readonly projectSearch = signal('');
  readonly filteredAllProjects = computed<GisProject[]>(() => {
    const q = this.projectSearch().trim().toLowerCase();
    const list = this.allProjects();
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  });

  /** The people the pickers offer: everyone linked to the working database. */
  readonly userItems = computed<PickItem[]>(() =>
    this.dbUsers.users().map((u) => ({ key: u.email, label: u.email })),
  );
  /** Projects this person does not have yet, for the Add projects dialog. */
  readonly assignItems = computed<PickItem[]>(() =>
    this.assignableProjects().map((p) => ({ key: p.name, label: p.name, sub: p.description || undefined })),
  );
  /** Every project, for the bulk dialog. */
  readonly projectItems = computed<PickItem[]>(() =>
    this.allProjects().map((p) => ({ key: p.name, label: p.name, sub: p.description || undefined })),
  );

  ngOnInit(): void {
    void this.load();
    void this.dbUsers.ensureLoaded();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.allProjects.set(await this.api.projectsAll());
    } catch (err: any) {
      console.error('[GisAccessPanel] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load projects');
    } finally {
      this.loading.set(false);
    }
  }

  async lookupUser(): Promise<void> {
    const email = this.lookupEmail().trim();
    if (!email) return;
    this.activeEmail.set(email);
    this.userProjects.set([]);
    this.userProjectsError.set(null);
    this.userProjectsLoading.set(true);
    try {
      this.userProjects.set(await this.api.userProjects(email));
    } catch (err: any) {
      console.error('[GisAccessPanel] user-projects load failed:', err);
      this.userProjectsError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load this user\'s projects');
    } finally {
      this.userProjectsLoading.set(false);
    }
  }

  clearUser(): void {
    this.activeEmail.set('');
    this.lookupEmail.set('');
    this.userProjects.set([]);
    this.userProjectsError.set(null);
  }

  openAssignModal(): void {
    this.assignSelection.set(new Set());
    this.assignError.set(null);
    this.showAssignModal.set(true);
  }

  closeAssignModal(): void {
    this.showAssignModal.set(false);
  }

  async confirmAssign(): Promise<void> {
    const email = this.activeEmail();
    const names = Array.from(this.assignSelection());
    if (!email || names.length === 0) {
      this.assignError.set('Select at least one project.');
      return;
    }
    this.assigning.set(true);
    this.assignError.set(null);
    try {
      const res = await this.api.assignProjects(email, names);
      if (res?.missing?.length) {
        this.assignError.set(`Not found, skipped: ${res.missing.join(', ')}`);
      } else {
        this.showAssignModal.set(false);
      }
      this.userProjects.set(await this.api.userProjects(email));
    } catch (err: any) {
      console.error('[GisAccessPanel] assign failed:', err);
      this.assignError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to assign');
    } finally {
      this.assigning.set(false);
    }
  }

  // ─── Bulk: several people, several projects, one go ─────────────────────
  // The single-person flow above means a lookup, a picker and a check per
  // person. This ticks people and projects in one dialog and sends one
  // assign call per person, a few at a time (see bulk-project-assign.ts).
  readonly showBulkModal = signal(false);
  readonly bulkUsers = signal<Set<string>>(new Set());
  readonly bulkProjects = signal<Set<string>>(new Set());
  readonly bulkRunning = signal(false);
  readonly bulkProgress = signal<{ done: number; total: number } | null>(null);
  readonly bulkOutcomes = signal<PersonOutcome[] | null>(null);
  /** The projects of the run being shown, so a retry sends the same ones. */
  private bulkRunProjects: string[] = [];

  readonly bulkSummaryText = computed(() => {
    const o = this.bulkOutcomes();
    return o ? bulkSummary(o, this.bulkRunProjects.length) : '';
  });
  readonly bulkFailures = computed(() => (this.bulkOutcomes() ?? []).filter((o) => !o.ok));
  readonly bulkMissing = computed(() => {
    const names = new Set<string>();
    for (const o of this.bulkOutcomes() ?? []) for (const m of o.missing) names.add(m);
    return Array.from(names);
  });
  readonly bulkCanRun = computed(
    () => !this.bulkRunning() && this.bulkUsers().size > 0 && this.bulkProjects().size > 0,
  );
  failureReason = personFailureReason;

  openBulkModal(): void {
    this.bulkUsers.set(new Set());
    this.bulkProjects.set(new Set());
    this.bulkOutcomes.set(null);
    this.bulkProgress.set(null);
    this.showBulkModal.set(true);
  }

  closeBulkModal(): void {
    if (this.bulkRunning()) return;
    this.showBulkModal.set(false);
  }

  /** Tick or untick everyone who matches the filter. */
  async runBulk(): Promise<void> {
    if (!this.bulkCanRun()) return;
    this.bulkRunProjects = Array.from(this.bulkProjects());
    await this.runBulkFor(Array.from(this.bulkUsers()));
  }

  /** Send only the people whose call failed, keeping the ones that worked. */
  async retryBulkFailures(): Promise<void> {
    const retry = failedEmails(this.bulkOutcomes() ?? []);
    if (!retry.length || this.bulkRunning()) return;
    const kept = (this.bulkOutcomes() ?? []).filter((o) => o.ok);
    await this.runBulkFor(retry, kept);
  }

  private async runBulkFor(emails: string[], kept: PersonOutcome[] = []): Promise<void> {
    this.bulkRunning.set(true);
    this.bulkProgress.set({ done: 0, total: emails.length });
    try {
      const outcomes = await runBulkProjectAssign(
        emails,
        this.bulkRunProjects,
        (email, names) => this.api.assignProjects(email, names),
        4,
        (done, total) => this.bulkProgress.set({ done, total }),
      );
      this.bulkOutcomes.set([...kept, ...outcomes]);
      // If the person currently looked up was in the run, show their new list.
      const active = this.activeEmail();
      if (active && emails.includes(active)) {
        try { this.userProjects.set(await this.api.userProjects(active)); } catch { /* the lookup panel shows its own error on refresh */ }
      }
    } finally {
      this.bulkRunning.set(false);
      this.bulkProgress.set(null);
    }
  }

  async removeProject(project: GisProject): Promise<void> {
    const email = this.activeEmail();
    if (!email) return;
    this.removing.set(project.name);
    try {
      await this.api.removeProject(email, project.name);
      this.userProjects.update((list) => list.filter((p) => p.name !== project.name));
    } catch (err: any) {
      console.error('[GisAccessPanel] remove failed:', err);
      this.userProjectsError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to remove access');
    } finally {
      this.removing.set(null);
    }
  }
}
