import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SessionService } from '../../session/session.service';
import { DbUsersService } from '../../services/db-users.service';
import { AdminUsersService, NewUserDraft } from '../../services/admin-users.service';
import { ClientRolesService } from '../../services/client-roles.service';
import {
  NEVER_SEED,
  STANDARD_ROLE_BUNDLES,
  STANDARD_ROLE_UTILITY,
  type StandardRoleName,
} from './standard-role-bundles';
import { ClientRole, UserRoleAssignment } from '../../services/roles.types';
import { AccessProject, PROJECT_REGISTRY } from './project-registry';
import { UserUtilitiesService, utilityKey } from '../../services/user-utilities.service';

/**
 * Tab order mirrors how the page is actually used: assign the user first,
 * then give them project access, then manage the role vocabulary behind it.
 *
 * 'directory' (the old "All access" tab) is gone — it listed the same
 * user->access picture the User assignments tab already shows, so it was two
 * places telling the same story, which invites them to disagree.
 */
type Tab = 'users' | 'projects' | 'roles';

/** One row of the standard-roles preview — everything the operator sees
 *  before anything is written. */
type BundlePreview = {
  role: StandardRoleName;
  summary: string;
  /** 'create' = role missing; 'empty' = exists with no privileges;
   *  'configured' = exists and already has privileges (skipped unless opted in). */
  state: 'create' | 'empty' | 'configured';
  /** Explicitly opted in to ADD missing privileges to a configured role. */
  include: boolean;
  /** Privileges the bundle names that the catalogue does not have. */
  cannotLink: string[];
  /** Already on the role — nothing to do. */
  alreadyLinked: number;
  /** What Apply will actually write. */
  toLink: string[];
  /** Privileges on the role that are NOT in the bundle — shown so the
   *  operator knows what "configured" means; never removed. */
  extra: number;
};

type BundleApplyRow = {
  role: StandardRoleName;
  done: number;
  total: number;
  failed: string[];
  state: 'pending' | 'running' | 'ok' | 'partial' | 'failed';
};

@Component({
  selector: 'app-access-control',
  standalone: true,
  imports: [FormsModule, NgComponentOutlet],
  templateUrl: './access-control.component.html',
})
export class AccessControlComponent implements OnInit {
  readonly userUtils = inject(UserUtilitiesService);
  readonly session = inject(SessionService);
  readonly dbUsers = inject(DbUsersService); // template reads dbUsers.users() for email dropdowns
  private readonly adminUsers = inject(AdminUsersService);
  private readonly clientRoles = inject(ClientRolesService);

  readonly activeTab = signal<Tab>('users');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly canManageRoles = signal(false); // _manage_client_roles — /roles/* writes

  // ─── Projects (dynamic — see project-registry.ts) ───────────────────────
  /**
   * Only the toolsets this manager actually holds.
   *
   * Every panel used to render for every user, so a manager with only Modules
   * still saw Stock Manager and GIS Projects tabs. The grant buttons inside
   * were disabled and the API refused the calls, but the surface was visible —
   * which leaks which systems exist and reads as a broken tool rather than as
   * "not yours". System Managers keep the full list, matching the bypass they
   * get everywhere else.
   *
   * Returns [] while the session is still resolving. accessList and
   * isSystemManager are both populated by validate(), so filtering before it
   * finishes would render every tab and then remove them — a flash of tools
   * the user does not have is worse than a beat of nothing.
   */
  readonly projects = computed<AccessProject[]>(() => {
    if (this.session.loading()) return [];
    if (this.session.isSystemManager()) return PROJECT_REGISTRY;

    const mine = new Set(
      (this.session.accessList() ?? [])
        .map((e: any) => utilityKey(typeof e === 'string' ? e : e?.utility_name ?? e?.name))
        .filter(Boolean),
    );
    return PROJECT_REGISTRY.filter((p) => mine.has(utilityKey(p.utility)));
  });

  /** True once we know the answer and it is "none" — lets the template explain
   *  an empty Projects tab instead of showing a blank panel area. */
  readonly hasNoProjects = computed(
    () => !this.session.loading() && this.projects().length === 0,
  );

  private readonly manualProjectId = signal<string>('');

  /** The chosen panel, falling back to the first one this manager can see.
   *  Without the fallback, a stored/default id that has been filtered out
   *  would leave the tab strip rendered with no panel under it. */
  readonly selectedProjectId = computed<string>(() => {
    const list = this.projects();
    if (list.length === 0) return '';
    const manual = this.manualProjectId();
    return list.some((p) => p.id === manual) ? manual : list[0].id;
  });

  readonly selectedProject = computed<AccessProject | null>(
    () => this.projects().find((p) => p.id === this.selectedProjectId()) ?? null,
  );

  selectProject(id: string): void {
    this.manualProjectId.set(id);
  }

