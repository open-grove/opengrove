import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const RELEASE_NOTES_COMPONENTS: Components = {
  a: ReleaseNotesLink,
  img: ReleaseNotesImage,
};

export function ReleaseNotesMarkdown(props: { markdown: string }) {
  return (
    <div className="release-notes-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={RELEASE_NOTES_COMPONENTS} skipHtml>
        {props.markdown}
      </ReactMarkdown>
    </div>
  );
}

function ReleaseNotesLink(props: ComponentProps<"a">) {
  return <a {...props} target="_blank" rel="noreferrer noopener" />;
}

function ReleaseNotesImage(props: ComponentProps<"img">) {
  return <img {...props} loading="lazy" referrerPolicy="no-referrer" />;
}
