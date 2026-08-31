// Crepe 富文本编辑器样式：随主包 eager 加载。
// 编辑器本体（markdown-rich-editor.tsx）经 React.lazy 拆成异步 chunk，
// 而异步 chunk 的 CSS 不会被浏览器自动加载，因此样式集中在这里引入。
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/frame.css";
