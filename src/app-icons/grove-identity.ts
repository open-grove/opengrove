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
