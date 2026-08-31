import type { ForwardRefExoticComponent, RefAttributes } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  AtSign,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileArchive,
  Globe2,
  Info,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Mic,
  MonitorCog,
  MoreHorizontal,
  Package,
  Palette,
  Paperclip,
  PencilLine,
  Play,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Store,
  ToggleLeft,
  Trash2,
  Upload,
  UserRound,
  WifiOff,
  Wrench,
  X,
  XCircle,
  PlugZap,
  type LucideIcon,
} from "lucide-react";
import {
  AddressBookIcon,
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  AtIcon,
  CameraIcon,
  CaretRightIcon,
  ChatCircleIcon,
  ChatsCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  CpuIcon,
  DesktopIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FileArchiveIcon,
  GearIcon,
  GlobeIcon,
  InfoIcon,
  LockIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  PackageIcon,
  PaperclipIcon,
  PaperPlaneTiltIcon,
  PaletteIcon,
  PencilSimpleIcon,
  PlayIcon,
  PushPinIcon,
  PlusIcon,
  PulseIcon,
  PuzzlePieceIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  StorefrontIcon,
  TrashIcon,
  ToggleLeftIcon,
  UploadSimpleIcon,
  WarningIcon,
  WifiSlashIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
  type IconProps as PhosphorIconProps,
} from "@phosphor-icons/react";

// Product controls use semantic names and default to Phosphor.
// Brand, provider, kernel, and app identity icons remain specialized assets.
export type ProductIconSystem = "lucide" | "phosphor";
export const DEFAULT_PRODUCT_ICON_SYSTEM: ProductIconSystem = "phosphor";

export type ProductIconName =
  | "add"
  | "appearance"
  | "archive"
  | "attach"
  | "back"
  | "camera"
  | "chat"
  | "check"
  | "close"
  | "contacts"
  | "copy"
  | "delete"
  | "desktop"
  | "download"
  | "edit"
  | "error"
  | "extensions"
  | "external"
  | "globe"
  | "info"
  | "kernel"
  | "loading"
  | "locked"
  | "mention"
  | "mode"
  | "more"
  | "network"
  | "next"
  | "offline"
  | "ops"
  | "package"
  | "pin"
  | "play"
  | "provider"
  | "refresh"
  | "reply"
  | "rooms"
  | "search"
  | "send"
  | "settings"
  | "shield"
  | "store"
  | "success"
  | "tools"
  | "upload"
  | "voice"
  | "warning";

const PHOSPHOR_PRODUCT_ICONS = {
  add: PlusIcon,
  appearance: PaletteIcon,
  archive: FileArchiveIcon,
  attach: PaperclipIcon,
  back: ArrowLeftIcon,
  camera: CameraIcon,
  chat: ChatCircleIcon,
  check: CheckIcon,
  close: XIcon,
  contacts: AddressBookIcon,
  copy: CopyIcon,
  delete: TrashIcon,
  desktop: DesktopIcon,
  download: DownloadSimpleIcon,
  edit: PencilSimpleIcon,
  error: XCircleIcon,
  extensions: PuzzlePieceIcon,
  external: ArrowSquareOutIcon,
  globe: GlobeIcon,
  info: InfoIcon,
  kernel: CpuIcon,
  loading: CircleNotchIcon,
  locked: LockIcon,
  mention: AtIcon,
  mode: ToggleLeftIcon,
  more: DotsThreeIcon,
  network: GlobeIcon,
  next: CaretRightIcon,
  offline: WifiSlashIcon,
  ops: PulseIcon,
  package: PackageIcon,
  pin: PushPinIcon,
  play: PlayIcon,
  provider: PlugsConnectedIcon,
  refresh: ArrowClockwiseIcon,
  reply: ChatCircleIcon,
  rooms: ChatsCircleIcon,
  search: MagnifyingGlassIcon,
  send: PaperPlaneTiltIcon,
  settings: GearIcon,
  shield: ShieldCheckIcon,
  store: StorefrontIcon,
  success: CheckCircleIcon,
  tools: WrenchIcon,
  upload: UploadSimpleIcon,
  voice: MicrophoneIcon,
  warning: WarningIcon,
} satisfies Record<ProductIconName, ForwardRefExoticComponent<PhosphorIconProps & RefAttributes<SVGSVGElement>>>;

const LUCIDE_PRODUCT_ICONS = {
  add: Plus,
  appearance: Palette,
  archive: FileArchive,
  attach: Paperclip,
  back: ArrowLeft,
  camera: Camera,
  chat: MessageSquare,
  check: Check,
  close: X,
  contacts: UserRound,
  copy: Copy,
  delete: Trash2,
  desktop: MonitorCog,
  download: Download,
  edit: PencilLine,
  error: XCircle,
  extensions: Package,
  external: ExternalLink,
  globe: Globe2,
  info: Info,
  kernel: Cpu,
  loading: LoaderCircle,
  locked: LockKeyhole,
  mention: AtSign,
  mode: ToggleLeft,
  more: MoreHorizontal,
  network: Globe2,
  next: ChevronRight,
  offline: WifiOff,
  ops: Activity,
  package: Package,
  pin: Pin,
  play: Play,
  provider: PlugZap,
  refresh: RefreshCw,
  reply: MessageCircle,
  rooms: MessagesSquare,
  search: Search,
  send: ArrowUp,
  settings: Settings,
  shield: ShieldCheck,
  store: Store,
  success: CheckCircle2,
  tools: Wrench,
  upload: Upload,
  voice: Mic,
  warning: AlertTriangle,
} satisfies Record<ProductIconName, LucideIcon>;

export const PRODUCT_ICON_NAMES = Object.freeze(Object.keys(PHOSPHOR_PRODUCT_ICONS) as ProductIconName[]);

export function ProductIcon(props: {
  name: ProductIconName;
  system?: ProductIconSystem;
  size?: number;
  className?: string;
}) {
  const { name, system = DEFAULT_PRODUCT_ICON_SYSTEM, size = 20, className } = props;
  if (system === "lucide") {
    const Icon = LUCIDE_PRODUCT_ICONS[name];
    return <Icon aria-hidden="true" className={className} size={size} strokeWidth={1.8} />;
  }

  const Icon = PHOSPHOR_PRODUCT_ICONS[name];
  return <Icon aria-hidden="true" className={className} size={size} weight="regular" />;
}
