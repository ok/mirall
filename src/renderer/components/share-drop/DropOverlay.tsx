// Full-pane highlight shown while dragging files or a folder over a space, telling the user what a drop will share.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../primitives/Icon.js";
import type { DragKind } from "../../hooks/useDragShare.js";

interface DropOverlayProps {
  active: boolean;
  kind: DragKind;
  fileCount: number;
  folderName: string | null;
}

export default function DropOverlay({
  active,
  kind,
  fileCount,
  folderName,
}: DropOverlayProps) {
  const { t } = useTranslation();
  // The drag state resets the moment the pointer leaves, but the overlay is still visible while it
  // fades out: it keeps showing the last active drag until the next one starts.
  const [shown, setShown] = useState({ kind, fileCount, folderName });
  if (
    active &&
    (shown.kind !== kind ||
      shown.fileCount !== fileCount ||
      shown.folderName !== folderName)
  ) {
    setShown({ kind, fileCount, folderName });
  }
  const content = active ? { kind, fileCount, folderName } : shown;
  const isFolder = content.kind === "folder";
  const subline = isFolder
    ? content.folderName
      ? t("dropZone.releaseFolder", { name: content.folderName })
      : t("dropZone.releaseFolderUnnamed")
    : t("dropZone.releaseFiles", { count: content.fileCount });

  // `top-4` is the content grid's own top padding, so the overlay's top edge is the resting drop
  // zone's top edge and the crossfade between the two does not jump.
  return (
    <div
      aria-hidden="true"
      className={`absolute inset-x-0 bottom-8 top-4 z-20 rounded-2xl border-2 border-dashed border-secondary flex flex-col items-center justify-center gap-4 text-center px-8 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
        active ? "opacity-100" : "opacity-0 pointer-events-none"
      }`}
    >
      <div className="absolute inset-0 rounded-2xl bg-surface-container-high/90" />
      <div className="relative flex flex-col items-center gap-4">
        <Icon
          name={isFolder ? "folder" : "draft"}
          size={48}
          className="text-secondary"
        />
        <h2 className="text-3xl font-headline font-extrabold text-accent">
          {t("dropZone.title")}
        </h2>
        <p className="text-base font-bold text-secondary">{subline}</p>
      </div>
    </div>
  );
}
