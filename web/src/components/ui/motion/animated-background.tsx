import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { LayoutGroup, motion, useReducedMotion, type Transition } from "motion/react";
import clsx from "clsx";
import styles from "./animated-background.module.css";

type AnimatedBackgroundItemProps = {
  "data-id": string;
  "data-checked"?: "true" | "false";
  children?: ReactNode;
  className?: string;
};

export function AnimatedBackground(props: {
  children: ReactNode;
  value: string;
  backgroundClassName?: string;
  transition?: Transition;
}) {
  const groupId = useId();
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion
    ? { duration: 0 }
    : (props.transition ?? { type: "spring", bounce: 0.12, duration: 0.38 });

  return (
    <LayoutGroup id={groupId}>
      {Children.map(props.children, (child) => {
        if (!isValidElement<AnimatedBackgroundItemProps>(child)) return child;
        const id = child.props["data-id"];
        const active = id === props.value;
        return cloneElement(
          child as ReactElement<AnimatedBackgroundItemProps>,
          {
            className: clsx(styles.item, child.props.className),
            "data-checked": active ? "true" : "false",
          },
          <>
            {active ? (
              <motion.span
                aria-hidden="true"
                className={clsx(styles.background, props.backgroundClassName)}
                layoutId="active-background"
                transition={transition}
              />
            ) : null}
            {child.props.children}
          </>,
        );
      })}
    </LayoutGroup>
  );
}
