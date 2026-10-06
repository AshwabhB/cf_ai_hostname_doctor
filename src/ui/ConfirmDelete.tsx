// The only way to delete a hostname: the user presses Delete here, which calls the
// confirmDelete callable with the ETag from the card. The model can suggest a delete
// but cannot open this dialog or press its button.
import { Button, Dialog } from "@cloudflare/kumo";
import { useState } from "react";

export type DeleteTarget = {
  id: string;
  etag: string;
  display_hostname: string;
};

type Props = {
  target: DeleteTarget | null;
  onClose: () => void;
  onConfirm: (target: DeleteTarget) => Promise<string | null>;
};

export function ConfirmDelete({ target, onClose, onConfirm }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog.Root
      role="alertdialog"
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) {
          setError(null);
          onClose();
        }
      }}
    >
      <Dialog className="p-6 max-w-md w-[calc(100vw-2rem)]">
        <Dialog.Title className="text-base font-semibold">
          Delete {target?.display_hostname}?
        </Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-kumo-subtle">
          This stops verification and removes {target?.display_hostname} from
          your hostnames. Its traffic will no longer be served. You can add it
          again later.
        </Dialog.Description>
        {error && (
          <p role="alert" className="mt-3 text-sm text-kumo-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Close
            render={(p) => (
              <Button variant="secondary" {...p} disabled={pending}>
                Cancel
              </Button>
            )}
          />
          <Button
            variant="destructive"
            loading={pending}
            disabled={pending}
            onClick={async () => {
              if (!target) return;
              setPending(true);
              setError(null);
              const problem = await onConfirm(target);
              setPending(false);
              if (problem) setError(problem);
              else onClose();
            }}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
