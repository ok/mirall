import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Space } from "../../types.js";
import { gradientForSpaceId } from "../../utils.js";
import IconPicker from "../widgets/IconPicker.js";
import Modal from "../primitives/Modal.js";
import Icon, { type IconName } from "../primitives/Icon.js";
import IconButton from "../primitives/IconButton.js";
import Button from "../primitives/Button.js";

interface CreateSpaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, icon: string) => Promise<Space>;
  onCreated?: (space: Space) => void;
}

export default function CreateSpaceModal({
  isOpen,
  onClose,
  onCreate,
  onCreated,
}: CreateSpaceModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("folder");
  const [createdSpace, setCreatedSpace] = useState<Space | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (name.trim().length < 2 || creating) return;
    setCreating(true);
    const space = await onCreate(name.trim(), icon);
    setCreatedSpace(space);
    setCreating(false);
  }

  function handleClose() {
    const justCreated = createdSpace;
    setName("");
    setIcon("folder");
    setCreatedSpace(null);
    onClose();
    if (justCreated) onCreated?.(justCreated);
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      onConfirm={createdSpace ? undefined : handleCreate}
      ariaLabel={t(
        createdSpace ? "createSpace.titleCreated" : "createSpace.titleNew",
      )}
      panelClassName={`glass-modal w-full ${createdSpace ? "max-w-lg" : "max-w-xl"} rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative`}
    >
      <>
        <div className="px-10 pt-10 pb-6">
          <div className="flex justify-between items-start mb-2">
            <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
              {createdSpace
                ? t("createSpace.titleCreated")
                : t("createSpace.titleNew")}
            </h1>
            <IconButton
              icon="close"
              onClick={handleClose}
              ariaLabel={t("actions.close")}
              iconClassName="text-secondary"
            />
          </div>
          <p className="text-on-surface-variant font-medium">
            {createdSpace
              ? t("createSpace.descCreated")
              : t("createSpace.descNew")}
          </p>
        </div>

        <div className="px-10 pb-10 space-y-8">
          {!createdSpace && (
            <>
              <div className="space-y-3">
                <label htmlFor="create-space-name" className="font-headline text-sm font-bold text-accent px-1">
                  {t("createSpace.nameLabel")}
                </label>
                <input
                  id="create-space-name"
                  autoFocus
                  className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all"
                  placeholder={t("createSpace.namePlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                />
              </div>

              <div className="space-y-3">
                <label className="font-headline text-sm font-bold text-accent px-1">
                  {t("createSpace.iconLabel")}
                </label>
                <IconPicker selected={icon} onSelect={setIcon} />
              </div>
            </>
          )}

          {createdSpace && (
            <div className="bg-surface-container-lowest p-5 rounded-2xl flex items-center gap-6 shadow-[0_4px_20px_rgba(74,59,82,0.04)]">
              <div
                className={`w-16 h-16 rounded-xl ${gradientForSpaceId(createdSpace.spaceId)} flex items-center justify-center shrink-0`}
              >
                <Icon
                  name={(createdSpace.icon as IconName) || "hub"}
                  size={32}
                  className="text-on-primary"
                />
              </div>
              <div className="flex-grow min-w-0">
                <h3 className="text-xl font-headline font-bold text-accent truncate pb-0.5">
                  {createdSpace.name}
                </h3>
                <p className="text-on-surface-variant text-sm truncate">
                  {t("createSpace.readyToShare")}
                </p>
              </div>
            </div>
          )}

          <div className="pt-4 flex flex-col gap-4">
            {!createdSpace ? (
              <Button size="lg" fullWidth onClick={handleCreate} disabled={name.trim().length < 2 || creating}>
                {creating ? t("createSpace.creating") : t("createSpace.initialize")}
                <Icon name="auto_awesome" />
              </Button>
            ) : (
              <Button size="lg" fullWidth onClick={handleClose}>
                {t("actions.done")}
                <Icon name="check" />
              </Button>
            )}
          </div>
        </div>
      </>
    </Modal>
  );
}
