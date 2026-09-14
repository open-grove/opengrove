import { useRef, useState } from "react";
import { Globe2, Store, Upload, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { AppWebsitePublishPanel } from "../network/app-website-publish-panel";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { MotionMenu, MotionMenuItem } from "../ui/motion/menu";
import styles from "./app-publish-menu.module.css";

export function AppPublishMenu(props: {
  appId: string;
  appTitle: string;
  canPublishWebsite: boolean;
  onPublishToStore(): void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [websiteOpen, setWebsiteOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <MotionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        ariaLabel={t("appPublish.title")}
        trigger={
          <button
            ref={triggerRef}
            type="button"
            className="app-titlebar-control"
            aria-label={t("appPublish.title")}
            title={t("appPublish.title")}
          >
            <Upload size={17} aria-hidden="true" />
          </button>
        }
      >
        <MotionMenuItem onClick={props.onPublishToStore}>
          <Store size={16} aria-hidden="true" />
          <span>{t("appPublish.store")}</span>
        </MotionMenuItem>
        <MotionMenuItem
          disabled={!props.canPublishWebsite}
          title={props.canPublishWebsite ? undefined : t("appPublish.adminRequired")}
          onClick={() => setWebsiteOpen(true)}
        >
          <Globe2 size={16} aria-hidden="true" />
          <span>{t("appPublish.website")}</span>
        </MotionMenuItem>
      </MotionMenu>
      <Dialog open={websiteOpen && props.canPublishWebsite} onOpenChange={setWebsiteOpen}>
        <DialogContent
          className={styles.dialog}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <div className={styles.header}>
            <div>
              <DialogTitle>{t("appPublish.website")}</DialogTitle>
              <p className={styles.appTitle}>{props.appTitle}</p>
            </div>
            <button
              type="button"
              className="app-titlebar-control"
              aria-label={t("mountedApp.close")}
              onClick={() => setWebsiteOpen(false)}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <AppWebsitePublishPanel appId={props.appId} />
        </DialogContent>
      </Dialog>
    </>
  );
}
