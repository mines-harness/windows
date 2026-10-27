import { useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function CatalogSectionArchiveDialog({
  title,
  onArchive,
  onClose,
}: {
  readonly title: string;
  readonly onArchive: (includeContents: boolean) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archive = async (includeContents: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onArchive(includeContents);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The section could not be archived.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Archive {title}?</DialogTitle>
          <DialogDescription>
            Archive only this section to keep its contents in your library, or archive its related
            projects and mines too. You can restore the section from Archived sections.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <DialogPanel>
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          </DialogPanel>
        ) : null}
        <DialogFooter className="sm:justify-between">
          <Button variant="destructive" disabled={busy} onClick={() => void archive(true)}>
            Archive all related projects &amp; mines
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void archive(false)}>
            Archive section
          </Button>
        </DialogFooter>
        <div className="flex justify-center pb-4">
          <Button variant="ghost-muted" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
