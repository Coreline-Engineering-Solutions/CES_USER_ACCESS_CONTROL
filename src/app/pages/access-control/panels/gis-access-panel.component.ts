import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GisAccessApiService } from '../../../services/gis-access-api.service';
import { SessionService } from '../../../session/session.service';
import { GisProject } from '../../../services/gis-access.types';

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
  imports: [FormsModule],
  templateUrl: './gis-access-panel.component.html',
})
export class GisAccessPanelComponent implements OnInit {
  private readonly api = inject(GisAccessApiService);
  private readonly session = inject(SessionService);

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
  readonly assignFilter = signal('');
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

  readonly filteredAssignable = computed(() => {
    const q = this.assignFilter().trim().toLowerCase();
    const list = this.assignableProjects();
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  });

  ngOnInit(): void {
    void this.load();
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
    this.assignFilter.set('');
    this.assignError.set(null);
    this.showAssignModal.set(true);
  }

  closeAssignModal(): void {
    this.showAssignModal.set(false);
  }

  toggleAssignSelection(name: string): void {
    this.assignSelection.update((set) => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
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
