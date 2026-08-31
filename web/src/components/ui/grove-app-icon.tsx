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
import styles from "./grove-app-icon.module.css";

export type GroveAppIconName =
  | "generic"
  | "story"
  | "research"
  | "launch"
  | "growth"
  | "delivery"
  | "media"
  | "production"
  | "editorial"
  | "library"
  | "seed"
  | "analytics"
  | "garden"
  | "character"
  | "talent";

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

export function resolveGroveAppIconName(input: {
  icon?: string;
  id?: string;
  appId?: string;
  category?: string;
  title?: string;
}): GroveAppIconName {
  const requested = normalizedIconToken(input.icon);
  const aliases: Record<string, GroveAppIconName> = {
    app: "generic",
    default: "generic",
    generic: "generic",
    production: "production",
    producer: "production",
    editorial: "editorial",
    library: "library",
    archive: "library",
    seed: "seed",
    "story-seed": "seed",
    analytics: "analytics",
    dashboard: "analytics",
    garden: "garden",
    "story-garden": "garden",
    character: "character",
    talent: "talent",
    story: "story",
    document: "story",
    research: "research",
    chart: "research",
    launch: "launch",
    rocket: "launch",
    growth: "growth",
    brand: "growth",
    delivery: "delivery",
    website: "delivery",
    media: "media",
    video: "media",
  };
  if (requested && aliases[requested]) return aliases[requested];

  const identity = `${input.id ?? ""} ${input.appId ?? ""} ${input.category ?? ""} ${input.title ?? ""}`.toLowerCase();
  if (/production|producer|film-review|制片|制片审核/.test(identity)) return "production";
  if (/editorial|编辑部|编辑审核/.test(identity)) return "editorial";
  if (/library|资料库|知识库/.test(identity)) return "library";
  if (/story-seed|故事种子/.test(identity)) return "seed";
  if (/analytics|data[-_\s]*dashboard|故事数据|数据后台/.test(identity)) return "analytics";
  if (/story-garden|故事花园/.test(identity)) return "garden";
  if (/character|角色工坊/.test(identity)) return "character";
  if (/talent|人才组织|人才/.test(identity)) return "talent";
  if (/research|研究|投资/.test(identity)) return "research";
  if (/launch|发布|产品/.test(identity)) return "launch";
  if (/growth|brand|增长|品牌/.test(identity)) return "growth";
  if (/website|delivery|网站|交付/.test(identity)) return "delivery";
  if (/vfs|video|media|剪辑|视频|素材/.test(identity)) return "media";
  if (/story|seed|故事|创作/.test(identity)) return "story";
  return "generic";
}

function normalizedIconToken(value: string | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized || /[/.]/.test(normalized)) return "";
  return normalized.replace(/^grove[:-]/, "");
}

function isCustomAppIconDataUrl(value: string | undefined): value is string {
  return /^data:image\/(?:png|webp);base64,/i.test(value?.trim() ?? "");
}
