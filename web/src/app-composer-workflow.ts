import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, MouseEvent, RefObject } from "react";
import type { AttachmentPayload, ContextArtifactPayload, SkillRecord, WorkingStateRecord } from "./bridge";
import type { ComposerMenuKind } from "./components/chat/chat-composer";
import {
  MAX_COMPOSER_ATTACHMENTS,
  composerImageFilesFromClipboardData,
  getKernelSlashCommands,
  getMatchingSkills,
  getMatchingSlashCommands,
  mergeComposerAttachments,
  parseSlashSkillQuery,
  pickCodexSkills,
  readComposerAttachment,
  skillInvocationName,
  type ComposerSkillInvocation,
} from "./runtime/ui-model";

export function useAppComposerWorkflow(input: {
  activeKernel: string | undefined;
  activeKernelCapabilityReport: Parameters<typeof getKernelSlashCommands>[2];
  appendSystemMessage(message: string): void;
  formatMaxAttachmentsMessage(count: number): string;
  formatPartialAttachmentsMessage(selected: number, count: number): string;
  isCodexKernel: boolean;
  setView(view: string): void;
  skills: SkillRecord[];
  threadScrollRef: RefObject<HTMLElement | null>;
  workingState: WorkingStateRecord;
}) {
  const {
    activeKernel,
    activeKernelCapabilityReport,
    appendSystemMessage,
    formatMaxAttachmentsMessage,
    formatPartialAttachmentsMessage,
    isCodexKernel,
    setView,
    skills,
    threadScrollRef,
    workingState,
  } = input;
  const [question, setQuestion] = useState("");
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [contextArtifacts, setContextArtifacts] = useState<ContextArtifactPayload[]>([]);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [composerSkillInvocation, setComposerSkillInvocation] = useState<ComposerSkillInvocation | null>(null);
  const [forceSlashMenuOpen, setForceSlashMenuOpen] = useState(false);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [modelMenuKind, setModelMenuKind] = useState<ComposerMenuKind | null>(null);
  const [modelMenuPlacement, setModelMenuPlacement] = useState<"up" | "down">("up");
  const [isComposingText, setIsComposingText] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const slashSkillCandidates = useMemo(
    () => (isCodexKernel ? pickCodexSkills(skills) : skills),
    [isCodexKernel, skills],
  );
  const skillQuery = parseSlashSkillQuery(composerSkillInvocation ? "" : question);
  const skillMenuKeyword = forceSlashMenuOpen && !skillQuery.active ? "" : skillQuery.keyword;
  const kernelSlashCommands = useMemo(
    () => getKernelSlashCommands(activeKernel, workingState, activeKernelCapabilityReport),
    [activeKernel, activeKernelCapabilityReport, workingState],
  );
  const matchingSlashCommands = useMemo(
    () => getMatchingSlashCommands(kernelSlashCommands, skillMenuKeyword),
    [kernelSlashCommands, skillMenuKeyword],
  );
  const matchingSkills = useMemo(
    () => getMatchingSkills(slashSkillCandidates, skillMenuKeyword),
    [slashSkillCandidates, skillMenuKeyword],
  );
  const slashMenuItemCount = matchingSlashCommands.length + matchingSkills.length;
  const showSlashPalette =
    (skillQuery.active || forceSlashMenuOpen) && !slashMenuDismissed && slashMenuItemCount > 0 && !modelMenuKind;
  const composerQuestionValue = question;

  useEffect(() => {
    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target;
      if (!modelMenuRef.current || !(target instanceof Node)) {
        return;
      }
      if (!modelMenuRef.current.contains(target)) {
        setModelMenuKind(null);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setModelMenuKind(null);
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function focusComposer() {
    composerInputRef.current?.focus();
  }

  function focusComposerAndScrollThread() {
    requestAnimationFrame(() => {
      focusComposer();
      const scrollEl = threadScrollRef.current;
      if (scrollEl) {
        scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
      }
    });
  }

  function resetComposerDraft() {
    setAttachments([]);
    setContextArtifacts([]);
    setQuestion("");
    setComposerSkillInvocation(null);
    setActiveSlashIndex(0);
    setForceSlashMenuOpen(false);
    setSlashMenuDismissed(false);
    setModelMenuKind(null);
  }

  function openAttachmentPicker(event?: MouseEvent<HTMLButtonElement>) {
    event?.currentTarget.blur();
    setModelMenuKind(null);
    fileInputRef.current?.click();
  }

  async function handleAttachmentInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    await addComposerAttachments(files);
  }

  async function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = composerImageFilesFromClipboardData(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    await addComposerAttachments(files);
  }

  async function addComposerAttachments(files: File[]) {
    const remainingSlots = Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachments.length);
    if (remainingSlots <= 0) {
      appendSystemMessage(formatMaxAttachmentsMessage(MAX_COMPOSER_ATTACHMENTS));
      return;
    }
    const selected = files.slice(0, remainingSlots);
    const loaded = await Promise.all(selected.map(readComposerAttachment));
    setAttachments((current) => mergeComposerAttachments(current, loaded));
    if (files.length > selected.length) {
      appendSystemMessage(formatPartialAttachmentsMessage(selected.length, MAX_COMPOSER_ATTACHMENTS));
    }
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }

  function removeContextArtifact(artifactId: string) {
    setContextArtifacts((current) => current.filter((artifact) => artifact.id !== artifactId));
  }

  function toggleModelMenu(kind: ComposerMenuKind) {
    const picker = modelMenuRef.current;
    if (picker) {
      const rect = picker.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
      const gap = 8;
      const viewportPadding = 12;
      const availableBelow = Math.max(220, viewportHeight - rect.bottom - gap - viewportPadding);
      const availableAbove = Math.max(220, rect.top - gap - viewportPadding);
      const idealMenuHeight = 440;
      const placement = availableBelow >= idealMenuHeight || availableBelow >= availableAbove ? "down" : "up";
      const availableHeight = placement === "down" ? availableBelow : availableAbove;
      picker.style.setProperty(
        "--opengrove-model-menu-max-height",
        `${Math.max(220, Math.min(420, availableHeight))}px`,
      );
      setModelMenuPlacement(placement);
    }
    setModelMenuKind((current) => (current === kind ? null : kind));
  }

  function applySkillSuggestion(skill: SkillRecord) {
    setComposerSkillInvocation({
      name: skillInvocationName(skill),
      skill,
      args: "",
    });
    setQuestion("");
    setView("chat");
    setActiveSlashIndex(0);
    setForceSlashMenuOpen(false);
    setSlashMenuDismissed(false);
    setModelMenuKind(null);
    focusComposerAndScrollThread();
  }

  function insertPrompt(prompt: string) {
    setQuestion(prompt);
    setComposerSkillInvocation(null);
    setActiveSlashIndex(0);
    setSlashMenuDismissed(false);
    setView("chat");
    setModelMenuKind(null);
    focusComposerAndScrollThread();
  }

  function handleQuestionChange(nextValue: string) {
    setQuestion(nextValue);
    setForceSlashMenuOpen(false);
    setSlashMenuDismissed(false);
    setModelMenuKind(null);
    setActiveSlashIndex(0);
  }

  function dismissSlashPalette() {
    setSlashMenuDismissed(true);
    setForceSlashMenuOpen(false);
    setActiveSlashIndex(0);
  }

  function appendVoiceTranscript(transcript: string) {
    const normalized = transcript.trim();
    if (!normalized) return;
    setQuestion((current) => {
      const separator = current.trim() ? "\n" : "";
      return `${current.trimEnd()}${separator}${normalized}`;
    });
    requestAnimationFrame(focusComposer);
  }

  function removeSkillInvocation() {
    setComposerSkillInvocation(null);
    setActiveSlashIndex(0);
    requestAnimationFrame(focusComposer);
  }

  return {
    activeSlashIndex,
    appendVoiceTranscript,
    applySkillSuggestion,
    attachments,
    composerInputRef,
    composerQuestionValue,
    composerSkillInvocation,
    contextArtifacts,
    dismissSlashPalette,
    fileInputRef,
    focusComposer,
    forceSlashMenuOpen,
    handleAttachmentInputChange,
    handleComposerPaste,
    handleQuestionChange,
    insertPrompt,
    isComposingText,
    matchingSkills,
    matchingSlashCommands,
    modelMenuKind,
    modelMenuPlacement,
    modelMenuRef,
    openAttachmentPicker,
    question,
    removeAttachment,
    removeContextArtifact,
    removeSkillInvocation,
    resetComposerDraft,
    setActiveSlashIndex,
    setComposerSkillInvocation,
    setContextArtifacts,
    setForceSlashMenuOpen,
    setIsComposingText,
    setModelMenuKind,
    setQuestion,
    showSlashPalette,
    slashMenuItemCount,
    toggleModelMenu,
  };
}
