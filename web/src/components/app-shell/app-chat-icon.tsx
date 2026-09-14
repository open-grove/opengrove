import { motion, useReducedMotion, type Variants } from "motion/react";

const eyeVariants: Variants = {
  open: {
    rx: [null, 1.5, 1.5, 1.8, 1.8, 1.5, 1.5, 1.8, 1.8, 1.5, 1.5],
    ry: [null, 1.74, 1.74, 0.12, 0.12, 1.74, 1.74, 0.12, 0.12, 1.62, 1.5],
    transition: {
      duration: 0.7,
      times: [0, 0.12, 0.27, 0.35, 0.4, 0.5, 0.67, 0.75, 0.8, 0.93, 1],
      ease: [0.4, 0, 0.2, 1],
    },
  },
  closed: {
    rx: [null, 1.725, 1.875],
    ry: [null, 0.24, 0.63],
    transition: { duration: 0.18, times: [0, 0.65, 1], ease: [0.4, 0, 0.2, 1] },
  },
  openStill: { rx: 1.5, ry: 1.5, transition: { duration: 0 } },
  closedStill: { rx: 1.875, ry: 0.63, transition: { duration: 0 } },
};

export function AppChatIcon(props: { open: boolean }) {
  const reduceMotion = useReducedMotion();
  const state = props.open ? "open" : "closed";
  return (
    <svg
      className="app-chat-icon"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x={4.5} y={8} width={15} height={13} rx={3.2} />
      <path d="M12 8V5" />
      <circle cx={12} cy={3.3} r={1.65} />
      {[9, 15].map((cx) => (
        <motion.ellipse
          key={cx}
          className="app-chat-icon-eye"
          cx={cx}
          cy={14.5}
          fill="currentColor"
          stroke="none"
          initial={false}
          animate={reduceMotion ? `${state}Still` : state}
          variants={eyeVariants}
        />
      ))}
    </svg>
  );
}
