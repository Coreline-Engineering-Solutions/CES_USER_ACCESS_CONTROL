/**
 * The standard client role bundles — GENERATED from CES_ROLE_SEED_SPEC.md
 * (MD docs and folders), which is the source of truth. Do not hand-edit;
 * change the spec and regenerate, so the button and any DB-creation seed
 * produce identical roles.
 *
 * Spec v2, 2026-09-11. Viewer 48 · Planner 84 (Viewer + 36) ·
 * Manager = every privilege in the utility's catalogue except 2.
 *
 * Two privileges are still undecided in the spec (§0.2 `_report_update_sort_order`,
 * §0.3 `_theme_remove`). They appear in NO explicit list below, so they fall
 * to Manager via all-except — the safe default until product decides.
 *
 * Bundles are applied against the AUTH API's role/privilege model — the one
 * every protected endpoint enforces — via ClientRolesService, never the
 * client-local /roles/* tables. See that service's header for why.
 */

export const STANDARD_ROLE_UTILITY = 'GIS System';

/** Never seeded into any bundle, whatever the catalogue says. */
export const NEVER_SEED: ReadonlySet<string> = new Set([
  '_manage_client_roles',
  '_stock_admin',
]);

export type StandardRoleName = 'Viewer' | 'Planner' | 'Manager';

export interface StandardRoleBundle {
  role: StandardRoleName;
  /** One line for the preview. */
  summary: string;
  /**
   * Resolve the privilege set against the live catalogue for the database.
   * Explicit-list bundles ignore the catalogue except to drop names it does
   * not contain (reported as "cannot link"); the all-except bundle IS the
   * catalogue minus exclusions.
   */
  resolve(catalogue: readonly string[]): string[];
}

const VIEWER: readonly string[] = [
  '_existing_projects',
  '_list_all_projects',
  '_list_user_projects',
  '_fetch_available_layers',
  '_fetch_fields',
  '_fetch_field_values',
  '_search',
  '_data_select_project',
  '_data_select_multi_projects',
  '_data_select_global',
  '_fetch_topography_layers',
  '_topography_data_select',
  '_list_attachments',
  '_fetch_attachment_preview',
  '_download_attachment',
  '_fetch_comments',
  '_fetch_preference',
  '_update_preference',
  '_theme_list',
  '_theme_fetch',
  '_theme_fetch_render_order',
  '_report_select_project',
  '_report_select_multi_projects',
  '_report_select_global',
  '_report_sort_order',
  '_report_download_attachment',
  '_report_workflow_read',
  '_save_location',
  '_get_locations',
  '_client_maps_read',
  '_gis_settings_view',
  '_stock_view',
  '_modules_read',
  '_modules_task_read',
  '_modules_subtask_read',
  '_modules_task_column_read',
  '_modules_subtask_column_read',
  '_modules_domain_read',
  '_modules_workflow_read',
  '_modules_types_read',
  '_modules_types_list',
  '_modules_buckets_list',
  '_modules_tasks_list_by_feature',
  '_modules_subtasks_list_by_feature',
  '_modules_tasks_list_by_user',
  '_modules_subtasks_list_by_user',
  '_module_list_attachments',
  '_module_download_attachment',
];

const PLANNER_ADDS: readonly string[] = [
  '_edit_editing_form',
  '_edit_create',
  '_edit_update',
  '_edit_delete',
  '_upload_attachment',
  '_delete_attachment',
  '_add_comment',
  '_delete_comment',
  '_theme_create_private',
  '_theme_update_private',
  '_theme_remove_private',
  '_theme_set_render_order_private',
  '_theme_update',
  '_theme_set_render_order',
  '_report_editing_form',
  '_report_update_field',
  '_report_write',
  '_report_upload_attachment',
  '_report_column_create',
  '_report_column_update',
  '_report_column_delete',
  '_report_workflow_create',
  '_report_workflow_update',
  '_report_workflow_delete',
  '_report_audit',
  '_import_data',
  '_export_data',
  '_conflicts_view',
  '_conflicts_resolve',
  '_modules_task_create',
  '_modules_task_update',
  '_modules_subtask_create',
  '_modules_subtask_update',
  '_module_upload_attachment',
  '_client_maps_create',
  '_client_maps_update',
];

export const STANDARD_ROLE_BUNDLES: readonly StandardRoleBundle[] = [
  {
    role: 'Viewer',
    summary: 'Read everything, change nothing.',
    resolve: () => [...VIEWER],
  },
  {
    role: 'Planner',
    summary: 'Everything Viewer has, plus do the work — full edit including delete.',
    resolve: () => [...VIEWER, ...PLANNER_ADDS],
  },
  {
    role: 'Manager',
    summary: 'Every privilege in the catalogue, except the keys to the kingdom.',
    resolve: (catalogue) => catalogue.filter((p) => !NEVER_SEED.has(p)),
  },
];

/** Names the spec lists explicitly — for the "cannot link" check on the two list bundles. */
export const EXPLICIT_BUNDLE_NAMES: ReadonlySet<string> = new Set([...VIEWER, ...PLANNER_ADDS]);
