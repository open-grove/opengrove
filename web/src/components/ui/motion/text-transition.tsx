import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import clsx from "clsx";
import styles from "./text-transition.module.css";

export function TextTransition(props: { children: ReactNode; identity: string; className?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <span className={clsx(styles.root, props.className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          className={styles.item}
          key={props.identity}
          initial={reduceMotion ? false : { y: 7, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduceMotion ? undefined : { y: -7, opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
        >
          {props.children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
