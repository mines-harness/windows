import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { MinesCatalog } from "@t3tools/client-runtime/catalog";
import { render } from "../../../test/render";
import { CatalogSectionArchiveDialog } from "./CatalogSectionArchiveDialog";
import "~/index.css";

function Fixture({
  catalog,
  section,
  onArchive,
}: {
  catalog: MinesCatalog;
  section: string;
  onArchive: (includeContents: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open archive</button>
      {open ? (
        <CatalogSectionArchiveDialog
          title={catalog.getEntity(section)!.title}
          onArchive={onArchive}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function setup() {
  const catalog = new MinesCatalog();
  const section = catalog.createSection("Work");
  catalog.upsert({ id: "mine", kind: "thread", title: "Mine" }, { parentId: section });
  const onArchive = vi.fn(async (includeContents: boolean) => {
    catalog.archiveSection(section, { includeContents });
  });
  return { catalog, section, onArchive };
}

it("cancels with Escape and Cancel without changing the section or linked content", async () => {
  const { catalog, section, onArchive } = setup();
  await using screen = await render(
    <Fixture catalog={catalog} section={section} onArchive={onArchive} />,
    { router: false },
  ); // Archiving does not navigate.
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Open archive" }));
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(onArchive).not.toHaveBeenCalled();
  expect(catalog.getSnapshot().roots[0]?.children[0]?.entity.id).toBe("mine");
  expect(catalog.getArchivedSections()).toEqual([]);
});

it("offers section-only and all-content archive as distinct reversible actions", async () => {
  const { catalog, section, onArchive } = setup();
  await using screen = await render(
    <Fixture catalog={catalog} section={section} onArchive={onArchive} />,
    { router: false },
  ); // Archiving does not navigate.
  await userEvent.click(page.getByRole("button", { name: "Archive section", exact: true }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(catalog.getSnapshot().roots[0]?.entity.id).toBe("mine");
  catalog.restoreSection(section);
  await userEvent.click(screen.getByRole("button", { name: "Open archive" }));
  await userEvent.click(
    page.getByRole("button", { name: "Archive all related projects & mines", exact: true }),
  );
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(catalog.getSnapshot().roots).toEqual([]);
  catalog.restoreSection(section);
  expect(catalog.getSnapshot().roots[0]?.children[0]?.entity.id).toBe("mine");
});

it("keeps the confirmation open when an interrupted archive can be retried", async () => {
  const { catalog, section } = setup();
  const onArchive = vi
    .fn()
    .mockRejectedValueOnce(new Error("Device offline"))
    .mockResolvedValueOnce(undefined);
  await using _screen = await render(
    <Fixture catalog={catalog} section={section} onArchive={onArchive} />,
    { router: false },
  ); // Archiving does not navigate.
  await userEvent.click(
    page.getByRole("button", { name: "Archive all related projects & mines", exact: true }),
  );
  await expect.element(page.getByRole("alert")).toHaveTextContent("Device offline");
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Archive section", exact: true }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(onArchive.mock.calls).toEqual([[true], [false]]);
});
