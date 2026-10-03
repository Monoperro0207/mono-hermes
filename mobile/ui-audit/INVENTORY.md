# Hermes desktop renderer: UI inventory for the phone WebView audit

Source root: `upstream/apps/desktop/src` (all paths below are relative to it). Read-only research; nothing under `upstream/` was changed.

**How to read this file**

- Router is a `HashRouter` (`main.tsx`), so every route is `index.html#/<path>?<query>`. Window kinds are chosen by `?win=` BEFORE the `#` (`hud`, `overlay`, `quick`, `wake`, `secondary`, `browser`, `watch`; `store/windows.ts`).
- "Reach" = route / click path / slash command / keyboard shortcut / context menu. `⌘` means Ctrl on Android/Linux (`mod`).
- Status column: blank = reachable by touch; `desktop-only` = needs an Electron preload API (`window.hermesDesktop.*`, 100+ call sites) or the local backend, inert or broken in a plain Android WebView; `partial` = works but some controls are desktop-only; `no-touch` = only reachable by keyboard or mouse hover/drag.
- Risk column cites `file:line` only where grepped; classes are Tailwind 4 (`w-72` = 18rem = 288px, `size-5` = 20px, `sm:` = viewport >= 640px).
- Viewports under test: 344x882, 412x915 (narrow mode); 690x829, 829x690, 768x1024 (docked mode). See the viewport matrix at the end of "Layout engine".

---

## 1. Layout engine

**Shell, panes, sidebars.** `ContribController` (`app/contrib/controller.tsx:828-860`) renders a `SidebarProvider` wrapper plus a `div.flex.h-screen.w-screen.flex-col` containing `LayoutTreeRoot titlebar` and, when visible, the statusbar (`footer.h-5`, 20px, `app/shell/statusbar-controls.tsx:104`). There is no in-flow titlebar box: `--titlebar-height` is forced to `0px` inside the shell (`controller.tsx:845`); the app's tool buttons are `fixed z-70` clusters (`app/shell/titlebar.ts:76-77`, 24px hit targets, `titlebar.ts:8`) and tab strips live inside the top-edge zones. Overlays re-pin `--titlebar-height` to 34px (`app/overlays/overlay-view.tsx:103`). The body is a recursive layout tree (`components/pane-shell/tree/*`: `split` rows/columns + `group` zones, 1px seams that double as sashes). Panes register through the contribution registry with sizing in `data`: `sessions` 237px fixed (min 237, max 360), `workspace` flex with `minWidth: 22vw` (`controller.tsx:226,549`), `files` and `review` 237px (min 10rem, max 20rem, `store/layout.ts:34-42`), `terminal` `height: 20vh` (max 80vh). Presets (`app/contrib/layout-presets.ts`): Default (sessions, workspace, review+files over terminal; weights 1 : 3.4 : 1.25), Basic (also the Simple-mode "sidebar-left/right"), Focus, Terminal deck, Quad. Simple vs Advanced interface mode (`store/interface-mode.ts`, default Advanced) shadows statusbar, terminal, files, review and tool-view prefs; Simple is the closest thing to a phone-friendly chrome but it is not selected automatically.

**The only structural breakpoint is 640px (viewport).** `SIDEBAR_COLLAPSE_MEDIA_QUERY = (max-width: 639.98px)` (`app/layout-constants.ts:30-32`) feeds `$narrowViewport` (`components/pane-shell/tree/store.ts:1298-1302`), `store/layout.ts:552`, `store/review.ts:396,442`. Below it every pane that declares `collapsible: true` (sessions, files, review, Bots roster) leaves the grid and becomes an edge slide-over (`renderer/narrow-overlays.tsx`: width `min(<docked width>, 85vw)`, `z-40`). Reveal paths: the titlebar sidebar toggles dispatch `PANE_TOGGLE_REVEAL_EVENT` (pinned), a 6px hover strip on the screen edge (`narrow-overlays.tsx:193`, `onMouseEnter` only, useless on touch), and Esc closes it. Non-collapsible panes (workspace, terminal, session tiles, previews) stay tiled, so on a phone the Advanced default tree can still leave a terminal column on the right (verify in browser). At 640px and above the sessions rail docks at its fixed 237px, which is exactly the 690/768/829 test widths: the chat pane gets about 453px at 690. Full-page workspace views (Capabilities, Messaging, Artifacts, plugin routes such as `/kanban`) render inside the workspace pane (`$workspaceIsPage`, `app/routes.ts`); Settings, Command Center, Agents, Cron, Webhooks, Profiles, Starmap and Session import are `OverlayView` cards (`fixed inset-0 z-50`, padding `calc(var(--titlebar-height)+0.625rem)` = 44px on ALL four sides, 48px at `sm:`, `overlay-view.tsx:82-83`), so the card is viewport minus 88px wide. Inside overlays `OverlaySplitLayout` is a 13rem rail + main grid that collapses to one column with a dropdown nav at `max-[47.5rem]` = 760px (`app/overlays/overlay-split-layout.tsx:16-17,60`); `Panel` flips at `min-[47.5rem]` (`overlays/panel.tsx:91,128`), Session import at `max-[760px]` (`session-import/index.tsx:150-262`).

**Other responsive mechanisms (and what is missing).** Media queries are almost absent: `@media` is used only for `prefers-reduced-motion`/`prefers-reduced-transparency` and a custom `compact` variant `(max-height: 768px)` for the sidebar section scrollers (`styles.css:93`, used in `app/chat/sidebar/index.tsx:254`). Tailwind breakpoints in TSX: `sm:` x44 (mostly forms/grids), `md:` x12 (almost all in `components/ui/sidebar.tsx`, `tab-dropdown.tsx`), `lg:`/`xl:` x3 each; arbitrary `max-[47.5rem]`, `max-[760px]`, `max-[44rem]` (floating HUD top offset, `app/floating-hud.ts:12`), `min-[72rem]`. Container queries: `@container` in settings primitives (`app/settings/primitives.tsx:146,179`, `@2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)]`), billing, and the catalog browser (`@[48rem]/catalog`). JS: `useMediaQuery`/`matchMedia` (narrow query, theme dark mode), `useIsMobile` (`hooks/use-mobile.ts`, `max-width: 47.9375rem` = <768px, only the language switcher and the shadcn sidebar use it, so it barely matters), composer width thresholds from a `ResizeObserver` (`app/chat/composer/composer-utils.ts:11-43`: compact pill <560px, fold voice <260, stack <320, minimal <180), and `window.innerWidth/innerHeight` clamping for the floating pet, composer pop-out, floating panes, find bar, tour and tips. NOT present: any `pointer: coarse` / `hover: none` handling (the `hover` variant is overridden to plain `:hover`, `styles.css:13-16`, so hover styles stick after a tap), `env(safe-area-inset-*)`, `visualViewport` keyboard handling (only the pet), `dvh` for the shell (`h-screen`/`w-screen` = 100vh), larger touch targets (statusbar 20px, titlebar and composer controls 24px, kebab buttons 20px), and a viewport meta beyond `width=device-width, initial-scale=1.0`. Android back does not produce Escape, so Esc-only dismissal paths (narrow overlay, layout edit mode, command palette sub-pages) need the on-screen close controls.

### Viewport matrix

| Viewport | Narrow mode (<640)? | `sm:` (>=640)? | Overlay split single-column (<760)? | `useIsMobile` (<768)? | `compact` (h<768)? | `max-[44rem]` (<704) |
|---|---|---|---|---|---|---|
| 344x882 | yes: sessions/files/review are slide-overs | no | yes | yes | no | yes |
| 412x915 | yes | no | yes | yes | no | yes |
| 690x829 | no: docked, sessions rail 237px + chat ~453px | yes | yes | yes | no | yes |
| 829x690 | no: docked, chat ~592px | yes | no (13rem rail) | no | yes | no |
| 768x1024 | no: docked, chat ~531px | yes | no | no (768 is not <768) | no | no |

Key mismatch at 690-829: `sm:`/`@2xl`-style layouts assume viewport width, but the chat/workspace pane that actually hosts Capabilities, Messaging, Artifacts, Kanban is 237px narrower than the viewport.

---

## 2. Routes and workspace pages

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| R-01 | New chat | `#/`; sidebar "New session"; ⌘N; `/new`, `/clear`, `/reset` | `app/routes.ts:41`, `app/contrib/surfaces.tsx` (index route), `app/chat/index.tsx`, `components/chat/intro.tsx` | Intro wordmark `px-0.5 sm:px-6 lg:px-8`; composer `--composer-width:100%`; see CH-*, CP-* | |
| R-02 | Session chat | `#/<encodeURIComponent(id)>`; sidebar row; `/resume` | `surfaces.tsx` (`:sessionId`), `app/chat/session-view.tsx`, `session-tile.tsx` | Same as R-01; sticky user bubbles; timeline rail on right edge (CH-37) | |
| R-03 | Redirect routes | `#/new`, `#/sessions/:id`, any unknown `#/x` redirect to `/` or the session | `surfaces.tsx` | Audit unknown-route fallback only | |
| R-04 | Settings overlay | `#/settings?tab=<view>&page=<subpage>`; titlebar gear; ⌘,; palette | `app/settings/index.tsx`, `app/overlays/overlay-view.tsx` | 44px overlay inset (card = viewport-88px); see section 3 | |
| R-05 | Command Center overlay | `#/command-center?section=sessions` / `system` / `usage` / `maintenance`; statusbar "Command center"; ⌘. | `app/command-center/index.tsx`, `maintenance.tsx` | Hover row actions `index.tsx:432`; header search `max-w-[40vw]`; stat grid `grid-cols-2 sm:grid-cols-3` (`:645`); `sm:grid-cols-2` (`:705`) | partial (system/maintenance read local host) |
| R-06 | Capabilities page | `#/capabilities?tab=skills` / `toolsets` / `connectors` / `plugins`; sidebar "Capabilities" | `app/capabilities/index.tsx` | Workspace page, not overlay; viewport `sm:` vs pane width mismatch (CAP-*) | |
| R-07 | Messaging page | `#/messaging`; sidebar "Messaging" | `app/messaging/index.tsx` | Master-detail 14rem rail (`app/master-detail.tsx:121`) | |
| R-08 | Webhooks overlay | `#/webhooks`; statusbar "Webhooks" | `app/webhooks/index.tsx` | `sm:grid-cols-2` forms `:444,474,493`; dialog `max-w-lg` `:420` | |
| R-09 | Artifacts page | `#/artifacts`; sidebar "Artifacts" (Advanced tier) | `app/artifacts/index.tsx` | Table `min-w-176` (704px) `:696` inside `overflow-x-auto` `:402`; card grid `minmax(11rem,1fr)` `:376`; hover-reveal `:635` | |
| R-10 | Scheduled jobs (cron) overlay | `#/cron`; sidebar "Scheduled" (Advanced); statusbar | `app/cron/index.tsx`, `blueprints.tsx` | Dialog `max-w-lg` `:1263`; `sm:grid-cols-2` `:1364` | |
| R-11 | Profiles overlay | `#/profiles`; palette; sidebar profile rail | `app/profiles/index.tsx`, create/rename/delete dialogs | List + dialogs | partial (local profile dirs) |
| R-12 | Agents overlay | `#/agents`; statusbar "Agents" | `app/agents/index.tsx` | Dense rows, `group-hover` title color `:382` | |
| R-13 | Star Map overlay | `#/starmap`; palette | `app/starmap/*` | Canvas with MOUSE-only handlers (`star-map.tsx:809-947`), timeline `w-[28rem] max-w-full` (`timeline.tsx:184`), Space-key playback | no-touch |
| R-14 | Session import overlay | `#/session-import`; palette | `app/session-import/index.tsx` | Two-pane grid `minmax(17rem,.85fr)/1.6fr`, collapses at viewport 760 with show/hide logic `:150-262` | partial (lists/imports Claude Code and Codex histories found on the gateway host) |
| R-15 | Kanban (plugin route) | `#/kanban`; sidebar nav row; statusbar item; palette | `plugins/kanban/plugin.tsx:110-153`, `board.tsx` | Columns `w-64` + horizontal scroll `board.tsx:455,1404`; HTML5 drag-and-drop `:286-289`; drawer/dialogs | no-touch (DnD) |
| R-16 | Legacy settings tab redirects | `#/settings?tab=mcp` and `?tab=plugins` redirect to `#/capabilities?tab=connectors/plugins` | `app/settings/moved-tabs.ts` | Redirect only | |
| R-17 | Legacy settings alias | `#/settings?tab=connections` redirects into Gateway | `app/settings/index.tsx:65-80` | Redirect only | |

