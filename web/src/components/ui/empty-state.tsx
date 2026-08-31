import clsx from "clsx";
import type { ReactNode } from "react";
import { Button } from "./button";
import { PixelIllustration, type PixelIllustrationName } from "./pixel-illustration";

export interface EmptyStateAction {
  label: string;
  onClick(): void;
  variant?: "primary" | "ghost";
}

export interface EmptyStateProps {
  illustration?: PixelIllustrationName;
  icon?: ReactNode;
  title: string;
  description?: string;
  actions?: EmptyStateAction[];
  compact?: boolean;
  className?: string;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div className={clsx("og-empty-state", props.compact && "og-empty-state--compact", props.className)}>
      {props.illustration ? (
        <div className="og-empty-state-art" aria-hidden="true">
          <PixelIllustration name={props.illustration} />
        </div>
      ) : null}
      {!props.illustration && props.icon ? (
        <div className="og-empty-state-icon" aria-hidden="true">
          {props.icon}
        </div>
      ) : null}
      <div className="og-empty-state-copy">
        <h3 className="og-empty-state-title">{props.title}</h3>
        {props.description ? <p className="og-empty-state-description">{props.description}</p> : null}
      </div>
      {props.actions?.length ? (
        <div className="og-empty-state-actions">
          {props.actions.map((action) => (
            <Button
              key={action.label}
              variant={action.variant === "primary" ? "primary" : "ghost"}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
