import { useEffect, useRef, useState, type CSSProperties } from "react";
import Avvvatars from "avvvatars-react";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import styles from "./name-avatar.module.css";

type AvvvatarsComponent = typeof Avvvatars;
const ResolvedAvvvatars =
  typeof Avvvatars === "function" ? Avvvatars : (Avvvatars as unknown as { default: AvvvatarsComponent }).default;

export function NameAvatarFallback(props: {
  name: string;
  value?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  size?: number;
}) {
  return (
    <Avatar className={props.className} style={{ width: "100%", height: "100%", ...props.style }} title={props.title}>
      <AvatarFallback>
        <AvvvatarsFallbackContent
          value={props.value || props.name || "?"}
          displayValue={props.name || "?"}
          initialSize={props.size}
        />
      </AvatarFallback>
    </Avatar>
  );
}

export function NameAvatar(props: {
  name: string;
  value?: string;
  src?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  size?: number;
}) {
  const src = props.src?.trim() || "";

  return (
    <Avatar className={props.className} style={{ width: "100%", height: "100%", ...props.style }} title={props.title}>
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback>
        <AvvvatarsFallbackContent
          value={props.value || props.name || "?"}
          displayValue={props.name || "?"}
          initialSize={props.size}
        />
      </AvatarFallback>
    </Avatar>
  );
}

export function AvvvatarsFallbackContent(props: { value: string; displayValue: string; initialSize?: number }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(props.initialSize ?? 32);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const bounds = container.getBoundingClientRect();
      const nextSize = Math.max(1, Math.round(Math.min(bounds.width, bounds.height)));
      setSize((current) => (current === nextSize ? current : nextSize));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <span ref={containerRef} className={styles.avvvatars} aria-hidden="true">
      <ResolvedAvvvatars value={props.value} displayValue={props.displayValue} size={size} style="character" />
    </span>
  );
}
