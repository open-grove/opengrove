import type { ResolvedLanguage } from "../i18n-types";

export interface DevFixtureAccountCopy {
  open: string;
  title: string;
  hint: string;
  noRoles: string;
  current: string;
  switching: string;
  switchAction: string;
  disabled: string;
}

export function devFixtureAccountCopy(language: ResolvedLanguage): DevFixtureAccountCopy {
  if (language === "zh-CN") {
    return {
      open: "切换测试账号",
      title: "切换测试账号",
      hint: "仅本地开发环境可用。点击账号后会自动使用固定验证码 000000 登录。",
      noRoles: "无附加角色",
      current: "当前账号",
      switching: "切换中…",
      switchAction: "切换",
      disabled: "已禁用",
    };
  }
  return {
    open: "Switch test account",
    title: "Switch test account",
    hint: "Available only in local development. Click an account to sign in with fixed code 000000.",
    noRoles: "No extra roles",
    current: "Current",
    switching: "Switching…",
    switchAction: "Switch",
    disabled: "Disabled",
  };
}
