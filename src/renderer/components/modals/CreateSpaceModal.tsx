import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Space } from "../../types.js";
import { gradientForSpaceId } from "../../utils.js";
import IconPicker from "../primitives/IconPicker.js";
import TextField from "../primitives/TextField.js"
import FieldLabel from "../primitives/FieldLabel.js"
import Modal from "../primitives/Modal.js";
import Icon, { type IconName } from "../primitives/Icon.js";
import ModalHeader from "../layout/ModalHeader.js";
import Button from "../primitives/Button.js";
import { useErrorText } from "../../hooks/useErrorText.js";

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
  const errorText = useErrorText();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("folder");
  const [createdSpace, setCreatedSpace] = useState<Space | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // setCreating lands a render later; the ref is what stops a held Enter creating two spaces.
  const creatingRef = useRef(false);

  async function handleCreate() {
    if (name.trim().length < 2 || creating || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const space = await onCreate(name.trim(), icon);
      setCreatedSpace(space);
    } catch (err) {
      setError(errorText(err));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  // onCreated fires AFTER onClose, and on the captured space: it navigates to the new space, and
  // running it first would leave this modal open over the screen it navigated to.
  function handleClose() {
    const justCreated = createdSpace;
    setName("");
    setIcon("folder");
    setCreatedSpace(null);
    setError(null);
    onClose();
    if (justCreated) onCreated?.(justCreated);
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      onConfirm={createdSpace ? handleClose : handleCreate}
      ariaLabel={t(
        createdSpace ? "createSpace.titleCreated" : "createSpace.titleNew",
      )}
      panelClassName={`glass-modal w-full ${createdSpace ? "max-w-lg" : "max-w-xl"} rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative`}
    >
      <>
        <ModalHeader
          title={createdSpace ? t("createSpace.titleCreated") : t("createSpace.titleNew")}
          description={createdSpace ? t("createSpace.descCreated") : t("createSpace.descNew")}
          onClose={handleClose}
        />

        <div className="px-10 pb-10 space-y-8">
          {!createdSpace && (
            <>
              <div className="space-y-3">
                <TextField
                  id="create-space-name"
                  label={t("createSpace.nameLabel")}
                  autoFocus
                  placeholder={t("createSpace.namePlaceholder")}
                  invalid={!!error}
                  describedBy={error ? "create-space-error" : undefined}
                  value={name}
                  onChange={(v) => { setName(v); setError(null); }}
                />
              </div>

              <div className="space-y-3">
                <FieldLabel>{t("createSpace.iconLabel")}</FieldLabel>
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
            {error && (
              <div id="create-space-error" className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
                {error}
              </div>
            )}
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