---

## 3. Settings (`#/settings?tab=<view>&page=<subpage>`)

Shell: `OverlayView` + `OverlaySplitLayout` (13rem nav rail, dropdown nav below viewport 760px). Config-field rows use `LIST_ROW_COLUMNS = @2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)]` (`settings/primitives.tsx:146`), a container query, so they stack when the content column is narrow. Deep links: `&field=<config.key>`, `&setting=<manifest-id>` (e.g. `appearance.tips`), `&aux=`, `&session=`, `&kind=&label=&origin=` (vault), `&pview=`, `&kview=`, `&bview=`.

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| ST-00 | Settings shell + nav + search pill + export/import/reset | `#/settings`; gear | `app/settings/index.tsx:100-520` (`searchPill` :467, `navFooter` :487) | Fake search pill rides card top edge (`-translate-y-1/2`, half outside card) and opens ⌘K palette scoped to settings (`:467-485`); type-to-search is a window `keydown` listener (`:435-455`); export uses `a[download]`+Blob, import uses hidden `<input type=file>`; nav footer icon buttons are tooltip-only | |
| ST-01 | Model > Main | `tab=config:model&page=main` | `config-subpages.ts:17`, `model-settings.tsx` | Controls `min-w-60 flex-1` (`:969`), `min-w-60` (`:997`), `min-w-48` (`:1159,1384,1472`); searchable-select popovers; at 344px card (256px) these overflow | |
| ST-02 | Model > Fallbacks | `page=fallbacks` | `fallback-models-field.tsx:146` (`min-w-52 flex-1`) | Reorder list; min-w overflow | |
| ST-03 | Model > Auxiliary | `page=auxiliary` (`&aux=<task>`) | `config-subpages.ts`, `model-settings.tsx` | Per-task model rows | |
| ST-04 | Model > MoA | `page=moa` | `config-subpages.ts` (prefix `moa.`) | Preset editor | |
| ST-05 | Chat > Behavior | `tab=config:chat&page=behavior` | `config-subpages.ts:26` (personality, timezone, show_reasoning) | Select with `min-w` | |
| ST-06 | Chat > Attachments | `page=attachments`; manifest `chat.attachment-size` | `settings-manifest.ts`, `config-subpages.ts` | Slider/number | |
| ST-07 | Appearance > General | `tab=config:appearance&page=general`; rows language, introSplash, modelPricing, resumeLastSession, tips, tours | `appearance-settings.tsx`, `components/language-switcher.tsx` | Language switcher uses bottom `Sheet` when `useIsMobile` (`language-switcher.tsx:44-98`) | |
| ST-08 | Appearance > Theme | `page=theme`; row theme | `appearance-settings.tsx:291,607` | Theme cards `sm:grid-cols-2 xl:grid-cols-3`; per-card hover action `:635` (`opacity-0`); install-theme page lives in palette (OV-01) | |
| ST-09 | Appearance > Typography | `page=typography`; rows uiScale, chatTextScale, chatFont, terminalFont | `appearance-settings.tsx`, `chat-font-setting.tsx`, `terminal-font-setting.tsx` | UI zoom via `hermesDesktop.zoom` (desktop); sliders | partial |
| ST-10 | Appearance > Window & layout | `page=window-layout`; rows interfaceMode, sessionDensity, tabStrip, appActions, minimizeToTray, translucency, backdrop, fileBrowser, composerPopout | `appearance-settings.tsx`, `minimize-to-tray-setting.tsx`, `store/translucency.ts` | Simple/Advanced toggle is the phone-relevant switch; tray/translucency/backdrop are Electron | partial |
| ST-11 | Appearance > Chat display | `page=chat-display`; rows userBubble, textDirection, hideThreadTimeline, reactions, vibeHearts, toolView, hideCodeDiffs, reasoningCollapsed, embeds | `appearance-settings.tsx` | `hideThreadTimeline` is the toggle for CH-37 | |
| ST-12 | Appearance > Pet | `page=pet`; row pet | `pet-settings.tsx:148,168,209` | Grids `sm:grid-cols-2 xl:grid-cols-3`; hover-only card actions `:209` | |
| ST-13 | Workspace > Projects | `tab=config:workspace&page=projects` | `config-subpages.ts:36` (terminal.cwd, desktop.repo_scan_*) | Folder picker is desktop FS | partial |
| ST-14 | Workspace > Shell | `page=shell` | persistent_shell, env_passthrough | Text fields | |
| ST-15 | Workspace > Files | `page=files` | code_execution.mode, file_read_max_chars | | |
| ST-16 | Safety > Approvals | `tab=config:safety&page=approvals` | `config-subpages.ts:54`, `field-copy.ts` | Allowlist editor | |
| ST-17 | Safety > Privacy | `page=privacy` | prefix `security.` | | |
| ST-18 | Safety > Checkpoints | `page=checkpoints` | prefix `checkpoints.` | | |
| ST-19 | Browser > Profile | `tab=config:browser&page=profile` | `browser-real-profile-panel.tsx` | Real Chrome profile consent | desktop-only |
| ST-20 | Browser > Network | `page=network` | browser.allow_private_urls, auto_local_for_private_urls | | |
| ST-21 | Memory > Persistent | `tab=config:memory&page=persistent` | prefix `memory.` | | |
| ST-22 | Memory > Context | `page=context` | prefixes `context.`, `compression.` | | |
| ST-23 | Voice > Conversation | `tab=config:voice&page=conversation` | `config-field.tsx`, `voice-provider-fields.tsx` | Mic permission in WebView | partial |
| ST-24 | Voice > Transcription | `page=transcription` | prefix `stt.` | Provider fields | |
| ST-25 | Voice > Speech | `page=speech` | `voice.auto_tts`, prefix `tts.` | | |
| ST-26 | Advanced > Desktop | `tab=config:advanced&page=desktop`; rows keepAwake, disableF12, warmBotBackends, backendIdleTimeout, quickEntry, quickEntryShortcut (+`updates.*`) | `settings-manifest.ts:150-175`, `pool-limits-setting.tsx`, `quick-entry-settings.tsx` | All Electron features | desktop-only |
| ST-27 | Advanced > Runtime | `page=runtime` | agent.max_turns, api_max_retries, service_tier | | |
| ST-28 | Advanced > Tools | `page=tools` | `toolsets`, tool_use_enforcement | `toolset-config-panel.tsx:224` (`min-w-52`) | |
| ST-29 | Advanced > Terminal | `page=terminal` | prefix `terminal.`, `terminal-backend-panel.tsx` | Backend selection (local/ssh/docker) | partial |
| ST-30 | Advanced > Delegation | `page=delegation` | prefix `delegation.` | | |
| ST-31 | Advanced > Output | `page=output` | `tool_output.`, `checkpoints.` | | |
| ST-32 | Providers > Accounts | `tab=providers&pview=accounts` | `providers-settings.tsx:284,373` | OAuth sign-in opens external browser / terminal | partial |
| ST-33 | Providers > API keys | `pview=keys` | `providers-settings.tsx`, `env-credentials.tsx`, `credential-key-ui.tsx:180,223,312` | `@container` cards; hover-only expand caret `opacity-0 group-hover/card:opacity-100` | |
| ST-34 | Providers > Custom endpoints | `pview=custom-endpoints` | `custom-endpoints-settings.tsx:353,418,453` | `sm:grid-cols-[minmax(0,1fr)_12rem]` | |
| ST-35 | Providers > Local models | `pview=local` (only with the `--local` flag) | `local-models-*.tsx`, `local-models-browse.tsx:168,247` | GGUF picker, hardware probe | desktop-only |
| ST-36 | Gateway > Connection | `tab=gateway&page=connection`; rows connectionMode, keychainEncryption, diagnostics | `gateway-settings.tsx:1084` (`sm:grid-cols-2 min-[72rem]:grid-cols-4`), `components/remote-setup/*` | Primary phone-relevant page: remote URL/token entry; keychain is Electron | partial |
| ST-37 | Gateway > Devices | `page=devices` | `gateway-settings.tsx` | Paired-device list | partial |
| ST-38 | Gateway > Managed updates | `page=managed-updates` | `managed-updates-section.tsx` | Local install updater | desktop-only |
| ST-39 | Keybinds > Shortcuts | `tab=keybinds&page=shortcuts` | `keybind-settings.tsx:223,284,299` | Key-capture UI needs a hardware keyboard; hover-reveal reset buttons | no-touch |
| ST-40 | Keybinds > HUD gesture | `page=hud-gesture`; row hudModifier | `hud-modifier-settings.tsx` | Global modifier tap | desktop-only |
| ST-41 | Keybinds > Screen capture | `page=screen-capture`; row screenshot | `screenshot-settings.tsx` | Window screenshot | desktop-only |
| ST-42 | API keys > Tools | `tab=keys&kview=tools` | `keys-settings.tsx` | Env var list | |
| ST-43 | API keys > Settings | `kview=settings` | `keys-settings.tsx` | | |
| ST-44 | Vault > Credentials | `tab=vault&page=credentials` (`&kind=&label=&origin=`) | `vault-settings.tsx:604,642,712,771,787` | `sm:grid-cols-2/4` forms; unlock with passphrase | |
| ST-45 | Vault > Sources | `page=sources` | `vault-settings.tsx` | Password-manager sources | |
| ST-46 | Notifications > Alerts | `tab=notifications&page=alerts`; rows enableAll, kind-* | `notifications-settings.tsx:95` (`min-w-56` select), `store/native-notifications.ts` | Native notifications are Electron | partial |
| ST-47 | Notifications > Sounds | `page=sounds`; row completionSound | `lib/completion-sound.ts` | WebAudio autoplay policy | |
| ST-48 | Billing > Overview | `tab=billing&bview=overview` | `settings/billing/index.tsx:356,449,532,565`, `auto-reload-row.tsx`, `current-plan-card.tsx` | `@container` blocks | |
| ST-49 | Billing > Plans | `bview=plans` | `billing/plans-view.tsx:227` (`@lg:grid-cols-2 @3xl:grid-cols-3`) | External checkout links | |
| ST-50 | Sessions > Archived | `tab=sessions&page=archived` (`&session=`); row autoArchive | `sessions-settings.tsx` | Restore/delete rows | |
| ST-51 | Sessions > Default directory | `page=default-directory` | `sessions-settings.tsx` | Folder picker | partial |
| ST-52 | About > Updates | `tab=about&page=updates`; row updates | `about-settings.tsx`, `components/update-status.tsx` | App updater | desktop-only |
| ST-53 | About > Uninstall | `page=uninstall` | `uninstall-section.tsx` | | desktop-only |

---

