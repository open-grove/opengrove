import type { ResolvedLanguage } from "../i18n-types";

export interface DevFixtureAccountCopy {
  open: string;
  title: string;
  hint: string;
  noRoles: string;
  yourAccount: string;
  restoreAction: string;
  restoring: string;
  current: string;
  switching: string;
  switchAction: string;
}

export function devFixtureAccountCopy(language: ResolvedLanguage): DevFixtureAccountCopy {
  if (language === "zh-CN") {
    return {
      open: "切换测试账号",
      title: "切换测试账号",
      hint: "仅本地开发环境可用。点击即切换，无需邮箱验证码。",
      noRoles: "无任何角色",
      yourAccount: "你的账号",
      restoreAction: "切回",
      restoring: "正在切回…",
      current: "当前账号",
      switching: "切换中…",
      switchAction: "切换",
    };
  }
  return {
    open: "Switch test account",
    title: "Switch test account",
    hint: "Available only in local development. Click an account to switch. No verification code needed.",
    noRoles: "no roles",
    yourAccount: "Your account",
    restoreAction: "Switch back",
    restoring: "Switching back…",
    current: "Current",
    switching: "Switching…",
    switchAction: "Switch",
  };
}
