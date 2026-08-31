import { Slot } from "@radix-ui/react-slot";
import clsx from "clsx";
import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "ghost" | "primary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: ButtonVariant;
}

export function Button({ asChild = false, className, variant = "ghost", type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={clsx(variant === "primary" ? "primary-button" : "ghost-button", className)}
      {...props}
      type={asChild ? undefined : (type ?? "button")}
    />
  );
}
