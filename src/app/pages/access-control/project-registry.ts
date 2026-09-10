import { Type } from '@angular/core';
import { StockAccessPanelComponent } from './panels/stock-access-panel.component';
import { ModulesAccessPanelComponent } from './panels/modules-access-panel.component';
import { GisAccessPanelComponent } from './panels/gis-access-panel.component';

/**
 * One entry per project/tool this client can grant access to. This is the
 * whole point of the registry: adding a new project (e.g. the next CES app)
 * means building its own panel component — self-contained, owns its own API
 * calls and state — and adding one entry here. Nothing about the shell (the
 * project switcher, the page layout, the "Projects" tab itself) changes.
 *
 * This does NOT make onboarding a new project zero-code — each backend has
 * its own grant shape (Stock: location/org/client scope + 6 roles; Modules:
 * flat module_gid + 3 levels), so each project still needs a small adapter
 * component that knows its own API. What's dynamic is the shell around it.
 * A truly zero-code system would need every backend to expose a
 * self-describing access contract (resource types + role vocabulary +
 * endpoint names) that this shell could render generically — none do today,
 * that's a bigger, separate piece of work.
 */
export interface AccessProject {
  id: string;
  label: string;
  hint: string;
  component: Type<unknown>;
  /**
   * The CES_WEB utility this panel administers. The shell shows a panel only
   * when the signed-in manager holds this utility themselves (System Managers
   * see everything) — a manager should not be handed the administration
   * surface for a tool their company does not run.
   *
   * These strings are compared NORMALISED (underscores/spacing/case ignored),
   * so 'Manager Portal' also matches 'manager_portal'.
   */
  utility: string;
}

export const PROJECT_REGISTRY: AccessProject[] = [
  {
    id: 'stock',
    label: 'Stock Manager',
    hint: 'Warehouses, stockpiles and bootstock.',
    component: StockAccessPanelComponent,
    utility: 'Stock Manager',
  },
  {
    id: 'modules',
    label: 'Modules',
    hint: 'Per-module manager / contributor / viewer access.',
    component: ModulesAccessPanelComponent,
    // Confirmed with gustav 2026-09-10: CES_MODULES is its own utility,
    // 'Modules' (gid 410748cb-f469-41f6-86f8-8b33e23b7f5e). 'Manager Portal'
    // and 'Project Portal' are projects that have not been started, so this
    // panel was gated on a utility nobody can hold — only System Managers,
    // who bypass the check, ever saw it.
    utility: 'Modules',
  },
  {
    id: 'gis',
    label: 'GIS Projects',
    hint: 'Binary project membership. Gated by GIS System Manager only.',
    component: GisAccessPanelComponent,
    utility: 'GIS System',
  },
];
