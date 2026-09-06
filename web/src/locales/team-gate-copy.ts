import type { ResolvedLanguage } from "../i18n-types";

export interface TeamGateCopy {
  title: string;
  hint: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  submit: string;
  pending: string;
  invalid: string;
  unavailable: string;
  privacy: string;
  pickTitle: string;
  pickHint: string;
  pickEmpty: string;
  pickNoRoles: string;
  useEmail: string;
}

export function teamGateCopy(language: ResolvedLanguage): TeamGateCopy {
  if (language === "zh-CN") {
    return {
      title: "测试环境准入",
      hint: "这台服务器要求先输入团队 token 才能登录。向团队索取即可。",
      tokenLabel: "团队 token",
      tokenPlaceholder: "粘贴团队 token",
      submit: "进入",
      pending: "验证中…",
      invalid: "团队 token 不正确。",
      unavailable: "暂时无法验证，请稍后重试。",
      privacy: "token 只发给本机的桌面服务，由它保管；浏览器不会存储它。",
      pickTitle: "选择测试账号",
      pickHint: "点任一账号即可进入，无需邮箱验证码。进入后仍可随时切换。",
      pickEmpty: "这台服务器没有可用的测试账号。",
      pickNoRoles: "无任何角色",
      useEmail: "改用邮箱登录",
    };
  }
  return {
    title: "Test environment access",
    hint: "This server asks for a team token before sign-in. Ask the team for it.",
    tokenLabel: "Team token",
    tokenPlaceholder: "Paste the team token",
    submit: "Continue",
    pending: "Verifying…",
    invalid: "That team token is not correct.",
    unavailable: "Cannot verify right now. Try again shortly.",
    privacy: "The token goes only to the local desktop service, which keeps it. The browser stores nothing.",
    pickTitle: "Pick a test account",
    pickHint: "Click any account to enter. No verification code needed, and you can switch again later.",
    pickEmpty: "This server offers no test accounts.",
    pickNoRoles: "no roles",
    useEmail: "Sign in with email instead",
  };
}