## 4. Capabilities and Messaging

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| CAP-01 | Page shell (tabs, search, scope) | `#/capabilities` | `app/page-search-shell.tsx:94` (`grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]`, tabs centered), `capabilities/index.tsx:189`, `scope-selector.tsx:210` (`w-56`) | 4 tab pills + search in one row; `pt-[calc(var(--titlebar-height)+0.5rem)]` | |
| CAP-02 | Skills tab (installed + Skills Hub) | `?tab=skills`; `&skill=` | `capabilities/skills/skills-tab.tsx`, `skill-detail.tsx`, `official-skill-detail.tsx` | `MasterDetail` wide grid `sm:grid-cols-[minmax(0,var(--md-split,.75fr))_minmax(0,1fr)]` (`master-detail.tsx:53`) is viewport-based, hidden drag sash `cursor-col-resize hidden sm:block` (`:131`) | |
| CAP-03 | Catalog browser (hub facets + grid) | inside Skills and Plugins tabs | `capabilities/catalog/catalog-browser.tsx:284-304` | Container query `@[48rem]/catalog`: facets `max-h-52` stacked below, `w-48` rail above | |
| CAP-04 | Catalog card / list row / detail dialog / install switch / advanced dialog | click a catalog item | `catalog-card.tsx:97`, `catalog-list-row.tsx`, `catalog-detail-dialog.tsx`, `catalog-detail.tsx:109,174`, `components/assistant-ui/catalog-advanced-dialog.tsx:168` | `grid-cols-3` detail stats; `grid-cols-[max-content_minmax(0,1fr)]` definition list; `max-h-[60vh]` | |
| CAP-05 | Toolsets tab | `?tab=toolsets` | `toolsets/toolsets-tab.tsx`, `toolset-detail.tsx` | Master-detail rail; config panel `min-w-52` | |
| CAP-06 | Connectors tab (directory) | `?tab=connectors` (`&server=`) | `connectors/connectors-tab.tsx`, `connectors-directory.tsx:200`, `connector-row-card.tsx:156` | Card action column fixed `w-[7.75rem]`; `sm:grid-cols-2` | |
| CAP-07 | Connector dialogs (add, hosted, local, connector) | "Add" button; row click | `connectors/add-dialog.tsx:82`, `connector-dialog.tsx:82`, `hosted-dialog.tsx`, `local-dialog.tsx` | `min-w-[min(34rem,90vw)]`, raw mode `h-[min(40rem,80vh)] min-w-[min(48rem,90vw)]` | |
| CAP-08 | Connector tools panel + filter bar + list | inside connector dialog | `connectors/tools-*.tsx`, `tool-row.tsx:100-138` (`max-w-[60ch]`) | `ResizeObserver` list (`tools-list.tsx`) | |
| CAP-09 | MCP editor + logs + probes | Connectors > custom server | `capabilities/mcp/mcp-editor.tsx`, `mcp-logs.tsx` | Cursor-driven layout, bottom detail pane with `cursor-row-resize` sash (`master-detail.tsx:277`) | partial (stdio servers run on host) |
| CAP-10 | Plugins tab + plugin settings form | `?tab=plugins` (`&plugin=`) | `plugins/plugins-tab.tsx:314`, `plugin-settings-form.tsx:260` | `sm:grid-cols-2` | partial (desktop plugins reconcile via Electron) |
| CAP-11 | Embedded / pinned-profile mode | opened from Bot Mode dialogs | `capabilities/index.tsx:37-50` | Dialog-in-dialog sizing | |
| CAP-12 | Plugin install modal | palette / Settings | `app/settings/plugin-install-modal.tsx` | Dialog | |
| MSG-01 | Platforms list + detail | `#/messaging` | `app/messaging/index.tsx:670,905` | 14rem rail `sm:grid-cols-[14rem_minmax(0,1fr)]` (`master-detail.tsx:121`) | |
| MSG-02 | Telegram QR setup | Messaging > Telegram | `messaging/telegram-qr-setup.tsx:291` | `lg:grid-cols-[minmax(0,1fr)_240px]`; QR + key capture | |

---

## 5. Sidebar (sessions pane)

Sessions pane is fixed 237px (min 237, max 360). On narrow viewports it is a slide-over (PL-04). Row geometry `min-h-[1.625rem]` (26px) (`app/chat/sidebar/row-geometry.ts`).

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| SB-01 | Sidebar container | titlebar left toggle; ⌘B | `app/chat/sidebar/index.tsx:1588`, `app/contrib/surfaces.tsx` (`SidebarSurface`) | 237px dock at 640-829; `compact:` (h<768) flattens sections into one scroller (`index.tsx:254,2001`) | |
| SB-02 | Nav rows (New session, Capabilities, Messaging, Artifacts*, Scheduled*, contributed e.g. Kanban) | sidebar top | `index.tsx:207-247,1700-1760` | `*` = Advanced tier only; right-click context menu "open in split" (`:1707`) | |
| SB-03 | Search field + results section | sidebar search; ⌘⇧F | `index.tsx:1736` (`SearchField`), `search-results-order.ts` | Soft keyboard resizes viewport (no `visualViewport` handling) | |
| SB-04 | Pinned section | `Pinned` header | `index.tsx:1792` | Reorder by drag only (DD-04) | |
| SB-05 | Recents/sessions list (virtualized) | default | `sessions-section.tsx`, `virtual-session-list.tsx`, `order.ts` | Virtualized list measured heights | |
| SB-06 | Groupings (date, profile/gateway, project, status) | filter menu; ⌘K "cycle grouping" | `filter-menu.tsx:121-135`, `gateway-groups.tsx`, `projects/workspace-group.tsx` | Collapsible headers with hover-only chevrons `chrome.tsx:156,310` | |
| SB-07 | Session row (dot, title, age, branch stem, PR chip, model/cost meta) | row | `session-row.tsx:118-122,505-665`, `session-status-dot.tsx`, `session-row-details.ts` | Tail hides on hover `group-hover:opacity-0` (`:118`); hover marquee `:565`; text 10-11px | |
| SB-08 | Row kebab / actions menu | kebab at row right (invisible until hover); long-press context menu | `session-row.tsx:330-355`, `session-actions-menu.tsx:290-515` | Kebab `size-5` (20px) and `text-transparent` until hover/focus; menu reachable on touch only through the invisible target or long-press | no-touch (kebab) |
| SB-09 | Menu items: open in new tab, new window, open in terminal, rename, pin/unpin, mark read/unread, branch from here, export, tab-zone items (reload, close, close others/right/all), hide tab bar, archive/unarchive, delete | row menu | `session-actions-menu.tsx:290-580` | New window, terminal, export-to-file are Electron | partial |
| SB-10 | Rename dialog | menu > Rename | `session-actions-menu.tsx:592` | Dialog `w-full max-w-lg`; focus-restore tricks | |
| SB-11 | Delete confirm | menu > Delete | `session-actions-menu.tsx:625-640` (`ConfirmDialog`) | Enter-to-confirm | |
| SB-12 | Branch from message/session | menu > Branch; `/branch` | `session-actions-menu.tsx:407`, `app/chat/composer/hooks/use-composer-branch.ts` | | |
| SB-13 | Row click modifiers (⇧ pin, ⌘ new tab, ⌘⇧ new window, ⌥⇧ archive) | modifier + click | `session-row-gesture.ts` | Touch only gets plain "resume" | no-touch |
| SB-14 | Row drag handle / reorder / drag to composer / drag to chat edge to split | press-drag row | `chrome.tsx:351-356` (`group-hover/handle`), `session-drag.ts`, `reorderable-list.tsx`, `new-session-drag.ts` | Custom pointer drag; hover-revealed handle; scroll conflict | no-touch |
| SB-15 | Filter menu (sort, group, row meta, PR/status filters, dots) | funnel icon in sessions header | `filter-menu.tsx:238-300` | Dropdown `min-w-52` + nested `DropdownMenuSub` (opens to the side) | |
| SB-16 | Mark all read button | sessions header | `index.tsx:1880` (`Tip` + icon) | Tooltip-only label | |
| SB-17 | Show projects toggle, project menu, project back row | sessions header; project row | `index.tsx:1911,1959,1990`, `projects/project-menu.tsx:234` (`w-48`, sub `w-auto p-2`), `projects/entered-content.tsx` | | |
| SB-18 | New session "+" / project add button (drag to split) | sessions header | `chrome.tsx` (`SidebarSectionAddButton`, hover-reveal `:41`) | Hover-reveal `opacity-0 group-hover/section:opacity-100` | no-touch |
| SB-19 | Project dialog / worktree dialog / base-branch picker | project menu; ⌘⇧B | `projects/project-dialog.tsx`, `worktree-dialog.tsx` (`sm:`), `base-branch-picker.tsx` | Git worktree ops use host git | partial |
| SB-20 | Load more row | list bottom | `load-more-row.tsx:25` (`size-5`) | 20px target | |
| SB-21 | Messaging platform groups (3 rows, +10 steps) | sidebar | `index.tsx:194-197` | | |
| SB-22 | Cron jobs section | sidebar (only when cron sessions exist) | `cron-jobs-section.tsx:194-389` | Row actions swap on hover `hidden group-hover/cron:flex` (`:335`), `size-5` | no-touch |
| SB-23 | Profile rail (profile squares, fleet) | ⌘⇧0 etc.; statusbar toggle | `profile-switcher.tsx:520-1540` | 20px squares, `opacity-35`, dnd-kit reorder `cursor-grab touch-none` (`:1473`), scroll row | |
| SB-24 | Profile dropdown switcher | statusbar `profile-switcher` item | `profile-dropdown-switcher.tsx:169-204` | Menu `min-w-48 max-w-72`, `side=top` | |
| SB-25 | Gateway/connection switcher | statusbar `gateway-switcher` | `connection-switcher.tsx:122-146` | `w-72` searchable popover | |
| SB-26 | Gateway groups + profile-group header slot | grouped sidebar | `gateway-groups.tsx:218,294`, `app/routes.ts:148` (`sidebar.profileGroup.header`; Bots "Screen" portal) | Drag reorder | |
| SB-27 | Profile launch menu / remote override dialog | right-click profile square | `profile-launch-menu.tsx:65`, `profile-remote-override-dialog.tsx` | Context menu `min-w-52` | |
| SB-28 | Local device switch / fleet gateway menu group | gateway rail | `local-device-switch.tsx`, `fleet-gateway-menu-group.tsx` | | |
| SB-29 | Section states (skeleton, empty, error), storage-corrupt notice | auto | `section-states.tsx`, `storage-corrupt-notice.test.tsx` | | |

---

