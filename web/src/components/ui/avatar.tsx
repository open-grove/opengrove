import * as React from "react";
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import clsx from "clsx";
import styles from "./avatar.module.css";

/**
 * Adapted from the shadcn/ui Base UI Avatar component (MIT).
 * Tailwind utility classes are translated to OpenGrove CSS tokens.
 * See THIRD_PARTY_NOTICES.md.
 */

type AvatarProps = Omit<AvatarPrimitive.Root.Props, "className"> & {
  className?: string;
  size?: "default" | "sm" | "lg";
};

function Avatar({ className, size = "default", ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root data-slot="avatar" data-size={size} className={clsx(styles.root, className)} {...props} />
  );
}

type AvatarImageProps = Omit<AvatarPrimitive.Image.Props, "className"> & {
  className?: string;
};

function AvatarImage({ className, ...props }: AvatarImageProps) {
  return <AvatarPrimitive.Image data-slot="avatar-image" className={clsx(styles.image, className)} {...props} />;
}

type AvatarFallbackProps = Omit<AvatarPrimitive.Fallback.Props, "className"> & {
  className?: string;
};

function AvatarFallback({ className, ...props }: AvatarFallbackProps) {
  return (
    <AvatarPrimitive.Fallback data-slot="avatar-fallback" className={clsx(styles.fallback, className)} {...props} />
  );
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="avatar-badge" className={clsx(styles.badge, className)} {...props} />;
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="avatar-group" className={clsx(styles.group, className)} {...props} />;
}

function AvatarGroupCount({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="avatar-group-count" className={clsx(styles.count, className)} {...props} />;
}

export { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage };
