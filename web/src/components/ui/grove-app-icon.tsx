import type { HTMLAttributes, SVGProps } from "react";
import { Sprout } from "lucide-react";
import {
  AppWindowIcon,
  BookOpenIcon,
  BriefcaseIcon,
  CameraIcon,
  ChartBarIcon,
  CodeIcon,
  DatabaseIcon,
  FilmSlateIcon,
  GlobeIcon,
  LightbulbIcon,
  MegaphoneIcon,
  NotePencilIcon,
  PaletteIcon,
  PlantIcon,
  RocketIcon,
  RobotIcon,
  ShoppingBagIcon,
  UsersIcon,
  WrenchIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { parseAppSystemIconToken, type AppSystemIconName } from "../../../../src/app-icons/catalog";
import { resolveGroveAppIconName, type GroveAppIconName } from "../../../../src/app-icons/grove-identity";
import styles from "./grove-app-icon.module.css";

export function GroveAppIcon(
  props: {
    name: GroveAppIconName;
    size?: number;
  } & Omit<SVGProps<SVGSVGElement>, "name">,
) {
  const { name, size = 24, className, ...svgProps } = props;
  if (name === "seed") {
    const seedClassName = `${styles.icon} ${styles.originalIcon}`;
    return (
      <Sprout
        {...svgProps}
        width={size}
        height={size}
        className={className ? `${seedClassName} ${className}` : seedClassName}
        aria-hidden="true"
      />
    );
  }
  const Icon = GROVE_APP_ICONS[name];
  return (
    <Icon
      {...svgProps}
      size={size}
      weight="regular"
      className={className ? `${styles.icon} ${className}` : styles.icon}
      aria-hidden="true"
    />
  );
}

export function GroveAppIconTile(
  props: {
    name: GroveAppIconName;
    iconSize?: number;
  } & Omit<HTMLAttributes<HTMLSpanElement>, "name">,
) {
  const { name, iconSize = 30, className, ...spanProps } = props;
  return (
    <span {...spanProps} className={className ? `${styles.tile} ${className}` : styles.tile} data-grove-tone={name}>
      <GroveAppIcon name={name} size={iconSize} />
    </span>
  );
}

const APP_SYSTEM_ICONS = {
  "app-window": AppWindowIcon,
  article: NotePencilIcon,
  books: BookOpenIcon,
  briefcase: BriefcaseIcon,
  camera: CameraIcon,
  "chart-bar": ChartBarIcon,
  code: CodeIcon,
  database: DatabaseIcon,
  "film-slate": FilmSlateIcon,
  "flower-lotus": PlantIcon,
  globe: GlobeIcon,
  lightbulb: LightbulbIcon,
  megaphone: MegaphoneIcon,
  palette: PaletteIcon,
  rocket: RocketIcon,
  robot: RobotIcon,
  "shopping-bag": ShoppingBagIcon,
  users: UsersIcon,
  wrench: WrenchIcon,
} satisfies Record<AppSystemIconName, PhosphorIcon>;

const GROVE_APP_ICONS = {
  generic: AppWindowIcon,
  story: BookOpenIcon,
  research: GlobeIcon,
  launch: RocketIcon,
  growth: ChartBarIcon,
  delivery: BriefcaseIcon,
  media: FilmSlateIcon,
  production: CameraIcon,
  editorial: NotePencilIcon,
  library: BookOpenIcon,
  analytics: ChartBarIcon,
  garden: PlantIcon,
  character: PaletteIcon,
  talent: UsersIcon,
} satisfies Record<Exclude<GroveAppIconName, "seed">, PhosphorIcon>;

export function AppIdentityIcon(props: {
  icon?: string;
  input?: {
    id?: string;
    appId?: string;
    category?: string;
    title?: string;
  };
  size?: number;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  const { icon, input = {}, size = 24, className } = props;
  if (isCustomAppIconDataUrl(icon)) {
    return (
      <img
        src={icon}
        width={size}
        height={size}
        className={className ? `${styles.customImage} ${className}` : styles.customImage}
        alt=""
        aria-hidden={props["aria-hidden"] ?? true}
      />
    );
  }
  const systemIconName = parseAppSystemIconToken(icon);
  if (systemIconName) {
    const Icon = APP_SYSTEM_ICONS[systemIconName];
    return <Icon size={size} weight="regular" className={className} aria-hidden={props["aria-hidden"] ?? true} />;
  }
  return (
    <GroveAppIcon
      name={resolveGroveAppIconName({ ...input, icon })}
      size={size}
      className={className}
      aria-hidden={props["aria-hidden"] ?? true}
    />
  );
}

export function AppIdentityIconTile(
  props: {
    icon?: string;
    input?: {
      id?: string;
      appId?: string;
      category?: string;
      title?: string;
    };
    iconSize?: number;
  } & Omit<HTMLAttributes<HTMLSpanElement>, "children">,
) {
  const { icon, input = {}, iconSize = 30, className, ...spanProps } = props;
  const groveIcon = resolveGroveAppIconName({ ...input, icon });
  const tone = isCustomAppIconDataUrl(icon) ? "custom" : parseAppSystemIconToken(icon) ? "system" : groveIcon;
  return (
    <span {...spanProps} className={className ? `${styles.tile} ${className}` : styles.tile} data-grove-tone={tone}>
      <AppIdentityIcon icon={icon} input={input} size={iconSize} aria-hidden="true" />
    </span>
  );
}

function isCustomAppIconDataUrl(value: string | undefined): value is string {
  return /^data:image\/(?:png|webp);base64,/i.test(value?.trim() ?? "");
}
