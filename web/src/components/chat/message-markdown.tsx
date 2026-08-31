import { Sparkles, Pencil, Play } from "lucide-react";
import type { SkillRecord } from "../../bridge";
import { summarize } from "../../format";
import { useI18n } from "../../i18n";
import type { ChatImagePayload } from "./message-types";
import { ChatMarkdownRenderer, type ChatMarkdownRenderOptions } from "./chat-markdown-renderer";
import type { ChatResourceAction, ChatResourceContext, ChatResourceRef } from "./resource-model";
import "./thread.css";

export type { ChatResourceRef, ChatResourceAction, ChatResourceContext };

export function ThreadTextBlock(props: {
  text: string;
  skills?: SkillRecord[];
  onTrySkill?(skillName: string): void;
  onEditSkill?(skillName: string): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onSaveImageArtifact?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const createdSkills = extractCreatedSkillCards(props.text, props.skills ?? []);
  const displayText = stripMemoryCitationBlocks(String(props.text || ""));

  const renderOptions: ChatMarkdownRenderOptions = {
    onPreviewImage: props.onPreviewImage,
    onSaveImageArtifact: props.onSaveImageArtifact,
    onOpenResource: props.onOpenResource,
    resourceContext: props.resourceContext,
  };

  return (
    <div className="thread-text-block tone-plain">
      <ChatMarkdownRenderer markdown={displayText} {...renderOptions} />
      {createdSkills.length ? (
        <div className="thread-skill-created-list">
          {createdSkills.map((skill) => (
            <SkillCreatedCard
              key={skill.name}
              skill={skill}
              onTrySkill={props.onTrySkill}
              onEditSkill={props.onEditSkill}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function stripMemoryCitationBlocks(text: string): string {
  return text
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function SkillCreatedCard(props: {
  skill: CreatedSkillCard;
  onTrySkill?(skillName: string): void;
  onEditSkill?(skillName: string): void;
}) {
  const { t } = useI18n();
  return (
    <section className="thread-created-skill-card">
      <div className="thread-created-skill-icon" aria-hidden="true">
        <Sparkles size={16} />
      </div>
      <div className="thread-created-skill-body">
        <div className="thread-created-skill-kicker">{t("chat.skillInstalledKicker")}</div>
        <div className="thread-created-skill-title">{props.skill.title || props.skill.name}</div>
        <div className="thread-created-skill-meta">
          /{props.skill.name}
          {props.skill.source
            ? ` · ${props.skill.source === "user" ? t("chat.personalSkill") : props.skill.source}`
            : ""}
          {props.skill.entry ? ` · ${props.skill.entry}` : ""}
        </div>
        {props.skill.description ? (
          <div className="thread-created-skill-description">{summarize(props.skill.description, 150)}</div>
        ) : null}
      </div>
      <div className="thread-created-skill-actions">
        <button
          type="button"
          className="thread-image-action primary"
          onClick={() => props.onTrySkill?.(props.skill.name)}
        >
          <Play size={13} />
          {t("chat.trySkill")}
        </button>
        <button type="button" className="thread-image-action" onClick={() => props.onEditSkill?.(props.skill.name)}>
          <Pencil size={13} />
          {t("common.edit")}
        </button>
      </div>
    </section>
  );
}

interface CreatedSkillCard {
  name: string;
  title: string;
  description: string;
  entry: string;
  source: string;
}

function extractCreatedSkillCards(text: string, skills: SkillRecord[]): CreatedSkillCard[] {
  const content = String(text || "");
  if (!/(已创建|已安装|安装到|安装到了|created|installed|Skill is valid)/i.test(content)) {
    return [];
  }

  const names = uniqueStrings(
    [...content.matchAll(/(?:^|[~\w/.-])\.codex\/skills\/([A-Za-z0-9][A-Za-z0-9_-]*)/g)]
      .map((match) => match[1])
      .concat(
        [...content.matchAll(/\[([A-Za-z0-9][A-Za-z0-9_-]*)\]\([^)]*\.codex\/skills\/\1(?:[)/]|%2F)/g)].map(
          (match) => match[1],
        ),
      )
      .filter((name): name is string => Boolean(name)),
  );

  return names.map((name) => {
    const manifest = skills.find(
      (skill) => skill?.name === name || skill?.id === `skill.${name}` || skill?.id === name,
    );
    return {
      name,
      title: manifest?.title || titleFromSkillName(name),
      description: manifest?.description || "",
      entry: manifest?.entry || manifest?.skillRoot || "",
      source: manifest?.source || "",
    };
  });
}

function titleFromSkillName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
