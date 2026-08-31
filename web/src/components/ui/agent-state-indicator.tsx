import clsx from "clsx";
import { ThinkingOrb, type OrbState } from "thinking-orbs";

export interface AgentStatePresentation {
  state: OrbState;
  label: string;
}

export function AgentStateIndicator(
  props: AgentStatePresentation & {
    className?: string;
    labelVisible?: boolean;
    size?: 20 | 64;
  },
) {
  const size = props.size ?? 20;
  return (
    <span
      className={clsx("agent-state-indicator", props.className)}
      data-size={size}
      role={props.labelVisible === false ? "img" : "status"}
      aria-label={props.label}
    >
      <ThinkingOrb state={props.state} size={size} aria-hidden="true" />
      {props.labelVisible === false ? null : <span>{props.label}</span>}
    </span>
  );
}
