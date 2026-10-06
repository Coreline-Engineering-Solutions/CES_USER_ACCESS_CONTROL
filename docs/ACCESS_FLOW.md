# CES access flow, on one page

6 October 2026. Written from the code in CES_WEB, CES_ACCESS_CONTROL (Admin Portal) and CES_USER_ACCESS_CONTROL (Client Portal), and from what Tiaan confirmed on the Colosseum.

## The idea

Access is **self-governing per client**. CES staff set a client up once. After that the client's own system manager runs their people.

1. **CES staff, in the Admin Portal:** add the user, give them the system-manager role (it carries most of the privileges), link them to the databases they work in, and link the tools (including the **Client Portal**).
2. **The client's system manager, in the Client Portal:** add their own users, create roles, assign roles, link tools **they hold themselves**, and give people access *inside* each tool they are linked to.
3. **Each tool keeps its own access.** Stock has its own (location grants), Modules has its own (per-module roles), GIS has its own (project membership). Linking a person to a tool puts the tile on their dashboard. It does not by itself let them do anything.

## Three different things, kept apart

| | What it answers | Set where | Enforced by |
|---|---|---|---|
| **Tool link** | "Do I see this tool?" | Admin Portal or Client Portal | Dashboard tile only. Most tools do not block entry by link. |
| **Role and privileges** | "What may I do?" Per database. | Client Portal, Roles | The server (refuses with 403) |
| **Access inside a tool** | "On which items?" | Each tool's panel in the Client Portal | The server, per tool |

The three tools' own access:
- **Stock:** grants on a location, organisation or client, as viewer, operator or controller. Giving them needs the `_stock_admin` privilege.
- **Modules:** manager, contributor or viewer on each module. A manager of that module, or a System Manager, can give them.
- **GIS:** project membership. Only a GIS System Manager gives it.

## What each app does

- **CES WEB (the dashboard):** a tile shows when the tool is linked. Nothing else decides it, except the Admin Portal tile, which also needs the staff privilege. What a person can do inside a tool is that tool's business.
- **Admin Portal (CES staff only):** opens only for someone holding `_manage_client_roles` under GIS System. Pages: Users, Tools, Roles, Privileges, Databases, License.
- **Client Portal:** Add user creates the user, links them to the active database and optionally gives a role. A manager can only link tools they hold themselves. **The Stock, Modules and GIS panels show only for tools the person is linked to**, System Managers included, the same rule as the dashboard.

## The System User Manager role

One **generic role**, the same for every client. It is the only role that lets a client govern their own group, and nobody else holds those privileges (Manager, Planner and Viewer do not).

It lets the client's system manager:
- **add their own users** (create the person, link them to the client's database, give them a role)
- **create roles** and choose what each role may do
- **see their users and manage them** (change or remove a role, link or remove tools they hold themselves)
- **give people access inside** Stock, Modules and GIS, for the tools they are linked to

What the role needs to do that:

| To do this | The role needs |
|---|---|
| Add users, create roles, see and manage users | `_manage_client_roles` |
| Give people Stock access | `_stock_admin` |
| Give people Modules access | System Manager (`_list_user_projects`), or manager of that module |
| Give people GIS access | GIS System Manager |

The standard Manager role is defined to leave out `_manage_client_roles` and `_stock_admin` (decided 28 Sep). That keeps them in this one role and out of everything else. On QA, Manager still holds every privilege today.

## Keeping clients out of the Admin Portal

`_manage_client_roles` is also what the Admin Portal used to check, so on its own it would let a client's system manager into our staff tool, which lists every client, database and licence. The Admin Portal therefore has **two locks, both must open**:

1. the privilege `_manage_client_roles`, and
2. a **non-`basic` role on the `Access_Control` tool**.

Every client user holds `Access_Control` with the `basic` role for database context, and many production users still do. Only CES staff hold anything else. So `basic` alone never opens the Admin Portal, whatever privileges the person has. This applies to both the dashboard tile (CES_WEB) and the portal itself.

## Where it is only on the screen

Which rows a person sees by task allocation, and which buttons show, are screen-side only. The server decides the rest. A hidden button is convenience, not security.

## Open decisions

1. When to take `_manage_client_roles` and `_stock_admin` off Manager, and which role replaces it for the self-governing manager.
2. The System Manager key (`_list_user_projects` versus a dedicated privilege).
3. Who may call `subtasks/allocate`, since it changes every subtask of a task.
4. Whether tools should block entry when not linked, instead of only hiding the tile.
