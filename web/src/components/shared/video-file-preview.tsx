import { MediaPlayer, MediaProvider } from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";

// 视频播放器经 React.lazy 异步加载（@vidstack/react 体积大）；
// 对应 CSS 留在 standard-file-preview.tsx 顶层随主包加载，因为异步 chunk 的 CSS 不会被自动加载。
const filePreviewVideoLayoutSlots = {
  airPlayButton: null,
  chapterTitle: null,
  googleCastButton: null,
  settingsMenu: null,
};

export function VideoFilePreview(props: { fileName: string; src: string }) {
  return (
    <MediaPlayer
      className="file-preview-video-player"
      title={props.fileName}
      src={props.src}
      viewType="video"
      streamType="on-demand"
      preload="metadata"
      playsInline
    >
      <MediaProvider />
      <DefaultVideoLayout icons={defaultLayoutIcons} noKeyboardAnimations slots={filePreviewVideoLayoutSlots} />
    </MediaPlayer>
  );
}
