import { useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import clsx from "clsx";
import type { TranslationFn } from "../../i18n";
import { KernelIcon } from "../ui/entity-icons";
import { MotionPopover } from "../ui/motion/popover";

export type DirectKernelRuntimeOption = {
  id: string;
  label: string;
  available?: boolean;
};

export function DirectKernelRuntimePicker(props: {
  t: TranslationFn;
  kernelId: string;
  kernelLabel: string;
  providerId: string;
  providerLabel: string;
  kernels: DirectKernelRuntimeOption[];
  providers: DirectKernelRuntimeOption[];
  providersLoading?: boolean;
  onSelectKernel(kernelId: string): void;
  onSelectProvider(providerId: string): void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <MotionPopover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      sideOffset={7}
      size="picker"
      className="direct-kernel-runtime-popover"
      role="dialog"
      ariaLabel={props.t("shell.kernelConversationRuntime")}
      trigger={
        <button
          className="topbar-status-pill topbar-runtime-picker"
          type="button"
          title={props.t("shell.changeKernelConversationRuntime")}
          aria-label={props.t("shell.changeKernelConversationRuntime")}
          aria-expanded={open}
          aria-busy={props.providersLoading === true}
          disabled={props.providersLoading === true}
        >
          <KernelIcon kernelId={props.kernelId} className="topbar-kernel-icon" size={14} />
          <span>{props.kernelLabel}</span>
          {props.providersLoading ? (
            <Loader2 className="topbar-runtime-chevron spin" size={14} aria-label={props.t("mountedApp.loading")} />
          ) : (
            <>
              <span className="topbar-runtime-provider">{props.providerLabel}</span>
              <ChevronDown className="topbar-runtime-chevron" size={14} aria-hidden="true" />
            </>
          )}
        </button>
      }
    >
      <RuntimeOptionGroup
        label={props.t("settings.kernels")}
        value={props.kernelId}
        options={props.kernels}
        onSelect={(kernelId) => props.onSelectKernel(kernelId)}
      />
      <RuntimeOptionGroup
        label={props.t("settings.providers")}
        value={props.providerId}
        options={[{ id: "", label: props.t("shell.followKernelProvider"), available: true }, ...props.providers]}
        onSelect={(providerId) => props.onSelectProvider(providerId)}
      />
    </MotionPopover>
  );
}

function RuntimeOptionGroup(props: {
  label: string;
  value: string;
  options: DirectKernelRuntimeOption[];
  onSelect(value: string): void;
}) {
  return (
    <section className="direct-kernel-runtime-group">
      <h3>{props.label}</h3>
      <div className="direct-kernel-runtime-options">
        {props.options.map((option) => {
          const selected = option.id === props.value;
          return (
            <button
              key={option.id || "auto"}
              className={clsx("direct-kernel-runtime-option", selected && "selected")}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={option.available === false}
              onClick={() => props.onSelect(option.id)}
            >
              <span>{option.label}</span>
              {selected ? <Check size={15} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
