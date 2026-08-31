import { memo, useMemo, type CSSProperties, type ElementType } from "react";
import { motion, useReducedMotion } from "motion/react";
import clsx from "clsx";
import styles from "./text-shimmer.module.css";

function TextShimmerComponent(props: {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}) {
  const { children, as: component = "span", className, duration = 1.8, spread = 1.65 } = props;
  const reduceMotion = useReducedMotion();
  const MotionComponent = useMemo(() => motion.create(component), [component]);
  const shimmerSpread = Math.min(96, Math.max(28, children.length * spread));

  return (
    <MotionComponent
      data-text-shimmer="true"
      className={clsx(styles.shimmer, className)}
      initial={reduceMotion ? false : { backgroundPosition: "100% center" }}
      animate={reduceMotion ? undefined : { backgroundPosition: "0% center" }}
      transition={
        reduceMotion
          ? undefined
          : {
              repeat: Infinity,
              duration,
              ease: "linear",
            }
      }
      style={{ "--text-shimmer-spread": `${shimmerSpread}px` } as CSSProperties}
    >
      {children}
    </MotionComponent>
  );
}

export const TextShimmer = memo(TextShimmerComponent);