## 6. Titlebar and statusbar

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| TB-01 | Left tool cluster (sidebar toggle with unread badge; plus gear/layout/HUD when "app actions left") | always visible except over overlays | `app/shell/titlebar-controls.tsx:213,308-326`, `titlebar.ts:93-110` | `fixed z-70`, left inset = 98px unless `connection.windowButtonPosition === null` (macOS traffic-light reservation; `titlebar.ts:93-110`, `contrib/wiring.tsx:1289`); 24px targets; labels are tooltip-only | |
| TB-02 | Right system cluster (gear, layout editor, HUD, flip panes, right-sidebar toggle) | always visible except over overlays | `titlebar-controls.tsx:213-350`, `store/titlebar-app-actions.ts` | 5 x 24px at right `0.75rem`; may collide with pane tool cluster and tab strip at 344px | |
| TB-03 | Pane tool cluster (preview/browser toolbar, contributed `titleBar.tools.*`) | when a pane contributes tools | `titlebar-controls.tsx:328-340`, `app/contrib/panes.tsx` (`useTitlebarToolContributions`) | Positioned `right-[calc(var(--titlebar-tools-right)+var(--shell-preview-toolbar-gap))]` | |
| TB-04 | Layout button reset morph (⌘-click) | modifier + click | `titlebar-controls.tsx:80-100` | Modifier-only | no-touch |
| TB-05 | Zone tab strip in titlebar (workspace tab, session tiles, "+", minimize chevron, tab context menu) | top-edge zones | `components/pane-shell/tree/renderer/tree-group.tsx:307,479-860`, `components/ui/pane-tab.tsx` | Tabs overflow-scroll `tab-strip-scroll.ts`; middle/⌘-click close; hover-only close chip `tree-group.tsx:604` (`opacity-0`); right-click zone menu `w-40` (`:229`) | |
| TB-06 | Chat title dropdown | click title in chat header | `app/chat/index.tsx:193`, `components/ui/title-menu-trigger.tsx` | Hidden inside zones (`header[class*="h-(--titlebar-height)"] {display:none}`, `renderer/index.tsx:60-65`) | |
| TB-07 | Overlay close "X" + titlebar actions | every OverlayView | `app/overlays/overlay-view.tsx:104-123` | `absolute right-[var(--titlebar-tools-right,0.75rem)]`, 24px; also backdrop click + Esc | |
| TB-08 | WSLg custom window controls | Linux/WSL only | `app/shell/wslg-window-controls.tsx` | | desktop-only |
| SBR-01 | Statusbar container | bottom; hide via ⌘⇧S or right-click > Hide | `statusbar-controls.tsx:96-125` | `h-5` (20px) `text-[0.6875rem]`; `overflow-x-clip` truncates items silently at 344px; unmounted in Simple mode | |
| SBR-02 | Statusbar visibility context menu | right-click / long-press bar | `statusbar-controls.tsx:128-190` | Menu `w-52`; long-press needed | no-touch |
| SBR-03 | Client / backend version pills | statusbar | `use-statusbar-items.tsx:415-467` | Opens update dialog (OV-06) | partial |
| SBR-04 | Command center item | statusbar; ⌘. | `use-statusbar-items.tsx:485` | | |
| SBR-05 | Gateway switcher / profile switcher items | statusbar | `use-statusbar-items.tsx:496-505` | See SB-24, SB-25 | |
| SBR-06 | Gateway health menu | statusbar | `use-statusbar-items.tsx:519-526` (`w-72`), `app/shell/gateway-menu-panel.tsx` (reconnect, logs `max-h-40`, restart) | Restart/log access are host actions | partial |
| SBR-07 | Free-tier chip | statusbar when eligible | `use-statusbar-items.tsx:549`, `components/free-tier/*` | | |
| SBR-08 | Workspace cwd menu (copy path, reveal in Finder/sidebar) | statusbar | `use-statusbar-items.tsx:559-596` (`w-56` default) | Reveal-in-Finder is Electron | partial |
| SBR-09 | Agents / Cron / Webhooks items | statusbar | `use-statusbar-items.tsx:617-638` | | |
| SBR-10 | Running timer, session timer, tokens/s, cache-hit text items | statusbar (busy) | `use-statusbar-items.tsx:676-726` | 11px text | |
| SBR-11 | Context usage meter + breakdown menu | statusbar | `use-statusbar-items.tsx:691-699`, `shell/context-usage-panel.tsx:39` (`w-72`) | Panel `w-72` fits; meter 20px high | |
| SBR-12 | System resources item + panel | statusbar | `shell/system-resources-statusbar.tsx:154` | Reads host hardware | desktop-only |
| SBR-13 | Approval mode menu (manual/smart/off, YOLO) | statusbar; `/yolo`, `/approvals` | `shell/approval-mode-menu.tsx`, `use-statusbar-items.tsx:731` | Radio menu `w-56` | |
| SBR-14 | Terminal toggle | statusbar; ⌃` | `use-statusbar-items.tsx:739` (`w-7`) | Desktop PTY (RS-07) | desktop-only |
| SBR-15 | Contributed items: Radio player, hello-runtime chip, Kanban chip | plugin statusbar slots | `plugins/radio/plugin.js:696`, `plugins/hello-runtime/plugin.runtime.js:32`, `plugins/kanban/plugin.tsx:116` | Radio `<audio>` streams, autoplay policy | |
| SBR-16 | Model menu (ModelCatalogMenu: search, favorites, provider groups, MoA presets, download rows, refresh, follow-default) | composer model pill (NOT in statusbar in this version); ⌘⇧M | `shell/model-menu-panel.tsx`, `model-catalog-menu.tsx:715` (`max-h-[max(150px,30dvh)]`), `chat/composer/model-pill.tsx:218` (`w-64`, `side=top`, `align=end`) | Row sub-menu opens to the side (`model-edit-submenu.tsx:103`, `w-52`, `DropdownMenuSubContent`), hover-star `opacity-0 group-hover/label:opacity-100` (`:765`) | |
| SBR-17 | Reasoning menu | composer reasoning pill; `/reasoning` | `shell/reasoning-menu-panel.tsx`, `chat/composer/reasoning-pill.tsx:90` (`w-52`) | Pill hidden when composer <560px (`compactModelPill`) | |

---

## 7. Chat view: messages, tool cards, prompts

Thread column: `list.tsx:1568` `mx-auto ... max-w-(--composer-width) px-6`; `--composer-width: 100%` (`styles.css:542`).

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| CH-01 | Empty chat intro (wordmark, tips, plugin empty slot) | new chat | `components/chat/intro.tsx:175`, `wordmark.tsx`, `chat-empty-slot.tsx`, `plugins/hermes-bots/chat-empty.tsx:84` | `pointer-events-none`; wordmark scale | |
| CH-02 | Thread list + transcript window ("Show earlier") | any session | `components/assistant-ui/thread/list.tsx:1541-1576`, `transcript-window.tsx`, `app/chat/transcript-window.ts` | `px-6` + `contain-[layout_paint]`; button `list.tsx:1576` | |
| CH-03 | User message bubble (sticky, clamped, expandable) | any turn | `thread/user-message.tsx:53-76,384` | Sticky `z-40`, `-mx-4 w-[calc(100%+2rem)]`; `.sticky-human-clamp` | |
| CH-04 | User message attachments (images, files, refs) | message with attachments | `thread/user-message.tsx:409-422`, `components/chat/preview-attachment.tsx:226-251` (`max-w-160`) | | |
| CH-05 | Edit user message (inline composer) | click bubble / "Edit" | `thread/user-edit-composer.tsx:314` (`spaceBelow = window.innerHeight - rect.bottom`) | Pop-below logic ignores keyboard | |
| CH-06 | User bubble hover actions (stop, restore checkpoint) | hover | `thread/user-message.tsx:506,566-575` | `opacity-0 group-hover/user-message:opacity-100`; `size-5` | no-touch |
| CH-07 | Assistant markdown text | any reply | `components/assistant-ui/markdown-text.tsx:523-546`, `markdown-blocks.ts` | `prose w-full overflow-hidden`; `wrap-anywhere` | |
| CH-08 | Reasoning / thinking block | reply with reasoning; Settings > Chat display | `thread/message-parts.tsx` (`ReasoningMessagePartComponent`), `store/reasoning-disclosure.ts` | Collapsible "Thought for Ns" row | |
| CH-09 | Run summary / tool group / live ticker | tool-using turn | `components/assistant-ui/tool/run-summary.ts`, `tool/run-ticker.tsx`, `tool/fallback.tsx` (`ToolGroupSlot`) | Expand/collapse disclosure rows | |
| CH-10 | Generic tool row (read, search, web, browser, agent, file kinds; tone variants agent/browser/default/file/image/terminal/web) | tool call | `tool/fallback.tsx:588-760`, `tool/fallback-model/index.ts` | Copy button `opacity-5 group-hover/tool-block:opacity-100` (`:658`); disclosure `opacity-0 group-hover/disclosure-row:opacity-80` (`:558`); `max-w-72` thumbnail; `max-h-56` pre | |
| CH-11 | Terminal tool block (ANSI, stdout/stderr, exit code, live) | `terminal`/`execute_code` | `thread/message-parts.tsx:130`, `components/assistant-ui/ansi-text.tsx`, `components/chat/terminal-output.tsx:60` | `pre w-max min-w-full` horizontal scroll, 9px mono | |
| CH-12 | File edit diff card (`edit_file`, `patch`, `write_file`) | file edit | `components/chat/diff-lines.tsx:54-683`, `syntax-diff.tsx`, `thread/changed-files-card.tsx` | `min-w-max` rows (horizontal scroll), fixed-row virtualization, `max-h-[12rem]` | |
| CH-13 | Web search results list | web_search | `tool/fallback.tsx:277-280` | Links open external | |
| CH-14 | Image generation card + placeholder | `image_generate` | `components/chat/generated-image-result.tsx:73-107`, `image-generation-placeholder.tsx`, `message-parts.tsx:41-54` | Download button `group-hover/image:opacity-100` | |
| CH-15 | Delegate task / subagents card | `delegate_task` | `tool/delegate.tsx:96-160` | | |
| CH-16 | Clarify prompt (pending, settled, undelivered notice) | `clarify` tool | `components/assistant-ui/clarify/{pending,settled,undelivered-notice}.tsx`, `core/shell.tsx`, `submit-shortcut.ts` | Submit shortcut is keyboard-oriented | |
| CH-17 | Todo list panel (hoisted above message) | `todo` tool | `message-parts.tsx:122`, `lib/todos.ts` | | |
| CH-18 | Connections consent card / MCP setup card | `manage_connections` | `components/assistant-ui/connector-tool.tsx`, `mcp-setup-tool.tsx` | OAuth opens external | |
| CH-19 | Catalog install consent card | `manage_catalog` | `components/assistant-ui/catalog-install-tool.tsx` | | |
| CH-20 | Approval prompt card (inline + floating sticky) | dangerous command | `tool/approval.tsx:63-64,141,330-363` | Floating variant `sticky bottom-4 w-full max-w-xl`; dropdown `min-w-44`; keyboard approve keys `lib/keybinds/approval-keys.ts` | |
| CH-21 | Approval details/deny dialog | approval card > details | `tool/approval.tsx:392-399` (`max-w-md`) | | |
| CH-22 | Sudo / secret / vault unlock / vault save-login / vault 2FA code prompts | server request events | `components/prompt-overlays.tsx:52,169,270,365,479` | 5 Radix dialogs, `showCloseButton={false}`, password inputs | |
| CH-23 | Code block (card, shiki highlight, copy, expand) | fenced code | `components/chat/code-card.tsx:16-39`, `shiki-*.tsx`, `expandable-block.tsx:39` | `[&_pre]:overflow-x-auto`; copy button hover-reveal | |
| CH-24 | Mermaid diagram (inline + zoom dialog) | ```mermaid fences | `components/assistant-ui/embeds/mermaid-embed.tsx:127-137` | Zoom img `max-h-[80vh] max-w-[85vw]`; inline `max-h-[33dvh]` | |
| CH-25 | SVG embed | ```svg fences | `embeds/svg-embed.tsx:28` | `max-h-[33dvh]` | |
| CH-26 | Markdown table (column-resize handles, sticky header) | any table | `components/assistant-ui/markdown-table.tsx:157-206`, `lib/markdown-table-widths.ts` | `min-w-[18rem]` in `overflow-x-auto`; resize handle `opacity-0 group-hover/mdcol:opacity-100` | no-touch (resize) |
| CH-27 | Math (KaTeX inline/display) | `$..$`, `$$..$$` | `lib/katex-memo.ts`, `styles.css` (katex import) | Wide equations overflow | |
| CH-28 | Markdown image + lightbox | image in reply | `markdown-text.tsx:405-465`, `components/chat/zoomable-image.tsx:60-226`, `components/ui/zoomable.tsx:89` | Lightbox `max-w-[calc(100vw-12rem)]` = 152px at 344 (`zoomable-image.tsx:172,190`); toolbar `fixed bottom-4`; download `opacity-0` (`:226`); pinch via pointer events `ui/use-zoom-pan.ts` | |
| CH-29 | Video player | video link/path | `components/chat/transcript-video.tsx`, `markdown-text.tsx:216-229` (`max-h-112`) | Native controls | |
| CH-30 | Rich URL embeds: YouTube, Vimeo, Spotify, X/Twitter, Instagram, TikTok, Pinterest, Maps, generic frame, listing set; consent placeholder | URL in reply | `embeds/{registry,url-embed,youtube-embed,spotify-embed,social-embed,frame-embed,listing-embed,embed-consent}.tsx` | Sandboxed iframes; width `min(maxWidth,100%,calc(33dvh*aspect))`; embeds gated by Settings > Chat display > embeds | |
| CH-31 | Artifact card / inline preview directive / changed-files card | artifact markers | `components/assistant-ui/artifact-card.tsx`, `inline-preview-directive.tsx`, `thread/changed-files-card.tsx:50-68` | Opens preview tile (RS-09/10) | partial |
| CH-32 | Reference chips, directive text, ask directive, transcript directive | `@file`, `/cmd` chips in text | `directive-text.tsx`, `ask-directive.tsx`, `transcript-directive.tsx`, `reference-kinds.ts` | | |
| CH-33 | Assistant action bar (copy, copy full, read aloud, branch in new chat, regenerate, reactions) | hover/focus under reply | `thread/assistant-message.tsx:1032-1070,1196-1202` | `opacity-0 pointer-events-none group-hover:...` (invisible until hover/focus; tap may stick :hover); icon buttons `size-6` | no-touch |
| CH-34 | Branch picker (prev/next) | message with branches | `thread/assistant-message.tsx:1196` | `size-6` | |
| CH-35 | Message reactions (emoji tapback) | react tool / hover | `thread/message-reactions.tsx:23-28,180` | Hover scale | |
| CH-36 | Turn duration, timestamp, thinking timer | each turn | `thread/timeline-timestamp.tsx`, `components/chat/activity-timer*.tsx` | | |
| CH-37 | Conversation timeline rail | right edge of thread | `thread/timeline.tsx:302-326`, `timeline-rail.tsx`, `timeline.css:1-37` | `absolute right-0 z-40 w-3rem`, tick pitch 7px (0.4375rem), hover-driven paint; Settings > Chat display > hide timeline | no-touch |
| CH-38 | Scroll-to-bottom button (with "N below" count) | scroll up in thread | `app/chat/scroll-to-bottom-button.tsx`, `thread/use-messages-below.ts` | Positioned off `--composer-measured-height` | |
| CH-39 | System / notice rows (`/status`, `/help` output, usage tables) | slash command output | `thread/system-message.tsx:29,145,170` | `w-[60%] max-w-[44rem]` = ~170px at 344 | |
| CH-40 | Agent delivery notice | agent-to-agent messages | `thread/agent-delivery.tsx` | | |
| CH-41 | Error banner / error state / retry | failed turn | `components/ui/error-state.tsx`, `thread/status.tsx`, `lib/error-surface*.ts`, `components/send-diagnostics-dialog.tsx` | | |
| CH-42 | Resume-exhausted overlay | resume fails | `app/chat/resume-exhausted-overlay.tsx:23-30` | `absolute inset-0`, `px-8` | |
| CH-43 | Chat swap overlay (profile switch) / file-drop overlay | switch profile; drag files in | `app/chat/chat-swap-overlay.tsx`, `chat-drop-overlay.tsx` | Drop overlay needs OS drag | partial |
| CH-44 | Billing banner / free-tier strip / shared-metrics strip | low credit; unauthenticated | `components/billing-banner.tsx:23`, `components/free-tier/notice-strip.tsx`, `shared-metrics/consent-strip.tsx` | | |
| CH-45 | Session tile header/sticky bar (multi-session tiles) | drag session to chat edge; `session.newTab` | `app/chat/session-tile.tsx:884-1000`, `route-tile.tsx`, `session-draft-title.tsx`, `pr-tag.tsx`, `profile-tag.tsx` | Tile splits need drag; `max-w-[24rem]` empty state (`:573`) | no-touch |
| CH-46 | Sticky-prompt clip, find-in-chat | scrolling; ⌘F | `thread/use-sticky-prompt-clip.ts`, `components/find-bar.tsx:296-360` | Find bar `fixed right-4`, input `w-40`, uses Electron `findInPage` | desktop-only |
| CH-47 | Onboarding-chat cards (setup, build, frame) | first-run chat onboarding | `components/onboarding-chat/{gate,cards/*,options,signpost}.tsx` | | partial |

---

## 8. Composer

Composer dock is `absolute bottom-0 left-1/2 ... w-[min(var(--composer-width),calc(100%-2rem))]` (`composer/index.tsx:1587`); control size `--composer-control-size: 1.5rem` (`styles.css:543`); editor is a `contenteditable` (`rich-editor.ts`).

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| CP-01 | Composer shell + dock | chat view | `app/chat/composer/index.tsx:1295-1590` | Dock `max-w-full`; surface fades `opacity-30 group-hover/composer:opacity-100` after scroll-up (`:1492`) | |
| CP-02 | Rich editor (contenteditable, chips, undo, paste handling, large-paste, type-to-focus) | tap | `index.tsx:1181-1240`, `rich-editor.ts`, `large-paste.ts`, `paste-to-focus.ts` | Enter submits, Shift+Enter newline (`index.tsx:1003`) and `keyCode 229` handling in `lib/ime.ts` means soft-keyboard Enter/newline is unreliable; no `visualViewport` keyboard handling | |
| CP-03 | Attach "+" menu (files, folders, images, URL, snippets, contributed tools) | "+" at left | `composer/context-menu.tsx:11-100`, `app/chat/hooks/use-composer-actions.ts` | Pickers call `hermesDesktop.selectPaths` (`lib/desktop-fs.ts:276`); no `<input type=file>` fallback seen | desktop-only (pickers) / partial |
| CP-04 | Attachment chips | after attach | `composer/attachments.tsx:27,148-211` | Remove "x" is `size-3.5` (14px) `opacity-0 group-hover/attachment:opacity-100` (`:203`); `max-w-56` chips | no-touch |
| CP-05 | URL dialog | attach menu > Link | `composer/url-dialog.tsx`, `hooks/use-composer-url-dialog.ts` | Dialog | |
| CP-06 | Slash completion drawer (`/` commands, skills, themes, args; Tab descends) | type `/` | `composer/trigger-popover.tsx`, `completion-drawer.tsx:11` (`w-80 max-w-[calc(100%-1rem)] max-h-[min(22rem,calc(100vh-8rem))]`), `hooks/use-slash-completions.ts`, `lib/desktop-slash-commands.ts` | Arrow/Tab navigation is keyboard-first; tap to select works | |
| CP-07 | @ mention completions (files, folders, sessions, bots) | type `@` | `hooks/use-at-completions.ts`, `at-folder-navigation.test.tsx`, `plugins/hermes-bots/plugin.tsx:144` | File/folder results come from host FS | partial |
| CP-08 | `:` emoji completions | type `:` | `hooks/use-emoji-completions.ts` | | |
| CP-09 | Help hint (`?` shortcuts overlay) | type `?` | `composer/help-hint.tsx` | | |
| CP-10 | Model pill + model menu | tap pill; ⌘⇧M | see SBR-16 | `w-64` menu; label truncation | |
| CP-11 | Reasoning pill + menu | tap pill | see SBR-17 | hidden <560px | |
| CP-12 | Voice fan (hover fan-out: dictate, conversation, auto-speak, wake) / folded voice menu | hover or tap mic; ⌘⌥V | `composer/voice-fan.tsx`, `voice-menu.tsx`, `ui/fan-menu.tsx:244-290` (`onPointerEnter`), `controls.tsx:95-120` | Fan opens on pointer-enter (fires on touch-down); folds into menu when composer <260px | |
| CP-13 | Voice conversation pill, wake-word button, activity canvas, start-voice primary | during voice | `controls.tsx:217-360`, `voice-activity.tsx:163` (`h-4 w-[88px]`), `start-voice-button.tsx`, `hooks/use-voice-*.ts` | `getUserMedia`/AudioContext in WebView need permission wiring; wake word is Electron | partial |
| CP-14 | Send / Stop / Queue / Steer buttons | primary button right | `controls.tsx:128-176` | 24px; tooltip-only labels | |
| CP-15 | Queue panel + edit queued prompt | queue while busy | `composer/queue-panel.tsx`, `hooks/use-composer-queue.ts`, `index.tsx:1520-1535` | | |
| CP-16 | Status stack (todos, subagents + transcript, background tasks, goal/loop/heartbeat controls, coding row, preview rows, collapsed indicator) | above composer when active | `composer/status-stack/*.tsx` (`index.tsx:371` `max-h-[40vh]`, `subagent-section.tsx:81,84` `max-h-[25vh]`, `coding-row.tsx:246-281` hover actions), `drawer.css` | Hover-revealed row actions; vh caps vs keyboard | |
| CP-17 | Suggestion pills, action badges, onboarding skip, restored-draft notice | above composer | `suggestion-pills.tsx`, `micro-actions.tsx`, `restored-draft-notice.tsx` | | |
| CP-18 | Composer pop-out (float + drag) | Settings > Window; drag grab margin | `hooks/use-popout-drag.ts:89-116`, `hooks/use-composer-popout.ts`, `store/composer-popout.ts:25,157`, `index.tsx:1311-1330` | `fixed max-w-[calc(100vw-1.5rem)]`, width 19.5rem, mouse-drag | no-touch |
| CP-19 | Composer app context menu (cut/copy/paste, spellcheck) | long-press | `app/context-menu/app-context-menu.tsx:552-648` | Android long-press selects text first | |
| CP-20 | Screenshot attach / drop | shortcut | `hooks/use-composer-screenshot.ts`, `drop-affordance.ts`, `hooks/use-composer-drop.ts` | | desktop-only |
| CP-21 | Composer contributed slots (leading, actions, bottom, underside, middleware, atCompletions) | plugins | `composer/contrib.ts`, `index.tsx:1536-1570` | | |
| CP-22 | Composer HUD mode | HUD window | `controls.tsx:184-215`, `app/hud/hud-shell.tsx` | | desktop-only |

---

## 9. Global overlays, dialogs, toasts

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| OV-01 | Command palette (root + pages: settings, theme, install-theme, pets, sessions, projects, palette contributions) | ⌘K / ⌘P; Settings search pill; app context menu "Search"; `/palette` | `app/command-palette/index.tsx:542-1700`, `contrib.ts`, `marketplace-theme-page.tsx`, `pet-palette-page.tsx`, `store/command-palette.ts` | No titlebar/sidebar button opens it; `w-[min(34rem,calc(100vw-2rem))]`, `max-h-[min(20rem,56vh)]`, `HUD_POSITION` shifts below titlebar at <704px; Esc/Backspace steps back | partial (no direct touch entry) |
| OV-02 | Model picker overlay | `/model`; ⌘⇧M | `app/model-picker-overlay.tsx`, `components/model-picker.tsx:178-230` | Dialog `max-w-2xl max-h-[85vh]`, list `max-h-96` | |
| OV-03 | Model visibility (hide models) overlay | picker/menu "manage" | `app/model-visibility-overlay.tsx`, `components/model-visibility-dialog.tsx:124` (`max-w-xs`, list `max-h-[55vh]`) | | |
| OV-04 | Session picker (`/resume`, `/sessions`) | slash; "Browse all..." | `app/session-picker-overlay.tsx`, `components/session-picker.tsx:51-56` (`w-[min(40rem,calc(100vw-2rem))] top-[14vh]`) | `top-[14vh]` with soft keyboard | |
| OV-05 | Session switcher HUD | ⌃Tab / ⌃PgDn (hold) | `app/session-switcher.tsx:51` (`w-[min(19rem,calc(100vw-2rem))] max-h-[min(22rem,64vh)]`) | Keyboard-driven; rows clickable by `mousedown` | no-touch |
| OV-06 | Updates dialog | version pill; palette | `app/updates-overlay.tsx:120` (`max-w-sm`), `components/update-status.tsx:190`, `version-details.tsx` | Updater is Electron | desktop-only |
| OV-07 | Gateway connecting overlay | during connect | `components/gateway-connecting-overlay.tsx:151` | `fixed inset-0` | |
| OV-08 | Boot failure overlay | backend failed | `components/boot-failure-overlay.tsx:75,478,502` | `max-h-[86vh] max-w-[46rem]`, `p-6` | partial |
| OV-09 | Desktop install overlay | first run local | `components/desktop-install-overlay.tsx:448-605` | `p-8` card, `sm:grid-cols-2` | desktop-only |
| OV-10 | Remote first-run setup | no saved connection | `components/remote-setup/first-run.tsx:42-43`, `use-remote-setup.ts`, `use-remote-oauth.ts`, `fields.tsx` | `max-w-xl p-8`; key path for phone connection | |
| OV-11 | Onboarding overlay (provider picker, API key form, OAuth flow, free tier ready, preparing) | no provider configured | `components/onboarding/{index,flow,providers}.tsx:419-874` | `max-w-[45rem]`, `max-h-[60dvh]`/`42dvh` lists, `sm:grid-cols-2` | partial |
| OV-12 | Onboarding chat gate + guide loading + skip | first chat | `components/onboarding-chat/{gate,guide-loading,skip}.tsx` | `fixed inset-0 px-8` | |
| OV-13 | Free-tier sign-in dialog | statusbar chip; Settings > Billing | `components/free-tier/sign-in-dialog.tsx:107` | Dialog default width | |
| OV-14 | Shared-metrics consent dialog | after onboarding | `components/shared-metrics/consent-dialog.tsx:113` (`max-w-md`) | | |
| OV-15 | MCP install deep-link dialog | `hermes://` deep link | `app/contrib/mcp-install-deeplink-dialog.tsx` | Deep links are OS-level | desktop-only |
| OV-16 | Pet generate overlay | `/generate-pet`, palette | `app/pet-generate/pet-generate-overlay.tsx` | | partial |
| OV-17 | File action dialogs (new/rename/delete file or folder) | Files pane menu | `app/right-sidebar/file-actions.tsx` | Host FS | desktop-only |
| OV-18 | Remote folder picker | choose cwd on remote | `app/right-sidebar/files/remote-picker.tsx:183` (`max-w-lg h-[min(36rem,calc(100vh-4rem))]`) | Usable over gateway FS | |
| OV-19 | Confirm host (`confirm()`) | any destructive confirm | `components/confirm-host.tsx:43` (`grid-cols-[5rem_minmax(0,1fr)]`), `components/ui/confirm-dialog.tsx:133` (`max-w-md`) | Enter confirms | |
| OV-20 | Send diagnostics dialog | error card action | `components/send-diagnostics-dialog.tsx:51` (`max-w-[30rem]`) | | |
| OV-21 | External-open failed dialog | external link fails | `components/external-open-failed-dialog.tsx:44` | `hermesDesktop.openExternal` | partial |
| OV-22 | Session tile close confirm | close busy tile | `app/chat/session-tile-actions.ts`, `SessionTileCloseConfirm` | | |
| OV-23 | Toasts (top-center stack with "+N more", clear-all; bottom-right stack) | any `notify()` | `components/notifications.tsx:108-190` | `w-[min(28rem,calc(100%-2rem))]` top (`top-[calc(var(--titlebar-height,34px)+0.75rem)]`), `w-[min(24rem,...)]` bottom-right; fixed above modals | |
| OV-24 | Tips (TipHost bubbles) | idle app | `components/tips/{index,tip-bubble,use-tip-rotation}.tsx`, `tips.css` | Anchored to elements by rect | |
| OV-25 | App tour (driver.js popover + spotlight blur) | Settings > tours; first run | `lib/tour/*`, `app-tour.css:26-27` (`min-w-15rem max-w-20rem`) | Targets by `data-tour`; hidden targets skipped | |
| OV-26 | Keybind panel | ⌘/ | `app/hooks/use-keybinds.ts`, `keybinds.panel` (`controller.tsx:430`) | Keyboard reference | no-touch |
| OV-27 | Layout edit bar + zone editor + layout picker (Default/Basic/Focus/Terminal deck/Quad thumbnails) | titlebar layout button | `components/pane-shell/tree/renderer/edit-bar.tsx:74` (`w-[26rem] max-w-[calc(100%-2rem)]`, draggable card), `layout-picker.tsx:191-214` (`grid-cols-2/4`), `zone-editor.tsx:530` | Exit via Done button (also Esc); sashes 10px | |
| OV-28 | App context menu (selection, link, image, editable, terminal, guest) | right-click / long-press | `app/context-menu/app-context-menu.tsx:543-648` (`w-56`), `shell-menu-items.tsx:40-110` | Pane-level shell items: new chat, palette, toggle statusbar/profile rail/tab strip, settings | partial |
| OV-29 | Tooltips (`Tip`, `TooltipContent`) | hover / keyboard focus only | `components/ui/tooltip.tsx:13-250` (delay 200ms, `collisionPadding 12`) | Never open on touch; every icon-only control loses its label | no-touch |
| OV-30 | Generic Dialog | many | `components/ui/dialog.tsx:129,171,227` | See section 14 | |
| OV-31 | Bottom sheet (language switcher on mobile) | Settings > language | `components/language-switcher.tsx:94-98`, `components/ui/sheet.tsx:58-60` | `w-3/4 sm:max-w-sm` side sheets | |
| OV-32 | Profile dialogs (create, rename, delete) | Profiles overlay | `app/profiles/{create,rename,delete}-profile-dialog.tsx` | | partial |
| OV-33 | Archive-skill confirm | Learning/skills | `app/learning/archive-skill-confirm-dialog.tsx` | | |
| OV-34 | Cron job dialog / webhook dialog / starmap node + share dialogs | their overlays | `cron/index.tsx:1263`, `webhooks/index.tsx:420`, `starmap/node-context-menu.tsx:152`, `starmap/share-controls.tsx:92` | `max-w-lg/md/2xl` | |
| OV-35 | Remote display banner | Electron remote display | `components/remote-display-banner.tsx` | | desktop-only |

---

## 10. Right sidebar / rail (files, review, terminal, preview, logs)

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| RS-01 | Files pane (tree) | titlebar right toggle; ⌘J; palette | `app/right-sidebar/index.tsx`, `files/tree.tsx:315-345`, `files/use-project-tree.ts`, `files/ipc.ts` | Slide-over on narrow (`min(237px,85vw)`); local FS via Electron IPC | desktop-only (local tree) / partial (remote) |
| RS-02 | Files header actions (label-reveal buttons) | hover header | `right-sidebar/index.tsx:142,220` | `pointer-events-none opacity-0` until hover/focus | no-touch |
| RS-03 | File row drag (to composer) | press-drag | `files/tree.tsx:315,345`, `files/dnd-manager.ts` | HTML5 drag | no-touch |
| RS-04 | Review pane (git diff, files, ship bar) | ⌘G; palette | `right-sidebar/review/index.tsx`, `file-tree.tsx:395-456`, `ship-bar.tsx`, `churn-bar.tsx` | Row actions `hidden group-hover/review-row:flex` (`:423`), draggable rows; host git | desktop-only |
| RS-05 | Terminal pane (xterm) + chrome + rail + tabs | statusbar terminal button; ⌃`; ⌃⇧` new | `right-sidebar/terminal/{chrome,rail,instance,persistent,workspace}.tsx`, `use-terminal-session.ts:513,1185` | PTY via `hermesDesktop.terminal`; rail action `opacity-0 group-hover/rail:opacity-100` (`rail.tsx:90`); height `20vh`; hardware keyboard | desktop-only |
| RS-06 | Terminal context menu / selection / paste | right-click | `terminal/terminal-context-menu.ts`, `selection.ts`, `clipboard.ts` | | desktop-only |
| RS-07 | Preview tile: embedded browser (address bar, back/forward, reload, devtools, pop-out) | open URL / file double-click / `/browser` | `app/chat/right-rail/preview-pane.tsx:1134` (`document.createElement('webview')`), `preview-browser-bar.tsx`, `preview-tile.tsx` | `<webview>` is an Electron element; inert in Android WebView | desktop-only |
| RS-08 | Preview file viewer (text, markdown, CSV table, image, PDF) | file preview | `right-rail/preview-file.tsx:389,706,1180-1215` | Table `min-w-[18rem]`, diff grid `min-w-max`; PDF via `<iframe>` (Android WebView cannot render PDFs inline) | partial |
| RS-09 | Preview artifact (sandboxed HTML iframe) | artifact preview | `right-rail/preview-artifact.tsx:77-97` | `<iframe sandbox="allow-scripts">` works | |
| RS-10 | Preview console panel (resize sash) | browser tile | `right-rail/preview-console.tsx:84,111,205-210` | `cursor-row-resize` 2px sash, hover rows | desktop-only |
| RS-11 | Annotate mode + card + handoff | browser tile | `right-rail/preview-annotate-*.ts(x)`, `lib/preview-annotate/*` | Pointer-position in guest page | desktop-only |
| RS-12 | Real-profile consent dialog | browser tile | `right-rail/real-profile-consent-dialog.tsx` | | desktop-only |
| RS-13 | Logs pane (agent log tail) | palette "Toggle logs" | `app/contrib/panes.tsx:35-95`, `controller.tsx:651-697` | `pre` auto-scroll; ⌘K-only | partial |
| RS-14 | Browser pop-out shell | `?win=browser` | `app/chat/browser-popout-shell.tsx:26` | Separate window | desktop-only |

---

## 11. Layout system (tiling, zones, splitters)

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| PL-01 | Layout tree + presets (Default, Basic, Focus, Terminal deck, Quad; Simple sidebar-left/right) | titlebar layout button > picker; Settings > Window | `app/contrib/layout-presets.ts`, `components/pane-shell/tree/{model,presets,store}.ts` | Default tree keeps a terminal column on narrow (non-collapsible); persisted per mode (`modeLayout`) | |
| PL-02 | Splits + sashes (drag, dblclick reset) | seams between zones | `renderer/tree-split.tsx:221-860` (`cursor-col-resize`/`row-resize`, `:821`), `track-model.ts` (`MIN_PANE_PX = 80`, `COLLAPSED_ZONE_PX = 28`) | 8px sash hit area; mouse-only intent | no-touch |
| PL-03 | Zones / tab strips / minimize rails | tabs, chevrons | `renderer/tree-group.tsx:394-860` | Minimized rail `w-7`; tab menu on right-click | |
| PL-04 | Narrow-viewport edge overlays | titlebar toggles (<640px); edge hover strip | `renderer/narrow-overlays.tsx:48-279` | See Layout engine; Esc closes; `onMouseLeave` dismisses unpinned | |
| PL-05 | Floating panes (fixed cards) | plugin `placement: 'floating'` | `renderer/floating-panes.tsx:59-60` | Anchors to window corners | |
| PL-06 | Flip sidebars | titlebar flip; ⌘\ | `store/layout.ts` (`togglePanesFlipped`) | | |
| PL-07 | Simple / Advanced interface mode | Settings > Window; palette | `store/interface-mode.ts` | Simple hides statusbar, terminal, files, review rows | |
| PL-08 | Tab drag-to-dock, multi-tab selection (⌥/Shift click) | tab drag | `renderer/drag-session.ts`, `tab-selection.ts` | Pointer drag with thresholds | no-touch |
| PL-09 | Keep-alive pane hosts | internal | `renderer/keep-alive-panes.tsx` | Memory on phone | |

---

## 12. Separate windows, HUD, pet

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| WN-01 | HUD chat bar | `?win=hud`; ⌘⇧H; titlebar HUD button | `app/hud/*`, `app/floating-hud.ts` | Spotlight-style transparent window | desktop-only |
| WN-02 | Pet overlay window | `?win=overlay` | `app/pet-overlay/*` | Transparent window | desktop-only |
| WN-03 | Quick entry window | `?win=quick` | `app/quick-entry/*` | Global shortcut | desktop-only |
| WN-04 | Wake indicator window | `?win=wake` | `app/wake-indicator/*` | | desktop-only |
| WN-05 | Secondary/session window | `?win=secondary&...` | `store/windows.ts`, `app/contrib/controller.tsx` | Single-chat shell | desktop-only |
| WN-06 | Watch window (spectate subagent) | `?win=watch` | `store/windows.ts:57-` | | desktop-only |
| WN-07 | In-app floating pet + bubble + egg + star shower | Settings > Pet; `/pet`, `/hatch` | `components/pet/floating-pet.tsx:50-77,339-478` (`position: fixed; touchAction: none`; `window.innerWidth` clamp with 800 fallback), `pet-bubble.tsx` | Pointer drag OK on touch; may cover composer; roams | |

---

## 13. Plugins

| ID | Name | Reach | Source | Phone risks | Status |
|---|---|---|---|---|---|
| PG-01 | Bots roster pane (sessions zone tab) + create/edit dialogs + MCP setup + model picker | sessions pane "Bots" tab | `plugins/hermes-bots/plugin.tsx:442-520`, `roster-pane*.tsx`, `create-dialog.tsx:619` (`maxHeight 90vh`), `edit-profile-dialog.tsx:188` | Pane `width: 260px` collapsible; DnD ordering | partial |
| PG-02 | Bots Screen pane / group chat view / group chat members | Bots row | `screen-pane.tsx:495`, `group-chat-view.tsx:1349,1473`, `group-panes.ts` | Dedicated pane `width 250px` | partial |
| PG-03 | Kanban board, switcher, drawer, new-task dialog, orchestration | `#/kanban` | `plugins/kanban/{board,board-switcher,drawer,orchestration}.tsx:688,972` | Dialog `w-[min(42rem,94vw)]`; drawer `max-h-[min(84vh,54rem)]`; DnD | no-touch |
| PG-04 | Radio player (statusbar) | statusbar | `plugins/radio/plugin.js` | Streams | |
| PG-05 | Hello-runtime chip | statusbar | `plugins/hello-runtime/plugin.runtime.js` | | |

---

## 14. Cross-cutting tables

### 14a. Radix/popover width constraints

| ID | Primitive / surface | Width constraint | Source |
|---|---|---|---|
| RX-01 | DropdownMenuContent | `min-w-36`, `max-h` = Radix available height, `collisionPadding 8`, `sideOffset 4` | `components/ui/dropdown-menu.tsx:235-265` |
| RX-02 | DropdownMenuSubContent | `min-w-36`, fixed `max-h-80`, opens to the side | `dropdown-menu.tsx:475-513` |
| RX-03 | ContextMenuContent / Sub | `min-w-36`; sub `max-h-80`; long-press to open | `components/ui/context-menu.tsx:35,149-166` |
| RX-04 | PopoverContent | fixed `w-72` (18rem), `collisionPadding 8`, `sideOffset 6` (4 for menu variant) | `components/ui/popover.tsx:24,62-79` |
| RX-05 | SelectContent | `min-w-36`, `max-h-72` / `min(18rem, available)`, popper width = trigger width | `components/ui/select.tsx:51-81` |
| RX-06 | Dialog | `fixed left-1/2 top-1/2 w-full max-w-lg max-h-[85vh]`; `fitContent` = `w-auto max-w-[92vw]`; inner body `max-h-[calc(85vh-5rem)]` | `components/ui/dialog.tsx:129,171,189` |
| RX-07 | ConfirmDialog | `max-w-md` | `components/ui/confirm-dialog.tsx:133` |
| RX-08 | Setup form dialog | `w-[min(32rem,calc(100vw-2rem))]` | `components/ui/setup-form-dialog.tsx:69` |
| RX-09 | Sheet | side sheets `w-3/4 sm:max-w-sm`; language switcher bottom sheet `max-h-[min(28rem,80vh)]` | `components/ui/sheet.tsx:58-60`, `language-switcher.tsx:98` |
| RX-10 | Command list | `max-h-72` (menu) / `max-h-100` | `components/ui/command.tsx:94` |
| RX-11 | Tooltip | `collisionPadding 12`, hover/focus only | `components/ui/tooltip.tsx:172-228` |
| RX-12 | Statusbar menus | default `w-56`; gateway `w-72`; context-usage `w-auto` (inner `w-72`); visibility ctx `w-52` | `statusbar-controls.tsx:271-273,~140`, `use-statusbar-items.tsx:521,694` |
| RX-13 | Composer menus | model `w-64`, reasoning `w-52`, model edit submenu `w-52`, completion drawer `w-80` (`max-w-[calc(100%-1rem)]`) | `model-pill.tsx:220`, `reasoning-pill.tsx:90`, `model-edit-submenu.tsx:103`, `completion-drawer.tsx:11` |
| RX-14 | Sidebar menus | filter `min-w-52`; project `w-48`; connection `min-w-52 max-w-72` (searchable `w-72`); profile `min-w-48 max-w-72`; launch ctx `min-w-52` | `filter-menu.tsx:255`, `project-menu.tsx:236`, `connection-switcher.tsx:146`, `profile-switcher.tsx:923`, `profile-launch-menu.tsx:67` |
| RX-15 | HUD-style floaters | palette `w-[min(34rem,calc(100vw-2rem))]`; session picker `w-[min(40rem,...)]`; switcher `w-[min(19rem,...)]`; toasts `w-[min(28rem,calc(100%-2rem))]` (top) or `w-[min(24rem,calc(100%-2rem))]` (bottom-right) | files cited in OV-01/04/05/23 |
| RX-16 | App/zone context menus | app menu `w-56`; zone/tab `w-40`; approval dropdown `min-w-44` | `app-context-menu.tsx:648`, `tree-group.tsx:229`, `tool/approval.tsx:363` |
| RX-17 | Tour popover | `min-width 15rem`, `max-width 20rem` | `lib/tour/app-tour.css:26-27` |

### 14b. Hover-only affordances (no `pointer: coarse` fallback; `:hover` sticks after tap)

| ID | Affordance | Source |
|---|---|---|
| HV-01 | Assistant action bar (copy, branch, read aloud, regenerate) `opacity-0 pointer-events-none group-hover` | `components/assistant-ui/thread/assistant-message.tsx:1039-1042` |
| HV-02 | User bubble stop/restore buttons | `thread/user-message.tsx:506` |
| HV-03 | Session row kebab (`text-transparent`) and tail swap | `app/chat/sidebar/session-row.tsx:118,345` |
| HV-04 | Sidebar section "+"/chevron reveals, drag handle | `app/chat/sidebar/chrome.tsx:41,156,310,356`, `sessions-section.tsx:94`, `index.tsx:272` |
| HV-05 | Cron row actions swap | `app/chat/sidebar/cron-jobs-section.tsx:332-389` |
| HV-06 | Composer attachment remove "x" | `app/chat/composer/attachments.tsx:203` |
| HV-07 | Tool block copy button, disclosure caret | `components/assistant-ui/tool/fallback.tsx:558,658` |
| HV-08 | Image download/zoom buttons | `components/chat/zoomable-image.tsx:73,200,226`, `generated-image-result.tsx:107` |
| HV-09 | Markdown table column resize handles | `markdown-table.tsx:206` |
| HV-10 | Model menu row favorite star, model edit submenu open | `app/shell/model-catalog-menu.tsx:765,1076` |
| HV-11 | Tab "x" close chip, zone chevrons | `components/pane-shell/tree/renderer/tree-group.tsx:604,1055` |
| HV-12 | Narrow-overlay edge hover strip | `renderer/narrow-overlays.tsx:193` |
| HV-13 | Voice fan-out (`onPointerEnter`) | `components/ui/fan-menu.tsx:251-290` |
| HV-14 | Command Center session row actions | `app/command-center/index.tsx:432` |
| HV-15 | Overlay `Panel` row action buttons, keybind reset buttons, pet card actions, provider key caret | `app/overlays/panel.tsx:267`, `settings/keybind-settings.tsx:284,299`, `settings/pet-settings.tsx:209`, `settings/credential-key-ui.tsx:223,312` |
| HV-16 | Terminal rail actions, files header actions, review row actions, status-stack row actions | `terminal/rail.tsx:90`, `right-sidebar/index.tsx:142`, `review/file-tree.tsx:423`, `composer/status-stack/coding-row.tsx:246-281` |
| HV-17 | Tooltips everywhere (icon-only buttons have no visible label on touch) | `components/ui/tooltip.tsx` |
| HV-18 | Composer surface dims to 30% until hover/focus after scroll-up | `composer/index.tsx:1492`, `status-stack/index.tsx:394` |
| HV-19 | Thread timeline tick hover paint | `thread/timeline-rail.tsx` |

### 14c. Keyboard shortcuts without a (discoverable) touch equivalent

Defaults in `lib/keybinds/actions.ts`.

| ID | Action | Default | Touch path? |
|---|---|---|---|
| KB-01 | Command palette `nav.commandPalette` | ⌘K, ⌘P | Only the Settings search pill and app context menu |
| KB-02 | Switch sessions `session.next/prev`, `session.slot.N` | ⌃Tab/⌃PgDn, ⌘1..9 | Sidebar |
| KB-03 | Focus session search `session.focusSearch` | ⌘⇧F | Tap search |
| KB-04 | Find in page `view.findInPage`/next/prev | ⌘F | None (and Electron) |
| KB-05 | Reopen closed tab `view.reopenTab`; close tab `view.closeTab` | ⌘⇧T, ⌘W | Tab "x" is hover-only |
| KB-06 | Toggle statusbar, tab strip, profile rail, Simple mode | ⌘⇧S, ⌘⌥T, none, none | App context menu / palette |
| KB-07 | Terminal show/new/next/prev/close | ⌃`, ⌃⇧`, ⌃⇧Down/Up, ⌃⇧W | Statusbar terminal button |
| KB-08 | Review/Files/Browser toggles | ⌘G, none, ⌘⇧L | Titlebar right toggle / palette |
| KB-09 | HUD toggle | ⌘⇧H | Titlebar HUD button (desktop-only) |
| KB-10 | Profile next/prev/default/toggle all | ⌘⇧]/[, ⌘D, ⌘⇧0 | Profile rail |
| KB-11 | Composer: focus (`/`, Enter), send (Enter), newline (Shift+Enter), queue (⌘Enter), steer, history (Up/Down), cancel (Esc), help (`?`), slash/mention triggers, Tab to descend | see `actions.ts:316-337` | Send button; newline and queue lack buttons (queue button appears while busy) |
| KB-12 | Composer voice `composer.voice`, dictate | ⌘⌥V (⌃B on mac), none | Mic button |
| KB-13 | Scroll page `conversation.scrollPageUp/Down` | PgUp/PgDn | Touch scroll |
| KB-14 | Appearance toggle `appearance.toggleMode` | ⇧X | Settings > Theme |
| KB-15 | Layout edit mode exit | Esc (also the "Done" button) | Done button |
| KB-16 | Overlay dismiss, narrow overlay dismiss, palette back | Esc / Backspace | Overlay "X"/backdrop; narrow overlay needs a titlebar toggle press; palette has a "Back" row |
| KB-17 | Starmap playback | Space (`starmap/playback-hotkey.ts`) | None |
| KB-18 | Approval keys, clarify submit shortcut, ConfirmDialog Enter | `lib/keybinds/approval-keys.ts`, `clarify/submit-shortcut.ts` | On-screen buttons |
| KB-19 | Settings type-to-search (printable key opens scoped palette) | any key | Search pill |
| KB-20 | Session row click modifiers | ⇧, ⌘, ⌥ | Plain tap only |

### 14d. Drag-and-drop, resize and pointer-gesture-only interactions

| ID | Interaction | Source |
|---|---|---|
| DD-01 | Sash drag between zones; double-click reset | `components/pane-shell/tree/renderer/tree-split.tsx:221-560,778-840` |
| DD-02 | Tab drag to dock/stack/split; multi-tab drag | `renderer/drag-session.ts`, `tree-group.tsx:630-700` |
| DD-03 | Session row drag: to composer (link), to chat edge (tile), reorder | `app/chat/session-drag.ts`, `new-session-drag.ts`, `sidebar/reorderable-list.tsx` |
| DD-04 | Pinned/profile/gateway-group reorder (dnd-kit) | `sidebar/profile-switcher.tsx:1473`, `gateway-groups.tsx:294` |
| DD-05 | Files/review tree rows (HTML5 `draggable`) to composer | `right-sidebar/files/tree.tsx:315-345`, `review/file-tree.tsx:395-398`, `files/dnd-manager.ts` |
| DD-06 | Kanban card drag between columns (HTML5 DnD) | `plugins/kanban/board.tsx:286-289,410-416` |
| DD-07 | MasterDetail column sash and bottom detail-pane sash | `app/master-detail.tsx:131,277` |
| DD-08 | Preview console height sash | `right-rail/preview-console.tsx:205` |
| DD-09 | Composer pop-out drag | `hooks/use-popout-drag.ts` |
| DD-10 | Layout edit card drag, zone editor handles | `renderer/edit-bar.tsx:50-58`, `zone-editor.tsx:530-542` |
| DD-11 | Floating pet drag (pointer events + `touch-action: none`) | `components/pet/floating-pet.tsx:339-478` |
| DD-12 | Star Map pan/zoom/node hover (mouse events, wheel) and timeline scrub | `app/starmap/star-map.tsx:809-947`, `timeline.tsx:199` |
| DD-13 | File drop onto chat/terminal (OS drag) | `app/chat/hooks/use-file-drop-zone.ts`, `use-terminal-session.ts:706-733` |
| DD-14 | Pinch/pan zoom in lightbox | `components/ui/use-zoom-pan.ts` (pointer events, supports touch) |

---

## 15. Likely mobile hazards (ranked)

1. **Overlay card inset eats the screen.** Every overlay (Settings, Command Center, Agents, Cron, Webhooks, Profiles, Starmap, Session import) pads `calc(34px + 0.625rem)` = 44px on all four sides (48px at `sm:`), so the card is 256px wide at 344px and 324px at 412px, then main adds `px-[clamp(0.8333rem,2.6667vw,...)]`. `app/overlays/overlay-view.tsx:82-83`. Combined with settings controls pinned at `min-w-60`/`min-w-56`/`w-56` (`settings/model-settings.tsx:969,997`, `notifications-settings.tsx:95`, `capabilities/scope-selector.tsx:210`, `fallback-models-field.tsx:146`) content overflows horizontally.
2. **Touch targets are 20-24px.** Statusbar `h-5` (`app/shell/statusbar-controls.tsx:104`), titlebar controls 24px (`app/shell/titlebar.ts:8`), composer controls `--composer-control-size: 1.5rem` (`styles.css:543`), kebab/section buttons `size-5` (`session-row.tsx:345`, `load-more-row.tsx:25`), attachment remove `size-3.5` (`composer/attachments.tsx:203`), timeline ticks 7px (`thread/timeline-rail.tsx`, `timeline.css:18-37`).
3. **Hover-only controls with no coarse-pointer fallback.** Reply actions (copy/branch/regenerate/read aloud) `opacity-0 pointer-events-none group-hover` (`thread/assistant-message.tsx:1039-1042`), session kebab `text-transparent` (`sidebar/session-row.tsx:345`), attachment remove (`attachments.tsx:203`), tool copy (`tool/fallback.tsx:658`), image download (`zoomable-image.tsx:226`), user bubble actions (`user-message.tsx:506`). `hover` is forced to plain `:hover` (`styles.css:13-16`) so behaviour depends on sticky tap-hover. Tooltips (all icon-only labels) never open on touch (`components/ui/tooltip.tsx`).
4. **Narrow-mode sidebars rely on a hover strip and a titlebar toggle.** Edge reveal is `onMouseEnter` on a 6px strip (`components/pane-shell/tree/renderer/narrow-overlays.tsx:193`); touch must use the titlebar toggle; dismissal is `onMouseLeave`/Esc; the overlay stays pinned afterward. Collapse threshold is viewport 640px (`app/layout-constants.ts:30-32`).
5. **Docked sessions rail at 690/768/829.** At >=640 the sessions pane docks at a fixed 237px (`app/contrib/controller.tsx:213-215`), leaving about 453px for the workspace at 690 while pages still use viewport-based `sm:` / 760px / `@2xl` rules: `app/master-detail.tsx:53,121,131`, `app/overlays/panel.tsx:91,128`, `overlays/overlay-split-layout.tsx:16-60`, `settings/primitives.tsx:146`. Workspace pane only guarantees `minWidth: 22vw` (`controller.tsx:226`).
6. **Titlebar clusters are `fixed z-70` and offset for macOS traffic lights.** `titlebarControlsPosition` returns `left = 98px` unless `connection.windowButtonPosition === null` (`app/shell/titlebar.ts:93-110`, `app/contrib/wiring.tsx:1289`), and right-hand clusters (up to 5 + pane tools) can collide with tab strips and overlay "X" at 344px. Set `windowButtonPosition: null` in the host shim.
7. **Electron-only surfaces in the default layout.** Preview/browser uses `document.createElement('webview')` (`app/chat/right-rail/preview-pane.tsx:1134`), terminal PTY via `hermesDesktop.terminal` (`right-sidebar/terminal/use-terminal-session.ts:513`), file/review trees via local IPC (`right-sidebar/files/ipc.ts`), attach pickers via `hermesDesktop.selectPaths` (`lib/desktop-fs.ts:276`), find bar via Electron `findInPage` (`components/find-bar.tsx`). Expect empty/broken panes unless shimmed or hidden.
8. **Composer input semantics.** Enter submits, only Shift+Enter inserts a newline (`app/chat/composer/index.tsx:1003`), with legacy `keyCode 229` handling (`lib/ime.ts`) that Android keyboards trigger; no mobile "Enter inserts newline" mode. `contenteditable` with chips, `/` `@` `:` completion that is arrow/Tab-first (`index.tsx:804-960`), and no `visualViewport`/`interactive-widget` handling, so the dock may sit under the keyboard.
9. **Shell uses `h-screen`/`w-screen` and ignores safe areas.** `app/contrib/controller.tsx:830,838` (100vh), `components/ui/dialog.tsx:171` (`max-h-[85vh]`), several `vh` caps (`status-stack/index.tsx:371`, `completion-drawer.tsx:11` `calc(100vh-8rem)`); no `env(safe-area-inset-*)`, no dvh for the shell, meta viewport has no `viewport-fit=cover`.
10. **Star Map is mouse-only.** `onMouseDown/Move/Up/Leave`, `onWheel`, `onContextMenu`, `onDoubleClick` on a `touch-none` canvas (`app/starmap/star-map.tsx:809-947`): no touch pan/zoom/select; timeline scrub is pointer-based but 28rem wide (`starmap/timeline.tsx:184`).
11. **HTML5 drag-and-drop and custom pointer drags have no touch path.** Kanban cards (`plugins/kanban/board.tsx:286-289`), files/review rows (`right-sidebar/files/tree.tsx:315`, `review/file-tree.tsx:395`), session rows (`app/chat/session-drag.ts`), tab drag, sashes (`tree-split.tsx:821`); layout editing, tiling and reordering are effectively desktop-only.
12. **Lightbox and notices sized off viewport minus fixed rem.** Image lightbox `max-w-[calc(100vw-12rem)]` = 152px at 344px (`components/chat/zoomable-image.tsx:172,190`); system/notice rows `w-[60%]` (~170px at 344px, `thread/system-message.tsx:145,170`); thread gutters `px-6` (`thread/list.tsx:1568`) plus the right-edge timeline rail 48px wide and `z-40` over text (`thread/timeline.tsx:302-326`).
13. **Command palette is keyboard-entered.** `⌘K` is the only direct entry (`app/hooks/use-keybinds.ts:293-298`); touch reaches it through the Settings search pill, the app context menu (long-press), or not at all (`app/context-menu/shell-menu-items.tsx:62`). Many features (grouping toggles, reopen tab, cycle sessions, terminal, layout reset, Simple mode) are only in the palette/keybinds. Palette sub-pages step back with Esc/Backspace (`command-palette/index.tsx:1631-1645`).
14. **Wide content that relies on horizontal scroll.** Artifacts table `min-w-176` = 704px (`app/artifacts/index.tsx:696`), diff rows `min-w-max` (`components/chat/diff-lines.tsx:54-55,656`), terminal output `w-max` 9px mono (`components/chat/terminal-output.tsx:60`), markdown tables `min-w-[18rem]` (`markdown-table.tsx:160`), Kanban columns `w-64` (`plugins/kanban/board.tsx:455`), Connector dialog `min-w-[min(48rem,90vw)]` (`capabilities/connectors/add-dialog.tsx:82`); nested scroll areas fight vertical swipe.
15. **Popovers anchored to a side, with desktop-only click models.** Model menu sub-menu opens to the side, `w-52` (`app/shell/model-edit-submenu.tsx:103`); statusbar menus `side=top` `w-56` (`statusbar-controls.tsx:271-273`); Radix `DropdownMenuSub`/`ContextMenu` need long-press; right-click-only menus (statusbar visibility, zone menu, session context menu, app context menu `w-56`, `app-context-menu.tsx:648`) depend on Android `contextmenu` long-press, which also starts text selection; Esc is the only dismissal for some layers (`lib/escape-layers.ts` users: narrow overlay, layout edit, overlay view) and Android Back does not emit it.

---

## 16. Suggested Playwright audit order

1. Narrow (344x882 and 412x915): `#/`, open sidebar via titlebar toggle, a session route, composer states (type `/`, `@`, attach, model menu, voice), every overlay route, Settings with each `tab`/`page`, Capabilities tabs, Messaging, Artifacts, `#/kanban`, command palette via Settings pill, statusbar (toggle on), toasts, dialogs from CH-20/CH-22.
2. Docked (690x829, 829x690, 768x1024): same list; additionally verify the 237px rail plus `sm:` mismatches (R-06, R-07, R-09, R-15), the 760px overlay split switch, and `compact:` flattening at 829x690.
3. Toggle Settings > Window & layout > Simple mode and re-run (statusbar, terminal, files, review rest closed).
4. Mark every `desktop-only` row as expected-inert and assert it does not crash the shell (error boundaries: `components/error-boundary.tsx`, `overlay-error-boundary.tsx`, `contrib/react/boundary.tsx`).