  // ─── Client roles/privileges ────────────────────────────────────────────
  readonly roles = signal<ClientRole[]>([]);
  /** Privilege NAMES from the auth API's `_available_privileges` (the
   *  catalogue AC has always used). The GIS `/roles/privileges/list`
   *  surface this used to read was not pulling anything through and was
   *  not db-specific - see ClientRolesService for why this moved. */
  readonly privileges = signal<string[]>([]);
  readonly privilegesError = signal<string | null>(null);

  /** Roles-tab scaling: filter + collapsed create form, so a db with dozens
   *  of roles stays usable instead of pushing everything off-screen. */
  readonly roleSearch = signal('');
  readonly showCreateRole = signal(false);
  readonly filteredRoles = computed<ClientRole[]>(() => {
    const q = this.roleSearch().trim().toLowerCase();
    const util = this.roleUtilityFilter();
    let list = this.roles();
    // Utility filter first — it is the coarse cut, and the text search should
    // then apply within the chosen system rather than across all of them.
    if (util) {
      const k = utilityKey(util);
      list = list.filter((r) => utilityKey(r.utility_name) === k);
    }
    if (!q) return list;
    return list.filter((r) => r.role_name.toLowerCase().includes(q) || r.utility_name.toLowerCase().includes(q));
  });

  readonly newRoleName = signal('');
  readonly newRoleUtility = signal('GIS System');
  /** Utility filter for the roles table — "swap between systems" without
   *  retyping a search term. '' = show every utility. */
  readonly roleUtilityFilter = signal('');

