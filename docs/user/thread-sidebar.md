<a id="working-with-threads"></a>

# Working with mines

Use a new mine for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

<a id="start-a-thread"></a>

## Start a mine

On web and desktop, a new mine keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New mine in this worktree** from the branch toolbar.

When you change a new mine's project, mines stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A mine does not need a project. To start one without a project, click **or
start without a project** under a new mine's heading, pick **No project** from
the project menu in that heading or from **New mine in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each mine without a project works in its own folder under `~/.mines/scratch` (the
`scratch` folder of your mines data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a mine keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new mine and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To select several models on web or desktop, **Shift-click** models in the picker
or use their selection controls. A regular click selects one model. Choose a
workflow: **Compare** produces independent answers; **Team** shares a group stream;
**Build + review** pairs a builder with reviewers; **Council** adds critique and
synthesis. Build + review and Council let you choose the lead model.

From a new mine in a Git project, the composer can prepare separate worktrees
for the selected models. The retained workflow launcher also lets you choose
existing mines and targets; a group itself does not require a Git repository.
No workflow merges code automatically. Group workflows accept text and workspace
references; send attachments to an individual mine when needed.

## Organize your library

**Library** is the default view on desktop and phone. Create sections, place projects
inside them, and keep mines or groups inside projects, inside sections, or directly
in the library. Moving a mine here changes its organization; its computer and working
folder stay the same.

Pin any mine, group, project, section, or device from its menu. Pinned containers are
shortcuts to their contents. On desktop, drag an item's grip between rows to reorder
it, onto a project or section to move it inside, or into **Pinned** to add a shortcut.
Sections stay at the library's top level. Use **Move to**, **Move up**, and **Move down**
from the item's menu for keyboard access or on your phone.

On desktop, choose **Archive** from a section's menu. **Archive section** keeps its
contents in the library; **Archive all related projects & mines** also archives its
projects and mines. Restore an archived section from the library menu to recover
its organization and the contents archived with it. Archiving keeps the underlying
files and conversations.

Library order and pins belong to your signed-in mines account. You can arrange them
offline; approved devices merge those changes when a direct connection becomes
available. Concurrent moves of the same item settle on one shared position. Items
on sleeping or disconnected computers remain visible so their places are preserved.

Choose **Instructions & sources** from a project or section's menu to add guidance
for its mines and select files or folders as context. Section instructions apply
first, followed by project instructions. The preview shows what is inherited.
Moving a mine changes the instructions used for its next message; a running turn
keeps the context it started with.

Each source belongs to the computer selected when you add it. Choose an exact path,
not a pattern. Adding a source does not copy its contents to other computers: the AI
reads it on that computer as needed. Sources on other computers remain visible in
the editor but are not applied to work running elsewhere. Remove a source or clear
the instructions in the same editor when they are no longer needed.

## Activity view

Switch to **Activity** for the working, snoozed, and settled shelves. Its mine
state controls are separate from your library organization. The behavior in this
section applies to the Activity view.

Use each mine’s menu to settle finished work, snooze it until later, or archive it.
Library keeps your pins and chosen positions independently of these activity states.
On web and desktop, settling, snoozing, and archiving offer **Undo**; `mod+z` triggers
the most recent Undo. See [Keybindings](./keybindings.md#commands-with-special-behavior).

To generate a fresh title from the conversation, open a mine's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Mine title instructions** in **Settings → General →
Text generation**, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through mines can use the same server-owned metadata workflow to
rename a mine, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

<a id="fold-working-threads-beta"></a>

### Fold working mines (beta)

Turn on **Settings → Beta → Working section** on web and desktop, or **Settings →
Mine behavior → Working section** on iOS and Android, to move mines that are working or
waiting on work they will resume from into a collapsed **Working** section below the active list.
That includes subagents, watched pull requests, and background commands or monitors the agent
says it is waiting on. A dev server or other process an agent leaves running does not keep a mine
there. A mine returns to the top of the active list when it finishes, fails, or needs an approval or
answer. The Working section lists the mine you last sent work to first. Your library
pins stay unchanged. Each device keeps its own choice.

While this is on, the active list is ordered by when each mine last came back to you.
Use Library for your shared manual order.

## Settle finished work

Choose **Settle mine** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle mine** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle mine dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the mine's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the mine's worktree when the
mine settles** for one of the project's actions, or set `"runOnSettle": true` on a
`mines.json` script, for example `cargo clean`. It runs each time a mine in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Mines in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a mine's **Settle** button and drag up or down to
settle every mine in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive mines after three days and settle
mines whose pull request merged. A closed pull request can also settle an idle
mine. An empty mine's inactivity counts from when it was created.
Work in progress, pending questions or approvals, and background work the agent
is waiting on prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep mines with a PR** in **Settings → General**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one mine out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → General** on web and desktop, or **Settings → Mine behavior** on mobile.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled mines.

## Link a pull request

The server finds the PR for each unsettled mine's saved branch, even when your
apps are closed. Settled mines keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a mine and choose
**Link to mine** to select a different PR. Use **Unlink from mine** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search mines
across connected environments by title, branch, pull request, or project.
Mines you open often or recently rank higher, and for three weeks the mine
you last picked for a query ranks higher when you type that query again.
Mines whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
On mobile, the mine list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a mine reference. A copied reference uses the mine's pull request
link when available, otherwise its mine ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

Use **Contacts** and **Shared groups** to talk with friends and bring selected mines
into a shared conversation. See [Contacts and shared groups](./contacts.md).

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the mine. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the mine. Enable **Auto-resume limited
mines** in **Settings → General** on web and desktop, or **Settings → Mine
behavior** on mobile, to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the mine, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the mine until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the mine without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze limited mines** in mine behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
Stop on a mine also stops the subagents it delegated to.

Subagent mines started by the agent can't take messages; message the parent
mine instead. When such a subagent needs an approval or an answer, the parent
mine asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Snooze until later

Choose **Snooze → Custom…** from a mine's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected mines together. Choose **Wake mine** to bring a mine back early.
A snoozed mine keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early only when it needs
an approval or answer from you, when a run fails, or when you send it a message.