  /**
   * Options for the Utility dropdowns.
   *
   * Sourced from the platform's own _available_utilities rather than a
   * hardcoded list, so a new CES tool appears here the moment it exists
   * without a frontend change. Utilities already used by roles on THIS
   * database are merged in, so a role created against a utility the auth API
   * no longer returns still shows its own value instead of silently
   * collapsing to the first option.
   */
  readonly utilityOptions = computed<string[]>(() => {
    const seen = new Map<string, string>();
    for (const u of this.userUtils.available()) {
      const k = utilityKey(u);
      if (k && !seen.has(k)) seen.set(k, u);
    }
    for (const r of this.roles()) {
      const name = String(r?.utility_name ?? '').trim();
      const k = utilityKey(name);
      if (k && !seen.has(k)) seen.set(k, name);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  });
  readonly creatingRole = signal(false);
  readonly roleError = signal<string | null>(null);

  // Privilege CREATE removed 3 Sep — the privilege list is defined by the
  // backend and pulled through read-only; UAC links existing privileges to
  // roles, it does not mint new privilege names. See RolesApiService.

  // --- Standard roles per database ---------------------------------------
  //
  // "Set up standard roles": Viewer / Planner / Manager from
  // CES_ROLE_SEED_SPEC.md, linked into the AUTH API's role model for this
  // database. Roughly 300 writes against a client's live access control, so
  // the flow is deliberately slow: preview -> type the db name -> apply
  // with progress. Additive only. Never removes a privilege, never touches
  // a role that already has privileges unless the operator opts that role
  // in explicitly, never grants NEVER_SEED.
  static readonly STANDARD_ROLES: StandardRoleName[] = ['Viewer', 'Planner', 'Manager'];

  /** Visible to _manage_client_roles holders who are ALSO system managers.
   *  A client admin who can edit a role should not necessarily be able to
   *  mint the whole standard set. */
  readonly canSeedStandardRoles = computed(() => this.canManageRoles() && this.session.isSystemManager());

  readonly missingStandardRoles = computed<string[]>(() => {
    const have = new Set(this.roles().map((r) => r.role_name.trim().toLowerCase()));
    return AccessControlComponent.STANDARD_ROLES.filter((n) => !have.has(n.toLowerCase()));
  });

  readonly seedOpen = signal(false);
  readonly seedStep = signal<'preview' | 'confirm' | 'apply' | 'done'>('preview');
  readonly seedLoading = signal(false);
  readonly seedError = signal<string | null>(null);
  readonly seedPreview = signal<BundlePreview[]>([]);
  readonly seedDbName = signal('');
  readonly seedConfirmText = signal('');
  readonly seedApply = signal<BundleApplyRow[]>([]);
  readonly seedApplying = signal(false);

  /** Total writes Apply will make, across every included bundle. */
  readonly seedTotalToLink = computed(() =>
    this.seedPreview().filter((b) => this.seedRowActive(b)).reduce((n, b) => n + b.toLink.length, 0),
  );
  readonly seedRolesToCreate = computed(() =>
    this.seedPreview().filter((b) => b.state === 'create').map((b) => b.role),
  );
  /** What the operator must type. The db name normally; if the session
   *  cannot resolve one, a literal so the flow is not silently unreachable. */
  readonly seedConfirmWord = computed(() => this.seedDbName().trim() || 'CONFIRM');
  readonly seedConfirmMatches = computed(() =>
    this.seedConfirmText().trim().toLowerCase() === this.seedConfirmWord().toLowerCase(),
  );

  /** A preview row Apply will act on: missing/empty roles always; configured only if opted in. */
  seedRowActive(b: BundlePreview): boolean {
    return b.state !== 'configured' || b.include;
  }

  toggleSeedInclude(role: StandardRoleName): void {
    this.seedPreview.update((rows) => rows.map((b) => (b.role === role ? { ...b, include: !b.include } : b)));
  }

  closeSeed(): void {
    if (this.seedApplying()) return;
    this.seedOpen.set(false);
  }

  /** Step 1 — read the catalogue and each role's current privileges, and
   *  show exactly what Apply would do. Nothing is written here. */
  async openSeedStandardRoles(): Promise<void> {
    this.seedOpen.set(true);
    this.seedStep.set('preview');
    this.seedError.set(null);
    this.seedPreview.set([]);
    this.seedApply.set([]);
    this.seedConfirmText.set('');
    this.seedLoading.set(true);
    try {
      const [catalogue, dbName] = await Promise.all([
        this.clientRoles.availablePrivileges(STANDARD_ROLE_UTILITY),
        this.clientRoles.activeDbName(),
      ]);
      this.seedDbName.set(dbName);
      if (catalogue.length === 0) {
        throw new Error('The privilege catalogue for this database came back empty — nothing can be linked.');
      }
      const catalogueSet = new Set(catalogue);
      const existing = new Map(
        this.roles()
          .filter((r) => r.utility_name === STANDARD_ROLE_UTILITY)
          .map((r) => [r.role_name.trim().toLowerCase(), r] as const),
      );

      const rows: BundlePreview[] = [];
      for (const bundle of STANDARD_ROLE_BUNDLES) {
        const wanted = bundle.resolve(catalogue).filter((p) => !NEVER_SEED.has(p));
        const cannotLink = wanted.filter((p) => !catalogueSet.has(p));
        const linkable = wanted.filter((p) => catalogueSet.has(p));

        const role = existing.get(bundle.role.toLowerCase());
        let current: string[] = [];
        if (role) {
          current = await this.clientRoles.rolePrivileges(role.role_name, role.utility_name);
        }
        const currentSet = new Set(current);
        const toLink = linkable.filter((p) => !currentSet.has(p));
        const alreadyLinked = linkable.length - toLink.length;
        const wantedSet = new Set(linkable);
        const extra = current.filter((p) => !wantedSet.has(p)).length;

        rows.push({
          role: bundle.role,
          summary: bundle.summary,
          state: !role ? 'create' : current.length === 0 ? 'empty' : 'configured',
          include: false,
          cannotLink,
          alreadyLinked,
          toLink,
          extra,
        });
      }
      this.seedPreview.set(rows);
    } catch (err: any) {
      console.error('[AccessControl] standard roles preview failed:', err);
      this.seedError.set(err?.message ?? 'Could not build the preview.');
    } finally {
      this.seedLoading.set(false);
    }
  }

  /** Step 2 — nothing happens until the database name is typed back. */
  goSeedConfirm(): void {
    if (this.seedTotalToLink() === 0 && this.seedRolesToCreate().length === 0) return;
    this.seedConfirmText.set('');
    this.seedStep.set('confirm');
  }

  /**
   * Step 3 — create missing roles, then link privileges, bundle by bundle,
   * a few writes in flight at a time. Failures are collected per role and
   * never stop the run; re-opening the preview afterwards shows only what
   * is still missing, so a re-run is the retry.
   */
  async applySeedStandardRoles(): Promise<void> {
    if (!this.seedConfirmMatches() || this.seedApplying()) return;
    const rows = this.seedPreview().filter((b) => this.seedRowActive(b));
    this.seedApply.set(rows.map((b) => ({ role: b.role, done: 0, total: b.toLink.length, failed: [], state: 'pending' })));
    this.seedStep.set('apply');
    this.seedApplying.set(true);
    this.seedError.set(null);

    const patch = (role: StandardRoleName, fn: (r: BundleApplyRow) => BundleApplyRow) =>
      this.seedApply.update((list) => list.map((r) => (r.role === role ? fn(r) : r)));

    try {
      for (const b of rows) {
        patch(b.role, (r) => ({ ...r, state: 'running' }));

        if (b.state === 'create') {
          try {
            await this.clientRoles.createRole(b.role, STANDARD_ROLE_UTILITY);
          } catch (err: any) {
            patch(b.role, (r) => ({ ...r, state: 'failed', failed: [`create role: ${err?.message ?? 'failed'}`] }));
            continue;
          }
        }

        // Belt and braces: the bundles already exclude these, but this is
        // the one place a mistake would grant the role-admin gate itself.
        const queue = b.toLink.filter((p) => !NEVER_SEED.has(p));
        const failed: string[] = [];
        const POOL = 3;
        let i = 0;
        const worker = async () => {
          while (i < queue.length) {
            const priv = queue[i++];
            let ok = false;
            try {
              ok = await this.clientRoles.assignPrivilege(b.role, priv, STANDARD_ROLE_UTILITY);
            } catch {
              ok = false;
            }
            if (!ok) failed.push(priv);
            patch(b.role, (r) => ({ ...r, done: r.done + 1, failed: [...failed] }));
          }
        };
        await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, worker));

        patch(b.role, (r) => ({
          ...r,
          state: failed.length === 0 ? 'ok' : failed.length === queue.length ? 'failed' : 'partial',
        }));
      }
      this.seedStep.set('done');
      await this.load();
    } finally {
      this.seedApplying.set(false);
    }
  }

  readonly seedingRoles = signal(false);
  readonly seedResult = signal<string | null>(null);

  /** The small "Create them" banner: create the missing standard roles
   *  (empty). Linking their privileges is the full flow above. */
  async seedStandardRoles(): Promise<void> {
    const missing = this.missingStandardRoles();
    if (missing.length === 0) return;
    this.seedingRoles.set(true);
    this.seedResult.set(null);
    const created: string[] = [];
    const failed: string[] = [];
    for (const name of missing) {
      try {
        await this.clientRoles.createRole(name, STANDARD_ROLE_UTILITY);
        created.push(name);
      } catch (err: any) {
        console.error('[AccessControl] seed role failed:', name, err);
        failed.push(name);
      }
    }
    await this.load();
    this.seedingRoles.set(false);
    this.seedResult.set(
      failed.length === 0
        ? 'Created ' + created.join(', ') + ' — empty. Use "Set up standard roles" to link their privileges.'
        : 'Created ' + (created.join(', ') || 'none') + '; failed: ' + failed.join(', ') + '.',
    );
  }

  // --- Per-role privilege editor -----------------------------------------
  // A real two-way editor now: `_check_role_privileges` returns what is
  // actually on the role for THIS database, so the checkboxes reflect real
  // state and Save applies the difference (assign what was ticked, remove
  // what was unticked). The earlier blind tick-then-Link/Unlink panel only
  // existed because the GIS /roles/* surface had no per-role read.
  readonly privRoleTarget = signal<ClientRole | null>(null);
  readonly privLinked = signal<Set<string>>(new Set());   // as loaded from the server
  readonly privDraft = signal<Set<string>>(new Set());    // as edited here
  readonly privSearch = signal('');
  readonly privLoading = signal(false);
  readonly privBusy = signal(false);
  readonly privResult = signal<string | null>(null);
  readonly privError = signal<string | null>(null);

  readonly filteredPrivileges = computed<string[]>(() => {
    const q = this.privSearch().trim().toLowerCase();
    const list = this.privileges();
    if (!q) return list;
    return list.filter((n) => n.toLowerCase().includes(q));
  });

  /** Ticked-minus-loaded and loaded-minus-ticked - what Save will actually
   *  send, and what the footer counts so the admin can see the size of the
   *  change before committing it. */
  readonly privToAdd = computed<string[]>(() => {
    const linked = this.privLinked();
    return Array.from(this.privDraft()).filter((n) => !linked.has(n));
  });
  readonly privToRemove = computed<string[]>(() => {
    const draft = this.privDraft();
    return Array.from(this.privLinked()).filter((n) => !draft.has(n));
  });
  readonly privDirty = computed(() => this.privToAdd().length > 0 || this.privToRemove().length > 0);

  async openRolePrivileges(role: ClientRole): Promise<void> {
    this.privRoleTarget.set(role);
    this.privSearch.set('');
    this.privResult.set(null);
    this.privError.set(null);
    this.privLinked.set(new Set());
    this.privDraft.set(new Set());
    this.privLoading.set(true);
    try {
      const linked = await this.clientRoles.rolePrivileges(role.role_name, role.utility_name || 'GIS System');
      this.privLinked.set(new Set(linked));
      this.privDraft.set(new Set(linked));
    } catch (err: any) {
      console.error('[AccessControl] role privileges load failed:', err);
      this.privError.set('Could not load this role\'s current privileges.');
    } finally {
      this.privLoading.set(false);
    }
  }

  closeRolePrivileges(): void {
    this.privRoleTarget.set(null);
  }

  togglePrivilege(name: string): void {
    this.privDraft.update((set) => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  resetPrivilegeDraft(): void {
    this.privDraft.set(new Set(this.privLinked()));
    this.privResult.set(null);
    this.privError.set(null);
  }

  /** Applies only the difference. Each call is reported individually so a
   *  partial failure names the privileges that did not take rather than
   *  rolling back a set of changes that already landed server-side. */
  async saveRolePrivileges(): Promise<void> {
    const role = this.privRoleTarget();
    if (!role) return;
    const add = this.privToAdd();
    const remove = this.privToRemove();
    if (add.length === 0 && remove.length === 0) return;

    const utility = role.utility_name || 'GIS System';
    this.privBusy.set(true);
    this.privError.set(null);
    this.privResult.set(null);
    const failed: string[] = [];
    let added = 0;
    let removed = 0;

    for (const name of add) {
      try {
        if (await this.clientRoles.assignPrivilege(role.role_name, name, utility)) added++;
        else failed.push(name);
      } catch { failed.push(name); }
    }
    for (const name of remove) {
      try {
        if (await this.clientRoles.removePrivilege(role.role_name, name, utility)) removed++;
        else failed.push(name);
      } catch { failed.push(name); }
    }

    // Re-read rather than assuming - the server is the truth about what
    // actually stuck, especially after a partial failure.
    try {
      const linked = await this.clientRoles.rolePrivileges(role.role_name, utility);
      this.privLinked.set(new Set(linked));
      this.privDraft.set(new Set(linked));
    } catch { /* leave the draft as-is; the message below still applies */ }

    this.privBusy.set(false);
    const parts: string[] = [];
    if (added) parts.push('added ' + added);
    if (removed) parts.push('removed ' + removed);
    this.privResult.set(
      failed.length === 0
        ? 'Saved - ' + (parts.join(', ') || 'no change') + ' on ' + role.role_name + '.'
        : 'Saved ' + (parts.join(', ') || 'nothing') + '; failed on: ' + failed.join(', ') + '.',
    );
  }


  // ─── Add a user (create -> link to THIS db -> optional role) ────────────
  // The client admin's own user-management flow, mirroring AC's Users page
  // but scoped: a user created here is always linked to the database this
  // session is currently pointed at (the company the admin belongs to),
  // never to one they pick. Role assignment is offered in the same step
  // because "created but no role" is a dead-end user.
  readonly showAddUser = signal(false);
  readonly newUser = signal<NewUserDraft>({ email: '', first_name: '', last_name: '', username: '', phone: '' });
  readonly newUserRoleGid = signal('');
  readonly creatingUser = signal(false);
  readonly createUserError = signal<string | null>(null);
  readonly createUserSteps = signal<string[]>([]);

  openAddUser(): void {
    this.newUser.set({ email: '', first_name: '', last_name: '', username: '', phone: '' });
    this.newUserRoleGid.set('');
    this.createUserError.set(null);
    this.createUserSteps.set([]);
    this.showAddUser.set(true);
  }

  closeAddUser(): void {
    this.showAddUser.set(false);
  }

  patchNewUser(patch: Partial<NewUserDraft>): void {
    this.newUser.update((u) => ({ ...u, ...patch }));
  }

  /**
   * Create -> link to the active db -> (optionally) assign a role, in that
   * order, reporting each step as it lands. Deliberately not all-or-nothing:
   * if the db link fails after the user was created, the user still exists
   * and the admin is told exactly which step failed, rather than seeing one
   * generic failure for a partially-completed sequence.
   */
  async submitAddUser(): Promise<void> {
    const draft = this.newUser();
    const email = draft.email.trim();
    if (!email) {
      this.createUserError.set('Email is required.');
      return;
    }

    this.creatingUser.set(true);
    this.createUserError.set(null);
    this.createUserSteps.set([]);
    const step = (msg: string) => this.createUserSteps.update((l) => [...l, msg]);

    try {
      const dbGid = await this.adminUsers.activeDbGid();
      if (!dbGid) {
        this.createUserError.set('Could not determine the active database — switch to a database first, then try again.');
        return;
      }

      const created = await this.adminUsers.createUser({ ...draft, email });
      if (!created.ok) {
        this.createUserError.set(created.detail ?? 'Failed to create the user.');
        return;
      }
      step(`User ${email} created.`);

      const linked = await this.adminUsers.assignUserToDb(email, dbGid);
      if (!linked) {
        this.createUserError.set(
          'The user was created but could not be linked to this database. Link them from the Databases screen, or retry.',
        );
        return;
      }
      step('Linked to this database.');

      const roleGid = this.newUserRoleGid();
      if (roleGid) {
        try {
          const target = this.roles().find((r) => r.role_gid === roleGid);
          const { utility, role } = target
            ? { utility: target.utility_name, role: target.role_name }
            : ClientRolesService.parseRoleKey(roleGid);
          if (!(await this.clientRoles.assignUserRole(email, role, utility))) {
            throw new Error('The auth API did not confirm the role assignment.');
          }
          step(`Assigned ${role}.`);
        } catch (err: any) {
          this.createUserError.set(
            `User created and linked, but the role could not be assigned: ${err?.response?.data?.detail ?? err?.message ?? 'unknown error'}`,
          );
          return;
        }
      }

      await Promise.all([this.dbUsers.reload(), this.load()]);
      setTimeout(() => this.showAddUser.set(false), 900);
    } catch (err: any) {
      console.error('[AccessControl] add user failed:', err);
      this.createUserError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to add the user.');
    } finally {
      this.creatingUser.set(false);
    }
  }

  // --- Users on this database, with their roles ---------------------------
  // /roles/users/list only carries user_gid, which on its own is unusable in
  // a UI ("who is 3f2a8c1e?"). DbUsersService has the gid->email mapping for
  // this db, so join them here: every db-linked user, their assigned roles,
  // and a revoke that no longer needs the admin to retype the email to prove
  // who they meant.
  // ─── Toolsets (CES_WEB dashboard access) ─────────────────────────────────
  //
  // Granting someone module/stock/GIS access from the Projects tab gives them
  // permission INSIDE a tool. It does not give them the tool: the dashboard
  // builds its tiles from the auth API's utility_list, so without a utility
  // row the user has access to something they can neither see nor reach.
  // This is where that row gets created.
  //
  // The dropdown is fed by UserUtilitiesService.assignable(), which is the
  // manager's OWN toolsets intersected with the platform list — a manager can
  // only ever hand out what they hold themselves. The service re-checks on
  // write, because a filtered dropdown is a convenience, not a boundary.

  /** email -> utilities currently granted. */
  readonly userToolsets = signal<Record<string, string[]>>({});
  /** email -> the toolset picked in that row's dropdown. */
  readonly toolsetPick = signal<Record<string, string>>({});
  /** email::utility currently being written, to disable just that control. */
  readonly toolsetBusy = signal<string>('');
  /** The user whose access modal is open ('' = closed).
   *
   *  Access lives in a modal rather than in the table. Inline pills read fine
   *  for two tools and fall apart at ten: the column either stretches and
   *  pushes Actions off the edge, or stays narrow and stacks every pill onto
   *  its own line, making one user twelve rows tall. The table now carries a
   *  count, and the detail — plus every add/remove control — opens on
   *  demand. */
  readonly accessModalEmail = signal<string>('');
  readonly toolsetError = signal<string | null>(null);

  toolsetsFor(email: string): string[] {
    return this.userToolsets()[email] ?? [];
  }

  /** Toolsets this manager can still add to that user (already-granted removed). */
  addableToolsetsFor(email: string): string[] {
    const has = new Set(this.toolsetsFor(email).map(utilityKey));
    return this.userUtils.assignable().filter((u) => !has.has(utilityKey(u)));
  }

  pickToolset(email: string, utility: string): void {
    this.toolsetPick.update((m) => ({ ...m, [email]: utility }));
  }

  openAccessModal(email: string): void {
    this.toolsetError.set(null);
    this.accessModalEmail.set(email);
    // The platform utility list is only needed to populate the picker, which
    // only exists inside this modal — so it is fetched here rather than on
    // page load. loadAvailable() caches, so reopening costs nothing.
    void this.userUtils.loadAvailable();
    void this.loadToolsetsFor(email);
  }

  closeAccessModal(): void {
    this.accessModalEmail.set('');
  }

  /** The table row for the user whose modal is open — gives the modal their
   *  roles as well as their toolsets, so it is one place to read access. */
  readonly accessModalRow = computed(() => {
    const email = this.accessModalEmail();
    if (!email) return null;
    return this.userRows().find((r) => r.email === email) ?? null;
  });

  /** True while one user's toolsets are being fetched for the modal. */
  readonly toolsetsLoading = signal(false);

  /**
   * Load ONE user's toolsets, on demand.
   *
   * This used to fan out with Promise.all across every user on the database
   * — 19 users meant 19 simultaneous POSTs to the auth API on every page
   * load, on top of _available_utilities, /auth/db/current and
   * /auth/access. That is the auth service EVERY CES app validates its
   * sessions against, so saturating it did not just slow this page down: it
   * timed out session checks platform-wide and signed people out of other
   * tools entirely. The empty-list retry added for the sign-out fix then
   * doubled /auth/access under exactly the load that caused it — the same
   * self-amplifying shape as a retry storm.
   *
   * Nobody needs 19 users' toolsets to look at one. The modal is the only
   * place the detail is shown, so the fetch belongs there: one call, when
   * asked for.
   */
  private async loadToolsetsFor(email: string): Promise<void> {
    if (!email) return;
    this.toolsetsLoading.set(true);
    try {
      const list = await this.userUtils.utilitiesFor(email);
      this.userToolsets.update((m) => ({ ...m, [email]: list }));
    } catch (e: any) {
      this.toolsetError.set(e?.message ?? 'Could not load this user\'s toolsets.');
    } finally {
      this.toolsetsLoading.set(false);
    }
  }

  async grantToolset(email: string): Promise<void> {
    const utility = (this.toolsetPick()[email] ?? '').trim();
    if (!utility) return;
    this.toolsetError.set(null);
    this.toolsetBusy.set(`${email}::${utility}`);
    try {
      const ok = await this.userUtils.assign(email, utility);
      if (!ok) throw new Error('The auth API did not confirm the change.');
      // Optimistic local update — a full reload of every user's utilities to
      // reflect one grant is a lot of round trips for a known outcome.
      this.userToolsets.update((m) => ({
        ...m,
        [email]: [...(m[email] ?? []), utility],
      }));
      // Modal stays open — granting several toolsets in a row is the common
      // case, and closing after each one would make that tedious.
      this.toolsetPick.update((m) => ({ ...m, [email]: '' }));
    } catch (e: any) {
      this.toolsetError.set(e?.message ?? `Could not grant ${utility} to ${email}.`);
    } finally {
      this.toolsetBusy.set('');
    }
  }

  async revokeToolset(email: string, utility: string): Promise<void> {
    this.toolsetError.set(null);
    this.toolsetBusy.set(`${email}::${utility}`);
    try {
      const ok = await this.userUtils.remove(email, utility);
      if (!ok) throw new Error('The auth API did not confirm the change.');
      this.userToolsets.update((m) => ({
        ...m,
        [email]: (m[email] ?? []).filter((u) => utilityKey(u) !== utilityKey(utility)),
      }));
    } catch (e: any) {
      this.toolsetError.set(e?.message ?? `Could not revoke ${utility} from ${email}.`);
    } finally {
      this.toolsetBusy.set('');
    }
  }

  isToolsetBusy(email: string, utility: string): boolean {
    return this.toolsetBusy() === `${email}::${utility}`;
  }

  readonly userRows = computed(() => {
    // Assignments from the auth API are keyed by EMAIL (user_gid carries
    // it) - which is also the one field every user source here agrees on.
    const rolesByEmail = new Map<string, UserRoleAssignment[]>();
    for (const a of this.assignments()) {
      const key = String(a.user_email ?? a.user_gid ?? '').toLowerCase();
      const list = rolesByEmail.get(key) ?? [];
      list.push(a);
      rolesByEmail.set(key, list);
    }
    return this.dbUsers.users().map((u) => ({
      email: u.email,
      user_gid: u.user_gid,
      roles: rolesByEmail.get(String(u.email ?? '').toLowerCase()) ?? [],
    }));
  });

  /** Assignments whose user_gid matches nobody linked to this db - surfaced
   *  separately rather than hidden, since a role still assigned to someone
   *  no longer on the database is exactly what an access review needs to
   *  see. */
  readonly orphanAssignments = computed<UserRoleAssignment[]>(() => {
    const known = new Set(this.dbUsers.users().map((u) => String(u.email ?? '').toLowerCase()));
    return this.assignments().filter((a) => !known.has(String(a.user_email ?? a.user_gid ?? '').toLowerCase()));
  });

  /** Revoke straight from a user row - the email is already known here, so
   *  no confirm-by-retyping step (that modal only exists because the raw
   *  assignments list has no email to work from). */
  readonly rowRevoking = signal<string>('');

  async revokeRoleFromUser(email: string, a: UserRoleAssignment): Promise<void> {
    this.rowRevoking.set(email + '::' + a.role_gid);
    try {
      const utility = a.utility_name || ClientRolesService.parseRoleKey(a.role_gid).utility;
      if (!(await this.clientRoles.removeUserRole(email, a.role_name, utility))) {
        throw new Error('The auth API did not confirm the revoke.');
      }
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] revoke role failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke role');
    } finally {
      this.rowRevoking.set('');
    }
  }

  /** Pre-fills the assign form below the table for one user. */
  assignRoleTo(email: string): void {
    this.assignEmail.set(email);
  }

  // ─── User-role assignments ──────────────────────────────────────────────
  readonly assignments = signal<UserRoleAssignment[]>([]);
  readonly assignEmail = signal('');
  readonly assignRoleGid = signal('');
  readonly assigning = signal(false);
  readonly assignError = signal<string | null>(null);

  readonly checkPrivilegeInput = signal('');
  readonly checkResult = signal<string | null>(null);
  readonly checking = signal(false);

  /**
   * /roles/users/list returns user_gid (no email); /roles/users/revoke
   * requires user_email. There's no gid→email lookup in this API surface,
   * so revoke needs the admin to re-enter the email rather than silently
   * sending an empty one.
   */
  readonly revokeAssignmentTarget = signal<UserRoleAssignment | null>(null);
  readonly revokeAssignmentEmail = signal('');
  readonly revokingAssignment = signal(false);
  readonly revokeAssignmentError = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
    void this.session.hasPrivilege('_manage_client_roles').then((v) => this.canManageRoles.set(v));
    // Toolsets are NOT loaded here. See loadToolsetsFor() — doing it per user
    // on page load put ~20 simultaneous requests on the shared auth service
    // and took session validation down platform-wide.
    void this.dbUsers.ensureLoaded();
  }

  setTab(t: Tab): void {
    this.activeTab.set(t);
    // Only the roles tab needs the utility catalogue, and loadAvailable()
    // caches — so this stays one request, made when it is actually used
    // rather than on every page load (see the auth-load fix in 36e02d8).
    if (t === 'roles') void this.userUtils.loadAvailable();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      // Roles and assignments come from the AUTH API - the system every
      // endpoint actually enforces. The client-local /roles/* list this used
      // to read showed roles that gated nothing (see ClientRolesService).
      // Roles are per utility; ask for each utility this user holds, plus
      // GIS System always, since that is where every privilege lives.
      const utilities = Array.from(new Set(['GIS System', ...this.userUtils.available()]));
      const [roles, privNames] = await Promise.all([
        this.clientRoles.listRoles(utilities),
        this.clientRoles.availablePrivileges('GIS System').catch((err) => {
          console.error('[AccessControl] privilege catalogue failed:', err);
          this.privilegesError.set('Could not load the privilege list from the auth API.');
          return [] as string[];
        }),
      ]);
      const assignments = await this.clientRoles.listAssignments(roles);
      this.roles.set(roles);
      this.privileges.set(privNames);
      this.assignments.set(assignments);
    } catch (err: any) {
      console.error('[AccessControl] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load access control data');
    } finally {
      this.loading.set(false);
    }
  }

  // ─── Client roles/privileges ─────────────────────────────────────────────

  async createRole(): Promise<void> {
    const name = this.newRoleName().trim();
    if (!name) {
      this.roleError.set('Role name is required.');
      return;
    }
    this.creatingRole.set(true);
    this.roleError.set(null);
    try {
      await this.clientRoles.createRole(name, this.newRoleUtility().trim() || 'GIS System');
      this.newRoleName.set('');
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] role create failed:', err);
      this.roleError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to create role');
    } finally {
      this.creatingRole.set(false);
    }
  }

  /**
   * Deleting a role has no Auth-API function yet. The old path deleted the
   * client-local row, which removed it from this list while the enforced
   * role (and everyone holding it) stayed exactly as it was - a delete that
   * looked done and was not. Better to say so than pretend. Revoke the
   * role's privileges and users instead; ask backend for `/role/delete`.
   */
  async deleteRole(role: ClientRole): Promise<void> {
    this.error.set(
      `Removing "${role.role_name}" is not supported by the auth API yet. Clear its privileges and revoke it from users instead - ` +
      `that is what actually changes access. (Backend: a /role/delete route is needed.)`,
    );
  }



  // ─── User-role assignments ────────────────────────────────────────────────

  async assignRole(): Promise<void> {
    const email = this.assignEmail().trim();
    if (!email || !this.assignRoleGid()) {
      this.assignError.set('User email and role are required.');
      return;
    }
    this.assigning.set(true);
    this.assignError.set(null);
    try {
      const target = this.roles().find((r) => r.role_gid === this.assignRoleGid());
      const { utility, role } = target
        ? { utility: target.utility_name, role: target.role_name }
        : ClientRolesService.parseRoleKey(this.assignRoleGid());
      if (!(await this.clientRoles.assignUserRole(email, role, utility))) {
        throw new Error('The auth API did not confirm the role assignment.');
      }
      this.assignEmail.set('');
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] user role assign failed:', err);
      this.assignError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to assign role');
    } finally {
      this.assigning.set(false);
    }
  }

  openRevokeAssignment(a: UserRoleAssignment): void {
    this.revokeAssignmentTarget.set(a);
    this.revokeAssignmentEmail.set('');
    this.revokeAssignmentError.set(null);
  }

  closeRevokeAssignment(): void {
    this.revokeAssignmentTarget.set(null);
  }

  async confirmRevokeAssignment(): Promise<void> {
    const a = this.revokeAssignmentTarget();
    const email = this.revokeAssignmentEmail().trim();
    if (!a) return;
    if (!email) {
      this.revokeAssignmentError.set("Enter the user's email to confirm.");
      return;
    }
    this.revokingAssignment.set(true);
    this.revokeAssignmentError.set(null);
    try {
      const utility = a.utility_name || ClientRolesService.parseRoleKey(a.role_gid).utility;
      if (!(await this.clientRoles.removeUserRole(email, a.role_name, utility))) {
        throw new Error('The auth API did not confirm the revoke.');
      }
      this.revokeAssignmentTarget.set(null);
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] user role revoke failed:', err);
      this.revokeAssignmentError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke role');
    } finally {
      this.revokingAssignment.set(false);
    }
  }

  async runCheck(): Promise<void> {
    const priv = this.checkPrivilegeInput().trim();
    if (!priv) return;
    this.checking.set(true);
    this.checkResult.set(null);
    try {
      // _check_function_permission on the auth API - the exact call every
      // protected endpoint makes. The client-local /roles/check-permission
      // this used to hit answers from tables nothing enforces.
      const granted = await this.clientRoles.checkFunctionPermission(priv, 'GIS System');
      this.checkResult.set(granted ? 'Granted' : 'Not granted');
    } catch (err: any) {
      console.error('[AccessControl] permission check failed:', err);
      this.checkResult.set('Check failed');
    } finally {
      this.checking.set(false);
    }
  }
}
